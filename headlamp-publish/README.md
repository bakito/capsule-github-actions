# Publish a Headlamp plugin

Builds a plugin with `npm ci`, `npm run build`, and `npm run package`; uploads its
`.tar.gz` archive to a GitHub release; and writes Artifact Hub metadata to
`<package-name>/<version>/` on the selected branch. The build directory defaults
to `headlamp/`. Container-image building, signing, and attestations can follow as
separate steps in the caller's workflow.

When GoReleaser or another release tool already packages, signs, and uploads the
plugin, pass its archive through `archive` to publish only the Artifact Hub
metadata. The action verifies the released archive's checksum without rebuilding
the plugin, changing source package files, or creating or uploading release assets.

```yaml
name: Publish Headlamp plugin
on:
  push:
    tags: ['v*']
permissions:
  contents: read
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    # Serialize every workflow that writes to this branch, across all tags.
    concurrency:
      group: artifacthub-publication
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0
        with:
          persist-credentials: false
      - uses: projectcapsule/github-actions/headlamp-publish@main
        id: plugin
        with:
          target-branch: artifacthub
          build-root: headlamp/
```

For the existing `projectcapsule/headlamp-plugin` repository, set `build-root: .`.
Its `capsule/package.template` on the `artifacthub` branch is supported directly.
To publish elsewhere, set e.g. `target-branch: catalog/headlamp`. The target is a
branch in the caller's repository; the source checkout remains on its original
commit. Only the plugin's package/lockfile versions and build outputs are modified
in the source checkout, without committing them.

## Inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `build-root` | `headlamp/` | Plugin path relative to `GITHUB_WORKSPACE`; `.` builds at the repository root. |
| `archive` | empty | Prebuilt `.tar.gz` path or glob relative to `GITHUB_WORKSPACE`; must match exactly one file already attached to the published release. Skips plugin installation, version changes, building, packaging, and release uploads. |
| `target-branch` | `artifacthub` | Branch to update or create for metadata. |
| `tag` | `github.ref_name` | Existing tag matching the checked-out commit; exact SemVer with optional `v`, including prereleases, without `+` build metadata. |
| `package-name` | `package.json` name | Artifact Hub package name and directory; lowercase letters, digits, and hyphens. Override this for scoped npm names. |
| `metadata-template` | automatic | Optional YAML template path relative to `build-root`. |
| `node-version` | `24` | Node.js version, at least 24. |
| `token` | `github.token` | Token with `contents: write` in the caller repository. |

Requires an Ubuntu runner, a checked-out repository, and `package.json`.
Without `archive`, also requires a compatible
`package-lock.json` and working `build` and `package` npm scripts. Packaging must
produce exactly one nonempty `.tar.gz` directly in `build-root`, which must not
already contain archives. Run the plugin's own lint and test checks before this
action. The action executes the plugin's trusted npm scripts.

## Combining with GoReleaser

Include the plugin archive in GoReleaser's archives, checksums, SBOMs, and Cosign
signing. Publish all assets together before the release becomes immutable, then
invoke this action with the exact archive that GoReleaser uploaded:

```yaml
- name: Publish release artifacts
  run: devbox run -- task release
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
- uses: projectcapsule/github-actions/headlamp-publish@main
  with:
    build-root: headlamp/
    archive: dist/resource-permits-*.tar.gz
    target-branch: headlamp-plugin
    metadata-template: artifacthub-pkg.yml
```

Pin a reviewed action commit SHA in production. Run this only after the release
tool succeeds, in the same tag-only job with `contents: write`. Keep pull-request
checks in a separate read-only workflow.

The glob must identify one nonempty archive within the source checkout. Symlinks
and paths escaping the checkout are rejected. Existing releases and assets must
already exist and match the local SHA-256. A missing release, missing asset, or
checksum mismatch fails before publishing metadata. Cosign bundles remain owned
by the release tool; this action leaves all release assets intact.

## Metadata and first publication

Templates are selected in this order:

1. Explicit `metadata-template`, relative to `build-root`.
2. `artifacthub-pkg.yml` in `build-root`.
3. `<package-name>/package.template` on `target-branch`.
4. `package.template` at the target branch root.
5. The highest semantic version's `<package-name>/<version>/artifacthub-pkg.yml`.

The template's `name` must match `package-name`. For a new branch, place a template
in the plugin directory, for example:

```yaml
name: capsule
displayName: Capsule
description: Capsule plugin for Headlamp
version: 0.0.0
annotations:
  headlamp/plugin/version-compat: '>=0.24'
  headlamp/plugin/distro-compat: 'in-cluster,web,desktop'
```

The action sets `version`, `createdAt`, `headlamp/plugin/archive-url`, and
`headlamp/plugin/archive-checksum` while preserving the other template fields.
The checksum is formatted as `sha256:<hex>`. A plugin-local `README.md` is copied
next to the package metadata. A plugin-local `artifacthub-repo.yml` is copied to
the branch root only if the branch does not already have one. Set up repository
ownership and register the target branch in Artifact Hub separately, following
the [Headlamp publishing guide](https://headlamp.dev/docs/latest/development/plugins/publishing/).

Existing versions, other packages, and branch-root files are preserved. If
migrating an older unversioned `artifacthub-pkg.yml`, remove that legacy entry
separately once the versioned layout is in place.

## Retries and concurrent publication

Metadata is validated and committed locally before the release is published.
The metadata branch is pushed only after the release archive exists. Missing tags,
tag/checkout mismatches, API failures, invalid metadata, and build failures stop
publication. Prerelease versions create GitHub prereleases.

A repeated release reuses an asset only when its SHA-256 matches, preserves the
metadata creation time, and avoids an empty commit. It never deletes or overwrites
an existing release asset. A different archive for an existing version requires
a new version; builds must produce identical archive bytes for a full retry.
The release and branch push are separate operations: if the push fails, the
already uploaded archive remains available for a retry.

Pushes use normal Git fast-forward checks. A concurrent branch update fails
without overwriting it; rerun after that writer completes. Use the same job
concurrency group for all publishers sharing the branch. Branch protections must
allow the supplied token to push. Tokens are supplied only to publishing steps,
and Git credentials are never persisted in a remote URL or Git configuration.

## Outputs

| Output | Meaning |
| --- | --- |
| `version` | Version without the `v` prefix. |
| `archive` | Absolute path to the local plugin archive, retained after publication. |
| `checksum` | Archive SHA-256 hex digest. |
| `archive-url` | GitHub release download URL. |
| `metadata-path` | Metadata path relative to the publication branch. |
| `commit` | Published metadata commit, including unchanged retries. |
