#!/usr/bin/env bash
# Builds recorder.js: PostHog's rrweb fork (record side) with its console and
# network plugins, from third_party/posthog-rrweb, with esbuild in a pinned
# Docker image (docker/recorder-build). Same entry and exports as upstream's
# packages/browser/src/entrypoints/recorder.ts. It is written next to every
# SDK build that loads it:
#
#   dist/recorder.js         next to posthog.full.js
#   dist/chunks/recorder.js  next to the chunks
#   dist/lazy/recorder.js    next to the lazy build's chunks
#
# (each with its .map). Called by build.sh; can be run on its own.
#
# Env: RECORDER_IMAGE (default posthog-recorder-build:esbuild-0.25.12),
#      RECORDER_SRC (default third_party/posthog-rrweb/src; e.g.
#      third_party/posthog-rrweb/original for the unmodified fork),
#      RECORDER_OUT (build only this file instead of the three above),
#      RECORDER_FLAGS (e.g. --no-minify).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${RECORDER_IMAGE:-posthog-recorder-build:esbuild-0.25.12}"
SRC="${RECORDER_SRC:-third_party/posthog-rrweb/src}"
cd "$ROOT"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Building $IMAGE ..."
  docker build -t "$IMAGE" docker/recorder-build
fi

build() {
  mkdir -p "$(dirname "$1")"
  # shellcheck disable=SC2086
  docker run --rm -u "$(id -u):$(id -g)" -v "$ROOT:/work" "$IMAGE" \
    third_party/posthog-rrweb/build.mjs --root "$SRC" --out "$1" ${RECORDER_FLAGS:-}
  echo "-> $1"
}

if [ -n "${RECORDER_OUT:-}" ]; then
  build "$RECORDER_OUT"
else
  build dist/recorder.js
  build dist/chunks/recorder.js
  build dist/lazy/recorder.js
fi
