#!/usr/bin/env bash
# Adapted from peak-scale/github-actions (Apache-2.0).
set -euo pipefail

[[ "$TASKFILE_TARGET" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_./:-]*$ ]] || { echo 'Expected a single Task target' >&2; exit 1; }
[[ "$REGISTRY" =~ ^[a-zA-Z0-9][a-zA-Z0-9.:-]*$ ]] || { echo 'Invalid registry host' >&2; exit 1; }
[[ "$REPO" =~ ^[a-z0-9][a-z0-9._/-]*$ ]] || { echo 'Invalid repository path' >&2; exit 1; }
[[ "$SBOM_NAME" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]] || { echo 'Invalid SBOM name' >&2; exit 1; }
[[ "$SIGN_IMAGE" == true || "$SIGN_IMAGE" == false ]] || exit 1
[[ "$VERSION_REQUIRED" == true || "$VERSION_REQUIRED" == false ]] || exit 1
if [[ "$VERSION_REQUIRED" == true && -z "$VERSION" ]]; then
  echo 'Version is required' >&2
  exit 1
fi
if [[ -n "$VERSION" && ! "$VERSION" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$ ]]; then
  echo 'Version must be a valid image tag' >&2
  exit 1
fi

image="$(task --silent --output=interleaved "$TASKFILE_TARGET")"
# ko prints one immutable reference. Refuse to propagate build logs or malformed
# output into GitHub's output file or into subsequent signing commands.
if [[ ! "$image" =~ ^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$ ]]; then
  echo 'Task target must print exactly one image@sha256:digest reference; send logs to stderr' >&2
  exit 1
fi
printf 'image=%s\ndigest=%s\n' "$image" "${image##*@}" >> "$GITHUB_OUTPUT"
