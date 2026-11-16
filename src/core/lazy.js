/**
 * @fileoverview Lazily loaded parts of optional modules (upstream's
 * `__PosthogExtensions__.loadExternalDependency(posthog, kind, cb)` kinds).
 *
 * Some modules are split where upstream splits them: an always-loaded shell
 * (the extension: config, remote config, deciding when to start) and a lazy
 * part (the dead click detector, the error wrapping functions, the web-vitals
 * library, ...). The lazy part registers itself with `provideLazy(kind, part)`
 * when its code runs; the shell reads it with `lazyPart(kind)`.
 *
 * - In the bundles (posthog.full.js) and the per-module chunks the lazy part is
 *   compiled in next to its shell, so it is present from the start and the
 *   shells keep their compiled-in behaviour.
 * - The lazy build (dist/lazy/posthog.js) installs a chunk loader
 *   (src/core/lazy-chunks.js). The shells then call `loadLazy` at the point
 *   upstream calls `loadExternalDependency`, and the part arrives with its
 *   chunk (dist/lazy/<kind>.js).
 */

/** @const {!Object<string, *>} parts by kind */
const parts = {};

/**
 * Loads the chunk of a kind and calls back with an error, or none once the
 * script has run.
 * @typedef {function(?, string, function((string|!Event|undefined)=))}
 */
export let LazyChunkLoader;

/** @type {?LazyChunkLoader} */
let chunkLoader = null;

/**
 * Called by a lazy part when its code runs.
 * @param {string} kind
 * @param {*} part
 */
export function provideLazy(kind, part) {
  parts[kind] = part;
}

/**
 * @param {string} kind
 * @return {*} the part, or undefined while it is not loaded
 */
export function lazyPart(kind) {
  return parts[kind];
}

/** @param {!LazyChunkLoader} loader */
export function setLazyChunkLoader(loader) {
  chunkLoader = loader;
}

/** @return {boolean} whether lazy parts come from chunks (the lazy build) */
export function lazyChunksEnabled() {
  return !!chunkLoader;
}

/**
 * Lazy build: calls back once the part `kind` is present: straight away when
 * it already is (upstream's "already loaded" check), else after its chunk has
 * loaded. Without a chunk loader the part is compiled in.
 * @param {?} instance the PostHog instance
 * @param {string} kind
 * @param {function((string|!Event|undefined)=)} callback
 */
export function loadLazy(instance, kind, callback) {
  if (parts[kind] || !chunkLoader) {
    callback(undefined);
    return;
  }
  chunkLoader(instance, kind, callback);
}
