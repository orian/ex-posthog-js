/**
 * @fileoverview Port of upstream browser-common/utils/patch.ts (derived from
 * rrweb's `patch`, itself from getsentry/sentry-javascript, MIT).
 *
 * Each call installs a "layer" in the wrapper chain. A wrapper calls down
 * through its layer's mutable `next` reference rather than closing over the
 * original, so any layer can later be spliced out of the chain even when newer
 * wrappers sit on top of it (session replay's network plugin and tracing
 * headers both wrap `fetch` and XHR). The markers `__posthog_layer__` /
 * `__rrweb_layer__` and the layer's `next` are shared with recorder.js, so
 * they are quoted.
 */

const noop = function() {};

/**
 * @param {*} method
 * @return {?Object|undefined} the patch layer of a wrapper, if any
 */
export function spliceableLayer(method) {
  if (typeof method !== 'function') return undefined;
  const layer = method['__posthog_layer__'];
  return /** @type {?Object|undefined} */ (layer != null ? layer : method['__rrweb_layer__']);
}

/**
 * Replaces `source[name]` with `replacement(callNext)`.
 * @param {!Object} source
 * @param {string} name
 * @param {function(!Function): ?} replacement
 * @return {function()} restores the patch
 */
export function patch(source, name, replacement) {
  try {
    if (!(name in source)) {
      return noop;
    }

    const original = source[name];
    const layer = {'next': original};

    // The wrapper receives this stable delegate instead of `original`, so the
    // function it actually calls can be re-pointed when a lower layer is removed.
    const callNext = /** @this {*} */ function(...args) {
      return layer['next'].apply(this, args);
    };

    const wrapped = replacement(callNext);

    // Make sure it's a function first, as we need to attach an empty prototype
    // for `defineProperties` to work.
    if (typeof wrapped === 'function') {
      wrapped.prototype = wrapped.prototype || {};
      Object.defineProperties(wrapped, {
        '__posthog_wrapped__': {enumerable: false, value: true},
        '__posthog_layer__': {enumerable: false, value: layer},
      });
    }

    source[name] = wrapped;

    return function() {
      // If we're still on top, hand back whatever we currently delegate to.
      if (source[name] === wrapped) {
        source[name] = layer['next'];
        return;
      }
      // Otherwise newer wrappers sit on top of us: re-point the layer directly
      // above us past us (walking both posthog and rrweb markers).
      let current = source[name];
      let currentLayer = spliceableLayer(current);
      while (currentLayer) {
        if (currentLayer['next'] === wrapped) {
          currentLayer['next'] = layer['next'];
          return;
        }
        current = currentLayer['next'];
        currentLayer = spliceableLayer(current);
      }
      // Buried under a non-posthog wrapper that closed over us, or already
      // removed: nothing safe to do.
    };
  } catch (e) {
    // This can throw when several instrumentation layers wrap the same global
    // object and redefine the same non-configurable wrapper marker.
    return noop;
  }
}
