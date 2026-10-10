# Test a Headlamp plugin

Installs the plugin's locked npm dependencies, including development dependencies,
then runs lint, formatting checks, type checks, tests, and a production build.
Every check must pass. Missing scripts and failed checks fail the action.

## Workflow template

Place this workflow in the plugin repository's `.github/workflows/headlamp-test.yaml`:

```yaml
name: Test Headlamp plugin

on:
  pull_request:
  push:
    branches: [main]
    tags: ['v*']

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0
        with:
          persist-credentials: false
      - uses: projectcapsule/github-actions/headlamp-test@main
        with:
          build-root: headlamp/
          node-version: '24'
```

Pin the shared action to a reviewed commit SHA in production. Set `build-root: .`
for plugins at the repository root, including `projectcapsule/headlamp-plugin`.
Release jobs can use `needs: test` before invoking
[headlamp-publish](../headlamp-publish/README.md) with the same build root and Node
version.

## Inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `build-root` | `headlamp/` | Plugin directory relative to the caller's checked-out repository. |
| `node-version` | `24` | Node.js version compatible with the plugin's toolchain. |

Check out the source before calling this action. The selected directory must
contain `package.json` and a compatible `package-lock.json`. The npm cache uses
that lockfile. The plugin must define these npm scripts:

| Script | Invocation |
| --- | --- |
| `lint` | `npm run lint` |
| `format` | `npm run format -- --check` |
| `tsc` | `npm run tsc` |
| `test` | `npm test` with `CI=true` |
| `build` | `npm run build` |

Configure `format` to support `--check` and `test` to finish in CI mode. The action
executes the repository's scripts, so projects can supply their own build setup,
such as Vite. Build output remains available to subsequent steps in the same job.
The action needs only `contents: read`; it has no publication step or outputs.
