import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import YAML from 'yaml';

const action = YAML.parse(fs.readFileSync(new URL('../headlamp-test/action.yaml', import.meta.url), 'utf8'));
const scripts = ['lint', 'format', 'tsc', 'test', 'build'];

function fixture(t, buildRoot = action.inputs['build-root'].default) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'headlamp-checks-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const root = path.join(workspace, buildRoot);
  fs.mkdirSync(root, { recursive: true });
  const pkg = {
    name: 'headlamp-test-fixture', version: '1.0.0', private: true,
    scripts: Object.fromEntries(scripts.map(script => [script, `node check.cjs ${script}`])),
  };
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({
    name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { '': pkg },
  }));
  fs.writeFileSync(path.join(root, 'check.cjs'), `
const fs = require('fs');
const [script, ...args] = process.argv.slice(2);
fs.appendFileSync('checks.jsonl', JSON.stringify({script, args, ci: process.env.CI}) + '\\n');
if (process.env.FAIL_SCRIPT === script) process.exit(17);
if (script === 'build') fs.writeFileSync('build-output', 'plugin bundle');
`);
  const interpolate = value => value.replaceAll('${{ inputs.build-root }}', buildRoot);
  return {
    root,
    run(env = {}) {
      const executed = [];
      // Execute the actual composite shell steps with GitHub's bash failure
      // semantics. Dependency installation and every npm script use real npm.
      for (const step of action.runs.steps.filter(step => step.run)) {
        const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.run], {
          cwd: path.resolve(workspace, interpolate(step['working-directory'])),
          env: { ...process.env, ...env, ...step.env }, encoding: 'utf8',
        });
        executed.push(step.name);
        if (result.status !== 0) return { ...result, executed };
      }
      return { status: 0, executed };
    },
    checks() {
      const file = path.join(root, 'checks.jsonl');
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse) : [];
    },
  };
}

test('Headlamp test action configures Node and the selected plugin lockfile cache', () => {
  assert.equal(action.inputs['build-root'].default, 'headlamp/');
  assert.equal(action.inputs['node-version'].default, '24');
  const setup = action.runs.steps.find(step => step.uses?.startsWith('actions/setup-node@'));
  assert.equal(setup.with['node-version'], '${{ inputs.node-version }}');
  assert.equal(setup.with.cache, 'npm');
  assert.equal(setup.with['cache-dependency-path'], '${{ inputs.build-root }}/package-lock.json');
  assert.ok(action.runs.steps.every(step => !step['continue-on-error'] && !step.if));
});

for (const root of [undefined, '.', 'plugins/plugin with spaces']) {
  test(`Headlamp checks pass in ${root || 'the default headlamp/ directory'}`, t => {
    const f = fixture(t, root);
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    const checks = f.checks();
    assert.deepEqual(checks.map(check => check.script), scripts);
    assert.deepEqual(checks.find(check => check.script === 'format').args, ['--check']);
    assert.equal(checks.find(check => check.script === 'test').ci, 'true');
    assert.equal(fs.readFileSync(path.join(f.root, 'build-output'), 'utf8'), 'plugin bundle');
  });
}

for (const failed of scripts) {
  test(`a failed ${failed} check fails the action and stops later steps`, t => {
    const f = fixture(t);
    const result = f.run({ FAIL_SCRIPT: failed });
    assert.notEqual(result.status, 0);
    assert.deepEqual(f.checks().map(check => check.script), scripts.slice(0, scripts.indexOf(failed) + 1));
    assert.equal(fs.existsSync(path.join(f.root, 'build-output')), false);
  });
}

test('missing lockfile fails dependency installation before any checks', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.root, 'package-lock.json'));
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.executed, ['Install dependencies']);
  assert.deepEqual(f.checks(), []);
});

test('a missing typecheck script is an error rather than a skipped check', t => {
  const f = fixture(t);
  const filename = path.join(f.root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(filename, 'utf8'));
  delete pkg.scripts.tsc;
  fs.writeFileSync(filename, JSON.stringify(pkg));
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing script: "tsc"/);
  assert.deepEqual(f.checks().map(check => check.script), ['lint', 'format']);
});
