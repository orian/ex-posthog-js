# posthog-js (Closure edition)

A rewrite of the [PostHog browser SDK](https://github.com/PostHog/posthog-js) in
plain, JSDoc-typed ES2020 JavaScript. It compiles cleanly with Google Closure
Compiler in **ADVANCED** mode with strict type checks, and outputs ES5.

It speaks the same wire protocol and uses the same storage format as upstream
(`/e/` batch endpoint, `/flags/?v=2`, the `ph_<token>_posthog` persistence key,
`$sesid`, `$device_id`, ...). A visitor keeps the same distinct_id and session
when a site switches between this SDK and upstream.

This is a **v1 covering the basics**. See [Scope](#scope).

## Layout

```
src/core/          always loaded: init, capture, identity, persistence, sessions,
                   batching/retry/transport, consent, pageviews, extension registry
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
| `dist/posthog.core.js` | core only | ~12.0 KB |
| `dist/posthog.core-flags.js` | core + feature flags | ~13.4 KB |
| `dist/posthog.full.js` | core + flags + web experiments | ~14.5 KB |
| `dist/chunks/core.js` | core chunk | ~12.2 KB |
| `dist/chunks/flags.js` | flags chunk (needs core) | ~2.0 KB |
| `dist/chunks/experiments.js` | experiments chunk (needs flags) | ~1.5 KB |

Every build uses ADVANCED optimizations, `--warning_level VERBOSE`, and treats
`checkTypes`, `missingProperties` and `strictMissingProperties` as errors. The
build currently produces zero warnings.

## Modularity

The core never imports the optional modules. Each module registers itself
through `registerExtension(name, factory)` (in `src/core/extensions.js`) and
plugs into the core through hooks: `onInit`, `eventProperties`,
`onIdentityChange` and `onReset`. There are two ways to leave a module out:

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
always present on `posthog`. Without the flags module they log a warning and
return `undefined` instead of throwing.

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

## Test

```sh
npm test               # 35 checks: raw sources + every compiled bundle + chunks
npm run test:chrome    # loads the chunks in real headless Chrome (chromedp/headless-shell)
```

## Scope

**Implemented**

- Capture: batching with a 3s flush interval, gzip through native
  `CompressionStream`, retry with exponential backoff and an offline queue,
  and a `sendBeacon` flush on `pagehide`
- Event context: UA parsing, URL, screen, timezone, UTM and click IDs, referrer, and `$initial_*` properties as `$set_once`
- Super properties: `register`, `register_once`, `register_for_session`,
  `unregister`, and `time_event`
- Identity: `identify` (sends `$identify`), `alias`, `setPersonProperties`,
  `group` / `resetGroups`, `reset`, `createPersonProfile`,
  `person_profiles` modes, and `bootstrap`
- Sessions: 30-minute idle timeout (configurable), a 24h cap, and per-tab window
  IDs that detect duplicated tabs
- Persistence: `localStorage+cookie` (the default), `localStorage`, `cookie`,
  `sessionStorage` and `memory`, plus cross-subdomain cookies
- Consent: `opt_in_capturing` / `opt_out_capturing`,
  `opt_out_capturing_by_default`, `respect_dnt`, and
  `opt_out_persistence_by_default`
- Pageviews: `$pageview`, SPA pageviews (`capture_pageview: 'history_change'`),
  and `$pageleave` with `$prev_pageview_*` properties
- Filters: `before_send` (a function or an array), `property_denylist`, the bot
  filter, and string truncation
- Feature flags: `/flags/?v=2` (with a v1 fallback), payloads, overrides,
  bootstrap, `$feature/*` and `$active_feature_flags` on every event, a
  deduplicated `$feature_flag_called` event, and reloads on identity or group
  changes
- Web experiments: flag-driven and URL/UTM-conditioned variants, previews
  (`?__experiment_id=&__experiment_variant=`), and `text`, `css`, `attributes`
  and `imgUrl` transforms

**Not yet implemented** (upstream features you could add as further extension
modules): autocapture, heatmaps, session replay, surveys, exception
autocapture, the toolbar, remote config (`/array/<token>/config`), cookieless
mode, client-side rate limiting, early-access features, logs, and site apps.

**Differences from upstream**

- Web experiments: upstream has `disable_web_experiments` default to `true`.
  Here, including the experiments module is the opt-in, and you can still turn
  it off with `disable_web_experiments: true`.
- `html` transforms in web experiments are applied **only** when you provide
  `web_experiments_html_sanitizer: (html) => safeHtml`. Upstream bundles
  DOMPurify for this; this port has no sanitizer, so it skips `html`
  transforms rather than inject unsanitised markup. Attribute transforms drop
  `on*` handlers and `javascript:` URLs.
- The UA parser and bot list are shorter than upstream's tables.

PostHog's original license is kept in `LICENSE.upstream`.
