# Check whether an input exists

Returns the string `true` when `value` is nonempty and `false` otherwise. Whitespace
and the literal string `false` are nonempty values.

```yaml
- uses: projectcapsule/github-actions/exists@main
  id: token
  with:
    value: ${{ secrets.RELEASE_TOKEN }}
- if: steps.token.outputs.result == 'true'
  run: echo 'A release token is configured'
```

The value itself is never printed. See [UPSTREAM.md](../UPSTREAM.md) for attribution.
