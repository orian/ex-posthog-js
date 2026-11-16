/**
 * @fileoverview Exception autocapture: a port of upstream
 * browser/src/extensions/exception-autocapture/index.ts (`ExceptionObserver`,
 * published as `posthog.exceptionObserver`) and the error wrapping functions
 * of browser/src/entrypoints/exception-autocapture.ts (`window.onerror`,
 * `window.onunhandledrejection`, `console.error`).
 *
 * Upstream lazy-loads the wrapping functions as `/static/exception-autocapture.js`;
 * here they are compiled into the module, so capturing starts synchronously.
 */
import {PostHog} from '../core/posthog.js';
import {Extension} from '../core/extensions.js';
import {logger as baseLogger} from '../core/logger.js';
import {isFunction, isObject, isString, isUndefined, win} from '../core/utils.js';
import {buildErrorPropertiesBuilder} from './error-tracking.js';
import {BucketedRateLimiter, resolveExceptionRateLimiterConfig} from './bucketed-rate-limiter.js';
import {PostHogExceptions} from './exceptions.js';

const logger = baseLogger.createLogger('[ExceptionAutocapture]');

export const EXCEPTION_CAPTURE_ENABLED_SERVER_SIDE = '$exception_capture_enabled_server_side';
const INSTRUMENTED = '__POSTHOG_INSTRUMENTED__';

const errorPropertiesBuilder = buildErrorPropertiesBuilder();

/** @typedef {function(!Object)} */
let CaptureFn;

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

/** @implements {Extension} */
export class ExceptionObserver {
  /** @param {!PostHog} instance */
  constructor(instance) {
    /** @private @const {!PostHog} */
    this.ph_ = instance;
    /** @private {boolean} */
    this.remoteEnabled_ = !!(instance.persistence && instance.persistence.props[EXCEPTION_CAPTURE_ENABLED_SERVER_SIDE]);
    const limits = resolveExceptionRateLimiterConfig(instance.config['error_tracking']);
    // Ten exceptions per type before limiting, then one per 10 seconds.
    /** @private @const {!BucketedRateLimiter} */
    this.rateLimiter_ = new BucketedRateLimiter({
      bucketSize: limits.bucketSize,
      refillRate: limits.refillRate,
      refillInterval: 10000,
    });
    /** @private {function()|undefined} */
    this.unwrapOnError_ = undefined;
    /** @private {function()|undefined} */
    this.unwrapUnhandledRejection_ = undefined;
    /** @private {function()|undefined} */
    this.unwrapConsoleError_ = undefined;
    /** @private {!Object<string, *>} */
    this.config_ = this.requiredConfig_();
    this.startIfEnabledOrStop();
  }

  /**
   * @return {!Object<string, *>}
   * @private
   */
  requiredConfig_() {
    const provided = this.ph_.config['capture_exceptions'];
    const config = {
      'capture_unhandled_errors': false,
      'capture_unhandled_rejections': false,
      'capture_console_errors': false,
    };
    if (isObject(provided)) {
      for (const k in /** @type {!Object} */ (provided)) {
        if (Object.prototype.hasOwnProperty.call(provided, k)) config[k] = provided[k];
      }
    } else if (isUndefined(provided) ? this.remoteEnabled_ : provided) {
      config['capture_unhandled_errors'] = true;
      config['capture_unhandled_rejections'] = true;
    }
    return config;
  }

  /** @return {boolean} */
  enabled_() {
    return !!(this.config_['capture_console_errors'] || this.config_['capture_unhandled_errors'] ||
        this.config_['capture_unhandled_rejections']);
  }

  startIfEnabledOrStop() {
    if (this.enabled_()) {
      logger.info('enabled');
      this.stopCapturing_();
      this.startCapturing_();
    } else {
      this.stopCapturing_();
    }
  }

  /** @private */
  startCapturing_() {
    if (!win || !this.enabled_()) return;
    const self = this;
    const capture = function(props) {
      self.captureException(props);
    };
    try {
      if (!this.unwrapOnError_ && this.config_['capture_unhandled_errors']) {
        this.unwrapOnError_ = wrapOnError(capture);
      }
      if (!this.unwrapUnhandledRejection_ && this.config_['capture_unhandled_rejections']) {
        this.unwrapUnhandledRejection_ = wrapUnhandledRejection(capture);
      }
      if (!this.unwrapConsoleError_ && this.config_['capture_console_errors']) {
        this.unwrapConsoleError_ = wrapConsoleError(capture);
      }
    } catch (e) {
      logger.error('failed to start', e);
      this.stopCapturing_();
    }
  }

  /** @private */
  stopCapturing_() {
    if (this.unwrapOnError_) this.unwrapOnError_();
    this.unwrapOnError_ = undefined;
    if (this.unwrapUnhandledRejection_) this.unwrapUnhandledRejection_();
    this.unwrapUnhandledRejection_ = undefined;
    if (this.unwrapConsoleError_) this.unwrapConsoleError_();
    this.unwrapConsoleError_ = undefined;
  }

  /** @param {?Object} response */
  onRemoteConfig(response) {
    if (!response || !('autocaptureExceptions' in response)) return;
    this.remoteEnabled_ = !!response['autocaptureExceptions'];
    if (this.ph_.persistence) {
      this.ph_.persistence.register({[EXCEPTION_CAPTURE_ENABLED_SERVER_SIDE]: this.remoteEnabled_});
    }
    this.config_ = this.requiredConfig_();
    this.startIfEnabledOrStop();
  }

  /**
   * Upstream set_config calls onConfigChange() and later startIfEnabledOrStop().
   * @param {!Object} config
   */
  onConfigChange(config) {
    this.config_ = this.requiredConfig_();
    this.startIfEnabledOrStop();
  }

  /** @param {!Object} errorProperties built `$exception` properties */
  captureException(errorProperties) {
    try {
      const list = errorProperties ? errorProperties['$exception_list'] : undefined;
      const first = list ? list[0] : undefined;
      const type = first ? first['type'] : undefined;
      const exceptionType = type == null ? 'Exception' : type;
      if (this.rateLimiter_.consumeRateLimit(exceptionType)) {
        logger.info('Skipping exception capture because of client rate limiting.', {'exception': exceptionType});
        return;
      }
      const exceptions = this.ph_.extensions['exceptions'];
      if (exceptions) /** @type {!PostHogExceptions} */ (exceptions).sendExceptionEvent(errorProperties);
    } catch (e) {
      // Never throw into customer code; don't log (console.error may be instrumented).
    }
  }
}
