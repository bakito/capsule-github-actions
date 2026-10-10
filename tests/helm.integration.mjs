import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('real Helm packages and inspects the chart before registry publication', t => {
  const helm = spawnSync('which', ['helm'], { encoding: 'utf8' }).stdout.trim();
  assert.ok(helm, 'Install Helm before running npm run test:helm');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-integration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin'); fs.mkdirSync(bin);
  const chart = path.join(directory, 'charts/example'); fs.mkdirSync(chart, { recursive: true });
  fs.writeFileSync(path.join(chart, 'Chart.yaml'), 'apiVersion: v2\nname: example\nversion: 1.2.3+build\ndescription: Integration fixture\n');
  // Use the real Helm binary for local operations; only network publication is stubbed.
  fs.writeFileSync(path.join(bin, 'helm'), `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === 'registry') { fs.readFileSync(0); process.exit(0); }
if (args[0] === 'push') {
  if (!fs.statSync(args[1]).isFile()) process.exit(1);
  fs.appendFileSync(process.env.PUSH_LOG, args[1] + '\\n');
  console.log('Digest: sha256:' + 'a'.repeat(64));
  process.exit(0);
}
const child = require('child_process').spawnSync(process.env.REAL_HELM, args, {stdio:'inherit'});
process.exit(child.status ?? 1);
`, { mode: 0o755 });
  const outputs = path.join(directory, 'outputs');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, REAL_HELM: helm,
    PUSH_LOG: path.join(directory, 'pushes'), RUNNER_TEMP: directory, GITHUB_OUTPUT: outputs,
    CHART_NAME: 'example', CHART_PATH: '', CHART_VERSION: '', APP_VERSION: '',
    REGISTRY: 'registry.example.test', REPOSITORY: 'charts', REGISTRY_USERNAME: 'test',
    REGISTRY_PASSWORD: 'dummy', UPDATE_DEPENDENCIES: 'false', SIGN_IMAGE: 'false' };
  const script = path.resolve(import.meta.dirname, '../helm-oci-chart/publish.sh');
  const result = spawnSync('bash', [script], { cwd: directory, env, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(fs.readFileSync(outputs, 'utf8'), /image=registry.example.test\/charts\/example:1.2.3_build/);
  assert.equal(fs.readFileSync(env.PUSH_LOG, 'utf8').trim().split('\n').length, 1);
  const mismatched = spawnSync('bash', [script], { cwd: directory,
    env: { ...env, CHART_NAME: 'wrong-name', CHART_PATH: 'charts/example' }, encoding: 'utf8' });
  assert.notEqual(mismatched.status, 0);
  assert.match(mismatched.stderr, /Chart name does not match/);
  assert.equal(fs.readFileSync(env.PUSH_LOG, 'utf8').trim().split('\n').length, 1, 'Mismatch was not pushed');
});
