# posthog-js (Closure edition)

A rewrite of the [PostHog browser SDK](https://github.com/PostHog/posthog-js) in
plain, JSDoc-typed ES2020 JavaScript. It compiles cleanly with Google Closure
Compiler in **ADVANCED** mode with strict type checks, and outputs ES5.

It speaks the same wire protocol and uses the same storage format as upstream
(`/e/` batch endpoint, `/flags/?v=2`, the `ph_<token>_posthog` persistence key,
`$sesid`, `$device_id`, ...). A visitor keeps the same distinct_id and session
when a site switches between this SDK and upstream.

It is a faithful port of upstream posthog-js **1.450.0** for the core, feature
flags, web experiments, exception capture, autocapture (with rageclicks), heatmaps and dead clicks. `test/diff` runs the same scenarios against the
official bundle and this SDK in headless Chrome and diffs the traffic; all
scenarios are identical (see [Test](#test)). See [Scope](#scope) for what is
not ported yet.

## Layout

```
src/core/          always loaded: init, capture, identity, persistence, sessions,
                   remote config, batching/retry/transport, consent, pageviews,
                   scroll tracking, rate limiting, extension registry
src/flags/         optional: feature flags (/flags/?v=2)
src/experiments/   optional: no-code web experiments (needs flags)
src/exceptions/    optional: exception capture + autocapture (posthog.exceptions,
                   posthog.exceptionObserver)
src/dom/           shared DOM helpers for the three modules below (element
                   properties, $elements_chain, sensitivity rules, ignorelists)
src/autocapture/   optional: $autocapture, $rageclick, $copy_autocapture (needs dom)
src/dead-clicks/   optional: $dead_click / $dead_swipe (needs dom)
src/heatmaps/      optional: $$heatmap (needs dom + dead-clicks)
src/entry/         bundle entry points (core, core-flags, full)
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
| `dist/posthog.core.js` | core only | ~34.2 KB |
| `dist/posthog.core-flags.js` | core + feature flags | ~40.9 KB |
| `dist/posthog.full.js` | core + flags + web experiments + exceptions + autocapture, dead clicks, heatmaps | ~66.0 KB |
| `dist/chunks/core.js` | core chunk | ~35.7 KB |
| `dist/chunks/flags.js` | flags chunk (needs core) | ~7.4 KB |
| `dist/chunks/experiments.js` | experiments chunk (needs flags) | ~6.5 KB |
| `dist/chunks/exceptions.js` | exception capture chunk (needs core) | ~8.4 KB |
| `dist/chunks/dom.js` | shared DOM helpers (needs core) | ~3.9 KB |
| `dist/chunks/autocapture.js` | autocapture chunk (needs dom) | ~3.5 KB |
| `dist/chunks/deadclicks.js` | dead clicks chunk (needs dom) | ~4.5 KB |
| `dist/chunks/heatmaps.js` | heatmaps chunk (needs deadclicks) | ~1.5 KB |

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

1. **At build time.** Pick a bundle: `posthog.core.js` has no flag or experiment
   code at all.
2. **At load time.** Use the Closure chunks. Load `chunks/core.js` first. You can
   then load `chunks/flags.js` and `chunks/experiments.js` whenever you want,
   including after `posthog.init()`. A module loaded late attaches to the live
   instance and starts working straight away. The chunks share renamed symbols
   through a single `window.__phc` namespace object.

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
`posthog.autocapture` (`isEnabled`, `startIfEnabled()`,
`setElementSelectors()`, `getElementSelectors()`, `rageclicks`),
`posthog.heatmaps` (`isEnabled`, `startIfEnabled()`, `getAndClearBuffer()`,
`flushIntervalMilliseconds`) and `posthog.deadClicksAutocapture`
(`startIfEnabledOrStop()`, `stop()`, `lazyLoadedDeadClicksAutocapture`).

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
npm test                         # Node fake browser: raw sources + every compiled bundle + chunks
npm run test:chrome              # loads the chunks in real headless Chrome (chromedp/headless-shell)
node --test test/user-agent.test.mjs
node --test test/autocapture.test.mjs   # $elements_chain, value scrubbing, RageClick
./scripts/build.sh && node test/diff/run.mjs [scenario ...]   # differential test vs official 1.450.0
node test/sanitizer-chrome.mjs   # html sanitiser vs real DOMPurify 3.4.13 (needs it in /tmp/dp, see the file)
node --test test/exceptions.test.mjs   # upstream's stack parser / coercer / builder unit tests, ported
```

The differential test serves the official `array.js` and our
`dist/posthog.full.js` (or `DIFF_BUNDLE=<file>`) from a fake PostHog that also
answers the remote config (`config.js` and JSON). It compares every request
(method, path, query, content type, event names) and every event/body after
normalising ids and timestamps (dead click timestamps and delays are timing
values: only their presence is compared). Scenarios drive real input through
CDP: the page calls `h.click(selector)`, `h.move(x, y)`, `h.type(text)` or
`h.cdp('Input.…', params)`, which `test/diff/chrome.mjs` runs as trusted
`Input.*` events via a `__cdpInput` binding. `ALLOWED` in `test/diff/fixtures.mjs` lists the
accepted differences: `$lib_version`, and properties owned by modules that do
not exist yet (`TODO(module)`).

Exception scenarios (`exc_*`) compare `$exception_list` frames as reported by
Chrome for the shared test page, so filenames, lines and columns are real. Only
frames inside the SDK file itself are normalised: each run of consecutive frames
from `/sdk/official/`, `/sdk/ours/` or the official lazy-loaded `/static/`
bundles becomes one `<sdk>` frame, because file, minified names, positions and
the number of frames left after inlining differ by construction. Errors the
scenarios throw on purpose say `diff-expected` and are not reported as page
errors.

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

**Not yet implemented** (upstream modules to add as extensions): session replay, surveys, product tours,
web vitals, logs/metrics, conversations, the toolbar,
site apps, tracing headers.

**Known differences from upstream**

- Not ported (opt-in upstream, off by default): `split_storage`,
  `cookieWinsOnConflict` cross-subdomain identity reconciliation, cross-tab
  feature-flag merging, `/flags` timing metrics (`metrics.flags`),
  `rewriteRequestPath` ingestion-endpoint tracking (the rewrite itself works).
- Sync gzip (beacons, `send_instantly`, no CompressionStream) uses a compact
  LZ77 + fixed-Huffman encoder instead of fflate: same decoded payload,
  somewhat larger bodies.
- Dead clicks: upstream lazy-loads the detector from `/static/`; here it is
  compiled in, so it starts synchronously instead of after the script load.
  As upstream, it never starts while `disable_external_dependency_loading` is
  set (until the detector has "loaded" once).
- Hook names of extensions are renamed by Closure, so extensions must be
  compiled with the core (as bundles or chunks).
- Exception autocapture's wrapping functions are compiled into the module
  instead of being lazy-loaded from `/static/exception-autocapture.js`, so
  `window.onerror` & co. are wrapped synchronously when autocapture turns on
  (upstream wraps them once that script has loaded). The legacy globals that
  script defines for old SDK versions (`posthogErrorWrappingFunctions`,
  `extendPostHogWithExceptionAutocapture`) are not provided.

PostHog's original license is kept in `LICENSE.upstream`.
