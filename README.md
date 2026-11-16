# posthog-js (Closure edition)

A rewrite of the [PostHog browser SDK](https://github.com/PostHog/posthog-js) in
plain, JSDoc-typed ES2020 JavaScript. It compiles cleanly with Google Closure
Compiler in **ADVANCED** mode with strict type checks, and outputs ES5.

It speaks the same wire protocol and uses the same storage format as upstream
(`/e/` batch endpoint, `/flags/?v=2`, the `ph_<token>_posthog` persistence key,
`$sesid`, `$device_id`, ...). A visitor keeps the same distinct_id and session
when a site switches between this SDK and upstream.

It is a faithful port of upstream posthog-js **1.450.0** for the core, feature
flags and web experiments. `test/diff` runs the same scenarios against the
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
| `dist/posthog.full.js` | core + flags + web experiments | ~47.1 KB |
| `dist/chunks/core.js` | core chunk | ~35.5 KB |
| `dist/chunks/flags.js` | flags chunk (needs core) | ~7.4 KB |
| `dist/chunks/experiments.js` | experiments chunk (needs flags) | ~6.5 KB |

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
```

Flag methods (`getFeatureFlag`, `isFeatureEnabled`, `onFeatureFlags`, ...) are
always present on `posthog`. Without the flags module they return `undefined`
(and `onFeatureFlags` calls back with `errorsLoading: true`), like upstream's
slim bundle. Attached modules are published like upstream:
`posthog.featureFlags` (with upstream's methods, e.g.
`posthog.featureFlags.overrideFeatureFlags(...)`) and `posthog.experiments`.

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

Future modules (autocapture, heatmaps, exception autocapture, session replay,
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
- `loadScript(config, url, callback)` in `src/core/script-loader.js` (upstream's
  external script loader: `prepare_external_dependency_script`,
  `disable_external_dependency_loading`, `external_scripts_inject_target`).

## Test

```sh
npm test                         # Node fake browser: raw sources + every compiled bundle + chunks
npm run test:chrome              # loads the chunks in real headless Chrome (chromedp/headless-shell)
node --test test/user-agent.test.mjs
./scripts/build.sh && node test/diff/run.mjs [scenario ...]   # differential test vs official 1.450.0
node test/sanitizer-chrome.mjs   # html sanitiser vs real DOMPurify 3.4.13 (needs it in /tmp/dp, see the file)
```

The differential test serves the official `array.js` and our
`dist/posthog.full.js` (or `DIFF_BUNDLE=<file>`) from a fake PostHog that also
answers the remote config (`config.js` and JSON). It compares every request
(method, path, query, content type, event names) and every event/body after
normalising ids and timestamps. `ALLOWED` in `test/diff/fixtures.mjs` lists the
accepted differences: `$lib_version`, and properties owned by modules that do
not exist yet (`TODO(module)`).

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

**Not yet implemented** (upstream modules to add as extensions): autocapture,
heatmaps, rageclicks/dead clicks, session replay, surveys, product tours,
exception autocapture, web vitals, logs/metrics, conversations, the toolbar,
site apps, tracing headers.

**Known differences from upstream**

- Not ported (opt-in upstream, off by default): `split_storage`,
  `cookieWinsOnConflict` cross-subdomain identity reconciliation, cross-tab
  feature-flag merging, `/flags` timing metrics (`metrics.flags`),
  `rewriteRequestPath` ingestion-endpoint tracking (the rewrite itself works).
- Sync gzip (beacons, `send_instantly`, no CompressionStream) uses a compact
  LZ77 + fixed-Huffman encoder instead of fflate: same decoded payload,
  somewhat larger bodies.
- Hook names of extensions are renamed by Closure, so extensions must be
  compiled with the core (as bundles or chunks).

PostHog's original license is kept in `LICENSE.upstream`.
