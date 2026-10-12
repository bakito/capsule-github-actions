import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const root = path.resolve(import.meta.dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'actions-lint-'));
try {
  const workflows = fs.readdirSync(path.join(root, '.github/workflows'))
    .filter(file => /\.ya?ml$/.test(file)).map(file => path.join(root, '.github/workflows', file));
  // actionlint validates workflows rather than composite action manifests.
  // Wrap each composite's actual steps and outputs in a reusable workflow so
  // expressions, inputs, step references, and inline shell are also checked.
  for (const name of ['exists', 'helm-oci-chart', 'task-ko-publish', 'headlamp-publish', 'headlamp-test']) {
    const action = YAML.parse(fs.readFileSync(path.join(root, name, 'action.yaml'), 'utf8'));
    const inputs = Object.fromEntries(Object.entries(action.inputs).map(([key, value]) =>
      [key, { type: 'string', description: value.description, required: false }]));
    const outputs = Object.fromEntries(Object.entries(action.outputs || {}).map(([key, value]) => [key, value.value]));
    const workflow = { name, on: { workflow_call: { inputs } }, jobs: {
      validate: { 'runs-on': 'ubuntu-latest', ...(Object.keys(outputs).length ? { outputs } : {}), steps: action.runs.steps },
    } };
    const filename = path.join(temporary, `${name}.yaml`);
    fs.writeFileSync(filename, YAML.stringify(workflow));
    workflows.push(filename);
  }
  const result = spawnSync(process.env.ACTIONLINT || 'actionlint', workflows, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status || 1;
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
