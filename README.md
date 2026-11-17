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

## Highlights

Same behaviour as official posthog-js 1.450.0 (every differential scenario
produces identical traffic), with a smaller and faster SDK. Like-for-like
numbers: our `lazy/posthog.js` against upstream's CDN `array.js`, both loading
their optional parts on demand, in headless Chrome with 4x CPU throttling
(roughly a mid-range phone).

| | official `array.js` | ours `lazy/posthog.js` | gain |
|---|---|---|---|
| Main script (gzip) | 122.4 KB | 82.4 KB | **-33%** |
| Downloaded at startup | 171 KB | 82.4 KB | **-52%** |
| Downloaded with session replay on | 244 KB | 151 KB | **-38%** |
| Downloaded with every ported feature on | 272 KB | 165 KB | **-39%** |
| Script load + parse + eval | 36.8 ms | 21.5 ms | **-42%** |
| `posthog.init()` | 26.0 ms | 16.5 ms | **-37%** |
| 1000 `capture()` calls | 495-580 ms | 269-297 ms | **~-50%** |
| SDK's own main-thread time in a 60 s analytics + autocapture + session replay session (CPU profile, rrweb excluded) | 1,421 ms | 792 ms | **-44%** |
| Total main-thread time added in that session, rrweb included (vs no SDK) | +2,312 ms | +1,503 ms | **-35%** |
| Data sent (events, recordings) | same | same | identical |

- **Session replay overhead**: rrweb itself (PostHog's fork, the same code in
  both SDKs) costs the same in both, about 380 ms per minute of a realistic
  session. Everything around it is cheaper in ours: event size estimates
  without a `Blob` per event (308 -> 22 ms), gzip validation with one read and
  a faster CRC-32 (436 -> 233 ms), and no redundant storage writes (195 -> 100
  ms), all without changing a single byte sent or stored. See
  [Benchmarks](#benchmarks) and the CPU profile there.
- **Pick what you load**: `posthog.core.js` alone is 35.2 KB gzip; every module
  is also a separate chunk, so core + flags is about 44 KB.
- **Fewer requests**: no `surveys.js` on every page (surveys are not ported),
  and no per-feature script unless the feature is on.

Every claim above is reproducible: `./scripts/build.sh`, then
`node test/diff/bench.mjs` (startup), `npm run bench:session -- --profile`
(session CPU) and `node test/diff/run.mjs` (parity, also with
`DIFF_BUNDLE=lazy/posthog.js`). The detailed tables follow.

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
| Downloaded with session replay on | 244 KB: + `lazy-recorder.js` 72.5 | 151 KB: + `replay.js` 21.2 + `recorder.js` 46.5 (PostHog's rrweb fork, rebuilt), ~0.62x |
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
(our `replay.js` and `recorder.js`, in parallel) where upstream
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
  compiles every lazy part in, loading only rrweb (`recorder.js`, PostHog's
  fork built from `third_party/posthog-rrweb`, next to the SDK); the lazy
  build loads its parts where upstream loads its `/static/` scripts (with
  replay as two scripts, see above).
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
  `/static/1.450.0/toolbar.js` (or PostHog's `recorder.js` with
  `closure_recorder_url: 'posthog'`), never for our own version. The diff test fails
  if our SDK requests an asset path that doesn't exist on the CDN.
- **ES5 output with no injected polyfills.** Like upstream, we target old
  browsers; we use no ES2015+ built-ins at all rather than polyfilling them.

### Benchmarks

Two benchmarks run real headless Chrome (`chromedp/headless-shell` in Docker,
see `test/diff/chrome.mjs`) against the fake PostHog server:

- `node test/diff/bench.mjs` measures script load, `init()` and 1000
  `capture()` calls on a bare page (the [Speed](#speed) table above).
- `npm run bench:session` (`test/bench/session.mjs`) measures a whole user
  session with analytics, autocapture and session replay on, on a realistic
  single page app, against a no-SDK baseline.

#### Session benchmark

```sh
./scripts/build.sh
npm run bench:session                          # 5 runs x 60 s, 4x CPU throttling
npm run bench:session -- --runs 3 --duration 120 --no-throttle
npm run bench:session -- --variants official,ours --seed 7
npm run bench:session -- --url https://example.com --journey generic   # bring your own site
```

Options: `--runs N` (default 5), `--duration S` (planned journey time per run,
default 60), `--throttle R` (CPU throttling rate, default 4) or
`--no-throttle`, `--variants none,official,ours[,lazy]` (`lazy` =
`dist/lazy/posthog.js`, included by default when it exists), `--seed N`,
`--url URL`, `--journey site|generic`, `--token T`, `--config JSON` (remote
config overrides), `--init JSON` (extra `posthog.init` options), `--out FILE`,
`--dump-logs DIR` (each run's raw fake-server log with decoded bodies, for
comparing what the SDKs sent), and the profiler options `--profile`,
`--profile-interval US`, `--profile-window session|load`, `--profile-only`
and `--save-profiles DIR` (see [CPU profile](#cpu-profile---profile)). The
runner prints a note, and records it in the JSON, when other headless Chrome
containers (`phc-diff-*`, e.g. diff tests in another worktree) were running
during the measurement.

**The demo app** (`test/bench/site/`, served at `/site/` by
`test/diff/server.mjs`) is "Lumen AI", a plain-JS single page app in the style
of an AI SaaS product, with no framework and no external assets: a landing
page (hero, hover menu, features, integrations, 24 template cards, blog,
testimonials, FAQ), a chat whose answers stream token by token and are
re-rendered as markdown with highlighted code blocks and tables on every
token (like React markdown renderers), a pricing page with a filterable and
sortable model catalogue (generated SVG artwork) and a detail modal, signup
and checkout forms (text, email, password, card number with formatting,
expiry, CVC, native selects, radios, checkboxes, textareas), and settings with
tabs, toggles, tables and custom dropdowns. Routes change through
`history.pushState`; there are about 390 CSS rules and 300-1,450 DOM nodes per
route at load (the chat transcript grows as answers stream). All content and
the streaming delays come from seeded PRNGs, so every variant renders the same
thing. The app knows nothing about analytics.

**Journeys** (`test/bench/journeys.mjs`) drive trusted CDP input
(`Input.dispatchMouseEvent`, `dispatchKeyEvent`, `insertText`) through
`test/bench/human.mjs`: mouse paths are eased cubic bezier curves with a
random bend, sampled at 60 Hz, with an overshoot and correction on a third of
long moves; scrolling is wheel bursts whose deltas decay like momentum
scrolling, over the scroll container under the pointer; typing has per-key
jitter (about 70 wpm), longer pauses after words and punctuation, and ~3%
typos (a neighbouring key, sometimes one more key, then Backspace); there are
pastes (password manager), Tab/arrow keys for native selects, hovers and
reading pauses with small idle mouse drifts. The journeys are *browse*
(landing, hover menu, scroll, pricing billing toggle, filter chip, sort,
model modal), *checkout* (email, card number, country, expiry, CVC, promo
code, pay), *chat* (two turns while answers stream, wheel up and down the
transcript, copy a code block), *signup* (every field type, terms, submit)
and *settings* (profile edit, toggles, API key, usage chart, team role
dropdown). They run back to back in that order, then in seeded random order.

Every decision comes from one seeded PRNG and runs on a *planned clock*: each
action waits until its planned time, and the session stops when the planned
time reaches `--duration`, even mid-journey. If the page lags (throttling, a
heavy SDK), actions start late but the plan doesn't change, so every variant
replays exactly the same input. At 60 s a session covers *browse*, *checkout*
and most of the first *chat* turn; `--duration 130` covers all five.

**What is measured**, after load and a 1 s settle, for the duration of the
journeys (runs are interleaved across variants; the table shows medians):

- main-thread task and script time (CDP `Performance.getMetrics`
  `TaskDuration` / `ScriptDuration`, wall time under throttling), and the SDK
  overhead: variant minus the no-SDK baseline running the same session;
- long tasks (`PerformanceObserver` `longtask`);
- INP from Event Timing (p75 and max over interactions, interactions under
  the 16 ms reporting threshold count as 0), and a next-paint probe (keydown
  or click to the first task after the next frame). The probe exists because
  headless Chrome sometimes reports no presentation for the keystrokes typed
  into a text field for seconds (they all end at the same later frame, with
  ~0 ms processing), in every variant including the baseline, which makes the
  Event Timing *max* meaningless; the p75 is unaffected;
- JS heap at the end and the peak of 1 s samples;
- requests, wire bytes and events for `/e/` and `/i/v0/e/`, and for `/s/`;
  `$snapshot` events, rrweb events and full snapshots; time from navigation to
  the fake server receiving the first full snapshot.

The JSON in `test/bench/results/<timestamp>.json` (gitignored) has every
sample, including per-request wire and decoded sizes, event names by type,
slow interactions, input counts and the planned-clock lag.

**Bring your own site** (`--url`): the SDK is injected into an arbitrary page
with `Page.addScriptToEvaluateOnNewDocument` (a loader that appends the SDK
`<script>` as soon as the document has a root, then calls `posthog.init`,
plus the same instrumentation). The api_host is `https://ph.example.test`:
nothing listens there, but the CDP `Fetch` domain pauses every request to it
and the runner forwards it (method, headers, raw body from `postDataEntries`)
to the fake server and fulfils it with the response, CORS headers included.
Because the api_host is https, https pages don't hit mixed content blocking
(an `http://ph.example.test:<port>` api_host is blocked there), and no TLS is
needed since requests are answered before any connection. The SDK bundles and
the lazy-loaded `/static/` assets go through the same route.
`Page.setBypassCSP` keeps the site's CSP from blocking the script and
requests. The generic journey hovers visible links and buttons, clicks
non-submit buttons (menus, tabs, accordions), types into the first visible
text input, and scrolls; link clicks and form submits are `preventDefault`ed
in the capture phase and main-frame document requests are failed after load,
so the session stays on the page. Pass `--token` and `--config` to shape the
remote config (replay and autocapture are on by default). Caveats: results
include the site's own network, third-party scripts, ads and CPU, and the
page can differ between runs (A/B tests, rotating content, cookie banners), so
use more runs and read the overhead columns rather than absolute numbers; a
site that already loads PostHog will conflict with the injected one; iframes
are not instrumented; bot protection may serve a different page to headless
Chrome.

**Results** (`npm run bench:session`: demo app, 60 s journeys, 5 runs, 4x CPU
throttling, medians; official 1.450.0 `array.js` vs our `posthog.full.js`, at
b400924). Another agent's Chrome diff tests were running on the same machine
during this run, so absolute times are somewhat noisy (one official run was an
outlier at +2.4 s, which the median absorbs); the differences against the
baseline and between the SDKs are what matter. The session covered *browse*,
*checkout* and the first chat turn (68 interactions: 17 clicks and 51 key
presses, plus 728 mouse moves and 471 wheel events).

| | no SDK | official | ours |
|---|---|---|---|
| Main-thread task time (SDK overhead) | 3,279 ms | 5,684 ms (+2,404) | 5,421 ms (+2,141, -11%) |
| Script time (SDK overhead) | 153 ms | 1,425 ms (+1,272) | 1,290 ms (+1,137, -11%) |
| Long tasks | 1 (56 ms) | 4 (426 ms) | 4 (403 ms) |
| INP p75 / max (Event Timing) | 16 / 192 ms | 16 / 200 ms | 16 / 200 ms |
| Next-paint probe p75 / max | 11 / 66 ms | 16 / 152 ms | 16 / 134 ms |
| JS heap at end / peak | 1.1 / 1.4 MB | 7.0 / 7.9 MB | 5.6 / 8.1 MB |
| Analytics: events (requests), wire KB | - | 30 (15), 21.9 KB | 30 (15), 22.5 KB |
| Replay: `$snapshot` (requests), rrweb events, full snapshots | - | 29 (17), 685, 1 | 29 (17), 684, 1 |
| Replay wire KB | - | 204.1 KB | 208.0 KB |
| First full snapshot received | - | 6.6 s | 6.6 s |

How to read it:

- **Both SDKs send the same data.** Per run, the two SDKs made the same
  requests in the same order with the same events (5 `$pageview`, 24
  `$autocapture`, 1 `$pageleave`; 674 incremental, 1 full, 1 meta and 8 custom
  rrweb events). Decoded analytics bodies are within a few bytes of each other
  (`$lib_version`); replay bodies within 0.1-1% (the recorded DOM contains the
  SDK and recorder `<script>` URLs, which differ by design, and mouse and
  scroll samples follow timing). The rrweb event count wobbles by ±1-2 between
  runs in both. The 0.6 KB / 3.9 KB more on the wire
  comes entirely from the three requests compressed synchronously: the initial
  `$pageview` (`send_instantly`), the `$pageleave` and the last replay batch on
  unload, which upstream gzips with fflate's dynamic Huffman and we with our
  smaller fixed-Huffman encoder (868 vs 1,061, 1,313 vs 1,608 and 24.7 KB vs
  29.0 KB); every CompressionStream-compressed request is the same size within
  a few bytes. Same data and same rrweb also mean the same first full snapshot
  time: about 6.6 s from navigation at 4x throttling (load, remote config, the
  recorder script, the snapshot of a 1,450-node page, then the first flush).
- **Most of the cost is session replay, and it is the same code.** About 4%
  of the main thread over the 60 s session goes to the SDK in both cases
  (+2.1-2.4 s of main-thread time at 4x throttling). rrweb (PostHog's fork, loaded at runtime by both) observes every
  mutation of the streamed chat answer and every re-rendered catalogue card
  and serialises them; the SDKs then size, batch and compress the events.
  The [CPU profile](#cpu-profile---profile) below splits this up: rrweb
  itself is the same in both and only about a fifth of the SDK time; most of
  the rest is replay logic that both SDKs share by design (event size
  estimates, compression), and our ~11% less script and task time comes
  from that SDK-side code. The long tasks are the same
  ones in both (SDK and recorder evaluation, the full snapshot, serialising
  large route renders) and slightly shorter in ours.
- **Interactions stay fast in both.** INP p75 is at the 16 ms floor with or
  without an SDK; the worst next-paint latency roughly doubles with either SDK
  (a click that triggers a large route render while rrweb serialises the
  mutation). The Event Timing max (~200 ms) is the headless keystroke artefact
  described above and is the same in the baseline.
- **Heap.** Peaks are the same (~8 MB, rrweb's mirror of the DOM and the
  replay buffer before a flush); at the end of the session ours holds about
  1.4 MB less.

A bring-your-own-site check on `https://en.wikipedia.org/wiki/Web_analytics`
(generic journey, 30 s, 3 runs, 4x throttling, official vs ours only) showed
the same picture: the same events and requests, ~6% less task and ~7% less
script time for ours, and a lower heap peak (20 vs 28 MB). One visible
difference there is timing, not data: our recorder starts about 0.4 s
earlier after load (full snapshot at ~0.6 s vs ~1.0 s), so it also records
the input and stylesheet changes Wikipedia's own scripts make right after
load (~30 more rrweb events). rrweb records programmatic input changes as
`Input` events, which both SDKs count as user activity, so they release the
"no interaction since recording started" hold, and in most runs ours ships its first batch
at ~3.2 s while the official SDK, which started after those changes, waits for
the first real mouse move (~8.7 s). Given the same events, both SDKs make the
same decisions.

#### CPU profile (`--profile`)

Both SDKs record with the same rrweb build (ours loads `/static/1.450.0/recorder.js`,
rrweb only; official loads `lazy-recorder.js`, rrweb plus upstream's replay
logic), so the totals above mostly measure rrweb twice. `--profile` says where
the time goes:

```sh
npm run bench:session -- --profile                        # plain runs + profiled runs
npm run bench:session -- --profile-only --profile-window load --runs 3
npm run bench:session -- --profile --save-profiles /tmp/profs   # keep .cpuprofile files
node test/bench/profile.mjs /tmp/profs [--update results.json]  # re-attribute saved profiles
```

After each round of plain runs, every variant runs once more with the CDP
sampling profiler (`Profiler.setSamplingInterval` 100 µs, same settings for
every variant). The profiler starts before and stops after the metrics
snapshots, so the plain runs and their tables are unaffected. Profiling
added 2-4% to the profiled runs' task time. `--profile-window load` starts
it before navigation, which adds SDK evaluation, `init` and the first full
snapshot. `test/bench/profile.mjs` charges the self time of every sample to
an original file and function, through the source maps (`node:module`
`SourceMap`, no dependencies): `dist/*.js.map` for ours, and the `.map` files
next to `array.js`, `lazy-recorder.js` and `recorder.js` for the official
SDK. Names come from the maps' `names` (terser puts them on the name token,
Closure on the `function` keyword), then from the original source line, and
otherwise fall back to `file:line`. It also sorts the time into buckets:

- the page;
- the SDK bundle;
- PostHog replay logic: `src/replay/*` in ours, and everything in
  `lazy-recorder.js` that isn't rrweb;
- rrweb and its plugins: rrweb-record, the console plugin and the network
  plugin, in both recorder files;
- other `/static/` scripts;
- browser (natives with no JS caller), GC, `(program)` and `(idle)`.

Native callees (`Blob`, `localStorage.setItem`, `closest`, ...) and unmapped
babel helpers (`_objectSpread2` at the top of both recorder files) are charged
to their closest JS caller and listed as `[native] X <- caller`. In
`--profile-window load` profiles Chrome doesn't report natives as separate
frames, so their time is in the caller's self time.

rrweb sits in both bundles as one pre-built file
(`rrweb/record/dist/rrweb-record.js`), and its own source map isn't published.
To get from there to rrweb's TypeScript files, the profiler indexes the
functions declared in `upstream/packages/rrweb` (same version as 1.450.0; in
a worktree the profiler finds the main checkout's `upstream/`, or set
`PH_UPSTREAM`). Every function definition in the bundle whose name is unique
to one rrweb file anchors its `rrweb-record.js` line to that file. The modules
come out as contiguous line ranges, e.g. `snapshot.ts` at 1364-2244 and
`mutation.ts` at 2669-3291. An anonymous function takes the file of the anchor
before it and is named after the closest definition, e.g.
`(anonymous, after findStylesheet) rrweb-record.js:1805`, which is
`serializeElementNode` (terser inlined it into `serializeNode`). rrweb time is
reported in two ways:

- **by code:** the rrweb file the sampled function lives in;
- **by context:** the innermost rrweb frame on the stack that says what rrweb is
  doing. For example, `serializeNodeWithId` under `pushAdd` counts as
  mutations, and under `takeFullSnapshot` as the full snapshot.

`build.sh` writes a source map for every single-file bundle and for the lazy
build and each of its chunks (`dist/lazy/*.js.map`), so the `lazy` variant's
frames are attributed too. The `dist/chunks/` build has no maps.

`test/bench/activities.mjs DIR [--root ROOT] [--detail N]` sorts the SDK-only
time of saved profiles (`--save-profiles DIR`) by activity: size estimates,
compression, persistence, session ids, autocapture, scroll manager, requests.
It is inclusive: a sample counts for the innermost frame on its stack that
belongs to an activity, so the `Blob` constructor and the `JSON.stringify`
under `estimateSize` both count as size estimates. `--root` points at the
checkout whose `dist/` was profiled, to compare an older build.

**Results** (5 rounds of plain + profiled runs, 60 s journeys, 4x
throttling, medians, at c661e53; `--profile-window load` with 3 runs for the
full snapshot). Other agents' Chrome diff tests (`phc-diff-344657`,
`-369769` and `-391746`) were running on the machine during the measurement
(load average up to 14 on 24 cores). One profiled official run took about twice
as long as the others, and the medians absorb it. The plain-run table matched the one above:

| | none | official | ours |
|---|---|---|---|
| Δ task / Δ script (plain runs) | - | +2,169 / +1,315 ms | +1,961 / +1,196 ms |

Self time in the measured window, from the profiled runs:

| | no SDK | official | ours |
|---|---|---|---|
| Page / app code | 248 ms | 244 ms | 247 ms |
| SDK bundle (excl. replay logic) | - | 655 ms (36%) | 536 ms (33%) |
| PostHog replay logic | - | 775 ms (43%) | 690 ms (43%) |
| **SDK-only** (bundle + replay logic) | - | **1,430 ms** | **1,226 ms (-14%)** |
| **rrweb** + recorder plugins | - | **379 ms (21%)** | **378 ms (24%)** |
| SDK total (incl. rrweb) | - | 1,809 ms | 1,604 ms |
| GC / (program) / natives without a JS caller, Δ vs no SDK | - | +61 / +486 / +76 ms | +57 / +587 / +60 ms |
| Busy main thread (not idle) | 3.6 s | 6.0 s | 5.9 s |

Percentages are shares of the SDK total. Time by SDK-side activity
(function-level groups from the same profiles; they overlap the buckets
above):

| SDK-side activity | official | ours |
|---|---|---|
| Event size estimates (`estimateSize`: `JSON.stringify` + `new Blob([json]).size`, per rrweb event) | 309 ms | 296 ms |
| Compression (`CompressionStream`, checking its output: header and trailer read back from the blob plus a CRC-32 of the input; `serializeForCompression`; fflate / our encoder) | 442 ms | 364 ms |
| Persistence (`localStorage.setItem`, `document.cookie` reads) | 194 ms | 137 ms |
| Autocapture, heatmaps, dead clicks | 86 ms | 89 ms |
| Scroll manager | 56 ms | 55 ms |

rrweb time:

| rrweb by context | official | ours |
|---|---|---|
| Mutations (observer callback, `processMutations`, serialising added nodes, removes) | 276 ms (73%) | 266 ms (70%) |
| Scroll observer (`getWindowScroll`, `emitScrollPosition`, per-target throttle) | 47 ms | 48 ms |
| Input observer | 24 ms | 30 ms |
| Helpers with no specific caller (throttle timers, `callbackWrapper`) | 23 ms | 25 ms |
| Emit / buffering (`wrappedEmit`, record/index.ts) | 8 ms | 7 ms |
| Mouse move, mouse interaction, selection, stylesheets | ~6 ms | ~7 ms |
| Full snapshot (load window only: 1,450 nodes at 4x) | 54 ms | 53 ms |

| rrweb by code (file) | official | ours |
|---|---|---|
| rrweb utils (`isBlocked`/`closest`, untainted DOM accessors, `throttle`, `getWindowScroll`) | 126 ms | 116 ms |
| mutation.ts | 75 ms | 72 ms |
| rrweb-snapshot snapshot.ts (serialisation) | 67 ms | 68 ms |
| observer.ts | 51 ms | 62 ms |
| rrweb-snapshot utils.ts (Mirror: `getId`, `add`, `removeNodeFromMap`) | 41 ms | 41 ms |
| record/index.ts | 34 ms | 33 ms |

Top rrweb functions, ours, measured window. Official is within a few ms of
each. The full lists are in the console output and the JSON:

- `serializeElementNode`: 27 ms;
- `serializeNodeWithId`: 17 ms;
- `processBufferedMutations`: 15 ms;
- the `callbackWrapper` wrapper: 14 ms;
- the removed-subtree walk in `genRemoves` (`rrweb-record.js:3273`, fills
  `removesSubTreeCache`): 12 ms;
- `pushAdd`: 12 ms;
- the object-spread helper in the attribute path of `processMutation`: 9 ms;
- `removeNodeFromMap`: 9 ms;
- `isBlocked` + `closest`: 14 ms;
- the untainted `childNodes` / `parentNode` accessors (`getUntaintedAccessor`,
  `getUntaintedMethod`, native getters): about 20 ms;
- `getWindowScroll` + `emitScrollPosition`: 14 ms.

How to read it:

- **rrweb is the same in both, so there is no parity gap there.** 379 vs
  378 ms over the session, 438 vs 446 ms from navigation. The activity split
  matches within noise, and so do the event counts: 684-686 rrweb events
  with one full snapshot. The two SDKs pass the same record options.
- **SDK-only, ours is about 14% cheaper:** 1,226 vs 1,430 ms in the window,
  1,344 vs 1,550 ms from navigation. The SDK bundle is 18% cheaper (less
  persistence work: 137 vs 194 ms in `localStorage` and cookie reads). The
  replay logic is 11% cheaper (compression 364
  vs 442 ms). This is where the ~11% difference in plain task and script
  time comes from.
- **rrweb is not the dominant cost.** It is about a fifth of the SDK's JS
  time: 378 ms of a 5.9 s busy main thread (6%), or about 0.6% of the 60 s
  session at 4x throttling. Two pieces of replay logic shared by both SDKs
  each cost about as much as all of rrweb:
  - the size estimate, mostly the `Blob` constructor: a `Blob` per rrweb event
    only to read `.size`;
  - compression.
- **What optimising rrweb could gain.** On this app rrweb does mutation work:
  the chat re-renders the whole answer on every streamed token. At best that
  is a few hundred ms per minute at 4x, perhaps 100-200 ms (5-10% of the SDK
  overhead) without changing what is recorded:
  - *Addressable without changing the output:*
    - caching `isBlocked`/`closest` per node within a mutation batch;
    - avoiding the full removed-subtree walk in `genRemoves` and the recursive
      `removeNodeFromMap` (both re-walk every removed answer subtree through
      the untainted `childNodes` accessor);
    - cheaper untainted accessors (the getter `.call` per node);
    - the babel object-spread helper in the attribute path, which is in
      `recorder.js` because it is transpiled;
    - scroll handling: a `setTimeout` per throttled wheel event, plus a
      `getWindowScroll` read per event.
  - *Needs recording-semantics changes:* the bulk of mutation cost is
    serialising the re-added nodes (`serializeElementNode`,
    `serializeNodeWithId`, `_serializedNode`, Mirror `add`), and that is
    proportional to what the page re-renders. Reducing it means recording
    less: coalescing mutations across frames, diffing re-rendered subtrees
    instead of re-adding them, or throttling high-frequency text mutations.
    Each of these changes the event stream and the replay. The full snapshot
    (~54 ms once) and stylesheet handling (<5 ms) aren't worth attacking
    here.
- **Bigger, simpler wins sit outside rrweb.** Replacing
  `new Blob([json]).size` with a UTF-8 byte count gives the same number
  without the blob allocation (the `Blob` constructor alone is 265-280 ms here; a byte-count loop would cost a fraction of that). Compression could check its
  output more cheaply (two blob reads and a CRC-32 per compressed event). Both are in the shared replay logic, so
  they would apply to either SDK, and neither changes what is sent. These
  are now done (below).

#### Hot-path optimisations

The SDK-side hot spots above are now cheaper, with the same wire bytes, the
same persisted state and the same decisions. Both diff suites stay identical,
and each change is its own commit:

- **Size estimates.** `estimateSize` (every rrweb event), the network
  plugin's body limit and the request size estimate count UTF-8 bytes with
  `TextEncoder.encodeInto` into a reused 64 KB buffer (`utf8ByteLength` in
  `src/core/utils.js`) instead of `new Blob([s]).size`. Blob and TextEncoder
  both take a USVString, so a lone surrogate counts as U+FFFD (3 bytes) in
  both. `test/utf8.test.mjs` fuzzes this against Node's `Blob`.
  `estimateSize` also runs plain `JSON.stringify` first and upstream's
  circular-reference replacer only when that throws. The replacer changes
  nothing unless a value is its own ancestor, which plain stringify
  rejects. `replay.test.mjs` fuzzes this against upstream's expression.
- **Compression.** Upstream reads CompressionStream's output back three
  times: header and trailer as blob slices for validation, then the whole
  blob. We read the whole blob once and run the same checks in the same
  order on those bytes. The output is still collected with
  `Response.blob()`, so Safari 16's `NotReadableError`, which turns native
  gzip off, surfaces as before. `test/gzip-native.test.mjs` runs both
  validations on corrupted CompressionStream outputs. CRC-32 is now
  slicing-by-8 over `Int32Array` tables (same value as zlib, about 6x
  faster).
- **Persistence.** The trigger matchers call `register_for_session` three
  times per rrweb event, and each call rewrote the same key list into
  `sessionStorage`. `WebStore.set` now reads the item first and skips
  `setItem` when it already holds the value. By spec that `setItem` is a
  no-op anyway (no storage event, no quota check), and a change made by
  another frame, tab or the page is still overwritten. The key list's JSON
  is cached while the list is unchanged, and the persistence blob is
  written with the JSON its no-op fingerprint already built. Cookie writes
  are untouched, since each one refreshes the expiry. Two-tab scenarios in
  `test/scenarios.mjs` share localStorage and a cookie jar between two SDK
  copies.

Same benchmark, before (at 1344a11) and after (at 05400ea): 5 rounds, 60 s,
4x throttling, medians. No other `phc-diff` containers were running and the
load average stayed under 2 on 24 cores. SDK-only self time by activity,
from `test/bench/activities.mjs`:

| SDK-side activity | official | ours before | ours after | lazy before | lazy after |
|---|---|---|---|---|---|
| Size estimates | 308 ms | 304 ms | 22 ms | 299 ms | 22 ms |
| Compression (replay fields and request bodies) | 436 ms | 344 ms | 235 ms | 354 ms | 233 ms |
| Persistence (storage, cookies) | 195 ms | 140 ms | 99 ms | 144 ms | 100 ms |
| **SDK-only total** | **1,421 ms** | **1,218 ms** | **795 ms** | **1,227 ms** | **792 ms** |
| SDK total incl. rrweb | 1,788 ms | 1,586 ms | 1,153 ms | 1,606 ms | 1,144 ms |

| Plain runs, vs no SDK | official | ours before | ours after | lazy before | lazy after |
|---|---|---|---|---|---|
| Δ task | +2,362 / +2,312 ms | +2,057 ms | +1,608 ms | +2,112 ms | +1,503 ms |
| Δ script | +1,290 / +1,260 ms | +1,164 ms | +880 ms | +1,179 ms | +820 ms |

(official: before / after run.) SDK-only time is down about 35% and is now
44% below official's. The plain-run overhead dropped by 450-600 ms of task
time and about 300-350 ms of script time. Requests, events, rrweb event
counts and replay bytes are unchanged. An intermediate run, without the
key-list JSON cache, measured +1,435 / +813 ms (ours) and +1,505 / +840 ms
(lazy), so plain-run Δs move by about ±100 ms between runs.

What remains is native work that upstream does too:

- `Response.blob()` and the blob read, CompressionStream setup and
  `close()`, and serialising the fields;
- `request.js` compresses `/e/` bodies with CompressionStream (~25 ms; it
  now also validates the output like upstream, with the same single read,
  see [Fixed differences](#scope));
- the first `document.cookie` read in each capture (~26 ms; Chrome caches
  later reads within the task);
- the persistence fingerprint's `JSON.stringify`.


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
src/replay/        optional: session replay (rrweb is loaded at runtime from recorder.js)
src/web-vitals/    optional: $web_vitals (Google's web-vitals compiled in from third_party/)
src/tracing-headers/ optional: tracing headers / traceparent on the app's fetch and XHR
third_party/web-vitals/ Google web-vitals 6.2.1 (Apache-2.0), ported to JSDoc; see its README
third_party/posthog-rrweb/ PostHog's rrweb fork (MIT) as in posthog-js 1.450.0's recorder.js, with
                   our optimisations; built into dist/recorder.js (see its README)
src/otlp/          shared OTLP helpers for logs and metrics (attribute encoder, resource
                   attributes, flush timer, backoff, the console/fetch `patch` layer)
src/logs/          opt-in: posthog.captureLog / posthog.logger / posthog.logs and console
                   log capture, sent to /i/v1/logs as OTLP (needs otlp)
src/metrics/       opt-in: posthog.metrics (count, gauge, histogram, network metrics),
                   sent to /i/v1/metrics as OTLP (needs otlp)
src/toolbar/       opt-in: the toolbar loader (posthog.loadToolbar, posthog.toolbar)
src/entry/         bundle entry points (core, core-flags, full, lazy)
docker/closure-compiler/Dockerfile   Closure Compiler v20261109 (official Maven jar, JRE 21)
docker/recorder-build/Dockerfile     node 24.21.0 + esbuild 0.25.12, for recorder.js
scripts/build.sh   builds every bundle in Docker (and calls build-recorder.sh)
scripts/build-recorder.sh  builds recorder.js (rrweb) from third_party/posthog-rrweb
test/              Node harness (fake browser) + headless-Chrome smoke test
test/diff/         differential test vs the official SDK (fake PostHog server, CDP driver)
test/bench/        session benchmark: demo app (site/), human-like input, journeys
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
| `dist/recorder.js`, `dist/chunks/recorder.js`, `dist/lazy/recorder.js` | rrweb (PostHog's fork) and its console and network plugins, next to each build; esbuild, not Closure | ~46.5 KB |

Session replay loads `recorder.js` (rrweb and its console and network
plugins) when recording starts, from next to the SDK script (see
[Session replay's recorder](#session-replays-recorder-rrweb)). Upstream loads
`lazy-recorder.js` instead (~72.5 KB: rrweb plus the replay logic that is
compiled into our bundle).

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
| `lazy-recorder` | `replay` + `recorder.js` (rrweb), requested together | recording starts (remote config, `startSessionRecording`) |
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
The replay chunk is the half of `lazy-recorder.js` we own; rrweb comes from
`recorder.js` next to the chunks, requested at the same time, and recording starts
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
its keys.) `recorder.js` sits next to the chunks too, so this key moves it as
well (`closure_recorder_url` overrides it). PostHog-hosted assets stay
PostHog-hosted: the remote config (`/array/<token>/config.js`) and
`toolbar.js`. The build is a
Closure chunk graph rooted at `posthog.js` with its own namespace object,
`window.__phl`, so it can share a page with the chunk build (`__phc`).

The standard PostHog HTML snippet also works. Calls the snippet queued before
the SDK loaded are replayed after `init`, with `identify` and `register` going
first.

### Session replay's recorder (rrweb)

rrweb is not compiled into any build: like upstream, session replay loads it
when recording starts, as `recorder.js` (rrweb's record side plus the console
and network plugins, with upstream's entry point and globals:
`__PosthogExtensions__.rrweb.{record, version, wasMaxDepthReached, ...}`,
`__PosthogExtensions__.rrwebPlugins`, `window.rrweb`, ...). We build that
file ourselves from PostHog's fork, vendored in
[`third_party/posthog-rrweb`](third_party/posthog-rrweb/README.md):

- **Source.** The fork as posthog-js 1.450.0 shipped it: upstream builds
  `recorder.js` from its pnpm workspace (`packages/rrweb`,
  `@posthog/rrweb-record` 0.0.89) at the release tag `posthog-js@1.450.0`
  (`63bc454`), which is the commit our `upstream/` clone is at. Those fork
  versions are not on npm, so the tag is the source. `original/` keeps the
  files unchanged; `src/` is what we build, with the optimisations below.
- **Build.** `scripts/build-recorder.sh` (run by `build.sh`) bundles the
  TypeScript with esbuild 0.25.12 on node 24.21.0 in a pinned Docker image
  (`docker/recorder-build`), minified with a source map, for the browsers
  upstream's Babel config targets. It is PostHog's TypeScript fork, not a
  port, so it is **not** Closure-compiled: it stays diffable against upstream,
  and ADVANCED renaming would break the names rrweb shares with its data and
  the replayer. No npm dependency is added to the SDK; the one dependency of
  the record side (`base64-arraybuffer` 1.0.2, MIT) is vendored.
- **Output.** The same file is written next to every build that loads it:
  `dist/recorder.js`, `dist/chunks/recorder.js`, `dist/lazy/recorder.js`.
  46.5 KB gzip (46,464 bytes) against PostHog's 46.5 KB (46,549 bytes).
- **Where it is loaded from.** `closure_recorder_url` (upstream has no
  `closure_*` keys):

  ```js
  posthog.init('phc_...', {})                                       // <SDK dir>/recorder.js?v=<our version>
  posthog.init('phc_...', { closure_recorder_url: 'https://cdn.example.com/rec.js' })  // that URL
  posthog.init('phc_...', { closure_recorder_url: 'posthog' })      // PostHog's /static/1.450.0/recorder.js
  ```

  Unset, it is next to the SDK script, found like the lazy build's chunks
  (`document.currentScript` while the SDK runs; in the lazy build, next to the
  chunks, so `closure_lazy_chunks_url` moves it too). If that directory is
  unknown (the SDK was not loaded by a `<script src>`), PostHog's
  `recorder.js` is loaded instead. `'posthog'` loads PostHog's CDN build as
  before, with upstream's URL rules (`asset_host`, `?v=`,
  `strict_script_versioning`). Either way it is injected with the core's
  `loadScript` (`prepare_external_dependency_script`,
  `disable_external_dependency_loading`, `external_scripts_inject_target`).
- **Same recording.** Before any change to the fork, every diff scenario was
  identical for both builds with our `recorder.js` against official 1.450.0
  with PostHog's `lazy-recorder.js`. The `replay_*` scenarios compare the
  decoded `$snapshot` payloads, node ids included. That is the evidence that
  the rebuild records exactly what PostHog's build records.

#### Recording equivalence test

The diff suite compares our SDK with the official one on short scenarios.
Changes to the fork itself are checked against the unmodified fork on the
session benchmark's journeys:

```sh
./scripts/build.sh
npm run test:recorder-equivalence                      # 60 s journeys, 4x CPU, seed 1
npm run test:recorder-equivalence -- --runs 3 --duration 120 --seed 7
npm run test:recorder-equivalence -- --self            # original vs original (harness check)
```

It builds `third_party/posthog-rrweb/original` and `src` into
`dist/equivalence/`, loads both into the demo app page, then our
`posthog.full.js` with replay on. The SDK sees one rrweb whose `record`
starts both recorders with the options it passes (plugins included) and
forwards `addCustomEvent`, `takeFullSnapshot` and `freezePage` to both, so
both record the same DOM, input and SDK calls at the same time. Each
recorder's events are serialised as they are emitted; after the journeys the
two streams must be identical, event for event, node ids included. Only each
event's wall-clock `timestamp` is normalised. The two copies run on a shared
clock (test builds only, `build.mjs --equivalence`): `Date.now` is frozen for
the duration of a task and timers due at the same moment run in one task, so
a millisecond ticking between the two copies' handlers can't change a
throttle decision (mouse moves, scroll). A 60 s run records ~650-750 events
(~1.2 MB).

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
node --test test/gzip-native.test.mjs  # native gzip validation (requests and replay), crc32 vs zlib
node --test test/strtou8.test.mjs      # sync gzip's UTF-8 step vs fflate's strToU8
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
(`/sdk/ours/lazy/<chunk>.js`, including `recorder.js`) happen in the same
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
loads `/static/lazy-recorder.js` from the vendored official dist, ours our
`dist/recorder.js` (in the lazy build `dist/lazy/recorder.js`, plus its
`replay` chunk) next to the SDK (`/static/` and `/sdk/` requests are not
compared). The normaliser
decodes the per-event `cv: '2024-10'` gzip fields and compares the recorded
DOM, mutations, custom events (including `$posthog_config`) and network entries
with node ids as-is. rrweb timestamps, browser-measured network timings and
transfer sizes are volatile; the SDK and recorder `<script>` URLs in the
recorded DOM are normalised (scheme and host included: upstream's comes from
the assets host, ours from the SDK's), and so is the recorder script's
`nextHopProtocol` in the network plugin's initial entries (the browser
exposes it only for our same-origin script); `$snapshot_bytes` is checked against the payload
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
  the debug properties and the public API. rrweb comes from our
  `recorder.js` (PostHog's fork, rebuilt; see
  [Session replay's recorder](#session-replays-recorder-rrweb)) next to the
  SDK, or from PostHog's with `closure_recorder_url: 'posthog'` (then with the
  same URL rules as upstream's lazy scripts: `?v=`,
  `strict_script_versioning`, `asset_host`), unless
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

- **Intentional:** in browsers without `TextEncoder`, the sync gzip path
  (beacons, `send_instantly`, no CompressionStream, replay's unload drain)
  sends correct UTF-8. Upstream's fflate `strToU8` mis-encodes surrogates
  there: it merges any surrogate with the next code unit, so emoji arrive as
  wrong code points (U+1F600 as U+1DA00) and a lone surrogate swallows the
  character after it (e.g. a closing quote). Ours produces exactly what
  `TextEncoder` would: same length as fflate for well-formed text; a lone
  surrogate becomes U+FFFD and the next character is kept, so that case can be
  up to 2 bytes longer. With `TextEncoder` (every current browser) both SDKs
  send identical bytes. `test/strtou8.test.mjs` covers both paths.
- Not ported (opt-in upstream, off by default): `split_storage`,
  `cookieWinsOnConflict` cross-subdomain identity reconciliation, cross-tab
  feature-flag merging, `/flags` timing metrics (`metrics.flags`),
  `rewriteRequestPath` ingestion-endpoint tracking (the rewrite itself works).
- Sync gzip (beacons, `send_instantly`, no CompressionStream) uses a compact
  LZ77 + fixed-Huffman encoder instead of fflate: same decoded payload
  (the input is UTF-8 encoded by a port of fflate's `strToU8`), somewhat
  larger bodies.
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

**Fixed differences** (each has a diff scenario that failed before the fix)

- Request compression is validated like upstream. `/e/` (and every other
  gzip-js) body compressed with CompressionStream is checked with upstream's
  `validateNativeGzip` (header, CRC-32 and size trailer; the code in
  `src/core/gzip.js` that session replay also uses). Invalid output turns
  native gzip off and the body is compressed synchronously; a
  `NotReadableError` turns it off and sends that body uncompressed; any
  other error falls back to the sync encoder for that body only. Before,
  invalid output was sent as is (or uncompressed, without a gzip header).
  Scenarios `gzip_native_bad_crc`, `gzip_native_bad_header`,
  `gzip_native_throws_once`, `gzip_native_not_readable`.
- Lone surrogates in synchronously gzipped bodies. Before, the sync
  encoder's UTF-8 step used `encodeURIComponent`, which throws on a lone
  surrogate: a `send_instantly` batch went uncompressed as JSON and an unload
  beacon batch was dropped (its base64 fallback throws too). Now it never
  throws and encodes like `TextEncoder` (identical to upstream wherever
  `TextEncoder` exists; see the intentional difference above for browsers
  without it). This applies to engines whose `JSON.stringify` leaves lone
  surrogates raw (before ES2019's well-formed stringify); replay's sync field
  compression uses the same encoder. Scenario `gzip_lone_surrogate` (emulates
  that `JSON.stringify`), `test/strtou8.test.mjs`.

PostHog's original license is kept in `LICENSE.upstream`.
