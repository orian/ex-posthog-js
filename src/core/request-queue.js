/**
 * @fileoverview Event batching + retry with exponential backoff.
 */
import {request, RequestOptions, HttpResponse} from './request.js';
import {addEventListener, nav, win} from './utils.js';
import {logger} from './logger.js';

/**
 * A capture request before batching. `data` is a single event.
 * @typedef {{url: string, data: !Object, batchKey: (string|undefined), transport: (string|undefined)}}
 */
export let QueuedEvent;

const MAX_RETRIES = 10;
const MAX_BATCH = 500; // events per request

/**
 * Wraps events in the batch envelope expected by /e/ (upstream "capture-body").
 * @param {!Array<!Object>} events
 * @return {!Object}
 */
export function captureBody(events) {
  const batch = events.map(function(e) {
    const copy = {};
    for (const k in e) copy[k] = e[k];
    if (e['timestamp'] instanceof Date) copy['timestamp'] = e['timestamp'].toISOString();
    return copy;
  });
  return {
    'api_key': batch.length && batch[0]['properties'] ? batch[0]['properties']['token'] : undefined,
    'batch': batch,
    'sent_at': new Date().toISOString(),
  };
}

export class RetryQueue {
  constructor() {
    /** @private {!Array<{opts: !RequestOptions, retryAt: number, attempt: number}>} */
    this.queue_ = [];
    /** @private {number} */
    this.timer_ = 0;
    /** @private {boolean} */
    this.online_ = !nav || nav.onLine !== false;
    const self = this;
    addEventListener(win, 'online', function() {
      self.online_ = true;
      self.flush_();
    });
    addEventListener(win, 'offline', function() {
      self.online_ = false;
    });
  }

  /** @return {number} */
  get length() {
    return this.queue_.length;
  }

  /**
   * Sends a request, scheduling retries on network errors / 5xx.
   * @param {!RequestOptions} opts
   * @param {number=} attempt
   */
  send(opts, attempt) {
    const self = this;
    const n = attempt || 0;
    const userCallback = opts.callback;
    /** @type {!RequestOptions} */
    const wrapped = /** @type {!RequestOptions} */ ({});
    for (const k in opts) wrapped[k] = opts[k];
    // Retries must re-encode from the original URL (request() appends params).
    const originalUrl = opts.url;
    wrapped.callback = function(/** !HttpResponse */ res) {
      if ((res.statusCode === 0 || res.statusCode >= 500) && n < MAX_RETRIES && opts.transport !== 'sendBeacon') {
        const copy = /** @type {!RequestOptions} */ ({});
        for (const k in opts) copy[k] = opts[k];
        copy.url = originalUrl;
        self.enqueue_(copy, n + 1);
        return;
      }
      if (userCallback) userCallback(res);
    };
    request(wrapped);
  }

  /**
   * @param {!RequestOptions} opts
   * @param {number} attempt
   * @private
   */
  enqueue_(opts, attempt) {
    // 3s, 6s, 12s ... capped at 30min, with +-50% jitter (upstream formula).
    let delay = Math.min(3000 * Math.pow(2, attempt - 1), 30 * 60 * 1000);
    delay += (Math.random() - 0.5) * delay;
    logger.warn('request failed, retry #' + attempt + ' in ' + Math.round(delay) + 'ms');
    this.queue_.push({opts: opts, retryAt: new Date().getTime() + delay, attempt: attempt});
    this.schedule_();
  }

  /** @private */
  schedule_() {
    if (this.timer_ || !this.queue_.length || !win) return;
    const self = this;
    this.timer_ = win.setTimeout(function() {
      self.timer_ = 0;
      self.flush_();
    }, 3000);
  }

  /** @private */
  flush_() {
    if (!this.online_) {
      this.schedule_();
      return;
    }
    const nowMs = new Date().getTime();
    const due = this.queue_.filter(function(x) {
      return x.retryAt <= nowMs;
    });
    this.queue_ = this.queue_.filter(function(x) {
      return x.retryAt > nowMs;
    });
    const self = this;
    due.forEach(function(x) {
      self.send(x.opts, x.attempt);
    });
    this.schedule_();
  }

  /** Page is unloading: fire everything pending as beacons, best effort. */
  unload() {
    if (this.timer_ && win) win.clearTimeout(this.timer_);
    this.timer_ = 0;
    const pending = this.queue_;
    this.queue_ = [];
    pending.forEach(function(x) {
      const opts = x.opts;
      opts.transport = 'sendBeacon';
      request(opts);
    });
  }
}

export class RequestQueue {
  /**
   * @param {function(!RequestOptions)} send
   * @param {number} flushIntervalMs
   */
  constructor(send, flushIntervalMs) {
    /** @private @const */
    this.send_ = send;
    /** @private {number} */
    this.interval_ = flushIntervalMs > 0 ? flushIntervalMs : 3000;
    /** @private {!Object<string, {url: string, events: !Array<!Object>}>} */
    this.buckets_ = {};
    /** @private {number} */
    this.timer_ = 0;
    /** @type {boolean} */
    this.paused = true;
  }

  /** @param {!QueuedEvent} item */
  enqueue(item) {
    const key = item.batchKey || item.url;
    const bucket = this.buckets_[key] || (this.buckets_[key] = {url: item.url, events: []});
    bucket.events.push(item.data);
    this.schedule_();
  }

  /** Starts periodic flushing (called once the instance is loaded and opted in). */
  start() {
    this.paused = false;
    this.schedule_();
  }

  /** @private */
  schedule_() {
    if (this.paused || this.timer_ || !win) return;
    const self = this;
    this.timer_ = win.setTimeout(function() {
      self.timer_ = 0;
      self.flush();
    }, this.interval_);
  }

  /**
   * Sends everything queued.
   * @param {string=} transport force a transport (e.g. 'sendBeacon' on unload)
   */
  flush(transport) {
    if (this.timer_ && win) win.clearTimeout(this.timer_);
    this.timer_ = 0;
    const buckets = this.buckets_;
    this.buckets_ = {};
    for (const key in buckets) {
      const b = buckets[key];
      for (let i = 0; i < b.events.length; i += MAX_BATCH) {
        this.send_(/** @type {!RequestOptions} */ ({
          url: b.url,
          method: 'POST',
          data: captureBody(b.events.slice(i, i + MAX_BATCH)),
          compression: 'gzip-js',
          transport: transport,
        }));
      }
    }
  }

  /** @return {number} */
  get length() {
    let n = 0;
    for (const k in this.buckets_) n += this.buckets_[k].events.length;
    return n;
  }
}
