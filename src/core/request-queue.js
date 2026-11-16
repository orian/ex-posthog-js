/**
 * @fileoverview Event batching (upstream request-queue.ts) and retry with
 * jittered exponential backoff (upstream retry-queue.ts).
 */
import {RequestOptions, TransportCallback} from './request.js';
import {addEventListener, assign, clampToRange, extendURLParams, isArray, isPositiveNumber, isUndefined, nav, win} from './utils.js';
import {logger} from './logger.js';

/** @const {number} */
export const DEFAULT_FLUSH_INTERVAL_MS = 3000;

export class RequestQueue {
  /**
   * @param {function(!RequestOptions, (string|undefined))} sendRequest (request, transportOverride)
   * @param {?Object=} config request_queue_config (quoted keys)
   */
  constructor(sendRequest, config) {
    /** @private {boolean} */
    this.isPaused_ = true;
    /** @private {!Array<!RequestOptions>} */
    this.queue_ = [];
    /** @private {number|undefined} */
    this.flushTimeout_ = undefined;
    /** @private @const {number} */
    this.flushTimeoutMs_ = clampToRange((config && config['flush_interval_ms']) || DEFAULT_FLUSH_INTERVAL_MS,
        250, 5000, DEFAULT_FLUSH_INTERVAL_MS);
    /** @private @const */
    this.sendRequest_ = sendRequest;
  }

  /** @param {!RequestOptions} req */
  enqueue(req) {
    this.queue_.push(req);
    if (!this.flushTimeout_) this.setFlushTimeout_();
  }

  /** Sends everything queued with sendBeacon (page unload). */
  unload() {
    this.clearFlushTimeout_();
    const requests = this.queue_.length > 0 ? this.formatQueue_() : {};
    const values = [];
    for (const k in requests) values.push(requests[k]);
    const sorted = values.filter(function(r) {
      return r.url.indexOf('/e') === 0;
    }).concat(values.filter(function(r) {
      return r.url.indexOf('/e') !== 0;
    }));
    const self = this;
    sorted.forEach(function(req) {
      const copy = /** @type {!RequestOptions} */ (assign(req));
      copy.callback = undefined;
      self.sendSafely_(copy, 'sendBeacon');
    });
  }

  enable() {
    this.isPaused_ = false;
    this.setFlushTimeout_();
  }

  /** @private */
  setFlushTimeout_() {
    if (this.isPaused_) return;
    const self = this;
    this.flushTimeout_ = setTimeout(function() {
      self.clearFlushTimeout_();
      self.flush_();
    }, this.flushTimeoutMs_);
  }

  /** @private */
  flush_() {
    if (this.queue_.length > 0) {
      const requests = this.formatQueue_();
      for (const key in requests) this.sendSafely_(requests[key]);
    }
  }

  /**
   * @param {!RequestOptions} req
   * @param {string=} transportOverride
   * @private
   */
  sendSafely_(req, transportOverride) {
    try {
      this.sendRequest_(req, transportOverride);
    } catch (e) {
      logger.error(e);
    }
  }

  /** @private */
  clearFlushTimeout_() {
    clearTimeout(this.flushTimeout_);
    this.flushTimeout_ = undefined;
  }

  /**
   * @return {!Object<string, !RequestOptions>}
   * @private
   */
  formatQueue_() {
    const requests = {};
    const callbacks = {};
    this.queue_.forEach(function(req) {
      const key = ((req ? req.batchKey : null) || req.url) + (req.batchGroup ? ':' + req.batchGroup : '');
      if (isUndefined(requests[key])) {
        const r = /** @type {!RequestOptions} */ (assign(req));
        r.data = [];
        r.callback = undefined;
        r.fireCallbackOnDrop = undefined;
        requests[key] = r;
        callbacks[key] = [];
      }
      requests[key].data.push(req.data);
      if (req.callback) callbacks[key].push(req.callback);
    });
    for (const key in callbacks) {
      const list = callbacks[key];
      if (list.length) {
        requests[key].callback = function(response) {
          list.forEach(function(cb) {
            cb(response);
          });
        };
      }
    }
    this.queue_ = [];
    return requests;
  }

  /** @return {number} */
  get length() {
    return this.queue_.length;
  }
}

const THIRTY_MINUTES = 30 * 60 * 1000;
const DEFAULT_MAX_RETRIES = 10;
const STATUS_CODE_ZERO_MAX_RETRIES = 3;

/**
 * @param {number} retriesSoFar
 * @return {number}
 */
export function pickNextRetryDelay(retriesSoFar) {
  const raw = 3000 * Math.pow(2, retriesSoFar);
  const minBackoff = raw / 2;
  const capped = Math.min(THIRTY_MINUTES, raw);
  const jitter = (Math.random() - 0.5) * (capped - minBackoff);
  return Math.ceil(capped + jitter);
}

export class RetryQueue {
  /**
   * @param {function(!RequestOptions, !TransportCallback)} dispatch sends via the instance (rate limits, headers...)
   * @param {function(!RequestOptions)} sendDirect sends without retries (used on unload)
   */
  constructor(dispatch, sendDirect) {
    /** @private @const */
    this.dispatch_ = dispatch;
    /** @private @const */
    this.sendDirect_ = sendDirect;
    /** @private {boolean} */
    this.isPolling_ = false;
    /** @private {number|undefined} */
    this.poller_ = undefined;
    /** @private @const {number} */
    this.pollIntervalMs_ = 3000;
    /** @private {!Array<{retryAt: number, requestOptions: !RequestOptions}>} */
    this.queue_ = [];
    /** @private {boolean} */
    this.areWeOnline_ = true;
    /** @private {function()|undefined} */
    this.onlineListener_ = undefined;
    /** @private {function()|undefined} */
    this.offlineListener_ = undefined;
    this.resume();
  }

  resume() {
    if (win && 'onLine' in win.navigator) {
      this.areWeOnline_ = win.navigator.onLine;
      if (this.onlineListener_) return;
      const self = this;
      this.onlineListener_ = function() {
        self.areWeOnline_ = true;
        self.flush_();
      };
      this.offlineListener_ = function() {
        self.areWeOnline_ = false;
      };
      addEventListener(win, 'online', this.onlineListener_);
      addEventListener(win, 'offline', this.offlineListener_);
    }
  }

  /** @return {number} */
  get length() {
    return this.queue_.length;
  }

  /**
   * @param {!RequestOptions} requestOptions
   * @param {string=} transportOverride
   */
  retriableRequest(requestOptions, transportOverride) {
    const retriesSoFar = requestOptions.retriesPerformedSoFar;
    const options = /** @type {!RequestOptions} */ (assign(requestOptions));
    delete options.retriesPerformedSoFar;
    if (isPositiveNumber(retriesSoFar)) {
      options.url = extendURLParams(options.url, {'retry_count': retriesSoFar});
    }
    let toSend = options;
    if (transportOverride) {
      toSend = /** @type {!RequestOptions} */ (assign(options));
      toSend.transport = transportOverride;
    }
    const self = this;
    this.dispatch_(toSend, function(response, retryAfterMs) {
      if (response.statusCode !== 200 && (response.statusCode < 400 || response.statusCode >= 500)) {
        const maxRetries = response.statusCode === 0 ? STATUS_CODE_ZERO_MAX_RETRIES : DEFAULT_MAX_RETRIES;
        if ((retriesSoFar || 0) < maxRetries) {
          const again = /** @type {!RequestOptions} */ (assign(options));
          again.retriesPerformedSoFar = retriesSoFar;
          self.enqueue_(again, retryAfterMs);
          return;
        }
        if (response.statusCode === 0) {
          logger.warn('Request failed before receiving an HTTP response; this can happen due to network issues, CORS, ' +
              'browser blocking, or ad blockers. Stopped retrying after ' + (retriesSoFar || 0) + ' retries.');
        }
      }
      if (options.callback) options.callback(response);
    });
  }

  /**
   * @param {!RequestOptions} requestOptions
   * @param {number=} retryAfterMs
   * @private
   */
  enqueue_(requestOptions, retryAfterMs) {
    const soFar = requestOptions.retriesPerformedSoFar || 0;
    requestOptions.retriesPerformedSoFar = soFar + 1;
    const ms = Math.max(pickNextRetryDelay(soFar), retryAfterMs || 0);
    this.queue_.push({retryAt: new Date().getTime() + ms, requestOptions: requestOptions});
    let msg = 'Enqueued failed request for retry in ' + ms;
    if (nav && !nav.onLine) msg += ' (Browser is offline)';
    logger.warn(msg);
    if (!this.isPolling_) {
      this.isPolling_ = true;
      this.poll_();
    }
  }

  /** @private */
  poll_() {
    if (this.poller_) clearTimeout(this.poller_);
    if (this.queue_.length === 0) {
      this.isPolling_ = false;
      this.poller_ = undefined;
      return;
    }
    const self = this;
    this.poller_ = setTimeout(function() {
      if (self.areWeOnline_ && self.queue_.length > 0) self.flush_();
      self.poll_();
    }, this.pollIntervalMs_);
  }

  /** @private */
  flush_() {
    const now = new Date().getTime();
    const notToFlush = [];
    const toFlush = this.queue_.filter(function(item) {
      if (item.retryAt < now) return true;
      notToFlush.push(item);
      return false;
    });
    this.queue_ = notToFlush;
    const self = this;
    toFlush.forEach(function(item) {
      self.retriableRequest(item.requestOptions);
    });
  }

  unload() {
    if (this.poller_) {
      clearTimeout(this.poller_);
      this.poller_ = undefined;
    }
    this.isPolling_ = false;
    if (win) {
      if (this.onlineListener_) {
        win.removeEventListener('online', this.onlineListener_);
        this.onlineListener_ = undefined;
      }
      if (this.offlineListener_) {
        win.removeEventListener('offline', this.offlineListener_);
        this.offlineListener_ = undefined;
      }
    }
    const self = this;
    this.queue_.forEach(function(item) {
      try {
        const o = /** @type {!RequestOptions} */ (assign(item.requestOptions));
        o.callback = isArray(o.data) ? undefined : o.callback;
        o.transport = 'sendBeacon';
        self.sendDirect_(o);
      } catch (e) {
        logger.error(e);
      }
    });
    this.queue_ = [];
  }
}
