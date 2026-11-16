#!/usr/bin/env bash
# Builds all bundles with Google Closure Compiler (ADVANCED) inside Docker.
#
#   dist/posthog.core.js        core only (no flags, no experiments)
#   dist/posthog.core-flags.js  core + feature flags
#   dist/posthog.full.js        core + feature flags + web experiments
#                               + autocapture, dead clicks, heatmaps
#   dist/chunks/{core,flags,experiments}.js
#                               the same code split into Closure chunks:
#                               load core.js, then optionally flags.js, then
#                               optionally experiments.js (any time later).
#   dist/chunks/exceptions.js   exception capture + autocapture (needs core only);
#                               also part of posthog.full.js.
#   dist/chunks/{dom,autocapture,deadclicks,heatmaps}.js
#                               dom.js (shared DOM helpers, needs core), then
#                               autocapture.js and/or deadclicks.js; heatmaps.js
#                               needs deadclicks.js.
#   dist/chunks/replay.js        session replay (needs only core.js); also part of
#                               posthog.full.js. rrweb is loaded at runtime.
#   dist/chunks/{otlp,logs,metrics,toolbar}.js
#                               opt-in modules: otlp.js (shared OTLP helpers, needs
#                               core), then logs.js and/or metrics.js; toolbar.js
#                               (the toolbar loader) needs only core. All are also
#                               part of posthog.full.js.
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
  src/core/rageclick.js src/core/extensions.js src/core/posthog.js src/entry/core.js
)
FLAGS_FILES=(src/flags/feature-flags.js src/flags/index.js)
EXPERIMENTS_FILES=(src/experiments/sanitizer.js src/experiments/web-experiments.js src/experiments/index.js)
EXCEPTIONS_FILES=(src/exceptions/stack-parser.js src/exceptions/error-tracking.js src/exceptions/bucketed-rate-limiter.js
  src/exceptions/exceptions.js src/exceptions/autocapture.js src/exceptions/index.js)
# Autocapture, dead clicks and heatmaps share the DOM helpers in src/dom/.
DOM_FILES=(src/dom/autocapture-utils.js)
AUTOCAPTURE_FILES=(src/autocapture/autocapture.js src/autocapture/index.js)
DEADCLICKS_FILES=(src/dead-clicks/dead-clicks.js src/dead-clicks/index.js)
HEATMAPS_FILES=(src/heatmaps/heatmaps.js src/heatmaps/index.js)
DOM_MODULE_FILES=("${DOM_FILES[@]}" "${AUTOCAPTURE_FILES[@]}" "${DEADCLICKS_FILES[@]}" "${HEATMAPS_FILES[@]}")
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

# Logs and metrics share the OTLP helpers in src/otlp/; the toolbar loader needs only core.
OTLP_FILES=(src/otlp/otlp.js)
LOGS_FILES=(src/logs/logs-core.js src/logs/console-logs.js src/logs/logs.js src/logs/index.js)
METRICS_FILES=(src/metrics/metrics-core.js src/metrics/network-metrics.js src/metrics/metrics.js src/metrics/index.js)
TOOLBAR_FILES=(src/toolbar/toolbar.js src/toolbar/index.js)
OPT_IN_FILES=("${OTLP_FILES[@]}" "${LOGS_FILES[@]}" "${METRICS_FILES[@]}" "${TOOLBAR_FILES[@]}")

bundle posthog.core src/entry/core.js "${CORE_FILES[@]}"
bundle posthog.core-flags src/entry/core-flags.js "${CORE_FILES[@]}" "${FLAGS_FILES[@]}" src/entry/core-flags.js
bundle posthog.full src/entry/full.js "${CORE_FILES[@]}" "${FLAGS_FILES[@]}" "${EXPERIMENTS_FILES[@]}" \
  "${EXCEPTIONS_FILES[@]}" "${DOM_MODULE_FILES[@]}" "${REPLAY_FILES[@]}" "${OPT_IN_FILES[@]}" src/entry/full.js

# Chunked build. Chunks share renamed symbols through the global `__phc`
# namespace object, so later chunks can be loaded on demand.
CHUNK_WRAPPER='(function(){%s}).call(this);'
echo "-> dist/chunks/{core,flags,experiments,exceptions,dom,autocapture,deadclicks,heatmaps,replay,otlp,logs,metrics,toolbar}.js"
args=()
for f in "${CORE_FILES[@]}" "${FLAGS_FILES[@]}" "${EXPERIMENTS_FILES[@]}" "${EXCEPTIONS_FILES[@]}" "${DOM_MODULE_FILES[@]}" "${REPLAY_FILES[@]}" "${OPT_IN_FILES[@]}"; do args+=(--js "$f"); done
closure "${args[@]}" \
  --rename_prefix_namespace __phc \
  --chunk "core:${#CORE_FILES[@]}" \
  --chunk "flags:${#FLAGS_FILES[@]}:core" \
  --chunk "experiments:${#EXPERIMENTS_FILES[@]}:flags" \
  --chunk "exceptions:${#EXCEPTIONS_FILES[@]}:core" \
  --chunk_wrapper "core:var __phc=window.__phc=window.__phc||{};${CHUNK_WRAPPER}" \
  --chunk_wrapper "flags:${CHUNK_WRAPPER}" \
  --chunk_wrapper "experiments:${CHUNK_WRAPPER}" \
  --chunk_wrapper "exceptions:${CHUNK_WRAPPER}" \
  --chunk "dom:${#DOM_FILES[@]}:core" \
  --chunk "autocapture:${#AUTOCAPTURE_FILES[@]}:dom" \
  --chunk "deadclicks:${#DEADCLICKS_FILES[@]}:dom" \
  --chunk "heatmaps:${#HEATMAPS_FILES[@]}:deadclicks" \
  --chunk_wrapper "dom:${CHUNK_WRAPPER}" \
  --chunk_wrapper "autocapture:${CHUNK_WRAPPER}" \
  --chunk_wrapper "deadclicks:${CHUNK_WRAPPER}" \
  --chunk_wrapper "heatmaps:${CHUNK_WRAPPER}" \
  --chunk "replay:${#REPLAY_FILES[@]}:core" \
  --chunk_wrapper "replay:${CHUNK_WRAPPER}" \
  --chunk "otlp:${#OTLP_FILES[@]}:core" \
  --chunk "logs:${#LOGS_FILES[@]}:otlp" \
  --chunk "metrics:${#METRICS_FILES[@]}:otlp" \
  --chunk "toolbar:${#TOOLBAR_FILES[@]}:core" \
  --chunk_wrapper "otlp:${CHUNK_WRAPPER}" \
  --chunk_wrapper "logs:${CHUNK_WRAPPER}" \
  --chunk_wrapper "metrics:${CHUNK_WRAPPER}" \
  --chunk_wrapper "toolbar:${CHUNK_WRAPPER}" \
  --chunk_output_path_prefix dist/chunks/

echo
ls -l dist dist/chunks | grep '\.js$' | awk '{printf "%8d  %s\n", $5, $NF}'
echo
echo "gzip sizes:"
for f in dist/*.js dist/chunks/*.js; do printf "%8d  %s\n" "$(gzip -9c "$f" | wc -c)" "$f"; done
