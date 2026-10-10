# Helm OCI chart

Install Helm (OCI-capable, 3.8 or newer) and check out the source before calling
this action. Install Cosign and grant `id-token: write` if enabling keyless
signing. The registry token needs permission to push the chart and any signatures.

```yaml
- uses: projectcapsule/github-actions/helm-oci-chart@main
  id: chart
  with:
    name: capsule
    registry: ghcr.io
    repository: projectcapsule/charts
    registry-username: ${{ github.actor }}
    registry-password: ${{ secrets.GITHUB_TOKEN }}
    # Optional: path defaults to charts/capsule.
    path: charts/capsule
    # Optional: otherwise Chart.yaml supplies both versions.
    version: 1.0.0
    app-version: v1.0.0
    update-dependencies: 'false'
    sign-image: 'true'
    signature-repository: ghcr.io/projectcapsule/signatures
```

For GHCR, grant the job `contents: read` and `packages: write`. Outputs are
`image` (the actual chart reference and packaged version) and `digest`
(`sha256:...`). Helm's SemVer `+` build metadata is represented as `_` in the OCI
tag. `name` must match the chart's name. The temporary packaging directory avoids
reusing stale archives; isolated registry credentials are deleted on both success
and failure. Neither Helm nor Cosign is installed by this action.

See [action.yaml](action.yaml) for all input descriptions and
[UPSTREAM.md](../UPSTREAM.md) for attribution.
