import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import YAML from 'yaml';

const script = path.resolve(import.meta.dirname, '../task-ko-publish/publish.sh');
const digest = `sha256:${'b'.repeat(64)}`;
const image = `localhost:5000/team/example:1.2.3@${digest}`;

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'actions task integration '));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const env = { ...process.env, TASKFILE_TARGET: 'image:publish', REGISTRY: 'localhost:5000',
    REGISTRY_USERNAME: 'publisher', REGISTRY_PASSWORD: 'dummy $(touch unexpected) token',
    REPO: 'team/example', REPOSITORY: 'team/example', VERSION: '1.2.3', VERSION_REQUIRED: 'true',
    SBOM_NAME: 'example', SIGN_IMAGE: 'false', COSIGN_REPOSITORY: 'localhost:5000/team/sbom',
    GITHUB_OUTPUT: path.join(directory, 'outputs'), TEST_IMAGE: image };
  fs.writeFileSync(path.join(directory, 'Taskfile.yml'), YAML.stringify({
    version: '3',
    // The action must keep the digest unprefixed, regardless of the caller's default.
    output: 'prefixed',
    tasks: {
      default: { cmds: ['echo "default target must not run" >&2', 'exit 1'] },
      'image:publish': { cmds: ['node publish.cjs'] },
    },
  }));
  fs.writeFileSync(path.join(directory, 'publish.cjs'), `
const fs = require('fs');
const keys = ['REGISTRY', 'REGISTRY_USERNAME', 'REGISTRY_PASSWORD', 'REPO', 'REPOSITORY', 'VERSION', 'COSIGN_REPOSITORY'];
fs.writeFileSync('environment.json', JSON.stringify(Object.fromEntries(keys.map(key => [key, process.env[key]]))));
console.error('build progress on stderr');
console.log(process.env.TEST_IMAGE);
if (process.env.FAIL_PUBLISH === 'true') process.exit(37);
`);
  const run = overrides => spawnSync('bash', [script], { cwd: directory, env: { ...env, ...overrides }, encoding: 'utf8' });
  return { directory, env, run };
}

test('real Task runs the namespaced target and forwards inputs without command echoing or output prefixes', t => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(f.env.GITHUB_OUTPUT, 'utf8'), `image=${image}\ndigest=${digest}\n`);
  const forwarded = JSON.parse(fs.readFileSync(path.join(f.directory, 'environment.json'), 'utf8'));
  for (const [key, value] of Object.entries(forwarded)) assert.equal(value, f.env[key]);
  assert.match(result.stderr, /build progress on stderr/);
  assert.doesNotMatch(result.stderr, /node publish\.cjs/);
  assert.equal(fs.existsSync(path.join(f.directory, 'unexpected')), false);
});

test('a real Task failure cannot publish success outputs even after printing an image', t => {
  const f = fixture(t);
  const result = f.run({ FAIL_PUBLISH: 'true' });
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(f.env.GITHUB_OUTPUT), false);
});

test('a missing Task target fails without running the default target', t => {
  const f = fixture(t);
  const result = f.run({ TASKFILE_TARGET: 'image:missing' });
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(f.env.GITHUB_OUTPUT), false);
  assert.equal(fs.existsSync(path.join(f.directory, 'environment.json')), false);
  assert.doesNotMatch(result.stderr, /default target must not run/);
});

test('a real Task cannot inject extra GitHub outputs through stdout', t => {
  const f = fixture(t);
  const result = f.run({ TEST_IMAGE: `${image}\nunexpected=value` });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exactly one image@sha256/);
  assert.equal(fs.existsSync(f.env.GITHUB_OUTPUT), false);
});
