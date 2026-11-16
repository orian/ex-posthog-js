/**
 * @fileoverview The error wrapping functions of exception autocapture: port of
 * upstream browser/src/entrypoints/exception-autocapture.ts (`window.onerror`,
 * `window.onunhandledrejection`, `console.error`), the lazily loaded part
 * `exception-autocapture`. Registered with provideLazy for ExceptionObserver
 * (autocapture.js).
 */
import {logger as baseLogger} from '../core/logger.js';
import {provideLazy} from '../core/lazy.js';
import {isFunction, isString, win} from '../core/utils.js';
import {buildErrorPropertiesBuilder} from './error-tracking.js';
import {CaptureFn, EXCEPTION_AUTOCAPTURE_KIND, ErrorWrappingFunctions} from './autocapture.js';

const logger = baseLogger.createLogger('[ExceptionAutocapture]');
const INSTRUMENTED = '__POSTHOG_INSTRUMENTED__';

const errorPropertiesBuilder = buildErrorPropertiesBuilder();


// Exception autocapture must never throw into customer code. Do not log in the
// catch because console.error may be instrumented and would re-enter it.
/**
 * @param {function(): T} fn
 * @param {T} fallback
 * @return {T}
 * @template T
 */
function safely(fn, fallback) {
  try {
    return fn();
  } catch (e) {
    return fallback;
  }
}

/**
 * @param {!CaptureFn} captureFn
 * @param {function(): !Object} buildProperties
 */
function safelyBuildAndCapture(captureFn, buildProperties) {
  safely(function() {
    captureFn(buildProperties());
  }, undefined);
}

/**
 * The handler is probed inside the guard (Firefox throws on dead/cross-compartment objects).
 * @param {*} handler
 * @return {boolean}
 */
function isReachableFunction(handler) {
  return safely(function() {
    return isFunction(handler) && isFunction(handler['call']);
  }, false);
}

/**
 * @param {!Object} owner
 * @param {string} key
 */
function markInstrumented(owner, key) {
  safely(function() {
    owner[key][INSTRUMENTED] = true;
  }, undefined);
}

/**
 * @param {!Object} owner
 * @param {string} key
 * @param {*} original
 */
function restore(owner, key, original) {
  safely(function() {
    const current = owner[key];
    if (current != null) delete current[INSTRUMENTED];
  }, undefined);
  safely(function() {
    owner[key] = original;
  }, undefined);
}

/**
 * `window.onerror` passes the location positionally; keep it when there is no Error.
 * @param {!Array<*>} args
 * @return {*}
 */
function resolveOnErrorInput(args) {
  const event = args[0];
  const source = args[1];
  const error = args[4];
  if (error != null) return error;
  if (isString(event) && isString(source) && /** @type {string} */ (source).length > 0 &&
      typeof ErrorEvent !== 'undefined') {
    try {
      return new ErrorEvent('error', /** @type {!ErrorEventInit} */ ({
        'message': event, 'filename': source, 'lineno': args[2], 'colno': args[3],
      }));
    } catch (e) {
      return event;
    }
  }
  return event;
}

/**
 * @param {!CaptureFn} captureFn
 * @return {function()} unwrap
 */
export function wrapOnError(captureFn) {
  const w = /** @type {?} */ (win);
  if (!w) logger.info('window not available, cannot wrap onerror');
  const originalOnError = /** @type {?} */ (safely(function() {
    return /** @type {?} */ (w.onerror);
  }, /** @type {?} */ (undefined)));
  w.onerror = function(...args) {
    safelyBuildAndCapture(captureFn, function() {
      return errorPropertiesBuilder.buildFromUnknown(resolveOnErrorInput(args), {mechanism: {'handled': false}});
    });
    if (!isReachableFunction(originalOnError)) return false;
    const result = originalOnError.apply(undefined, args);
    return result == null ? false : result;
  };
  markInstrumented(w, 'onerror');
  return function() {
    restore(w, 'onerror', originalOnError);
  };
}

/**
 * @param {!CaptureFn} captureFn
 * @param {boolean=} defaultReturnValue
 * @return {function()} unwrap
 */
export function wrapUnhandledRejection(captureFn, defaultReturnValue) {
  const w = /** @type {?} */ (win);
  if (!w) logger.info('window not available, cannot wrap onUnhandledRejection');
  const original = /** @type {?} */ (safely(function() {
    return /** @type {?} */ (w.onunhandledrejection);
  }, /** @type {?} */ (undefined)));
  w.onunhandledrejection = function(ev) {
    safelyBuildAndCapture(captureFn, function() {
      return errorPropertiesBuilder.buildFromUnknown(ev, {mechanism: {'handled': false}});
    });
    if (!isReachableFunction(original)) return !!defaultReturnValue;
    const result = original(ev);
    return result == null ? false : result;
  };
  markInstrumented(w, 'onunhandledrejection');
  return function() {
    restore(w, 'onunhandledrejection', original);
  };
}

/**
 * @param {!CaptureFn} captureFn
 * @return {function()} unwrap
 */
export function wrapConsoleError(captureFn) {
  const con = /** @type {?} */ (typeof console !== 'undefined' ? console : undefined);
  if (!con) logger.info('console not available, cannot wrap console.error');
  const originalConsoleError = /** @type {?} */ (safely(function() {
    return /** @type {?} */ (con.error);
  }, /** @type {?} */ (undefined)));
  con.error = function(...args) {
    // SDK loggers pass the prefix and the diagnostic separately.
    const isInternalDiagnostic = safely(function() {
      return args.length > 1 && isString(args[0]) &&
          (/^\[PostHog\.js\](?: |$)/.test(/** @type {string} */ (args[0])) || args[0] === 'rrweb logger error:');
    }, false);
    if (!isInternalDiagnostic) {
      safelyBuildAndCapture(captureFn, function() {
        const event = args.length == 1 ? args[0] : args.join(' ');
        let error = undefined;
        for (let i = 0; i < args.length; i++) {
          if (args[i] instanceof Error) {
            error = args[i];
            break;
          }
        }
        return errorPropertiesBuilder.buildFromUnknown(error || event, {
          mechanism: {'handled': true, 'type': 'onconsole'},
          syntheticException: new Error('PostHog syntheticException'),
          skipFirstLines: 2,
        });
      });
    }
    if (isReachableFunction(originalConsoleError)) originalConsoleError.apply(undefined, args);
  };
  markInstrumented(con, 'error');
  return function() {
    restore(con, 'error', originalConsoleError);
  };
}

provideLazy(EXCEPTION_AUTOCAPTURE_KIND, /** @type {!ErrorWrappingFunctions} */ ({
  wrapOnError: wrapOnError,
  wrapUnhandledRejection: wrapUnhandledRejection,
  wrapConsoleError: wrapConsoleError,
}));
