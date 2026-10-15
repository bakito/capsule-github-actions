import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import semver from 'semver';
import YAML from 'yaml';

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status}): ${result.stderr || ''}`);
  }
  return result.stdout?.trim() || '';
}

// Resolve both existing and not-yet-created paths without following a symlink
// outside the selected checkout. Branch contents are data, never executable code.
export function within(root, relative) {
  if (!relative || path.isAbsolute(relative) || /[\r\n\0]/.test(relative)) {
    throw new Error('Expected a relative path within the checkout');
  }
  root = fs.realpathSync(root);
  const target = path.resolve(root, relative);
  const inside = value => value === root || value.startsWith(`${root}${path.sep}`);
  if (!inside(target)) throw new Error('Path escapes the checkout');
  let component = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    component = path.join(component, part);
    if (fs.lstatSync(component, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error('Symlinks are not allowed in publication paths');
    }
  }
  let parent = target;
  while (!fs.existsSync(parent)) {
    // existsSync follows symlinks: also reject dangling links.
    if (fs.lstatSync(parent, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error('Dangling symlink in publication path');
    }
    parent = path.dirname(parent);
  }
  if (!inside(fs.realpathSync(parent))) throw new Error('Symlink escapes the checkout');
  return target;
}

export function versionFromTag(tag) {
  const version = tag?.replace(/^v/, '');
  if (!version || semver.valid(version) !== version || version.includes('+')) {
    throw new Error('tag must be an exact semantic version, optionally prefixed with v, without build metadata');
  }
  return version;
}

function output(values, filename = process.env.GITHUB_OUTPUT) {
  if (!filename) return;
  for (const [name, value] of Object.entries(values)) {
    if (/[\r\n]/.test(String(value))) throw new Error(`Invalid multiline output: ${name}`);
    fs.appendFileSync(filename, `${name}=${value}\n`);
  }
}

function save(state) {
  fs.writeFileSync(state.stateFile, `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

export function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function build(env = process.env) {
  const workspace = fs.realpathSync(env.GITHUB_WORKSPACE);
  const root = within(workspace, env.INPUT_BUILD_ROOT || 'headlamp/');
  const tag = env.INPUT_TAG;
  const version = versionFromTag(tag);
  const branch = env.INPUT_TARGET_BRANCH || 'artifacthub';
  run('git', ['check-ref-format', `refs/heads/${branch}`]);
  if (branch.startsWith('-') || /[\r\n]/.test(branch)) throw new Error('Invalid target branch');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY)) {
    throw new Error('Invalid GitHub repository');
  }
  const pkg = JSON.parse(fs.readFileSync(within(root, 'package.json'), 'utf8'));
  const name = env.INPUT_PACKAGE_NAME || pkg.name;
  if (!/^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/.test(name || '')) {
    throw new Error('package-name must contain lowercase letters, digits, and internal hyphens');
  }
  const template = env.INPUT_METADATA_TEMPLATE ? within(root, env.INPUT_METADATA_TEMPLATE) : null;
  if (template && !fs.statSync(template).isFile()) throw new Error('Metadata template must be a file');
  const sourceCommit = run('git', ['rev-parse', 'HEAD'], { cwd: workspace });
  const prebuilt = Boolean(env.INPUT_ARCHIVE);
  let archive;
  if (prebuilt) {
    within(workspace, env.INPUT_ARCHIVE);
    const archives = fs.globSync(env.INPUT_ARCHIVE, { cwd: workspace });
    if (archives.length !== 1) throw new Error('archive must match exactly one .tar.gz file within the checkout');
    archive = within(workspace, archives[0]);
    if (!archive.endsWith('.tar.gz')) throw new Error('archive must be a .tar.gz file');
  } else {
    if (fs.readdirSync(root).some(file => file.endsWith('.tar.gz'))) {
      throw new Error('Remove existing .tar.gz archives from build-root before packaging');
    }
    const options = { cwd: root, env, stdio: 'inherit' };
    run('npm', ['ci', '--no-audit', '--no-fund'], options);
    run('npm', ['version', version, '--no-git-tag-version', '--allow-same-version', '--ignore-scripts'], options);
    run('npm', ['run', 'build'], options);
    run('npm', ['run', 'package'], options);
    const archives = fs.readdirSync(root).filter(file => file.endsWith('.tar.gz'));
    if (archives.length !== 1) throw new Error('Packaging must produce exactly one .tar.gz archive in build-root');
    archive = within(root, archives[0]);
  }
  if (!fs.statSync(archive).isFile() || fs.statSync(archive).size === 0) throw new Error('Plugin archive is empty or not a file');
  const server = env.GITHUB_SERVER_URL || 'https://github.com';
  const directory = fs.mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), 'headlamp-publish-'));
  const state = {
    stateFile: path.join(directory, 'state.json'), directory, root, workspace,
    sourceCommit, tag, version, branch, name, template, archive, prebuilt, checksum: sha256(archive),
    repository: env.GITHUB_REPOSITORY, server,
    api: env.GITHUB_API_URL || 'https://api.github.com',
    remote: `${server}/${env.GITHUB_REPOSITORY}.git`,
    archiveURL: `${server}/${env.GITHUB_REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(path.basename(archive))}`,
    metadataPath: `${name}/${version}/artifacthub-pkg.yml`,
  };
  save(state);
  output({ state: state.stateFile, version, archive, checksum: state.checksum,
    'archive-url': state.archiveURL, 'metadata-path': state.metadataPath }, env.GITHUB_OUTPUT);
  return state;
}

// Credentials exist only in child process environment, not command arguments,
// URLs, the source checkout, or the temporary checkout's persistent git config.
export function gitEnvironment(state, token) {
  if (!token) throw new Error('A GitHub token is required for publication');
  return {
    ...process.env, GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: `http.${state.server}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
    GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: '',
    GIT_CONFIG_KEY_2: 'core.hooksPath', GIT_CONFIG_VALUE_2: '/dev/null',
  };
}

function templateFile(state, checkout) {
  if (state.template) return state.template;
  const local = within(state.root, 'artifacthub-pkg.yml');
  if (fs.existsSync(local)) return local;
  for (const relative of [`${state.name}/package.template`, 'package.template']) {
    const candidate = within(checkout, relative);
    if (fs.existsSync(candidate)) return candidate;
  }
  const packageRoot = within(checkout, state.name);
  if (fs.existsSync(packageRoot)) {
    const versions = fs.readdirSync(packageRoot).filter(value => semver.valid(value) === value).sort(semver.rcompare);
    for (const version of versions) {
      const candidate = within(checkout, `${state.name}/${version}/artifacthub-pkg.yml`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error('No metadata template: add artifacthub-pkg.yml in build-root, set metadata-template, or provide package.template on target-branch');
}

export function prepare(state, gitEnv) {
  const checkout = path.join(state.directory, 'metadata');
  fs.mkdirSync(checkout);
  const options = { cwd: checkout, env: gitEnv };
  run('git', ['init', '--quiet'], options);
  run('git', ['remote', 'add', 'origin', state.remote], options);
  const ref = `refs/heads/${state.branch}`;
  const probe = spawnSync('git', ['ls-remote', '--exit-code', '--heads', 'origin', ref], { ...options, encoding: 'utf8' });
  if (probe.error) throw probe.error;
  if (probe.status === 0) {
    run('git', ['fetch', '--quiet', '--depth=1', 'origin', ref], options);
    run('git', ['checkout', '--quiet', '-b', state.branch, 'FETCH_HEAD'], options);
  } else if (probe.status === 2) {
    run('git', ['symbolic-ref', 'HEAD', ref], options);
  } else {
    throw new Error(`Cannot inspect metadata branch: ${probe.stderr}`);
  }
  const template = YAML.parseDocument(fs.readFileSync(templateFile(state, checkout), 'utf8'), { uniqueKeys: true });
  if (template.errors.length) throw new Error(`Invalid metadata YAML: ${template.errors[0].message}`);
  const data = template.toJS({ maxAliasCount: 100 });
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.name !== state.name) {
    throw new Error('Metadata template name must match package-name');
  }
  const metadata = within(checkout, state.metadataPath);
  let createdAt = new Date().toISOString();
  if (fs.existsSync(metadata)) {
    const existing = YAML.parse(fs.readFileSync(metadata, 'utf8'));
    if (existing?.annotations?.['headlamp/plugin/archive-checksum'] !== `sha256:${state.checksum}` ||
        existing?.annotations?.['headlamp/plugin/archive-url'] !== state.archiveURL) {
      throw new Error('This plugin version already has different archive metadata; publish a new version');
    }
    createdAt = existing.createdAt || createdAt;
  }
  template.set('version', state.version);
  template.set('createdAt', createdAt);
  template.setIn(['annotations', 'headlamp/plugin/archive-url'], state.archiveURL);
  template.setIn(['annotations', 'headlamp/plugin/archive-checksum'], `sha256:${state.checksum}`);
  fs.mkdirSync(path.dirname(metadata), { recursive: true });
  fs.writeFileSync(metadata, template.toString());
  const paths = [state.metadataPath];
  const readme = within(state.root, 'README.md');
  if (fs.existsSync(readme)) {
    const relative = `${state.name}/${state.version}/README.md`;
    fs.copyFileSync(readme, within(checkout, relative));
    paths.push(relative);
  }
  const repositoryMetadata = within(state.root, 'artifacthub-repo.yml');
  const repositoryDestination = within(checkout, 'artifacthub-repo.yml');
  if (!fs.existsSync(repositoryDestination) && fs.existsSync(repositoryMetadata)) {
    fs.copyFileSync(repositoryMetadata, repositoryDestination);
    paths.push('artifacthub-repo.yml');
  }
  run('git', ['add', '--', ...paths], options);
  const changed = run('git', ['diff', '--cached', '--name-only'], options);
  if (changed) {
    run('git', ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', `chore(release): publish ${state.name} ${state.tag}`], options);
  }
  state.checkout = checkout;
  state.changed = Boolean(changed);
  save(state);
  return state;
}

export async function release(state, token, fetcher = fetch) {
  if (!token) throw new Error('A GitHub token is required for publication');
  const base = `${state.api}/repos/${state.repository}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  async function request(url, options = {}, notFound = false) {
    const response = await fetcher(url, { signal: AbortSignal.timeout(300_000), ...options, headers: { ...headers, ...options.headers } });
    if (response.status === 404 && notFound) return null;
    if (!response.ok) throw new Error(`GitHub request failed: HTTP ${response.status}`);
    return response;
  }
  // Verify the tag exists and resolves to exactly the source being packaged.
  // POST /releases would otherwise silently create a missing tag.
  let reference = await (await request(`${base}/git/ref/tags/${encodeURIComponent(state.tag)}`)).json();
  let object = reference.object;
  for (let depth = 0; object.type === 'tag' && depth < 10; depth++) {
    reference = await (await request(`${base}/git/tags/${object.sha}`)).json();
    object = reference.object;
  }
  if (object.type !== 'commit' || object.sha !== state.sourceCommit) {
    throw new Error('Release tag does not resolve to the checked-out source commit');
  }
  const found = await request(`${base}/releases/tags/${encodeURIComponent(state.tag)}`, {}, true);
  if (!found && state.prebuilt) {
    throw new Error('Prebuilt archive requires an existing published release; publish it before running this action');
  }
  const published = found ? await found.json() : await (await request(`${base}/releases`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: state.tag, name: `Release ${state.tag}`, generate_release_notes: true,
      prerelease: Boolean(semver.prerelease(state.version)) }),
  })).json();
  const filename = path.basename(state.archive);
  let existing;
  for (let page = 1; ; page++) {
    const assets = await (await request(`${base}/releases/${published.id}/assets?per_page=100&page=${page}`)).json();
    existing = assets.find(asset => asset.name === filename);
    if (existing || assets.length < 100) break;
  }
  if (existing) {
    let digest = existing.digest;
    if (!digest) {
      const response = await request(`${base}/releases/assets/${existing.id}`, { headers: { Accept: 'application/octet-stream' } });
      const hash = createHash('sha256');
      for await (const chunk of response.body) hash.update(chunk);
      digest = `sha256:${hash.digest('hex')}`;
    }
    if (digest !== `sha256:${state.checksum}`) throw new Error('Release asset already exists with different content; publish a new version');
    return;
  }
  if (state.prebuilt) {
    throw new Error('Prebuilt archive is not attached to the release; publish it and its signatures before metadata');
  }
  if (published.immutable) {
    throw new Error('Cannot add an archive to an immutable release; include it before publication and use the archive input');
  }
  const upload = new URL(published.upload_url.replace(/\{.*$/, ''));
  upload.searchParams.set('name', filename);
  await request(upload, { method: 'POST', headers: { 'Content-Type': 'application/gzip' }, body: await fs.openAsBlob(state.archive) });
}

export function publish(state, gitEnv) {
  const options = { cwd: state.checkout, env: gitEnv };
  if (state.changed) run('git', ['push', 'origin', `HEAD:refs/heads/${state.branch}`], options);
  const commit = run('git', ['rev-parse', 'HEAD'], options);
  output({ commit });
  return commit;
}

async function main() {
  const phase = process.argv[2];
  if (phase === 'build') return build();
  const state = JSON.parse(fs.readFileSync(process.env.STATE_FILE, 'utf8'));
  switch (phase) {
    case 'prepare': return prepare(state, gitEnvironment(state, process.env.GH_TOKEN));
    case 'release': return release(state, process.env.GH_TOKEN);
    case 'publish': return publish(state, gitEnvironment(state, process.env.GH_TOKEN));
    case 'cleanup': return fs.rmSync(state.directory, { recursive: true, force: true });
    default: throw new Error(`Unknown phase: ${phase}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
