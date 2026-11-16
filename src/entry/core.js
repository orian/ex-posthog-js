/**
 * @fileoverview Core entry point: exposes `window.posthog` and replays calls
 * queued by the standard PostHog HTML snippet. Optional modules are added by
 * other entries (full.js) or by loading their Closure chunks afterwards.
 */
import {PostHog, exportPublicApi} from '../core/posthog.js';
import {registerExtension} from '../core/extensions.js';
import {logger} from '../core/logger.js';
import {isArray, isFunction, win} from '../core/utils.js';

exportPublicApi();

/**
 * Replays `[method, ...args]` calls recorded by the snippet stub.
 * @param {!PostHog} instance
 * @param {!Array} calls
 */
function replay(instance, calls) {
  // Mirror upstream: identity/registration calls first so the initial
  // events carry the right distinct_id.
  const priority = ['identify', 'register', 'register_once', 'set_config', 'opt_in_capturing', 'opt_out_capturing'];
  const ordered = calls.filter(function(c) {
    return isArray(c) && priority.indexOf(c[0]) !== -1;
  }).concat(calls.filter(function(c) {
    return isArray(c) && priority.indexOf(c[0]) === -1;
  }));
  ordered.forEach(function(call) {
    const fn = instance[call[0]];
    if (isFunction(fn)) {
      try {
        fn.apply(instance, call.slice(1));
      } catch (e) {
        logger.critical('queued call ' + call[0] + ' failed', e);
      }
    }
  });
}

if (win) {
  const existing = win['posthog'];
  const main = new PostHog();
  // Allow late-loaded chunks/bundles to register extensions via the global.
  main['__registerExtension'] = registerExtension;
  main['PostHog'] = PostHog;

  if (isArray(existing) && existing['__SV']) {
    // Snippet stub: `posthog._i` holds [token, config, name] init calls,
    // the stub itself (and named sub-stubs) hold queued method calls.
    const inits = existing['_i'] || [];
    win['posthog'] = main;
    inits.forEach(function(args) {
      const name = args[2];
      const instance = name ? main.init(args[0], args[1], name) : main.init(args[0], args[1]);
      const queued = name ? existing[name] : existing;
      if (instance && isArray(queued)) replay(instance, /** @type {!Array} */ (queued));
    });
  } else if (!existing || !existing['__loaded']) {
    win['posthog'] = main;
  }
}

export {PostHog};
