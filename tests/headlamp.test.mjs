import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import YAML from 'yaml';
import { build, gitEnvironment, prepare, publish, release, run, sha256, versionFromTag, within } from '../headlamp-publish/publish.mjs';

function fixture(t, branch = 'catalog/testing') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'headlamp-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'plugin');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'artifacthub-pkg.yml'), 'name: capsule\ndisplayName: Capsule\nannotations:\n  headlamp/plugin/version-compat: ">=0.24"\n');
  fs.writeFileSync(path.join(root, 'README.md'), '# Plugin\n');
  fs.writeFileSync(path.join(root, 'artifacthub-repo.yml'), 'owners:\n  - name: capsule-maintainers\n');
  const archive = path.join(root, 'capsule-1.2.3.tar.gz');
  fs.writeFileSync(archive, 'test archive bytes');
  const remote = path.join(directory, 'remote.git');
  run('git', ['init', '--quiet', '--bare', remote]);
  const state = {
    directory: path.join(directory, 'publication'), root, version: '1.2.3', tag: 'v1.2.3', branch,
    name: 'capsule', archive, checksum: sha256(archive), sourceCommit: 'a'.repeat(40),
    remote, repository: 'projectcapsule/example', server: 'https://github.com', api: 'https://api.github.com',
    archiveURL: 'https://github.com/projectcapsule/example/releases/download/v1.2.3/capsule-1.2.3.tar.gz',
    metadataPath: 'capsule/1.2.3/artifacthub-pkg.yml',
  };
  fs.mkdirSync(state.directory);
  state.stateFile = path.join(state.directory, 'state.json');
  const env = gitEnvironment(state, 'dummy-test-token');
  return { state, env, directory };
}

function retry(state) {
  fs.rmSync(state.checkout, { recursive: true });
  return state;
}

function commit(checkout, message = 'fixture') {
  run('git', ['add', '.'], { cwd: checkout });
  run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.org', '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '-m', message], { cwd: checkout });
}

test('first publication creates only the selected metadata branch, repeat is unchanged', t => {
  const { state, env } = fixture(t);
  prepare(state, env);
  assert.equal(run('git', ['--git-dir', state.remote, 'for-each-ref']), '');
  const first = publish(state, env);
  const metadata = YAML.parse(run('git', ['--git-dir', state.remote, 'show', `${state.branch}:${state.metadataPath}`]));
  assert.equal(metadata.version, '1.2.3');
  assert.equal(metadata.annotations['headlamp/plugin/archive-url'], state.archiveURL);
  assert.equal(metadata.annotations['headlamp/plugin/archive-checksum'], `sha256:${state.checksum}`);
  assert.equal(metadata.annotations['headlamp/plugin/version-compat'], '>=0.24');
  assert.equal(run('git', ['--git-dir', state.remote, 'show', `${state.branch}:capsule/1.2.3/README.md`]), '# Plugin');
  assert.match(run('git', ['--git-dir', state.remote, 'show', `${state.branch}:artifacthub-repo.yml`]), /capsule-maintainers/);
  prepare(retry(state), env);
  assert.equal(state.changed, false);
  assert.equal(publish(state, env), first);
  assert.equal(YAML.parse(fs.readFileSync(path.join(state.checkout, state.metadataPath), 'utf8')).createdAt, metadata.createdAt);
  assert.doesNotMatch(fs.readFileSync(path.join(state.checkout, '.git/config'), 'utf8'), /dummy-test-token|extraheader/);
});

test('existing branch keeps unrelated files and discovers a package template', t => {
  const { state, env } = fixture(t, 'artifacthub');
  prepare(state, env);
  fs.writeFileSync(path.join(state.checkout, 'unrelated.txt'), 'preserve me');
  fs.writeFileSync(path.join(state.checkout, 'capsule/package.template'), 'name: capsule\ndisplayName: Shared template\n');
  commit(state.checkout);
  publish(state, env);
  fs.unlinkSync(path.join(state.root, 'artifacthub-pkg.yml'));
  state.version = '1.2.4'; state.tag = 'v1.2.4'; state.metadataPath = 'capsule/1.2.4/artifacthub-pkg.yml';
  prepare(retry(state), env);
  publish(state, env);
  assert.equal(run('git', ['--git-dir', state.remote, 'show', 'artifacthub:unrelated.txt']), 'preserve me');
  assert.equal(YAML.parse(run('git', ['--git-dir', state.remote, 'show', `artifacthub:${state.metadataPath}`])).displayName, 'Shared template');
  assert.match(run('git', ['--git-dir', state.remote, 'show', 'artifacthub:capsule/1.2.3/artifacthub-pkg.yml']), /1.2.3/);
});

test('fallback selects the highest semantic version, not lexicographic order', t => {
  const { state, env } = fixture(t);
  prepare(state, env);
  for (const version of ['1.9.0', '1.10.0']) {
    const target = path.join(state.checkout, 'capsule', version);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'artifacthub-pkg.yml'), `name: capsule\ndisplayName: ${version}\n`);
  }
  commit(state.checkout);
  publish(state, env);
  fs.unlinkSync(path.join(state.root, 'artifacthub-pkg.yml'));
  prepare(retry(state), env);
  assert.equal(YAML.parse(fs.readFileSync(path.join(state.checkout, state.metadataPath), 'utf8')).displayName, '1.10.0');
});

test('a concurrent branch update fails without overwriting the other writer', t => {
  const { state, env, directory } = fixture(t);
  prepare(state, env); publish(state, env);
  fs.writeFileSync(path.join(state.root, 'README.md'), '# Changed\n');
  prepare(retry(state), env);
  const other = path.join(directory, 'other');
  run('git', ['clone', '--quiet', '--branch', state.branch, state.remote, other]);
  fs.writeFileSync(path.join(other, 'another-plugin.txt'), 'concurrent publication');
  commit(other); run('git', ['push', '--quiet'], { cwd: other });
  assert.throws(() => publish(state, env), /failed/);
  assert.equal(run('git', ['--git-dir', state.remote, 'show', `${state.branch}:another-plugin.txt`]), 'concurrent publication');
});

test('changing an already published version is rejected before metadata push', t => {
  const { state, env } = fixture(t);
  prepare(state, env); const first = publish(state, env);
  state.checksum = 'b'.repeat(64);
  assert.throws(() => prepare(retry(state), env), /already has different archive metadata/);
  assert.equal(run('git', ['--git-dir', state.remote, 'rev-parse', `refs/heads/${state.branch}`]), first);
});

test('missing, malformed, and wrongly named templates fail before publication', t => {
  const { state, env } = fixture(t);
  fs.unlinkSync(path.join(state.root, 'artifacthub-pkg.yml'));
  assert.throws(() => prepare(state, env), /No metadata template/);
  state.checkout = path.join(state.directory, 'metadata');
  fs.writeFileSync(path.join(state.root, 'artifacthub-pkg.yml'), 'name: [broken');
  assert.throws(() => prepare(retry(state), env), /Invalid metadata YAML/);
  fs.writeFileSync(path.join(state.root, 'artifacthub-pkg.yml'), 'name: another-plugin');
  assert.throws(() => prepare(retry(state), env), /name must match/);
});

test('explicit source templates take precedence and can bootstrap an empty branch', t => {
  const { state, env } = fixture(t);
  state.template = path.join(state.root, 'custom.yml');
  fs.writeFileSync(state.template, 'name: capsule\ndisplayName: Explicit\n');
  prepare(state, env); publish(state, env);
  assert.equal(YAML.parse(run('git', ['--git-dir', state.remote, 'show', `${state.branch}:${state.metadataPath}`])).displayName, 'Explicit');
});

test('root branch template remains supported and existing repository ownership is preserved', t => {
  const { state, env } = fixture(t);
  prepare(state, env);
  fs.writeFileSync(path.join(state.checkout, 'package.template'), 'name: capsule\ndisplayName: Root template\n');
  fs.writeFileSync(path.join(state.checkout, 'artifacthub-repo.yml'), 'repositoryID: preserve-existing-id\n');
  commit(state.checkout); publish(state, env);
  fs.unlinkSync(path.join(state.root, 'artifacthub-pkg.yml'));
  prepare(retry(state), env); publish(state, env);
  assert.equal(YAML.parse(run('git', ['--git-dir', state.remote, 'show', `${state.branch}:${state.metadataPath}`])).displayName, 'Root template');
  assert.equal(run('git', ['--git-dir', state.remote, 'show', `${state.branch}:artifacthub-repo.yml`]), 'repositoryID: preserve-existing-id');
});

test('a remote read failure is not mistaken for a missing branch', t => {
  const { state, env } = fixture(t);
  state.remote = path.join(state.directory, 'does-not-exist.git');
  assert.throws(() => prepare(state, env), /Cannot inspect metadata branch/);
});

test('metadata branch symlinks cannot redirect writes into another package', t => {
  const { state, env } = fixture(t);
  prepare(state, env);
  const metadata = path.join(state.checkout, state.metadataPath);
  fs.writeFileSync(path.join(state.checkout, 'another-package.yml'), fs.readFileSync(metadata));
  fs.unlinkSync(metadata);
  fs.symlinkSync('../../another-package.yml', metadata);
  commit(state.checkout); publish(state, env);
  assert.throws(() => prepare(retry(state), env), /Symlinks are not allowed/);
});

test('empty credentials are rejected before network requests', async t => {
  const { state } = fixture(t);
  assert.throws(() => gitEnvironment(state, ''), /token is required/);
  await assert.rejects(release(state, ''), /token is required/);
});

test('path traversal and escaping symlinks are rejected', t => {
  const { state, directory } = fixture(t);
  assert.throws(() => within(state.root, '../outside'), /escapes/);
  assert.throws(() => within(state.root, '/outside'), /relative path/);
  fs.symlinkSync(directory, path.join(state.root, 'link'));
  assert.throws(() => within(state.root, 'link/output/file'), /Symlinks are not allowed/);
  fs.symlinkSync(path.join(directory, 'missing'), path.join(state.root, 'dangling'));
  assert.throws(() => within(state.root, 'dangling/file'), /Symlinks are not allowed/);
  fs.symlinkSync(state.root, path.join(state.root, 'internal'));
  assert.throws(() => within(state.root, 'internal/README.md'), /Symlinks are not allowed/);
});

test('version validation accepts release and prerelease tags, rejects injection and branches', () => {
  for (const tag of ['v1.2.3', '1.2.3', 'v1.2.3-rc.1']) assert.equal(versionFromTag(tag), tag.replace(/^v/, ''));
  for (const tag of ['main', 'v1.2', 'v01.2.3', 'v1.2.3+build', 'v1.2.3\ncommit=x', '$(touch /tmp/injected)', undefined]) {
    assert.throws(() => versionFromTag(tag), /semantic version/);
  }
});

function fakeGitHub(state, options = {}) {
  const calls = [];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
  return {
    calls,
    fetch: async (url, init) => {
      const address = String(url); calls.push({ url: address, ...init });
      assert.equal(init.headers.Authorization, 'Bearer test-token');
      if (address.includes('/git/ref/tags/')) return json({ object: options.annotated ? { type: 'tag', sha: 'tagsha' } : { type: 'commit', sha: options.commit || state.sourceCommit } });
      if (address.includes('/git/tags/')) return json({ object: { type: 'commit', sha: state.sourceCommit } });
      if (address.includes('/releases/tags/')) return options.exists ? json({ id: 7 }) : json({}, options.error || 404);
      if (address.endsWith('/releases') && init.method === 'POST') return json({ id: 7, upload_url: 'https://uploads.github.com/repos/projectcapsule/example/releases/7/assets{?name,label}' }, 201);
      if (address.includes('?per_page=')) return json(options.asset ? [{ id: 9, name: path.basename(state.archive), ...options.asset }] : []);
      if (address.includes('/releases/assets/9')) return new Response(fs.readFileSync(state.archive));
      if (address.startsWith('https://uploads.github.com/')) return json({}, 201);
      throw new Error(`Unexpected API request: ${address}`);
    },
  };
}

test('release verifies annotated tag, creates a prerelease, and uploads exact archive bytes', async t => {
  const { state } = fixture(t);
  state.version = '1.2.3-rc.1'; state.tag = 'v1.2.3-rc.1';
  const api = fakeGitHub(state, { annotated: true });
  await release(state, 'test-token', api.fetch);
  const creation = api.calls.find(call => call.url.endsWith('/releases'));
  assert.equal(JSON.parse(creation.body).prerelease, true);
  const upload = api.calls.find(call => call.url.startsWith('https://uploads'));
  assert.equal(await upload.body.text(), fs.readFileSync(state.archive, 'utf8'));
  assert.ok(upload.url.endsWith('name=capsule-1.2.3.tar.gz'));
});

test('identical assets are reused with digest or download verification', async t => {
  const { state } = fixture(t);
  for (const asset of [{ digest: `sha256:${state.checksum}` }, {}]) {
    const api = fakeGitHub(state, { exists: true, asset });
    await release(state, 'test-token', api.fetch);
    assert.equal(api.calls.filter(call => call.method === 'POST').length, 0);
  }
});

test('release does not overwrite different assets or hide authorization failures', async t => {
  const { state } = fixture(t);
  for (const [options, error] of [
    [{ exists: true, asset: { digest: `sha256:${'b'.repeat(64)}` } }, /different content/],
    [{ error: 403 }, /HTTP 403/],
    [{ commit: 'wrong' }, /checked-out source commit/],
  ]) {
    const api = fakeGitHub(state, options);
    await assert.rejects(release(state, 'test-token', api.fetch), error);
    assert.equal(api.calls.filter(call => ['POST', 'DELETE', 'PATCH'].includes(call.method)).length, 0);
  }
});

for (const buildRoot of ['headlamp/', '.', 'plugins/plugin with spaces']) {
  test(`real npm build works with build-root ${buildRoot}`, t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'headlamp-build-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const workspace = path.join(directory, 'workspace'); fs.mkdirSync(workspace);
    const root = path.join(workspace, buildRoot); fs.mkdirSync(root, { recursive: true });
    const pkg = { name: 'capsule', version: '0.0.0', scripts: { build: 'node build.cjs', package: 'node package.cjs' } };
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { '': pkg } }));
    fs.writeFileSync(path.join(root, 'build.cjs'), "require('fs').writeFileSync('built', require('./package.json').version)");
    fs.writeFileSync(path.join(root, 'package.cjs'), "require('fs').writeFileSync('plugin.tar.gz', require('fs').readFileSync('built'))");
    run('git', ['init', '--quiet', workspace]); commit(workspace);
    const env = { ...process.env, GITHUB_WORKSPACE: workspace, RUNNER_TEMP: directory, GITHUB_OUTPUT: path.join(directory, 'outputs'),
      GITHUB_REPOSITORY: 'projectcapsule/example', INPUT_TAG: 'v2.0.1', INPUT_BUILD_ROOT: buildRoot === 'headlamp/' ? '' : buildRoot,
      INPUT_TARGET_BRANCH: 'catalog/custom' };
    const state = build(env);
    assert.equal(state.root, fs.realpathSync(root));
    assert.equal(state.branch, 'catalog/custom');
    assert.equal(fs.readFileSync(state.archive, 'utf8'), '2.0.1');
    assert.match(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'), /metadata-path=capsule\/2.0.1\/artifacthub-pkg.yml/);
    assert.throws(() => build(env), /Remove existing/);
  });
}
