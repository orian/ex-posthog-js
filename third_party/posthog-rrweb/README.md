# PostHog's rrweb fork (record side), as built into posthog-js 1.450.0's `recorder.js`

This is the code PostHog ships as `/static/1.450.0/recorder.js`: PostHog's fork
of [rrweb](https://github.com/rrweb-io/rrweb) (record side only) plus its
console plugin and posthog-js's network plugin. `scripts/build-recorder.sh`
builds our `dist/recorder.js` from it, and session replay loads that file
instead of PostHog's (see the top-level README, "Session replay's recorder").

## Version and source

- posthog-js **1.450.0**, tag `posthog-js@1.450.0` = commit
  `63bc454a45a86c35bf5a11a84cc876b5345da0ca` of https://github.com/PostHog/posthog-js
  (the version bump commit, 2026-11-15; npm published 1.450.0 at 14:25 UTC that day).
- In that monorepo the fork lives in `packages/rrweb/` and the browser SDK uses
  it as pnpm workspace packages (`workspace:*` in `pnpm-lock.yaml`), so
  1.450.0's `recorder.js` was built from the fork's sources at that commit:
  `@posthog/rrweb-record` **0.0.89**, `@posthog/rrweb` 0.1.9,
  `@posthog/rrweb-snapshot` 0.0.68, `@posthog/rrdom` 0.0.68,
  `@posthog/rrweb-types` 0.0.62, `@posthog/rrweb-utils` 0.0.66,
  `@posthog/rrweb-plugin-console-record` 1.0.9 (the `package.json` versions at
  that commit). These versions are not on npm (the registry's latest
  `@posthog/rrweb-record` is 0.0.60), so the tag is the only source.
- What 1.450.0's `recorder.js` contains, from its source map
  (`test/diff/vendor/posthog-js-1.450.0/dist/recorder.js.map`):
  `rrweb/record/dist/rrweb-record.js` (the fork, bundled by vite from
  `packages/rrweb/{record,rrweb,rrweb-snapshot,rrdom,types,utils}`),
  `rrweb-plugin-console-record`, and from posthog-js
  `src/entrypoints/recorder.ts`, `src/extensions/replay/external/{network-plugin,config,denylist}.ts`,
  `src/utils/globals.ts` and helpers from `@posthog/browser-common` and
  `@posthog/core`. Its globals: `__PosthogExtensions__.rrweb` =
  `{record, version: 'v2', wasMaxDepthReached, resetMaxDepthState,
  getLastSnapshotCost, getMutationCost, getObserverInitFailures,
  resetSnapshotCostState}`, `__PosthogExtensions__.rrwebPlugins` =
  `{getRecordConsolePlugin, getRecordNetworkPlugin}`, and the legacy
  `window.rrweb`, `window.rrwebConsoleRecord`, `window.getRecordNetworkPlugin`.

## Layout

- `original/packages/...`: the files the build reads, copied unchanged from
  the tag, at their monorepo paths. This is the fork exactly as PostHog
  shipped it, kept for diffing and for the recording-equivalence test.
- `src/packages/...`: the same files with our optimisations (see below). This
  is what `dist/recorder.js` is built from.
- `deps/base64-arraybuffer-1.0.2/`: the one npm dependency of the record side
  (canvas recording), the version pinned in upstream's lockfile, unchanged.
- `build.mjs`: the esbuild build (runs in Docker, see below).

The file list is exactly the build's inputs (esbuild's metafile): the record
side of the fork, rrdom (`rrweb/src/utils.ts` imports `BaseRRNode`), the
console plugin, and the posthog-js / browser-common / core files the network
plugin and the entry point import. Replay-side code (rrweb's replayer,
`rrweb-snapshot/src/rebuild.ts`, postcss) is not included.

## Build

`scripts/build-recorder.sh` (called by `scripts/build.sh`) runs `build.mjs` in
`docker/recorder-build`: `node:24.21.0-alpine` pinned by digest and
`esbuild@0.25.12`. No npm dependencies are added to the SDK. The entry is
upstream's `packages/browser/src/entrypoints/recorder.ts`, unchanged; workspace
imports resolve to the vendored sources the way upstream's builds resolve
them (`@posthog/rrweb` to `rrweb/src/entries/record.ts` and
`@posthog/rrweb-snapshot` to `rrweb-snapshot/src/record.ts`, as in
`packages/rrweb/record/vite.config.ts`), and vite's `?worker&inline` import
(canvas worker) is bundled and inlined with vite's wrapper. Output: an IIFE,
minified, with a source map, targeting the browsers of upstream's Babel config
for `recorder.js` (`chrome63`, `firefox60`, `safari12`, `ios11`, `opera50`,
`edge79`). Class fields use define semantics, as the fork's
`tsconfig.base.json` (target ESNext) gives them.

**Why not Closure.** This is PostHog's TypeScript fork, not code we port: we
want to stay diffable against upstream (and pick up its fixes by copying
files), and rrweb relies on things ADVANCED mode would rename or break
(serialised node fields such as `_cssText`, `rr_*` attributes, option and
event objects shared with the SDK and the replayer). esbuild bundles the
TypeScript as is. Upstream builds it with vite/rolldown, then Babel and terser
with property mangling of `_`-prefixed names (with rrweb's names reserved);
esbuild does no property mangling, which only renames internals.

**Size.** gzip -9: PostHog's 46.5 KB (46,549 bytes); ours 46.5 KB (46,464
bytes) unmodified, 46.7 KB (46,702 bytes) with the optimisations below; raw
144 KB vs 151 KB.

**Identical behaviour.** Before any change, with `src/` equal to
`original/`, every diff scenario was identical for both builds
(`node test/diff/run.mjs`, also with `DIFF_BUNDLE=lazy/posthog.js`): the
`replay_*` scenarios compare the decoded `$snapshot` payloads (recorded DOM,
mutations, node ids, custom events, network entries) between the official
SDK with PostHog's `lazy-recorder.js` and ours with this build.

## Changes from upstream

Build-only:

- `@posthog/core` resolves to `packages/core/src/utils/index.ts` (the
  recorder uses only helpers from there), marked side-effect free so esbuild
  drops the unused ones, as rollup does upstream.

Performance, none of which changes what is recorded (same events, same node
ids, same order; each is its own commit with the reasoning, and
`npm run test:recorder-equivalence` checks `src/` against `original/`):

- `utils/src/index.ts`: cached untainted methods (`contains`,
  `getRootNode`) are called with `.call` instead of a new bound function and
  cache key per call; the node accessors read their cached getter directly.
- `rrweb/src/record/mutation.ts`: removed subtrees are no longer walked when
  the removal is processed. The emission checks an added or moved node's
  parent's ancestors against the removed roots (memoised); the subtrees are
  still walked into `removesSubTreeCache` when the emission is deferred
  (frozen or locked buffer) or throws.
- `rrweb/src/record/index.ts`, `observer.ts`: event payloads are built with
  `Object.assign({source}, p)` instead of `{source, ...p}`, which the build
  lowers to an object-spread helper for its oldest targets.
- `rrweb/src/utils.ts`: `getWindowScroll` reads `document.scrollingElement`
  once.

`diff -ru original src` shows all of it.
