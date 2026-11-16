# posthog-js (Closure edition)

A rewrite of the [PostHog browser SDK](https://github.com/PostHog/posthog-js) in
plain, JSDoc-typed ES2020 JavaScript. It compiles cleanly with Google Closure
Compiler in **ADVANCED** mode with strict type checks, and outputs ES5.

It speaks the same wire protocol and uses the same storage format as upstream
(`/e/` batch endpoint, `/flags/?v=2`, the `ph_<token>_posthog` persistence key,
`$sesid`, `$device_id`, ...). A visitor keeps the same distinct_id and session
when a site switches between this SDK and upstream.

It is a faithful port of upstream posthog-js **1.450.0** for the core, feature
flags, web experiments, exception capture, autocapture (with rageclicks), heatmaps, dead clicks, session replay,
web vitals, tracing headers, logs, metrics and the toolbar loader. `test/diff` runs the same scenarios against the
official bundle and this SDK in headless Chrome and diffs the traffic; all
scenarios are identical (see [Test](#test)). See [Scope](#scope) for what is
not ported yet.

Two main builds: `posthog.full.js` has everything compiled in, and
`lazy/posthog.js` is split exactly like upstream's `array.js`, loading each
lazy part from `lazy/<kind>.js` where upstream loads `/static/<kind>.js` (see
[The lazy build](#the-lazy-build)).

## Size and performance vs the official SDK

Measured against official posthog-js 1.450.0 on the same page in headless
Chrome with 4x CPU throttling (roughly a mid-range phone), medians of 7 runs
(`./scripts/build.sh && node test/diff/bench.mjs`), on the `lazy-build` branch.
Absolute times vary with machine load; the ratios were stable across runs.

### Like for like: `lazy/posthog.js` vs `array.js`

Upstream's CDN `array.js` is the core plus every extension's *shell*; the
heavy parts are lazy-loaded from `/static/<kind>.js` when a feature turns on.
Our lazy build (`lazy/posthog.js`) is split at exactly the same points and
loads its parts from `lazy/<kind>.js` at the same moments (see
[The lazy build](#the-lazy-build)), so the two compare like for like. Sizes
are gzip -9; "downloaded" is every SDK script the page loaded.

| | official `array.js` | ours `lazy/posthog.js` |
|---|---|---|
| Main script | `array.js` 122.4 KB (372 KB raw) | `posthog.js` 82.4 KB (231 KB raw), ~0.67x |
| Downloaded at startup, default setup | 171 KB: `array.js` + `surveys.js` 48.7 (fetched even with surveys off; not ported here) | 82.4 KB, ~0.48x (0.67x without `surveys.js`) |
| Downloaded with session replay on | 244 KB: + `lazy-recorder.js` 72.5 | 151 KB: + `replay.js` 21.2 + PostHog's `recorder.js` 46.5, ~0.62x |
| Downloaded with replay, exceptions, dead clicks, web vitals, tracing headers and console logs on | 272 KB: + `web-vitals-with-attribution.js` 7.0, `exception-autocapture.js` 6.5, `dead-clicks-autocapture.js` 8.5, `logs.js` 2.8, `tracing-headers.js` 2.6 | 165 KB: + `web-vitals.js` 5.9, `exception-autocapture.js` 0.9, `dead-clicks-autocapture.js` 3.9, `logs.js` 1.6, `tracing-headers.js` 2.2, ~0.61x |
| Script download + parse + eval (default setup) | 36.8 ms (1x) | 21.5 ms (~0.58x) |
| `posthog.init()` (default / everything on) | 26.0 / 30.8 ms | 16.5 / 20.7 ms (~0.65x) |
| 1000 `capture()` calls (incl. client rate limiting) | 495-580 ms | 269-297 ms (~0.5x) |
| Long tasks during the test | 1 (540-626 ms) | 1 (293-327 ms) |

Without `surveys.js` (not ported), the like-for-like gaps are the main script
(82.4 vs 122.4 KB) and each lazy part (ours are smaller: e.g. our
`exception-autocapture.js` reuses the stack parser already in `posthog.js`,
where upstream's bundles its own copy; `replay.js` + `recorder.js` is 67.7 KB
vs `lazy-recorder.js` 72.5 KB). Our lazy build makes the same number of
requests as upstream minus `surveys.js`, plus one: replay loads two scripts
(our `replay.js` and PostHog's `recorder.js`, in parallel) where upstream
loads `lazy-recorder.js`.

### Other builds

| | official | ours |
|---|---|---|
| Core only | `module.slim` 54.0 KB (npm build) | `posthog.core.js` 35.4 KB |
| Everything in one main script | `array.full.js` 231 KB (also includes surveys; still lazy-loads some parts) | `posthog.full.js` 111.3 KB; only `recorder.js` (46.5) is downloaded, when replay is on |

| default setup | load + eval | `init()` | 1000 captures | downloaded |
|---|---|---|---|---|
| official `array.js` | 36.8 ms | 26.0 ms | 495 ms | 171 KB |
| ours `posthog.full.js` | 23.1 ms | 17.1 ms | 282 ms | 111 KB (158 KB with replay or everything on) |
| ours `lazy/posthog.js` | 21.5 ms | 16.5 ms | 269 ms | 82 KB |
| ours `posthog.core.js` | 17.7 ms | 11.8 ms | 269 ms | 35 KB |

Surveys, product tours and conversations are not ported, so part of
upstream's size has no counterpart here. Per-module chunk sizes are in the
Build section; core + flags alone is about 44 KB.

Other differences besides size and speed:

- **Requests.** Upstream lazy-loads `surveys.js` on every page (even with
  surveys off in the project); we have no surveys module. `posthog.full.js`
  compiles every lazy part in, loading only PostHog's rrweb fork
  (`recorder.js`); the lazy build loads its parts where upstream loads its
  `/static/` scripts (with replay as two scripts, see above).
- **Compiled in vs lazy-loaded.** In `posthog.full.js` and the chunks,
  exception autocapture's wrappers, dead clicks, web vitals, tracing headers
  and console capture start immediately rather than after a script load. The
  resulting traffic is the same (see the known differences); the lazy build
  starts them when upstream does.
- **Pick what you load.** Each module is also a Closure chunk; `posthog.core.js`
  plus only the chunks you need is smaller than any upstream CDN build.
- **Synchronous gzip** (beacons on unload, `send_instantly`, browsers without
  `CompressionStream`) uses our compact encoder instead of fflate: same decoded
  payload, somewhat larger request bodies.
- **Lazy assets are pinned.** PostHog CDN assets are requested for the upstream
  version we track (`UPSTREAM_VERSION`, currently 1.450.0), e.g.
  `/static/1.450.0/recorder.js`, never for our own version. The diff test fails
  if our SDK requests an asset path that doesn't exist on the CDN.
- **ES5 output with no injected polyfills.** Like upstream, we target old
  browsers; we use no ES2015+ built-ins at all rather than polyfilling them.

## Layout

```
src/core/          always loaded: init, capture, identity, persistence, sessions,
                   remote config, batching/retry/transport, consent, pageviews,
                   scroll tracking, rate limiting, extension registry, lazy part
                   registry (lazy.js) and the lazy build's chunk loader (lazy-chunks.js)
src/flags/         optional: feature flags (/flags/?v=2)
src/experiments/   optional: no-code web experiments (needs flags)
src/exceptions/    optional: exception capture + autocapture (posthog.exceptions,
                   posthog.exceptionObserver)
src/dom/           shared DOM helpers for the three modules below (element
                   properties, $elements_chain, sensitivity rules, ignorelists)
src/autocapture/   optional: $autocapture, $rageclick, $copy_autocapture (needs dom)
src/dead-clicks/   optional: $dead_click / $dead_swipe (needs dom)
src/heatmaps/      optional: $$heatmap (needs dom + dead-clicks)
src/replay/        optional: session replay (rrweb is loaded at runtime from /static/recorder.js)
src/web-vitals/    optional: $web_vitals (Google's web-vitals compiled in from third_party/)
src/tracing-headers/ optional: tracing headers / traceparent on the app's fetch and XHR
third_party/web-vitals/ Google web-vitals 6.2.1 (Apache-2.0), ported to JSDoc; see its README
src/otlp/          shared OTLP helpers for logs and metrics (attribute encoder, resource
                   attributes, flush timer, backoff, the console/fetch `patch` layer)
src/logs/          opt-in: posthog.captureLog / posthog.logger / posthog.logs and console
                   log capture, sent to /i/v1/logs as OTLP (needs otlp)
src/metrics/       opt-in: posthog.metrics (count, gauge, histogram, network metrics),
                   sent to /i/v1/metrics as OTLP (needs otlp)
src/toolbar/       opt-in: the toolbar loader (posthog.loadToolbar, posthog.toolbar)
src/entry/         bundle entry points (core, core-flags, full, lazy)
docker/closure-compiler/Dockerfile   Closure Compiler v20261109 (official Maven jar, JRE 21)
scripts/build.sh   builds every bundle in Docker
test/              Node harness (fake browser) + headless-Chrome smoke test
upstream/          shallow clone of PostHog/posthog-js, kept for reference only (git-ignored)
```

## Build

```sh
./scripts/build.sh        # builds the Docker image on first run
# EXTRA_FLAGS="--formatting=PRETTY_PRINT --debug" ./scripts/build.sh  # readable output
```

| Output | Contents | gzip |
|---|---|---|
| `dist/posthog.core.js` | core only | ~35.4 KB |
| `dist/posthog.core-flags.js` | core + feature flags | ~42.1 KB |
| `dist/posthog.full.js` | everything: all modules below | ~111.3 KB |
| `dist/chunks/core.js` | core chunk | ~36.9 KB |
| `dist/chunks/flags.js` | flags chunk (needs core) | ~7.4 KB |
| `dist/chunks/experiments.js` | experiments chunk (needs flags) | ~6.5 KB |
| `dist/chunks/exceptions.js` | exception capture chunk (needs core) | ~8.5 KB |
| `dist/chunks/dom.js` | shared DOM helpers (needs core) | ~3.9 KB |
| `dist/chunks/autocapture.js` | autocapture chunk (needs dom) | ~3.5 KB |
| `dist/chunks/deadclicks.js` | dead clicks chunk (needs dom) | ~4.5 KB |
| `dist/chunks/heatmaps.js` | heatmaps chunk (needs deadclicks) | ~1.5 KB |
| `dist/chunks/replay.js` | session replay chunk (needs core) | ~23.6 KB |
| `dist/chunks/webvitals.js` | web vitals chunk, web-vitals library included (needs core) | ~7.9 KB |
| `dist/chunks/tracingheaders.js` | tracing headers chunk (needs core) | ~2.7 KB |
| `dist/chunks/otlp.js` | shared OTLP helpers (needs core) | ~1.9 KB |
| `dist/chunks/logs.js` | logs and console capture (needs otlp) | ~6.5 KB |
| `dist/chunks/metrics.js` | metrics (needs otlp) | ~5.3 KB |
| `dist/chunks/toolbar.js` | toolbar loader (needs core) | ~1.4 KB |
| `dist/lazy/posthog.js` | the lazy build's main script: like `array.js` (see below) | ~82.4 KB |
| `dist/lazy/replay.js` | replay recorder logic (upstream `lazy-recorder.js` without rrweb) | ~21.2 KB |
| `dist/lazy/exception-autocapture.js` | error wrapping functions | ~0.9 KB |
| `dist/lazy/dead-clicks-autocapture.js` | dead click detector | ~3.9 KB |
| `dist/lazy/web-vitals.js` | Google's web-vitals, every flavour | ~5.9 KB |
| `dist/lazy/tracing-headers.js` | fetch/XHR tracing patches | ~2.2 KB |
| `dist/lazy/logs.js` | console log capture | ~1.6 KB |

Session replay also loads upstream's `recorder.js` (rrweb and its console and
network plugins, ~46.5 KB gzip) from the assets host when recording starts.
Upstream loads `lazy-recorder.js` instead (~72.5 KB: rrweb plus the replay
logic that is compiled into our bundle).

In `posthog.full.js` and the chunks, web vitals load nothing at runtime: Google's web-vitals library (6.2.1, the
release upstream pins) is compiled into the chunk. Upstream loads
`web-vitals-with-attribution.js` by default (~7.1 KB; `web-vitals.js`, ~4.0 KB,
without attribution) once web vitals are enabled. Tracing headers likewise
compile in the fetch/XHR patches upstream loads as `tracing-headers.js` (~2.6 KB).

Most of the core is the user-agent tables (a faithful port of upstream's UA
and bot detection). The experiments chunk includes the html sanitiser (~5 KB).

Every build uses ADVANCED optimizations, `--warning_level VERBOSE`, and treats
`checkTypes`, `missingProperties` and `strictMissingProperties` as errors. The
build currently produces zero warnings.

## Modularity

The core never imports the optional modules. Each module registers itself
through `registerExtension(name, factory)` (in `src/core/extensions.js`) and
plugs into the core through the hooks described in
[Writing an extension](#writing-an-extension). There are two ways to leave a
module out:

1. **At build time.** Pick a bundle: `posthog.core.js` has no flag, replay or
   experiment code at all.
2. **At load time.** Use the Closure chunks. Load `chunks/core.js` first. You can
   then load `chunks/flags.js` and `chunks/experiments.js` whenever you want,
   including after `posthog.init()`. A module loaded late attaches to the live
   instance and starts working straight away. The chunks share renamed symbols
   through a single `window.__phc` namespace object.
3. **Lazily, like upstream.** The lazy build (`lazy/posthog.js`) loads each
   lazy part only when its feature turns on; see [The lazy build](#the-lazy-build).

```html
<script src="chunks/core.js"></script>
<script>posthog.init('phc_...', { api_host: 'https://eu.i.posthog.com' })</script>
<!-- optional, any time later: -->
<script src="chunks/flags.js"></script>
<script src="chunks/experiments.js"></script>
<script src="chunks/exceptions.js"></script>
<!-- autocapture, dead clicks, heatmaps: dom.js first; heatmaps.js needs deadclicks.js -->
<script src="chunks/dom.js"></script>
<script src="chunks/autocapture.js"></script>
<script src="chunks/deadclicks.js"></script>
<script src="chunks/heatmaps.js"></script>
<script src="chunks/replay.js"></script>  <!-- needs only core.js -->
<script src="chunks/webvitals.js"></script>  <!-- needs only core.js -->
<script src="chunks/tracingheaders.js"></script>  <!-- needs only core.js -->
<!-- opt-in: otlp.js first for logs.js / metrics.js; toolbar.js needs only core.js -->
<script src="chunks/otlp.js"></script>
<script src="chunks/logs.js"></script>
<script src="chunks/metrics.js"></script>
<script src="chunks/toolbar.js"></script>
```

The DOM helpers shared by autocapture, dead clicks and heatmaps (element
properties and `$elements_chain`, the sensitivity rules, the rageclick and
dead click ignorelists) are their own `dom` chunk rather than part of the
autocapture chunk: each of the three modules can be used without the others
(heatmaps without autocapture is a common setup), and they stay out of the
core. Heatmaps depend on the dead clicks chunk because, like upstream, they
run their own dead click detector for `deadclick` points; loading it also
registers `posthog.deadClicksAutocapture`, which only starts when
`capture_dead_clicks` or the remote `captureDeadClicks` enables it. The
`RageClick` detector lives in the core (both autocapture and heatmaps use it,
and the date-gated `rageclick` default needs its keyword list).

Flag methods (`getFeatureFlag`, `isFeatureEnabled`, `onFeatureFlags`, ...) are
always present on `posthog`. Without the flags module they return `undefined`
(and `onFeatureFlags` calls back with `errorsLoading: true`), like upstream's
slim bundle. Attached modules are published like upstream:
`posthog.featureFlags` (with upstream's methods, e.g.
`posthog.featureFlags.overrideFeatureFlags(...)`), `posthog.experiments`,
`posthog.sessionRecording`,
`posthog.autocapture` (`isEnabled`, `startIfEnabled()`,
`setElementSelectors()`, `getElementSelectors()`, `rageclicks`),
`posthog.heatmaps` (`isEnabled`, `startIfEnabled()`, `getAndClearBuffer()`,
`flushIntervalMilliseconds`), `posthog.deadClicksAutocapture`
(`startIfEnabledOrStop()`, `stop()`, `lazyLoadedDeadClicksAutocapture`),
`posthog.webVitalsAutocapture` (`isEnabled`, `allowedMetrics`,
`flushToCaptureTimeoutMs`, `attributionMetrics`, `useAttribution`,
`useSoftNavs`, `startIfEnabled()`) and `posthog.tracingHeaders`
(`startIfEnabledOrStop()`).

Exception capture works the same way. `captureException`, `addExceptionStep`,
`startExceptionAutocapture` and `stopExceptionAutocapture` are core methods, as
upstream; the core only delegates to the `exceptions` module through the
`ExceptionsApi` record. Without the module, `captureException` returns
`undefined` and sends nothing, `addExceptionStep` is a no-op and the
start/stop methods only set `capture_exceptions`, which is what upstream does
when its `exceptions` extension is unavailable. Everything else (coercers, stack
parsing, filters, steps, rate limiting, the `window.onerror` /
`onunhandledrejection` / `console.error` wrappers, the remote config keys) is in
the module, so `posthog.core.js` carries none of it. The module publishes
`posthog.exceptions` and `posthog.exceptionObserver` (with `isEnabled`), like
upstream.

Logs, metrics and the toolbar are opt-in modules in the same way. `captureLog`,
`logger` (`trace`/`debug`/`info`/`warn`/`error`/`fatal`) and `loadToolbar` are
core methods, as upstream; the core delegates through the `LogsApi` /
`ToolbarApi` records and, without the modules, `captureLog` and `logger` do
nothing and `loadToolbar` returns `false`. The core's only other hooks are
upstream's: the unload handler drains `metrics` (always) and `logs` (with
`request_batching`) with sendBeacon, and turning capturing off releases console
capture (`_onOptOut`). The modules publish `posthog.logs` (`captureLog`,
`logger`, `flush()`, `flushLogs(transport)`, `reset()`, ...),
`posthog.metrics` (`count`, `gauge`, `histogram`, `flush(transport)`) and
`posthog.toolbar` (`loadToolbar`, `maybeLoadToolbar`, `maybeLoadEditor`).
Logs and metrics share the `otlp` chunk (the OTLP attribute encoder, resource
attributes, flush timer and backoff); it is a chunk of its own so either can be
loaded without the other.

`startSessionRecording(override)`, `stopSessionRecording()` and
`sessionRecordingStarted()` are always present;
without the replay module they only toggle `disable_session_recording`.

The replay chunk depends only on core: linked flags go through the public
`onFeatureFlags`, which works whether or not the flags chunk is loaded (without
it a linked flag never matches, like upstream without flags).

### The lazy build

`dist/lazy/posthog.js` is the like-for-like counterpart of upstream's
`array.js`. It carries what `array.js` carries eagerly (the core, feature
flags, web experiments, exception capture, autocapture, heatmaps, metrics, the
toolbar loader) plus the *shell* of each lazily loaded extension: its config
and remote config handling and the decision to start. The heavy part is loaded
where upstream calls `__PosthogExtensions__.loadExternalDependency(posthog,
kind, cb)`, from a chunk next to `posthog.js`:

| upstream `/static/<kind>.js` | ours `lazy/<chunk>.js` | loaded when |
|---|---|---|
| `lazy-recorder` | `replay` + PostHog's `recorder.js` (rrweb), requested together | recording starts (remote config, `startSessionRecording`) |
| `exception-autocapture` | `exception-autocapture` | exception autocapture turns on |
| `dead-clicks-autocapture` | `dead-clicks-autocapture` | dead clicks (or heatmaps' detector) start |
| `web-vitals`, `web-vitals-with-attribution`, `web-vitals-soft-navs`, `web-vitals-with-attribution-soft-navs` | `web-vitals` | web vitals start |
| `tracing-headers` | `tracing-headers` | `tracing_headers` / `trace_propagation_targets` are set |
| `logs` | `logs` | console log capture turns on |

One `web-vitals` chunk serves all four flavours: they are the same web-vitals
release (6.2.1), built with and without attribution. The extension still
computes upstream's flavour at the same point (`capture_performance`
attribution and soft-navs options) and checks
`__PosthogExtensions__.postHogWebVitalsCallbacksByFlavor[flavour]` first; if
those are missing it loads the chunk, then uses its attributed or plain
callbacks for that flavour and, for the attribution flavours, starts the
attribution build's resource observer, as loading that script does upstream.
The replay chunk is the half of `lazy-recorder.js` we own; rrweb still comes
from PostHog's `recorder.js`, requested at the same time, and recording starts
once both have loaded. Its `<script>` element is removed once it has run, so
the page (which replay records) has one script where upstream has one.

Chunks are injected like upstream's scripts (the core's `loadScript`:
`disable_external_dependency_loading`, `prepare_external_dependency_script`,
`external_scripts_inject_target` apply) with `?v=<our version>` for cache
busting. They are loaded from the directory of the script that loaded
`posthog.js` (`document.currentScript` while it runs, like webpack's automatic
`publicPath`), or from `closure_lazy_chunks_url` when set:

```js
posthog.init('phc_...', { closure_lazy_chunks_url: 'https://cdn.example.com/posthog/lazy/' })
```

(Upstream has no `closure_*` options, so the name can't collide with one of
its keys.) PostHog-hosted assets stay PostHog-hosted: the remote config
(`/array/<token>/config.js`), `toolbar.js` and `recorder.js`. The build is a
Closure chunk graph rooted at `posthog.js` with its own namespace object,
`window.__phl`, so it can share a page with the chunk build (`__phc`).

The standard PostHog HTML snippet also works. Calls the snippet queued before
the SDK loaded are replayed after `init`, with `identify` and `register` going
first.

## Closure conventions

- Everything that crosses the SDK boundary uses **quoted keys**, so ADVANCED
  renaming never touches it. That covers user config (`config['api_host']`),
  persisted JSON, server responses and event payloads. Internal state uses
  dotted access and does get renamed.
- The public API is exported explicitly in `exportPublicApi()` in
  `src/core/posthog.js`. Add new public methods there.
- Contracts between modules are `@record` types, for example `FeatureFlagsApi`
  in `extensions.js`, so the core can type-check calls into a module it does
  not import.
- Polyfill injection is turned off (`--rewrite_polyfills=false`). Code uses ES5
  built-ins only. `fetch`, `CompressionStream` and `Promise` are
  feature-detected; when they are missing the SDK falls back to XHR or to
  uncompressed requests.
- The sources run unmodified as native ES modules. The test suite runs every
  scenario against both the raw sources and the compiled bundles, which
  catches renaming bugs.

## Writing an extension

Optional modules (autocapture, heatmaps, exception autocapture, session replay,
...) are built as Closure modules/chunks on top of these core APIs. They are
compiled together with the core, so they use dotted (renamed) access to
internal APIs and quoted access to public/wire data.

**Registering.** `registerExtension('autocapture', (posthog) => new Autocapture(posthog))`.
The factory runs during `init` at the point upstream initialises its
extensions (after persistence, sessions and the feature-flags module exist,
before the bootstrap identity is applied), or immediately when the chunk is
loaded after `init`. The instance is published as `posthog[name]`. Pick the
upstream name (`autocapture`, `heatmaps`, `sessionRecording`, `exceptions`...).

**Lazy parts.** A module that upstream splits into a shell and a
`/static/<kind>.js` script is split the same way. The lazy part registers
itself with `provideLazy(kind, part)` (`src/core/lazy.js`) when its code runs;
the shell calls `loadLazy(posthog, kind, cb)` at the point upstream calls
`loadExternalDependency` and reads the part with `lazyPart(kind)` (typed
through a `@record` in the shell, e.g. `DeadClickDetectorApi`). The module's
`index.js` imports the lazy part before `shell.js`, so in the bundles and
chunks the part is present from the start and `loadLazy` calls back
synchronously; only the lazy build installs a chunk loader. Where the
compiled-in builds mirror upstream's script-load refusal under
`disable_external_dependency_loading`, they do so only when
`lazyChunksEnabled()` is false: the lazy build gets the real refusal from
`loadScript`. List the files in `scripts/build.sh` as `*_SHELL_FILES` and
`*_LAZY_FILES` and add the chunk to the lazy build's chunk graph.

**Hooks** (`Extension` @record in `src/core/extensions.js`, all optional):

- `onInit()`: called once right after the factory.
- `eventProperties(eventName) => ?Object`: merged into every event after
  persisted/session super properties and before the event's own properties
  (upstream's dynamic event-property producers). Return `null` for none.
- `onRemoteConfig(config)`: `config` is the `/array/<token>/config` object
  (quoted keys, e.g. `config['autocapture_opt_out']`, `config['heatmaps']`,
  `config['elementsChainAsString']`, `config['sessionRecording']`), or `null`
  when loading failed (upstream's `{ok: false}`: keep fail-safe defaults). It
  is called once per load, after the core applied the result (compression,
  `analytics.endpoint`, `person_profiles`), in attach order. An extension
  attached after the config arrived is called with the last result straight
  away. Modules persist their server-side switches themselves, like upstream:
  e.g. autocapture registers `$autocapture_disabled_server_side`, which
  `HIDDEN_PERSISTENCE_KEYS` in `constants.js` leaves event-visible, as upstream's
  persistence-key policy does. Hidden keys (never sent as event properties)
  must be added to that list.
- `onReset()`: called by `reset()` after persistence was cleared and before the
  new anonymous identity is registered.
- `onConfigChange(partialConfig)`: called by `set_config()` (including the one in
  `init` and the one the remote config triggers) after the config, persistence,
  flags and history autocapture were updated, in attach order. Upstream's
  `onConfigChange()` / `startIfEnabled()` / `startIfEnabledOrStop()` calls map to
  it; extensions that only re-check their state ignore the argument.

Modules the core must call at specific points, as upstream's core does, get a
typed contract next to `FeatureFlagsApi`. `SessionRecordingApi` (the
`sessionRecording` module) is called for the replay debug properties of every
event (`getSdkDebugProperties`, with upstream's 30 s throttle of the optional
ones), by `set_config`, `opt_in_capturing` and `reset` (`flushBeforeIdentityReset`),
and is disposed and detached/recreated when entering/leaving cookieless mode;
like upstream it is not created while the SDK is in cookieless mode.

**Core APIs for extensions** (on the `PostHog` instance):

- `capture(event, properties, options)`: options (quoted keys) are upstream's
  `'$set'`, `'$set_once'`, `'$unset'`, `'timestamp'` (Date), `'uuid'`,
  `'send_instantly'` (bypass the batch queue, sync gzip), `'transport'`
  (`'XHR'|'fetch'|'sendBeacon'`), `'_batchKey'` (batch per key, e.g.
  `'recordings'`; batching also requires `request_batching`), `'_url'`
  (endpoint override), `'_noTruncate'`, `'skip_client_rate_limiting'` and
  `'_originatedFromCaptureException'`. As upstream: any options object without
  `_batchKey` sends the event unbatched; `_batchKey: 'recordings'` or a `/s/`
  URL switches to replay framing (`sent_at` per item, batches grouped by
  `$session_id`/`$window_id`). Returns the captured event or `undefined`.
- `endpointFor(target, path)` (also `posthog.requestRouter.endpointFor`):
  `target` is `'api' | 'assets' | 'ui' | 'flags'`. Cloud hosts map to
  `https://<region>.i.posthog.com` / `https://<region>-assets.i.posthog.com` /
  `https://<region>.posthog.com`; custom hosts use `api_host` (`flags` uses
  `flags_api_host` when set, `/static/` assets use `asset_host`).
- `sendRequest(options)`: a `RequestOptions` (`src/core/request.js`) through the
  SDK transport stack (request headers, `best-available` compression, server
  quota limits, `on_request_error`). `timestampMode: 'query'|'body'|'capture-body'`.
- `scrollManager`: `scrollY()`, `scrollX()`, `scrollElement()` (honours
  `scroll_root_selector`), `getContext()`; also public as `posthog.scrollManager`.
- `sessionManager.checkAndGetSessionAndWindowId(readOnly, timestamp)` and
  `onSessionId(cb)`; `sessionManager.onForcedIdleReset(cb)`.
- `on('eventCaptured', cb)` (every captured event, after `before_send`),
  `rateLimiter`, `consent`, `persistence` (`register`, `get_property`, ...),
  `config` (public, quoted keys), `isPageUnloading`.
- `RageClick` and the rageclick keyword lists in `src/core/rageclick.js`.
- `loadScript(config, url, callback)` in `src/core/script-loader.js` (upstream's
  external script loader: `prepare_external_dependency_script`,
  `disable_external_dependency_loading`, `external_scripts_inject_target`).

## Test

```sh
npm test                         # Node fake browser: raw sources + every compiled bundle + chunks + the lazy build
npm run test:chrome              # loads the chunks and the lazy build in real headless Chrome (chromedp/headless-shell)
node --test test/user-agent.test.mjs
node --test test/autocapture.test.mjs   # $elements_chain, value scrubbing, RageClick
node --test test/replay.test.mjs # session replay: status, triggers, sampling, buffering, compression
./scripts/build.sh && node test/diff/run.mjs [scenario ...]   # differential test vs official 1.450.0
DIFF_BUNDLE=lazy/posthog.js node test/diff/run.mjs [scenario ...]   # the same against the lazy build
node test/sanitizer-chrome.mjs   # html sanitiser vs real DOMPurify 3.4.13 (needs it in /tmp/dp, see the file)
node --test test/exceptions.test.mjs   # upstream's stack parser / coercer / builder unit tests, ported
node --test test/web-vitals.test.mjs   # upstream's web vitals tests, ported, + the web-vitals port
node --test test/tracing-headers.test.mjs   # upstream's tracing headers and patch tests, ported
node --test test/logs-metrics.test.mjs # OTLP encoder, log records/pipeline, console capture, metrics aggregation
```

The differential test serves the official `array.js` and our
`dist/posthog.full.js` (or `DIFF_BUNDLE=<file>`, a path under `dist/`, e.g.
`DIFF_BUNDLE=lazy/posthog.js` for the lazy build) from a fake PostHog that also
answers the remote config (`config.js` and JSON). It compares every request
(method, path, query, content type, event names) and every event/body after
normalising ids and timestamps (dead click timestamps and delays are timing
values: only their presence is compared). Scenarios drive real input through
CDP: the page calls `h.click(selector)`, `h.move(x, y)`, `h.type(text)` or
`h.cdp('Input.…', params)`, which `test/diff/chrome.mjs` runs as trusted
`Input.*` events via a `__cdpInput` binding. `ALLOWED` in `test/diff/fixtures.mjs` lists the
accepted differences: only `$lib_version`.

Run against the lazy build, the runner also checks that our chunk requests
(`/sdk/ours/lazy/<chunk>.js`, and PostHog's `recorder.js`) happen in the same
order and in the same scenarios as the official SDK's `/static/<kind>.js`
requests, with the kind map from [The lazy build](#the-lazy-build)
(`lazy-recorder` is our `replay` chunk plus `recorder.js`, requested together;
every web-vitals flavour is our `web-vitals` chunk). Kinds we don't port
(`surveys`, product tours, conversations) are left out, and `toolbar.js` is
compared as a request anyway.

Normalisations that depend on the build:

- Compiled-in builds only (`posthog.full.js`): `$dead_click_last_mutation_timestamp`
  / `$dead_swipe_last_mutation_timestamp` are ignored. Their detector starts
  synchronously at init and sees the SDK's own `config.js` `<script>` being
  inserted, which upstream's detector, started once its script has loaded,
  does not. The lazy build starts it where upstream does and is compared as is.
- Lazy build only: in replay's network capture, the initial resource entry of
  our `replay` chunk is dropped (upstream has one `lazy-recorder.js` entry for
  it and rrweb; both SDKs have the `recorder.js` / `lazy-recorder.js` entry).

Exception scenarios (`exc_*`) compare `$exception_list` frames as reported by
Chrome for the shared test page, so filenames, lines and columns are real. Only
frames inside the SDK file itself are normalised: each run of consecutive frames
from `/sdk/official/`, `/sdk/ours/` or the official lazy-loaded `/static/`
bundles becomes one `<sdk>` frame, because file, minified names, positions and
the number of frames left after inlining differ by construction. Errors the
scenarios throw on purpose say `diff-expected` and are not reported as page
errors.
Session replay scenarios (`replay_*`) serve a remote config with
`sessionRecording` and compare the `$snapshot` payloads too: the official SDK
loads `/static/lazy-recorder.js`, ours `/static/recorder.js` (plus, in the lazy
build, its `replay` chunk), both from the vendored official dist (`/static/`
requests are not compared). The normaliser
decodes the per-event `cv: '2024-10'` gzip fields and compares the recorded
DOM, mutations, custom events (including `$posthog_config`) and network entries
with node ids as-is. rrweb timestamps, browser-measured network timings and
transfer sizes are volatile; the SDK and recorder `<script>` URLs in the
recorded DOM are normalised; `$snapshot_bytes` is checked against the payload
(it must equal upstream's size estimate) because sizes include those URLs.
The replay scenarios set `disable_surveys` because upstream injects
`surveys.js` (not ported) into the recorded DOM otherwise; `dead_clicks` sets
it because that insertion is a DOM mutation upstream's dead click detector
sees.

Web vitals scenarios (`wv_*`) use real LCP, CLS, FCP and INP from the test
page and CDP input. Metric values, deltas, attribution timings and the
`v6-<time>-<random>` metric ids are browser-measured or random and are
normalised (presence still compared), as is FCP's attribution `loadState`
(FCP time against this load's DOM milestones); names, ratings, navigation
fields, URLs, targets and which metrics travel together are compared. The
runner fails any scenario in which our SDK requests `/static/web-vitals*.js`.
Tracing headers scenarios (`th_*`) call `/__echo` on other hosts
(`api.`/`other.`/`third.example.test`), which the fake server answers on any
non-PostHog host by recording the request's host, method, query, headers and
body; a random `traceparent` is normalised after its format is checked.
Logs and metrics scenarios (`logs_*`, `metrics_*`) compare the OTLP bodies sent
to `/i/v1/logs` and `/i/v1/metrics` in full, except wall-clock values:
`timeUnixNano` / `observedTimeUnixNano` / `startTimeUnixNano` and the
`sessionStartTimestamp` / `lastActivityTimestamp` log attributes are volatile,
and `telemetry.sdk.version` / the scope `version` are the SDK version (like
`$lib_version`). Toolbar scenarios (`toolbar_*`) serve a stub `toolbar.js` from
the fake server that records each `ph_load_toolbar(params, posthog)` call; the
toolbar script requests are compared (unlike other `/static/` requests) with the
version in the path or `v` normalised and `t` (a 5-minute wall-clock boundary)
checked for its shape only, and the scenario results compare `ph_toolbar_state`,
the `_postHogToolbarParams` localStorage entry, the URL hash and the recorded
calls. `toolbar_persisted` reloads the page to launch the toolbar from the
params saved by the first load.

The Node harness cannot execute injected scripts, so remote config always goes
through the JSON fallback there.

## Scope

**Ported from upstream 1.450.0**

- Core (`posthog-core.ts` and helpers): config defaults (including `defaults`
  dates and config renames), remote config (config.js, JSON fallback,
  `supportedCompression`, `analytics.endpoint`), event properties
  (`event-utils`, session entry props, `$prev_pageview_*` with scroll depth,
  campaign params, `$set_once` initial props), capture options and batching
  rules, gzip/base64 encoding, retry queue, client rate limiting and server
  quota limiting, identify/alias/group/reset/register*, consent
  (`$opt_in`, `consent_persistence_name`, DNT/GPC, cookieless mode), sessions
  and window ids, SPA pageviews (history autocapture), snippet replay, `$fbc`/`$fbp`.
- Feature flags (`browser-common/feature-flags.ts`), including early access
  features and the background refresh.
- Web experiments with an html sanitiser equivalent to DOMPurify 3.4.13 under
  upstream's config.
- Exception capture (`posthog-exceptions.ts`, the `exception-autocapture`
  extension and its wrapping functions, core `error-tracking`): coercers for
  Error / DOMException / ErrorEvent / PromiseRejectionEvent / Event / objects /
  strings / primitives, Chrome and Gecko stack parsers (Safari extension frames,
  recursion collapse, frame and line limits, `in_app`), causes and
  `AggregateError` members, `$exception_steps`, `$release_id` and chunk ids,
  the per-type bucketed rate limiter, remote `suppressionRules`, the
  extension / injected-script / SDK-error filters, `capture_exceptions` vs the
  `autocaptureExceptions` remote flag (`$exception_capture_enabled_server_side`,
  `$error_tracking_suppression_rules`, `$error_tracking_capture_extension_exceptions`).
- Autocapture (`browser-common/autocapture.ts`, `autocapture-utils.ts`,
  `browser-autocapture.ts`): `$autocapture` for click/change/submit with
  `$elements_chain` (and `$elements` when the remote `elementsChainAsString`
  is off), the sensitivity rules, `ph-no-capture` / `ph-sensitive` /
  `ph-include`, `data-ph-capture-attribute-*`, `$input_value` for
  `capture_value_css_selector_allowlist` (default `[data-ph-capture-value]`),
  SVG icon clicks attributed to their button/link, pointer-target recovery,
  shadow DOM, `$external_click_url`, the `autocapture` options (url/element/
  css allow and ignore lists, `dom_event_allowlist`,
  `element_attribute_ignorelist`, `capture_copied_text` for
  `$copy_autocapture`), `$rageclick` with thresholds, `css_selector_ignorelist`,
  `content_ignorelist` and `ignore_text_selection` (and their `defaults`-dated
  defaults), and `autocapture_opt_out` persisted as
  `$autocapture_disabled_server_side`.
- Heatmaps (`heatmaps.ts`): click / rageclick / deadclick / debounced mousemove
  points with scroll offsets unless the target is fixed or sticky, buffered per
  (masked) URL, flushed as `$$heatmap` every `flush_interval_milliseconds`
  while visible and on beforeunload; `capture_heatmaps` / `enable_heatmaps` /
  remote `heatmaps` (`$heatmaps_enabled_server_side`).
- Dead clicks (`dead-clicks-autocapture.ts` and its lazy entrypoint):
  `$dead_click` and `$dead_swipe` with the mutation/scroll/selection/
  visibility/focus rules, `capture_dead_clicks` options and the remote
  `captureDeadClicks` (`$dead_clicks_enabled_server_side`).

- Session replay (`extensions/replay/session-recording.ts` plus everything
  upstream ships in `lazy-recorder.js`: `lazy-loaded-session-recorder.ts`,
  `recording-strategies.ts`, `triggerMatching.ts`, `sessionrecording-utils.ts`,
  `mutation-throttler.ts`, `flushed-size-tracker.ts`, `config.ts`, `json-ld.ts`,
  `extensions/sampling.ts`): remote config persistence with its 1 h TTL,
  V1 triggers (URL, event, linked flag, `any`/`all`), URL blocklist, sampling,
  minimum duration (strict and not), V2 trigger groups, rrweb options and
  masking, console and network plugins, canvas options, the interaction hold,
  buffering (0.9 MB / 2 s, 6.3 MB split, sessionStorage parking on unload),
  per-event compression, idle detection, session rotation, JSON-LD capture,
  the debug properties and the public API. rrweb comes from upstream's
  `recorder.js`, loaded with the same URL rules as upstream's lazy scripts
  (`?v=`, `strict_script_versioning`, `asset_host`), unless
  `window.__PosthogExtensions__.rrweb.record` already exists.

- Web vitals (`extensions/web-vitals/index.ts` and the four `web-vitals*`
  entrypoints): `capture_performance` (`true`/`false` or `web_vitals`,
  `web_vitals_allowed_metrics`, `web_vitals_attribution`,
  `web_vitals_delayed_flush_ms`, `__web_vitals_max_value`,
  `__preview_web_vitals_soft_navs`), the remote `capturePerformance.web_vitals`
  and `web_vitals_allowed_metrics` (persisted as `$web_vitals_enabled_server_side`
  and `$web_vitals_allowed_metrics`), flavour selection (attributed INP/LCP by
  default), buffering per navigation, the `$web_vitals` event shape, flush when
  complete / after the delay / on navigation change / by beacon on hidden or
  pagehide, the attribution allowlist, URL masking and the max-value rule.
  The observers are Google's web-vitals 6.2.1, ported in `third_party/web-vitals`.
- Tracing headers (`extensions/tracing-headers.ts`, `entrypoints/tracing-headers.ts`,
  `browser-common/utils/patch.ts`): `X-POSTHOG-SESSION-ID` / `-WINDOW-ID` /
  `-DISTINCT-ID` on fetch, `fetch(Request)` and XHR for `tracing_headers`
  hostnames (deprecated `addTracingHeaders`, `__add_tracing_headers`, whose
  `true` means every host), a fresh W3C `traceparent` for
  `trace_propagation_targets`, live updates through `set_config`, and the
  spliceable patch layers shared with replay's network plugin.

- Logs (`posthog-logs.ts`, browser-common `logs.ts`, `logs-config.ts`,
  `console-logs.ts`, the `logs` entrypoint, core `logs/` and the OTLP
  encoders): `captureLog` and `logger` with every level, attributes and trace
  context, `beforeSend` chains, the per-interval rate cap, the in-memory queue
  with its flush trigger (`maxBufferSize`), timer (`flushIntervalMs`), 100-record
  slices, 413 halving, retry with backoff and the status-0 circuit breaker,
  console capture (`logs.captureConsoleLogs` and the remote
  `logs.captureConsoleLogs`, persisted as `$logs_capture_enabled_server_side`,
  with the pre-load recorder and its replay), opt-out/reset handling and the
  sendBeacon drain on unload.
- Metrics (`posthog-metrics.ts`, `extensions/network-metrics.ts`, core
  `metrics/`): `count` / `gauge` / `histogram` aggregation with series identity,
  bounds, the series and bounds caps, `beforeSend`, the 60 s browser flush
  interval, the flush on `visibilitychange` to hidden, merge-back on transient
  failures and the sendBeacon drain on unload; `metrics.network` request
  duration histograms for `fetch` and XHR.
- The toolbar loader (`extensions/toolbar.ts`): the `__posthog` / `state` hash
  param read at parse time, `_postHogToolbarParams`, `loadToolbar`,
  `maybeLoadToolbar`, `maybeLoadEditor`, `window.ph_toolbar_state`, and the
  `toolbar.js` URL (`/static/<version>/toolbar.js`, falling back to
  `/static/toolbar.js?v=<version>&t=<5 min>`, with the upstream version). The hosted toolbar itself is not
  part of this SDK.

**Not yet implemented** (upstream modules to add as extensions): surveys, product tours,
conversations, site apps, WebMCP.

**Known differences from upstream**

- Not ported (opt-in upstream, off by default): `split_storage`,
  `cookieWinsOnConflict` cross-subdomain identity reconciliation, cross-tab
  feature-flag merging, `/flags` timing metrics (`metrics.flags`),
  `rewriteRequestPath` ingestion-endpoint tracking (the rewrite itself works).
- Sync gzip (beacons, `send_instantly`, no CompressionStream) uses a compact
  LZ77 + fixed-Huffman encoder instead of fflate: same decoded payload,
  somewhat larger bodies.
- Compiled in vs lazy-loaded. The items below marked *(compiled-in builds)*
  apply to `posthog.full.js` and the per-module chunks, where the lazy parts
  are compiled in. The lazy build (`lazy/posthog.js`) loads them where and
  when upstream loads its `/static/` scripts, so they don't apply to it; there
  a script-load refusal (`disable_external_dependency_loading`) is the real
  one from `loadScript`, and only the replay chunk is an extra request (see
  [The lazy build](#the-lazy-build)).
- Dead clicks *(compiled-in builds)*: upstream lazy-loads the detector from
  `/static/`; here it is compiled in, so it starts synchronously instead of
  after the script load. As upstream, it never starts while
  `disable_external_dependency_loading` is set (until the detector has
  "loaded" once).
- Hook names of extensions are renamed by Closure, so extensions must be
  compiled with the core (as bundles or chunks).
- Exception autocapture *(compiled-in builds)*: the wrapping functions are
  compiled into the module instead of being lazy-loaded from
  `/static/exception-autocapture.js`, so `window.onerror` & co. are wrapped
  synchronously when autocapture turns on (upstream wraps them once that
  script has loaded), and `disable_external_dependency_loading` does not stop
  them. In every build, the legacy globals that script defines for old SDK
  versions (`posthogErrorWrappingFunctions`,
  `extendPostHogWithExceptionAutocapture`) are not provided.
- Web vitals *(compiled-in builds)*: upstream lazy-loads `/static/web-vitals*.js` when web vitals
  start (at init with the client config, else when the remote config enables
  them) and registers the observers once it has loaded; here Google's library
  is compiled in and the observers are registered synchronously. They use
  `buffered` PerformanceObservers, so the same entries are seen; what changes
  is timing: a trusted click or keypress before upstream's script has loaded
  does not finalise LCP there but does here, and metrics may be reported (and
  `$web_vitals` sent) a few milliseconds earlier. As upstream, nothing starts
  while `disable_external_dependency_loading` is set, and callbacks already on
  `__PosthogExtensions__.postHogWebVitalsCallbacksByFlavor` (or the legacy
  `postHogWebVitalsCallbacks`) are used first. Our module does not publish its
  callbacks there, and it does not install upstream's `Array.prototype.at` /
  `findLast` polyfills (the port does not need them). In every build,
  upstream builds each flavour as a separate script with its own module state;
  here the flavours share one copy (only one is used per page), and the lazy
  build loads that copy as one `web-vitals` chunk whatever the flavour.
- Tracing headers *(compiled-in builds)*: the fetch/XHR patches are compiled in instead of being
  lazy-loaded from `/static/tracing-headers.js`, so they are installed
  synchronously during init (upstream patches once that script has loaded;
  requests made in between carry no headers there). As upstream, nothing is
  patched while `disable_external_dependency_loading` is set (until the
  patches have "loaded" once). Patch functions on
  `__PosthogExtensions__.tracingHeadersPatchFns` are not used or defined.
- Session replay always loads `recorder.js`: the `scriptConfig.script` remote
  setting (which selects another upstream recorder bundle) is ignored. When
  the native CompressionStream is missing or fails, and when compressions are
  drained on unload, events are compressed with the core's encoder instead of
  fflate (same decoded data, different `$snapshot_bytes`).
- Console log capture *(compiled-in builds)* is compiled into the `logs` module instead of being
  lazy-loaded from `/static/logs.js`, so it takes over the recorder's buffer
  synchronously when capture is enabled (upstream does it once that script has
  loaded; the same records are sent). Like the script load upstream, it is
  refused under `disable_external_dependency_loading`. The compatibility shims
  `logs.js` keeps for older cores (`__PosthogExtensions__.logs`) are not
  provided.
- Logs and metrics: upstream's `Retry-After` window is not ported because the
  browser senders never report a `Retry-After` (it can never open there), and
  metric exemplars are not ported because they need an active span, which the
  browser host never provides. The OTLP encoder's debug messages go to
  `console.log` instead of `console.debug` (debug mode only).
- Loaded as a chunk, the toolbar module reads the URL hash when the chunk is
  parsed (upstream: when the SDK is parsed). Upstream's deprecated
  `toolbar._loadEditor` is mangled in its bundle and is not published here either.
- With a `maskCapturedNetworkRequestFn` that drops an initial navigation entry,
  upstream marks the URL-less fallback in a WeakSet that the network plugin
  reads to drop the entry's server timings. recorder.js's plugin has its own
  WeakSet, so our mask function drops those server timings itself (same
  result).

PostHog's original license is kept in `LICENSE.upstream`.
