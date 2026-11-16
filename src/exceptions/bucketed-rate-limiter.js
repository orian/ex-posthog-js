/**
 * @fileoverview Token buckets per key, a port of upstream
 * core/src/utils/bucketed-rate-limiter.ts. Exception autocapture uses one
 * bucket per exception type.
 */
import {clampToRange} from '../core/utils.js';

const ONE_DAY_IN_MS = 86400000;
export const DEFAULT_EXCEPTION_RATE_LIMITER_REFILL_RATE = 1;
export const DEFAULT_EXCEPTION_RATE_LIMITER_BUCKET_SIZE = 10;

/**
 * Upstream resolveExceptionRateLimiterConfig: `error_tracking` keys
 * `exceptionRateLimiterRefillRate` / `exceptionRateLimiterBucketSize`, with
 * the deprecated `__`-prefixed spellings as fallbacks.
 * @param {*=} config
 * @return {{refillRate: *, bucketSize: *}}
 */
export function resolveExceptionRateLimiterConfig(config) {
  const c = config || {};
  const pick = function(a, b, fallback) {
    return a != null ? a : b != null ? b : fallback;
  };
  return {
    refillRate: pick(c['exceptionRateLimiterRefillRate'], c['__exceptionRateLimiterRefillRate'],
        DEFAULT_EXCEPTION_RATE_LIMITER_REFILL_RATE),
    bucketSize: pick(c['exceptionRateLimiterBucketSize'], c['__exceptionRateLimiterBucketSize'],
        DEFAULT_EXCEPTION_RATE_LIMITER_BUCKET_SIZE),
  };
}

export class BucketedRateLimiter {
  /**
   * @param {{bucketSize: *, refillRate: *, refillInterval: *}} options
   */
  constructor(options) {
    /** @private @const {number} */
    this.bucketSize_ = clampToRange(options.bucketSize, 0, 100);
    /** @private @const {number} */
    this.refillRate_ = clampToRange(options.refillRate, 0, this.bucketSize_);
    /** @private @const {number} */
    this.refillInterval_ = clampToRange(options.refillInterval, 0, ONE_DAY_IN_MS);
    /** @private {!Object<string, {tokens: number, lastAccess: number}>} */
    this.buckets_ = {};
  }

  /**
   * @param {{tokens: number, lastAccess: number}} bucket
   * @param {number} now
   * @private
   */
  applyRefill_(bucket, now) {
    const elapsedMs = now - bucket.lastAccess;
    const refillIntervals = Math.floor(elapsedMs / this.refillInterval_);
    if (refillIntervals > 0) {
      bucket.tokens = Math.min(bucket.tokens + refillIntervals * this.refillRate_, this.bucketSize_);
      bucket.lastAccess = bucket.lastAccess + refillIntervals * this.refillInterval_;
    }
  }

  /**
   * Takes a token for `key`. Returns true when the call is rate limited (the
   * bucket was empty, or this call emptied it).
   * @param {string|number} key
   * @return {boolean}
   */
  consumeRateLimit(key) {
    const now = Date.now();
    const keyStr = String(key);
    let bucket = this.buckets_[keyStr];
    if (!bucket) {
      bucket = {tokens: this.bucketSize_, lastAccess: now};
      this.buckets_[keyStr] = bucket;
    } else {
      this.applyRefill_(bucket, now);
    }
    if (bucket.tokens === 0) return true;
    bucket.tokens--;
    return bucket.tokens === 0;
  }

  stop() {
    this.buckets_ = {};
  }
}
