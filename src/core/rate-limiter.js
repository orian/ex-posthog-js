/**
 * @fileoverview Client-side token-bucket rate limiting and server quota
 * limiting (port of upstream rate-limiter.ts).
 */
import {CAPTURE_RATE_LIMIT} from './constants.js';
import {logger as baseLogger} from './logger.js';
import {assign, isArray, isNumber, loc} from './utils.js';

const logger = baseLogger.createLogger('[RateLimiter]');
const ONE_MINUTE_IN_MILLISECONDS = 60 * 1000;
const RATE_LIMIT_EVENT = '$$client_ingestion_warning';
const DEFAULT_EVENTS_PER_SECOND = 10;
const BURST_LIMIT_MULTIPLIER = 10;

/**
 * What the rate limiter needs from the PostHog instance.
 * @record
 */
export class RateLimiterHost {
  constructor() {}
  /** @return {!Object} live config (quoted keys) */
  getConfig() {}
  /**
   * @param {string} key
   * @return {*}
   */
  getProp(key) {}
  /**
   * @param {string} key
   * @param {*} value
   */
  setProp(key, value) {}
  /** @return {string|undefined} */
  sessionId() {}
  /**
   * @param {string} event
   * @param {!Object} props
   * @param {!Object} options
   * @return {*} the captured event or undefined
   */
  capture(event, props, options) {}
}

export class RateLimiter {
  /** @param {!RateLimiterHost} host */
  constructor(host) {
    /** @private @const {!RateLimiterHost} */
    this.host_ = host;
    /** @type {!Object<string, number>} */
    this.serverLimits = {};
    /** @type {boolean} */
    this.lastEventRateLimited = false;
    this.lastEventRateLimited = this.clientRateLimitContext(true).isRateLimited;
  }

  /** @return {number} */
  captureEventsPerSecond() {
    const rl = this.host_.getConfig()['rate_limiting'];
    return (rl && rl['events_per_second']) || DEFAULT_EVENTS_PER_SECOND;
  }

  /** @return {number} */
  captureEventsBurstLimit() {
    const rl = this.host_.getConfig()['rate_limiting'];
    return Math.max((rl && rl['events_burst_limit']) || this.captureEventsPerSecond() * BURST_LIMIT_MULTIPLIER,
        this.captureEventsPerSecond());
  }

  /** @return {boolean} whether an event captured now would be dropped (no state change) */
  isClientRateLimited() {
    return this.refilledBucket_()['tokens'] < 1;
  }

  /**
   * @param {boolean=} checkOnly
   * @return {{isRateLimited: boolean, remainingTokens: number}}
   */
  clientRateLimitContext(checkOnly) {
    const bucket = this.refilledBucket_();
    const isRateLimited = bucket['tokens'] < 1;
    if (!isRateLimited && !checkOnly) bucket['tokens'] = Math.max(0, bucket['tokens'] - 1);
    if (isRateLimited && !checkOnly) {
      const dropped = (isNumber(bucket['dropped']) ? bucket['dropped'] : 0) + 1;
      bucket['dropped'] = dropped;
      if (!this.lastEventRateLimited && this.captureWarning_(dropped)) bucket['dropped'] = 0;
    }
    this.lastEventRateLimited = isRateLimited;
    this.host_.setProp(CAPTURE_RATE_LIMIT, bucket);
    return {isRateLimited: isRateLimited, remainingTokens: bucket['tokens']};
  }

  /** @return {!Object} @private */
  refilledBucket_() {
    const burst = this.captureEventsBurstLimit();
    const perSecond = this.captureEventsPerSecond();
    const now = new Date().getTime();
    const stored = this.host_.getProp(CAPTURE_RATE_LIMIT);
    const bucket = stored ? assign(stored) : {'tokens': burst, 'last': now};
    bucket['tokens'] += (Math.max(0, now - bucket['last']) / 1000) * perSecond;
    bucket['last'] = Math.max(bucket['last'], now);
    if (bucket['tokens'] > burst) bucket['tokens'] = burst;
    return bucket;
  }

  /**
   * @param {string} property
   * @return {boolean}
   * @private
   */
  isPropertyAllowed_(property) {
    const denylist = this.host_.getConfig()['property_denylist'];
    return !isArray(denylist) || denylist.indexOf(property) === -1;
  }

  /** @return {string|undefined} @private */
  triggeringPage_() {
    if (!this.isPropertyAllowed_('$current_url') || !this.isPropertyAllowed_('$pathname') || !loc || !loc.pathname) {
      return undefined;
    }
    return (loc.origin || '') + loc.pathname;
  }

  /**
   * @param {number} dropped
   * @return {boolean}
   * @private
   */
  captureWarning_(dropped) {
    const page = this.triggeringPage_();
    const sessionId = this.isPropertyAllowed_('$session_id') ? this.host_.sessionId() : undefined;
    const context = [
      dropped + ' event(s) dropped since the last warning',
      page ? 'triggered on ' + page : undefined,
      sessionId ? 'session ' + sessionId : undefined,
    ].filter(Boolean).join(', ');
    return !!this.host_.capture(RATE_LIMIT_EVENT, {
      '$$client_ingestion_warning_message': 'posthog-js client rate limited: ' + context + '. Config is set to ' +
          this.captureEventsPerSecond() + ' events per second and ' + this.captureEventsBurstLimit() +
          ' events burst limit.',
    }, {'skip_client_rate_limiting': true});
  }

  /**
   * @param {string|undefined} batchKey
   * @return {boolean}
   */
  isServerRateLimited(batchKey) {
    const retryAfter = this.serverLimits[batchKey || 'events'] || false;
    if (retryAfter === false) return false;
    return new Date().getTime() < retryAfter;
  }

  /** @param {{text: (string|undefined)}} response */
  checkForLimiting(response) {
    const text = response.text;
    if (!text || !text.length) return;
    try {
      const parsed = JSON.parse(text);
      const limited = parsed['quota_limited'] || [];
      const self = this;
      limited.forEach(function(batchKey) {
        logger.info((batchKey || 'events') + ' is quota limited.');
        self.serverLimits[batchKey] = new Date().getTime() + ONE_MINUTE_IN_MILLISECONDS;
      });
    } catch (e) {
      logger.warn('could not rate limit - continuing. Error: "' + (e && e.message) + '"', {'text': text});
    }
  }
}
