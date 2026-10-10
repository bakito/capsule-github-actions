# Publish a ko image through make

Runs the caller's Make target, generates a CycloneDX SBOM, uploads it as a workflow
artifact, attaches it to the image, and optionally signs the image. Check out the
source and install Go, ko (or let the Makefile install it), and Cosign first.
Cosign is required even when image signing is disabled, because SBOM attachment
is always performed. This action does not perform vulnerability scanning or
generate provenance; add those steps separately if needed.

```yaml
- uses: projectcapsule/github-actions/make-ko-publish@main
  id: image
  with:
    makefile-target: ko-publish
    registry: ghcr.io
    registry-username: ${{ github.actor }}
    registry-password: ${{ secrets.GITHUB_TOKEN }}
    repository: projectcapsule/example
    version: ${{ github.ref_name }}
    sign-image: 'true'
    sbom-name: example
    sbom-repository: ghcr.io/projectcapsule/sbom
    signature-repository: ghcr.io/projectcapsule/signatures
    main-path: ./cmd/controller
```

For GHCR, the job needs `contents: read` and `packages: write`, plus
`id-token: write` for keyless signing. The caller's Make target must authenticate
to the registry and leave credentials available to Cosign, normally through
`DOCKER_CONFIG`. Use password-stdin in the Makefile and avoid echoing credentials.

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

Makefile variables should use `?=` to respect these supplied values. The single
target must print exactly one immutable image reference to stdout, such as
`ghcr.io/projectcapsule/example@sha256:<64 hex digits>`. Send build progress to
stderr; extra stdout is rejected before signing or attaching an SBOM. Use a
single make target name, not shell commands or make flags.

`version-required` defaults to `true`; set it to `'false'` to allow an empty
version. Nonempty versions must be valid image tags. `sign-image` defaults to
`false`. `signature-repository` is optional and otherwise uses Cosign's default
repository. `sbom-name` is a filename base, not a path.

The imported CycloneDX installer selects the latest compatible `v1` generator
version. The external action itself is pinned by commit. See
[action.yaml](action.yaml) for all inputs.

Outputs: `digest` contains `sha256:...`; `image` contains the complete immutable
reference. See [UPSTREAM.md](../UPSTREAM.md) for attribution and import details.
