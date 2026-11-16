/**
 * @fileoverview Exception autocapture: a port of upstream
 * browser/src/extensions/exception-autocapture/index.ts (`ExceptionObserver`,
 * published as `posthog.exceptionObserver`) and the error wrapping functions
 * of browser/src/entrypoints/exception-autocapture.ts (`window.onerror`,
 * `window.onunhandledrejection`, `console.error`).
 *
 * The wrapping functions are the lazy part `exception-autocapture`
 * (wrappers.js; upstream `/static/exception-autocapture.js`). In the bundles
 * and chunks they are compiled in, so capturing starts synchronously; the
 * lazy build loads them as their own chunk at upstream's trigger point.
 */
import {PostHog} from '../core/posthog.js';
import {Extension} from '../core/extensions.js';
import {logger as baseLogger} from '../core/logger.js';
import {lazyPart, loadLazy} from '../core/lazy.js';
import {isObject, isUndefined, win} from '../core/utils.js';
import {BucketedRateLimiter, resolveExceptionRateLimiterConfig} from './bucketed-rate-limiter.js';
import {PostHogExceptions} from './exceptions.js';

const logger = baseLogger.createLogger('[ExceptionAutocapture]');

export const EXCEPTION_CAPTURE_ENABLED_SERVER_SIDE = '$exception_capture_enabled_server_side';

/** @const {string} the lazy part (upstream kind) */
export const EXCEPTION_AUTOCAPTURE_KIND = 'exception-autocapture';

/** @typedef {function(!Object)} */
export let CaptureFn;

/**
 * Upstream `__PosthogExtensions__.errorWrappingFunctions`; each returns its unwrap function.
 * @record
 */
export class ErrorWrappingFunctions {
  constructor() {
    /** @type {function(!CaptureFn): function()} */
    this.wrapOnError;
    /** @type {function(!CaptureFn, boolean=): function()} */
    this.wrapUnhandledRejection;
    /** @type {function(!CaptureFn): function()} */
    this.wrapConsoleError;
  }
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
      // Upstream `_loadScript(this._startCapturing)`.
      const self = this;
      loadLazy(this.ph_, EXCEPTION_AUTOCAPTURE_KIND, function(err) {
        if (err) {
          logger.error('failed to load script', err);
          return;
        }
        self.startCapturing_();
      });
    } else {
      this.stopCapturing_();
    }
  }

  /** @private */
  startCapturing_() {
    const fns = /** @type {!ErrorWrappingFunctions|undefined} */ (lazyPart(EXCEPTION_AUTOCAPTURE_KIND));
    if (!win || !this.enabled_() || !fns) return;
    const self = this;
    const capture = function(props) {
      self.captureException(props);
    };
    try {
      if (!this.unwrapOnError_ && this.config_['capture_unhandled_errors']) {
        this.unwrapOnError_ = fns.wrapOnError(capture);
      }
      if (!this.unwrapUnhandledRejection_ && this.config_['capture_unhandled_rejections']) {
        this.unwrapUnhandledRejection_ = fns.wrapUnhandledRejection(capture);
      }
      if (!this.unwrapConsoleError_ && this.config_['capture_console_errors']) {
        this.unwrapConsoleError_ = fns.wrapConsoleError(capture);
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
