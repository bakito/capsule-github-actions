# Project Capsule GitHub Actions

Shared composite actions for plugin checks and release workflows. Use them from a
job after checking out the caller's repository. Publishing requires a trusted tag or manual release
workflow with the permissions listed by each action. Examples use `@main`; pin a
reviewed commit SHA in production.

| Action | Purpose |
| --- | --- |
| [headlamp-test](headlamp-test/README.md) | Lint, check formatting and types, test, and build a Headlamp plugin from a configurable directory. Includes a workflow template. |
| [headlamp-publish](headlamp-publish/README.md) | Build a Headlamp plugin or reuse an already published archive, then publish versioned Artifact Hub metadata to a configurable branch. |
| [helm-oci-chart](helm-oci-chart/README.md) | Package and push a Helm chart to an OCI registry, with optional signing. |
| [task-ko-publish](task-ko-publish/README.md) | Publish a ko image through a Task target, generate and attach a CycloneDX SBOM, and optionally sign it. |
| [exists](exists/README.md) | Return whether an input is nonempty. |

The ko action uses `task-ko-publish` and `taskfile-target`; callers migrating from
`make-ko-publish` / `makefile-target` must update both names and provide a Taskfile.
The other imported actions retain their input names. The imported actions originate
from [peak-scale/github-actions](https://github.com/peak-scale/github-actions). All code is licensed
under [Apache-2.0](LICENSE).

## Development

Use Node.js 24 or newer, npm, Git, Bash, actionlint 1.7.7, and ShellCheck:

```sh
npm ci --ignore-scripts
npm test
npm run lint
shellcheck helm-oci-chart/publish.sh task-ko-publish/publish.sh
# With Task installed (CI uses 3.53.1):
npm run test:task
# With Helm installed (CI uses 4.2.0):
npm run test:helm
```

`ACTIONLINT=/path/to/actionlint npm run lint` selects a local actionlint binary.
Lint checks both repository workflows and composite steps wrapped as reusable
workflows. Tests use real temporary Git repositories and npm fixtures, a mock
GitHub API, and stub registry tools; they never publish to GitHub or a registry.
`test:task` invokes real Taskfiles with namespaced targets and failure cases.
`test:helm` additionally uses real Helm packaging and inspection while stubbing
registry calls. CI also invokes the `exists` composite itself.

Keep input values in environment variables and quote their use in scripts. Pin
external actions to commit SHAs. Test failure paths and credential cleanup when
changing publishing behavior. Container publication is a separate workflow step;
the Headlamp action returns archive details for downstream consumers.
