#!/usr/bin/env bash
# Adapted from peak-scale/github-actions; see ../UPSTREAM.md (Apache-2.0).
set -euo pipefail

[[ "$CHART_NAME" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]] || { echo 'Invalid chart name' >&2; exit 1; }
[[ "$REGISTRY" =~ ^[a-zA-Z0-9][a-zA-Z0-9.:-]*$ ]] || { echo 'Invalid registry host' >&2; exit 1; }
[[ "$REPOSITORY" =~ ^[a-z0-9][a-z0-9._/-]*$ ]] || { echo 'Invalid repository path' >&2; exit 1; }
[[ "$SIGN_IMAGE" == true || "$SIGN_IMAGE" == false ]] || exit 1
[[ "$UPDATE_DEPENDENCIES" == true || "$UPDATE_DEPENDENCIES" == false ]] || exit 1

chart_path="${CHART_PATH:-charts/$CHART_NAME}"
publish_dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/helm-oci-chart.XXXXXX")"
trap 'rm -rf "$publish_dir"' EXIT
# Helm and Cosign both read Docker-compatible registry credentials. Isolate them
# from the caller's credentials and remove them on success and failure.
export HELM_REGISTRY_CONFIG="$publish_dir/config.json"
export DOCKER_CONFIG="$publish_dir"
printf '%s' "$REGISTRY_PASSWORD" | helm registry login "$REGISTRY" --username "$REGISTRY_USERNAME" --password-stdin
unset REGISTRY_PASSWORD

if [[ "$UPDATE_DEPENDENCIES" == true ]]; then
  helm dependency update "$chart_path"
fi
args=(package "$chart_path" --destination "$publish_dir")
if [[ -n "$CHART_VERSION" ]]; then args+=(--version "$CHART_VERSION"); fi
if [[ -n "$APP_VERSION" ]]; then args+=(--app-version "$APP_VERSION"); fi
helm "${args[@]}"
shopt -s nullglob
archives=("$publish_dir"/*.tgz)
[[ ${#archives[@]} == 1 ]] || { echo 'Expected exactly one chart archive' >&2; exit 1; }
filename="${archives[0]##*/}"
actual_name="$(helm show chart "${archives[0]}" | sed -n 's/^name: *//p')"
actual_name="${actual_name#\"}"; actual_name="${actual_name%\"}"
actual_name="${actual_name#\'}"; actual_name="${actual_name%\'}"
[[ "$actual_name" == "$CHART_NAME" ]] || { echo 'Chart name does not match input name' >&2; exit 1; }
[[ "$filename" == "$CHART_NAME-"*.tgz ]] || { echo 'Chart name does not match input name' >&2; exit 1; }
version="${filename#"$CHART_NAME-"}"
version="${version%.tgz}"

helm push "${archives[0]}" "oci://$REGISTRY/$REPOSITORY" 2>&1 | tee "$publish_dir/push.log"
digest="$(sed -n 's/^Digest: //p' "$publish_dir/push.log" | tr -d '\r')"
[[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'Missing or invalid chart digest' >&2; exit 1; }
image="$REGISTRY/$REPOSITORY/$CHART_NAME:${version//+/_}"
printf 'image=%s\ndigest=%s\n' "$image" "$digest" >> "$GITHUB_OUTPUT"

if [[ "$SIGN_IMAGE" == true ]]; then
  cosign sign --yes -a "repo=$GITHUB_REPOSITORY" -a "workflow=$GITHUB_WORKFLOW" -a "ref=$GITHUB_SHA" "$image@$digest"
fi
