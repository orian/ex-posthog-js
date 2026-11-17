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
import {LAZY_CHUNKS_URL_CONFIG, lazyChunksBase} from './script-base.js';

/**
 * Kinds that upstream ships inside another of its scripts. The replay chunk
 * is the logic of upstream's `lazy-recorder.js`, which also contains rrweb;
 * rrweb is our `recorder.js`, loaded next to it. Its `<script>` is
 * removed once it has run, so the page (which replay records) has one script
 * where upstream has one.
 * @const {!Object<string, boolean>}
 */
const DETACHED_KINDS = {'replay': true};

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
