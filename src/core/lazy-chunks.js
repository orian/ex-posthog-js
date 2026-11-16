/**
 * @fileoverview The chunk loader of the lazy build (dist/lazy/posthog.js):
 * upstream's `loadExternalDependency` for our own lazy chunks.
 *
 * A kind's chunk is `<base><kind>.js?v=<our version>`, injected with the
 * core's `loadScript` (so `disable_external_dependency_loading`,
 * `prepare_external_dependency_script` and `external_scripts_inject_target`
 * apply as upstream). `<base>` is the `closure_lazy_chunks_url` config key
 * when set, else the directory of the script that loaded posthog.js
 * (`document.currentScript` while it runs, like webpack's automatic
 * publicPath). Upstream has no `closure_*` config keys, so the name cannot
 * collide with one of its options.
 *
 * Must be imported before the core (src/entry/lazy.js), so `currentScript`
 * is read while posthog.js itself runs.
 */
import {Config} from './constants.js';
import {doc} from './utils.js';
import {loadScript} from './script-loader.js';
import {setLazyChunkLoader} from './lazy.js';

/** @const {string} config key overriding where the chunks are loaded from */
export const LAZY_CHUNKS_URL_CONFIG = 'closure_lazy_chunks_url';

/**
 * Kinds that upstream ships inside another of its scripts. The replay chunk
 * is the logic of upstream's `lazy-recorder.js`, which also contains rrweb;
 * we load rrweb from PostHog's `recorder.js` next to it. Its `<script>` is
 * removed once it has run, so the page (which replay records) has one script
 * where upstream has one.
 * @const {!Object<string, boolean>}
 */
const DETACHED_KINDS = {'replay': true};

/**
 * The directory of `src`, with a trailing slash.
 * @param {string} src
 * @return {string}
 */
function directoryOf(src) {
  const path = src.split('#')[0].split('?')[0];
  return path.slice(0, path.lastIndexOf('/') + 1);
}

/** @const {string} directory of the script running now (posthog.js) */
const scriptBase = (function() {
  const current = doc ? /** @type {?HTMLScriptElement} */ (doc.currentScript) : null;
  return current && current.src ? directoryOf(current.src) : '';
})();

/**
 * @param {!Object} config PostHog config (quoted keys)
 * @return {string} the chunk directory, with a trailing slash, or ''
 */
export function lazyChunksBase(config) {
  const configured = config[LAZY_CHUNKS_URL_CONFIG];
  if (typeof configured === 'string' && configured) {
    return configured.charAt(configured.length - 1) === '/' ? configured : configured + '/';
  }
  return scriptBase;
}

/**
 * @param {!Object} config
 * @param {string} kind
 * @return {string}
 */
export function lazyChunkUrl(config, kind) {
  return lazyChunksBase(config) + kind + '.js?v=' + Config.LIB_VERSION;
}

setLazyChunkLoader(function(instance, kind, callback) {
  const config = /** @type {!Object} */ (instance.config);
  if (!lazyChunksBase(config)) {
    callback('cannot locate the ' + kind + ' chunk: set ' + LAZY_CHUNKS_URL_CONFIG);
    return;
  }
  const url = lazyChunkUrl(config, kind);
  loadScript(config, url, function(error) {
    if (!error && DETACHED_KINDS[kind] && doc) {
      const scripts = doc.querySelectorAll('script');
      for (let i = 0; i < scripts.length; i++) {
        const s = /** @type {!HTMLScriptElement} */ (scripts[i]);
        if ((s.src === url || s.getAttribute('src') === url) && s.parentNode) s.parentNode.removeChild(s);
      }
    }
    callback(error);
  });
});
