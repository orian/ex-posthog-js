# web-vitals 6.2.1 (Google), ported for Closure

- Upstream: https://github.com/GoogleChrome/web-vitals (tag `v6.2.1`)
- Source used: the npm release https://registry.npmjs.org/web-vitals/-/web-vitals-6.2.1.tgz,
  integrity `sha512-rLcLXA2sx6+9dE88NHFubwTtGxpK4yYBLj6qHPdFoCaLr0cXGb4efOqtKLlm4loGA4OEKHIQKMKzZkKyOh5ctw==`
  (the version posthog-js 1.450.0 pins in its lockfile, for both `web-vitals` and
  the `web-vitals-soft-navs` alias)
- License: Apache-2.0, see `LICENSE` (copied unchanged from the package)

`original-src/` is the package's `src/` directory, unmodified, for reference
and diffing. It is not compiled.

The compiled port:

| File | Ports |
|---|---|
| `lib.js` | `src/lib/*` (bfcache, bindReporter, doubleRAF, the entry managers, generateUniqueID, getActivationStart, getLoadState, getNavigationEntry, getSelector, getVisibilityWatcher, initMetric, initUnique, InteractionManager, observe, polyfills/interactionCountPolyfill, runOnce, softNavs, whenActivated, whenIdleOrHidden) |
| `metrics.js` | `src/onFCP.ts`, `src/onCLS.ts`, `src/onINP.ts`, `src/onLCP.ts` |
| `attribution.js` | `src/attribution/onFCP.ts`, `onCLS.ts`, `onINP.ts`, `onLCP.ts` |

`onTTFB` and the package's `index.ts` re-exports are not ported (PostHog does
not use TTFB).

## Why a JSDoc port rather than compiling the package's JS

The package ships ES modules (`dist/modules/*.js`), but they cannot be used as
Closure ADVANCED inputs as they are: every metric and attribution field
(`name`, `value`, `rating`, `navigationType`, `interactionTarget`, ...) is data
handed to the caller and ends up in PostHog's `$web_vitals` event, so ADVANCED
renaming would corrupt it unless each of those keys is quoted. The modules also
use ES2015+ runtime features (`for...of` over Sets/Maps, array/object spread,
`Array.prototype.at`/`findLast`/`find`/`includes`, `Array.from`) that would
need Closure's polyfills and runtime library, which this build turns off. A
port with quoted data keys and JSDoc types type-checks under the strict build
with no suppressions and no extra externs beyond the performance timeline
types Closure lacks (`externs/web-vitals.js`).

## What changed (behaviour is that of 6.2.1)

- Data objects (metrics, attribution, report options, PerformanceObserver
  init) use quoted keys; internal fields of the entry managers and of
  `Interaction` are renamed by Closure (they were `_`-prefixed internals).
- `Array.prototype.at(-1)`, `findLast`, `find`, `includes`, `Array.from`,
  `startsWith`, `for...of` and spread are replaced by equivalent ES5 code. The
  PostHog entrypoints install `Array.prototype.at` / `findLast` polyfills on
  the page before evaluating web-vitals; the port does not need them and
  does not modify `Array.prototype`.
- `getVisibilityWatcher()` returns `getFirstHiddenTime()` instead of a
  `firstHiddenTime` getter.
- Module-level state that the package creates when it is evaluated is created
  lazily: the `onHidden` Set and `initUnique`'s WeakMap on first use, and the
  attribution build's `resource` PerformanceObserver (`attribution/onLCP.ts`)
  by `startResourceBuffer()`, which the PostHog module calls where upstream
  would load its attribution script. So loading the chunk with web vitals off
  observes nothing.
- PostHog builds each flavour (`web-vitals`, `-with-attribution`, `-soft-navs`,
  `-with-attribution-soft-navs`) as a separate script with its own copy of the
  module state; here one copy is shared. Only one flavour is used per page.
