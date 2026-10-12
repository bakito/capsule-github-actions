# Publish a ko image through Task

Runs the caller's Task target, generates a CycloneDX SBOM, uploads it as a workflow
artifact, attaches it to the image, and optionally signs the image. Check out the
source and install [Task](https://taskfile.dev), Go, ko, and Cosign first, for example
through the caller's Devbox environment. These tools must be available on `PATH`
for the composite action. Cosign is required even when signing is disabled, because
SBOM attachment is always performed. Add vulnerability scanning and provenance
steps separately if needed.

```yaml
- uses: projectcapsule/github-actions/task-ko-publish@main
  id: image
  with:
    taskfile-target: image:publish
    registry: ghcr.io
    registry-username: ${{ github.actor }}
    registry-password: ${{ secrets.GITHUB_TOKEN }}
    repository: projectcapsule/example
    version: ${{ github.ref_name }}
    sign-image: 'true'
    sbom-name: example
    sbom-repository: ghcr.io/projectcapsule/sbom
    signature-repository: ghcr.io/projectcapsule/signatures
    main-path: ./cmd
```

Pin a reviewed commit SHA in production. For GHCR, the job needs `contents: read`
and `packages: write`, plus `id-token: write` for keyless signing. The caller's
target must authenticate to the registry and leave credentials available to Cosign,
normally through `DOCKER_CONFIG`. Use password-stdin and avoid echoing credentials.

The action runs `task --silent --output=interleaved TARGET` in the caller's working
directory, using Task's normal Taskfile discovery. Namespaced targets such as
`image:publish` are supported. Pass one target name; shell commands, flags, variable
assignments, and wildcard target patterns are rejected.

The target receives these environment variables:

| Variable | Value |
| --- | --- |
| `REGISTRY` | `registry` |
| `REGISTRY_USERNAME` | `registry-username` |
| `REGISTRY_PASSWORD` | `registry-password` |
| `REPO` | `repository` |
| `REPOSITORY` | Caller's existing `REPOSITORY`, or `repository` when unset |
| `VERSION` | `version` |
| `COSIGN_REPOSITORY` | `sbom-repository` |

Use these environment variables directly or respect them when defining Taskfile
variables. For example:

```yaml
version: '3'
tasks:
  image:publish:
    cmds:
      - printf '%s' "$REGISTRY_PASSWORD" | ko login "$REGISTRY" --username "$REGISTRY_USERNAME" --password-stdin >&2
      - KO_DOCKER_REPO="$REGISTRY/$REPOSITORY" ko build ./cmd --bare --tags="$VERSION"
```

The target must print exactly one immutable image reference to stdout, such as
`ghcr.io/projectcapsule/example:1.2.3@sha256:<64 hex digits>`. Send build and login
progress to stderr; additional stdout is rejected before signing or attaching an
SBOM. Task command echoing is disabled by the action, but commands' own output
still follows this contract. A failed target fails the action without success
outputs, even if it printed an image reference before failing.

`version-required` defaults to `true`; set it to `'false'` to allow an empty
version. Nonempty versions must be valid image tags. `sign-image` defaults to
`false`. `signature-repository` is optional and otherwise uses Cosign's default
repository. `sbom-name` is a filename base, not a path.

The CycloneDX installer selects the latest compatible `v1` generator version.
The external action itself is pinned by commit. See [action.yaml](action.yaml)
for all inputs. Outputs: `digest` contains `sha256:...`; `image` contains the
complete immutable reference.

## Migration from Make

Replace the action path `make-ko-publish` with `task-ko-publish`, replace the input
`makefile-target` with `taskfile-target`, and convert the publishing target to a
Taskfile. The action no longer invokes Make or accepts the old input. Registry,
version, signing, SBOM inputs, and outputs retain their existing meanings. Callers
pinned to an older action commit keep that commit's behavior until they upgrade.

Originally adapted from the Apache-2.0-licensed
[peak-scale/github-actions](https://github.com/peak-scale/github-actions) ko action.
