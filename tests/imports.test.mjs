import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import YAML from 'yaml';

const repository = path.resolve(import.meta.dirname, '..');
const digest = `sha256:${'a'.repeat(64)}`;

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'actions-import-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin'); fs.mkdirSync(bin);
  const logs = path.join(directory, 'calls.jsonl');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALL_LOG: logs, RUNNER_TEMP: directory,
    GITHUB_OUTPUT: path.join(directory, 'outputs'), GITHUB_REPOSITORY: 'projectcapsule/example',
    GITHUB_SHA: 'a'.repeat(40), GITHUB_WORKFLOW: 'Release $(false)', REGISTRY: 'ghcr.io',
    REGISTRY_USERNAME: 'publisher', REGISTRY_PASSWORD: 'token with $(syntax) and spaces',
    REPOSITORY: 'projectcapsule/charts', REPO: 'projectcapsule/charts',
    SIGN_IMAGE: 'false', COSIGN_REPOSITORY: '', CHART_NAME: 'example', CHART_PATH: '',
    CHART_VERSION: '', APP_VERSION: '', UPDATE_DEPENDENCIES: 'false', TEST_DIGEST: digest };
  const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\nconst fs = require('fs');\nconst args = process.argv.slice(2);\n${body}\n`, { mode: 0o755 });
  const invoke = action => spawnSync('bash', [path.join(repository, action, 'publish.sh')], { cwd: directory, env, encoding: 'utf8' });
  const calls = () => fs.existsSync(logs) ? fs.readFileSync(logs, 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { directory, env, stub, invoke, calls };
}

function helm(t) {
  const f = fixture(t);
  f.stub('helm', `
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({tool:'helm', args, config:process.env.HELM_REGISTRY_CONFIG,
  password: args[0] === 'registry' ? fs.readFileSync(0, 'utf8') : null}) + '\\n');
if (args[0] === 'package') {
  const destination = args[args.indexOf('--destination') + 1];
  const version = args.includes('--version') ? args[args.indexOf('--version') + 1] : '1.2.3+build';
  fs.writeFileSync(destination + '/example-' + version + '.tgz', 'archive');
}
if (args[0] === 'show') console.log('name: ' + (process.env.WRONG_NAME || 'example'));
if (args[0] === 'push') {
  if (process.env.FAIL_PUSH) { console.error('registry unavailable'); process.exit(1); }
  console.log('Digest: ' + (process.env.BAD_DIGEST ? 'not-a-digest' : process.env.TEST_DIGEST));
}
`);
  f.stub('cosign', `fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({tool:'cosign', args}) + '\\n');`);
  return f;
}

test('Helm defaults chart path and derives the output version from the fresh package', t => {
  const f = helm(t);
  fs.mkdirSync(path.join(f.directory, 'chart-build'));
  fs.writeFileSync(path.join(f.directory, 'chart-build/stale-0.1.tgz'), 'old');
  const result = f.invoke('helm-oci-chart');
  assert.equal(result.status, 0, result.stderr);
  const calls = f.calls();
  assert.equal(calls.find(call => call.args[0] === 'package').args[1], 'charts/example');
  assert.equal(calls[0].password, f.env.REGISTRY_PASSWORD);
  assert.ok(calls[0].args.includes('--password-stdin'));
  assert.ok(!calls[0].args.includes(f.env.REGISTRY_PASSWORD));
  assert.match(fs.readFileSync(f.env.GITHUB_OUTPUT, 'utf8'), /image=ghcr.io\/projectcapsule\/charts\/example:1.2.3_build/);
  assert.equal(fs.existsSync(path.dirname(calls[0].config)), false, 'temporary credentials removed');
  assert.ok(!calls.find(call => call.tool === 'cosign'));
});

test('Helm preserves spaces and shell characters in input values and signs the immutable reference', t => {
  const f = helm(t);
  Object.assign(f.env, { SIGN_IMAGE: 'true', UPDATE_DEPENDENCIES: 'true', CHART_PATH: 'path with spaces/$(false)',
    CHART_VERSION: '2.3.4', APP_VERSION: 'app $(false)' });
  const result = f.invoke('helm-oci-chart');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls().find(call => call.args[0] === 'dependency').args, ['dependency', 'update', f.env.CHART_PATH]);
  const packaged = f.calls().find(call => call.args[0] === 'package');
  assert.ok(packaged.args.includes(f.env.APP_VERSION));
  const signed = f.calls().find(call => call.tool === 'cosign');
  assert.equal(signed.args.at(-1), `ghcr.io/projectcapsule/charts/example:2.3.4@${digest}`);
  assert.ok(signed.args.includes('workflow=Release $(false)'));
});

for (const flag of ['FAIL_PUSH', 'BAD_DIGEST', 'WRONG_NAME']) {
  test(`Helm rejects ${flag}, omits success outputs, and cleans credentials`, t => {
    const f = helm(t); f.env[flag] = '1';
    const result = f.invoke('helm-oci-chart');
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(f.env.GITHUB_OUTPUT), false);
    assert.equal(fs.existsSync(path.dirname(f.calls()[0].config)), false);
  });
}

function ko(t) {
  const f = fixture(t);
  Object.assign(f.env, { TASKFILE_TARGET: 'image:publish', VERSION: 'v1.2.3', VERSION_REQUIRED: 'true', SBOM_NAME: 'example' });
  f.stub('task', `
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({args, username:process.env.REGISTRY_USERNAME,
  password:process.env.REGISTRY_PASSWORD, version:process.env.VERSION, repository:process.env.REPOSITORY}) + '\\n');
if (process.env.FAIL_TASK) process.exit(1);
console.log(process.env.BAD_IMAGE || ('ghcr.io/projectcapsule/example@' + process.env.TEST_DIGEST));
`);
  return f;
}

test('ko passes registry credentials and version to Task and returns the image digest', t => {
  const f = ko(t); const result = f.invoke('task-ko-publish');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls()[0], { args: ['--silent', '--output=interleaved', 'image:publish'], username: f.env.REGISTRY_USERNAME,
    password: f.env.REGISTRY_PASSWORD, version: 'v1.2.3', repository: f.env.REPOSITORY });
  assert.match(fs.readFileSync(f.env.GITHUB_OUTPUT, 'utf8'), new RegExp(`digest=${digest}`));
});

for (const [key, value] of [
  ['VERSION', ''], ['VERSION', '$(false)'], ['SBOM_NAME', '../outside'],
  ['TASKFILE_TARGET', ''], ['TASKFILE_TARGET', '--taskfile=evil.yml'],
  ['TASKFILE_TARGET', 'image:publish other'], ['TASKFILE_TARGET', 'image:*'],
  ['TASKFILE_TARGET', 'image:publish VERSION=evil'], ['TASKFILE_TARGET', 'image:publish; touch unexpected'],
]) {
  test(`ko rejects invalid ${key} before executing Task`, t => {
    const f = ko(t); f.env[key] = value;
    assert.notEqual(f.invoke('task-ko-publish').status, 0);
    assert.equal(f.calls().length, 0);
  });
}

test('ko permits an explicitly optional version and rejects malformed Task output', t => {
  const f = ko(t); f.env.VERSION_REQUIRED = 'false'; f.env.VERSION = '';
  assert.equal(f.invoke('task-ko-publish').status, 0);
  fs.unlinkSync(f.env.GITHUB_OUTPUT);
  f.env.BAD_IMAGE = `build log\nghcr.io/example@${digest}`;
  assert.notEqual(f.invoke('task-ko-publish').status, 0);
  assert.equal(fs.existsSync(f.env.GITHUB_OUTPUT), false);
  delete f.env.BAD_IMAGE; f.env.FAIL_TASK = '1';
  assert.notEqual(f.invoke('task-ko-publish').status, 0);
});

test('action manifests keep all inputs and output references valid and pin external actions', () => {
  for (const action of ['exists', 'helm-oci-chart', 'task-ko-publish', 'headlamp-publish', 'headlamp-test']) {
    const source = fs.readFileSync(path.join(repository, action, 'action.yaml'), 'utf8');
    const metadata = YAML.parse(source);
    assert.equal(metadata.runs.using, 'composite');
    const steps = new Set(metadata.runs.steps.map(step => step.id).filter(Boolean));
    for (const match of source.matchAll(/inputs\.([\w-]+)/g)) assert.ok(metadata.inputs[match[1]], `${action}: undefined input ${match[1]}`);
    for (const output of Object.values(metadata.outputs || {})) {
      assert.ok(steps.has(output.value.match(/steps\.([\w-]+)\.outputs\./)?.[1]), `${action}: invalid output`);
    }
    for (const step of metadata.runs.steps) {
      if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/);
      if (step.run) {
        assert.equal(step.shell, 'bash');
        // The exists action interpolates only a boolean expression, never the raw input.
        if (action !== 'exists') assert.doesNotMatch(step.run, /\$\{\{/);
      }
    }
  }
  const headlamp = YAML.parse(fs.readFileSync(path.join(repository, 'headlamp-publish/action.yaml'), 'utf8'));
  assert.equal(headlamp.inputs['build-root'].default, 'headlamp/');
  assert.equal(headlamp.inputs['target-branch'].default, 'artifacthub');
  const ko = YAML.parse(fs.readFileSync(path.join(repository, 'task-ko-publish/action.yaml'), 'utf8'));
  assert.equal(ko.inputs['taskfile-target'].required, true);
  assert.equal(ko.inputs['makefile-target'], undefined);
  assert.equal(ko.runs.steps[0].env.TASKFILE_TARGET, '${{ inputs.taskfile-target }}');
});
