/**
 * @fileoverview Where the SDK's own scripts live: the directory of the script
 * that loaded the SDK (`document.currentScript` while it runs, like webpack's
 * automatic publicPath), and the lazy build's `closure_lazy_chunks_url`
 * override. Used for the lazy build's chunks and for our `recorder.js`.
 *
 * `currentScript` is only set while a classic script runs. Every build
 * evaluates its modules while its own script runs: the bundles and the lazy
 * build's posthog.js in one go, the chunk build in the chunk that holds this
 * module (all chunks sit in one directory).
 */
import {doc} from './utils.js';

/** @const {string} config key overriding where the lazy build's chunks are loaded from */
export const LAZY_CHUNKS_URL_CONFIG = 'closure_lazy_chunks_url';

/**
 * The directory of `src`, with a trailing slash.
 * @param {string} src
 * @return {string}
 */
export function directoryOf(src) {
  const path = src.split('#')[0].split('?')[0];
  return path.slice(0, path.lastIndexOf('/') + 1);
}

/** @const {string} directory of the script running now (the SDK) */
const scriptBase = (function() {
  const current = doc ? /** @type {?HTMLScriptElement} */ (doc.currentScript) : null;
  return current && current.src ? directoryOf(current.src) : '';
})();

/** @return {string} the SDK script's directory, with a trailing slash, or '' when unknown */
export function sdkScriptBase() {
  return scriptBase;
}

/**
 * @param {!Object} config PostHog config (quoted keys)
 * @return {string} the lazy build's chunk directory, with a trailing slash, or ''
 */
export function lazyChunksBase(config) {
  const configured = config[LAZY_CHUNKS_URL_CONFIG];
  if (typeof configured === 'string' && configured) {
    return configured.charAt(configured.length - 1) === '/' ? configured : configured + '/';
  }
  return scriptBase;
}
