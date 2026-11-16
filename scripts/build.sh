#!/usr/bin/env bash
# Builds all bundles with Google Closure Compiler (ADVANCED) inside Docker.
#
#   dist/posthog.core.js        core only (no flags, no experiments)
#   dist/posthog.core-flags.js  core + feature flags
#   dist/posthog.full.js        core + feature flags + web experiments
#   dist/chunks/{core,flags,experiments,replay}.js
#                               the same code split into Closure chunks:
#                               load core.js, then optionally flags.js, then
#                               optionally experiments.js (any time later).
#                               replay.js (session replay) needs only core.js.
#
# Env: CLOSURE_IMAGE (default posthog-closure-compiler:v20261109),
#      EXTRA_FLAGS (appended to every compile, e.g. "--debug --formatting=PRETTY_PRINT").
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${CLOSURE_IMAGE:-posthog-closure-compiler:v20261109}"
cd "$ROOT"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Building $IMAGE ..."
  docker build -t "$IMAGE" docker/closure-compiler
fi

rm -rf dist && mkdir -p dist/chunks

closure() {
  docker run --rm -u "$(id -u):$(id -g)" -v "$ROOT:/work" "$IMAGE" \
    --compilation_level ADVANCED \
    --language_in ECMASCRIPT_2020 \
    --language_out ECMASCRIPT5 \
    --module_resolution BROWSER \
    --rewrite_polyfills=false \
    --warning_level VERBOSE \
    --jscomp_error checkTypes \
    --jscomp_error missingProperties \
    --jscomp_error strictMissingProperties \
    --jscomp_off lintChecks \
    --externs externs/browser.js \
    ${EXTRA_FLAGS:-} \
    "$@"
}

CORE_FILES=(
  src/core/utils.js src/core/constants.js src/core/logger.js src/core/uuid.js src/core/user-agent.js
  src/core/storage.js src/core/event-utils.js src/core/persistence.js src/core/session.js
  src/core/session-props.js src/core/scroll-manager.js src/core/page-view.js src/core/gzip.js
  src/core/request.js src/core/request-queue.js src/core/rate-limiter.js src/core/request-router.js
  src/core/consent.js src/core/script-loader.js src/core/remote-config.js src/core/history-autocapture.js
  src/core/extensions.js src/core/posthog.js src/entry/core.js
)
FLAGS_FILES=(src/flags/feature-flags.js src/flags/index.js)
EXPERIMENTS_FILES=(src/experiments/sanitizer.js src/experiments/web-experiments.js src/experiments/index.js)
# Session replay (needs only core; rrweb itself is loaded at runtime from /static/recorder.js).
REPLAY_FILES=(
  src/replay/constants.js src/replay/sampling.js src/replay/trigger-matching.js src/replay/recording-strategies.js
  src/replay/utils.js src/replay/gzip-field.js src/replay/json-ld.js src/replay/recorder.js
  src/replay/session-recording.js src/replay/index.js
)

WRAPPER='(function(){%output%}).call(this);'

bundle() { # name entry files...
  local name="$1" entry="$2"; shift 2
  local args=()
  for f in "$@"; do args+=(--js "$f"); done
  echo "-> dist/$name.js"
  closure "${args[@]}" \
    --dependency_mode PRUNE --entry_point "$entry" \
    --assume_function_wrapper --output_wrapper "$WRAPPER" \
    --create_source_map "dist/$name.js.map" \
    --js_output_file "dist/$name.js"
  echo "//# sourceMappingURL=$name.js.map" >> "dist/$name.js"
}

bundle posthog.core src/entry/core.js "${CORE_FILES[@]}"
bundle posthog.core-flags src/entry/core-flags.js "${CORE_FILES[@]}" "${FLAGS_FILES[@]}" src/entry/core-flags.js
bundle posthog.full src/entry/full.js "${CORE_FILES[@]}" "${FLAGS_FILES[@]}" "${EXPERIMENTS_FILES[@]}" "${REPLAY_FILES[@]}" src/entry/full.js

# Chunked build. Chunks share renamed symbols through the global `__phc`
# namespace object, so later chunks can be loaded on demand.
CHUNK_WRAPPER='(function(){%s}).call(this);'
echo "-> dist/chunks/{core,flags,experiments,replay}.js"
args=()
for f in "${CORE_FILES[@]}" "${FLAGS_FILES[@]}" "${EXPERIMENTS_FILES[@]}" "${REPLAY_FILES[@]}"; do args+=(--js "$f"); done
closure "${args[@]}" \
  --rename_prefix_namespace __phc \
  --chunk "core:${#CORE_FILES[@]}" \
  --chunk "flags:${#FLAGS_FILES[@]}:core" \
  --chunk "experiments:${#EXPERIMENTS_FILES[@]}:flags" \
  --chunk "replay:${#REPLAY_FILES[@]}:core" \
  --chunk_wrapper "core:var __phc=window.__phc=window.__phc||{};${CHUNK_WRAPPER}" \
  --chunk_wrapper "flags:${CHUNK_WRAPPER}" \
  --chunk_wrapper "experiments:${CHUNK_WRAPPER}" \
  --chunk_wrapper "replay:${CHUNK_WRAPPER}" \
  --chunk_output_path_prefix dist/chunks/

echo
ls -l dist dist/chunks | grep '\.js$' | awk '{printf "%8d  %s\n", $5, $NF}'
echo
echo "gzip sizes:"
for f in dist/*.js dist/chunks/*.js; do printf "%8d  %s\n" "$(gzip -9c "$f" | wc -c)" "$f"; done
