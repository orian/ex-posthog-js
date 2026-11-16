/**
 * @fileoverview The `metrics` extension (optional module), published as
 * `posthog.metrics`. Port of upstream browser/src/posthog-metrics.ts.
 *
 * ```js
 * posthog.metrics.count('orders_created', 1)
 * posthog.metrics.gauge('active_connections', 42)
 * posthog.metrics.histogram('api_latency', 187, {unit: 'ms'})
 * ```
 *
 * Aggregated windows are POSTed to `/i/v1/metrics?token=<token>` every
 * `metrics.flushIntervalMs` (browser default 60 s), when the page becomes
 * hidden, on `flush()`, and drained with sendBeacon on unload.
 */
import {PostHog} from '../core/posthog.js';
import {Extension} from '../core/extensions.js';
import {RequestOptions} from '../core/request.js';
import {Config} from '../core/constants.js';
import {logger as baseLogger} from '../core/logger.js';
import {addEventListener, doc, isUndefined} from '../core/utils.js';
import {SendOutcome, classifyStatus} from '../otlp/otlp.js';
import {MetricsAggregator, MetricsHost, resolveMetricsConfig} from './metrics-core.js';
import {startNetworkMetrics} from './network-metrics.js';

const METRICS_ENDPOINT = '/i/v1/metrics';
const METRICS_SEND_TIMEOUT_MS = 90000;
const BROWSER_DEFAULT_FLUSH_INTERVAL_MS = 60000;

/** @implements {Extension} */
export class PostHogMetrics {
  /** @param {!PostHog} instance */
  constructor(instance) {
    /** @type {!PostHog} */
    this.instance = instance;
    /** @private @const */
    this.logger_ = baseLogger.createLogger('[metrics]');
    /** @private {?MetricsAggregator} */
    this.core_ = null;
    /** @private {*} */
    this.resolvedFrom_ = undefined;
    /** @private {?function()} */
    this.stopNetworkMetrics_ = null;
    /** @private {boolean} */
    this.disposed_ = false;
    /** @private {boolean} */
    this.visibilityListening_ = false;
    const self = this;
    /** @private @const */
    this.onVisibilityChange_ = function() {
      if (doc && doc.visibilityState === 'hidden') self.flush();
    };
  }

  /** Upstream `initialize()`. */
  onInit() {
    this.onConfigChange();
    if (!this.disposed_ && !this.visibilityListening_ && doc && doc.addEventListener) {
      addEventListener(doc, 'visibilitychange', this.onVisibilityChange_);
      this.visibilityListening_ = true;
    }
  }

  /** Starts or stops `metrics.network`. */
  onConfigChange() {
    if (this.disposed_) return;
    const metrics = this.instance.config['metrics'];
    const enabled = !!(metrics && metrics['network']);
    const self = this;
    if (enabled && !this.stopNetworkMetrics_) {
      this.stopNetworkMetrics_ = startNetworkMetrics(this.instance, function(name, value, options) {
        self.histogram(name, value, options);
      });
    } else if (!enabled && this.stopNetworkMetrics_) {
      this.stopNetworkMetrics_();
      this.stopNetworkMetrics_ = null;
    }
  }

  /**
   * Built lazily (sees post-init config) and rebuilt when `config.metrics` is replaced.
   * @return {?MetricsAggregator}
   * @private
   */
  getCore_() {
    if (this.disposed_) return null;
    const metricsConfig = this.instance.config ? this.instance.config['metrics'] : undefined;
    if (!this.core_ || this.resolvedFrom_ !== metricsConfig) {
      if (this.core_) this.core_.reset();
      this.resolvedFrom_ = metricsConfig;
      const resolved = resolveMetricsConfig(metricsConfig);
      if (isUndefined(metricsConfig ? metricsConfig['flushIntervalMs'] : undefined)) {
        resolved.flushIntervalMs = BROWSER_DEFAULT_FLUSH_INTERVAL_MS;
      }
      this.core_ = new MetricsAggregator(this.createHost_(), resolved, this.logger_);
    }
    return this.core_;
  }

  /**
   * @param {string} name
   * @param {number=} value default 1
   * @param {?Object=} options
   */
  count(name, value, options) {
    const core = this.getCore_();
    if (core) core.count(name, value === undefined ? 1 : value, options);
  }

  /**
   * @param {string} name
   * @param {number} value
   * @param {?Object=} options
   */
  gauge(name, value, options) {
    const core = this.getCore_();
    if (core) core.gauge(name, value, options);
  }

  /**
   * @param {string} name
   * @param {number} value
   * @param {?Object=} options
   */
  histogram(name, value, options) {
    const core = this.getCore_();
    if (core) core.histogram(name, value, options);
  }

  /**
   * Sends the window now; with a transport, drains it synchronously (unload).
   * @param {string=} transport
   * @return {!Promise<void>}
   */
  flush(transport) {
    if (!this.core_) return Promise.resolve();
    if (transport) {
      const payload = this.core_.drainWindow();
      if (payload) this.sendMetricsBatch_(payload, transport);
      return Promise.resolve();
    }
    const self = this;
    return this.core_.flush().then(undefined, function(err) {
      self.logger_.error('PostHog metrics flush failed:', err);
    });
  }

  /** Upstream `reset()`, called by posthog.reset(). */
  onReset() {
    if (this.core_) this.core_.reset();
  }

  dispose() {
    this.disposed_ = true;
    if (doc && doc.removeEventListener) doc.removeEventListener('visibilitychange', this.onVisibilityChange_);
    this.visibilityListening_ = false;
    if (this.stopNetworkMetrics_) this.stopNetworkMetrics_();
    this.stopNetworkMetrics_ = null;
    if (this.core_) this.core_.reset();
  }

  /**
   * @return {!MetricsHost}
   * @private
   */
  createHost_() {
    const self = this;
    return /** @type {!MetricsHost} */ ({
      optedOut: function() {
        return !self.instance.is_capturing();
      },
      sendMetricsBatch: function(payload) {
        return self.sendMetricsBatch_(payload);
      },
      libraryId: function() {
        return Config.LIB_NAME;
      },
      libraryVersion: function() {
        return Config.LIB_VERSION;
      },
    });
  }

  /**
   * @param {!Object} payload
   * @param {string=} transport
   * @return {!Promise<!SendOutcome>}
   * @private
   */
  sendMetricsBatch_(payload, transport) {
    const self = this;
    return new Promise(function(resolve) {
      let settled = false;
      let timer = undefined;
      const settle = function(outcome) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      };
      timer = setTimeout(function() {
        settle({kind: 'retry-later', error: new Error('metrics request timed out')});
      }, METRICS_SEND_TIMEOUT_MS);
      const options = /** @type {!RequestOptions} */ ({
        method: 'POST',
        url: self.instance.requestRouter.endpointFor('api', METRICS_ENDPOINT) + '?token=' +
          encodeURIComponent(self.instance.config['token']),
        data: payload,
        compression: 'best-available',
        batchKey: 'metrics',
        fireCallbackOnDrop: true,
        callback: function(response) {
          settle(classifyStatus(response.statusCode, response.error, 'metrics'));
        },
      });
      if (transport) options.transport = transport;
      // A hidden tab can be frozen before async CompressionStream finishes.
      if (doc && doc.visibilityState === 'hidden') options.preferSyncCompression = true;
      self.instance.sendRequest(options);
    });
  }
}
