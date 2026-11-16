/**
 * @fileoverview Ports of upstream replay helpers: sessionrecording-utils.ts
 * (sizes, console-log truncation, buffer splitting), flushed-size-tracker.ts,
 * mutation-throttler.ts (with core's BucketedRateLimiter) and config.ts
 * (network plugin options). rrweb events use quoted keys.
 */
import {PostHog} from '../core/posthog.js';
import {logger as baseLogger} from '../core/logger.js';
import {
  clampToRange, convertToURL, each, isArray, isFunction, isNull, isNullish, isNumber, isObject, isString,
  isUndefined, trim, utf8ByteLength,
} from '../core/utils.js';
import {SESSION_RECORDING_FLUSHED_SIZE} from './constants.js';

const LOGGER_PREFIX = '[SessionRecording]';

/** @const {number} */ export const FULL_SNAPSHOT_EVENT_TYPE = 2;
/** @const {number} */ export const META_EVENT_TYPE = 4;
/** @const {number} */ export const INCREMENTAL_SNAPSHOT_EVENT_TYPE = 3;
/** @const {number} */ export const CUSTOM_EVENT_TYPE = 5;
/** @const {number} */ export const PLUGIN_EVENT_TYPE = 6;
/** @const {number} */ export const MUTATION_SOURCE_TYPE = 0;
/** @const {number} */ export const STYLE_SHEET_RULE_SOURCE_TYPE = 8;
/** @const {number} */ export const CANVAS_MUTATION_SOURCE_TYPE = 9;

/**
 * Upstream circularReferenceReplacer.
 * @return {function(this:?, string, *): *}
 */
export function circularReferenceReplacer() {
  const ancestors = [];
  return function(_key, value) {
    if (isObject(value) || isArray(value)) {
      while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
      if (ancestors.indexOf(value) !== -1) return '[Circular]';
      ancestors.push(value);
      return value;
    }
    return value;
  };
}

/**
 * Upstream's `new Blob([data]).size`. A string goes through utf8ByteLength
 * (same number, no blob); anything else (the network plugin's bodies are
 * typed as strings, but Blob would size a buffer as binary) still uses Blob.
 * @param {*} data
 * @return {number}
 */
function estimateStringBytes(data) {
  return isString(data) ? utf8ByteLength(/** @type {string} */ (data)) : new Blob([data]).size;
}

/** @const {number} */ export const UNSTRINGIFIABLE_EVENT_SIZE = -1;

/**
 * @param {*} sizeable
 * @return {number}
 */
export function estimateSize(sizeable) {
  try {
    const s = JSON.stringify(sizeable, circularReferenceReplacer());
    return s ? estimateStringBytes(s) : 0;
  } catch (e) {
    return UNSTRINGIFIABLE_EVENT_SIZE;
  }
}

/**
 * Loose JSON size estimate for compressed events (no string allocation).
 * @param {*} value
 * @return {number}
 */
export function estimateCompressedEventSize(value) {
  if (isNull(value)) return 4;
  if (isUndefined(value)) return 0;
  switch (typeof value) {
    case 'string':
      return /** @type {string} */ (value).length + 2;
    case 'number':
      return String(value).length;
    case 'boolean':
      return value ? 4 : 5;
    case 'object': {
      if (isArray(value)) {
        const arr = /** @type {!Array<*>} */ (value);
        let size = 2;
        for (let i = 0; i < arr.length; i++) {
          if (i > 0) size += 1;
          const el = arr[i];
          size += isNullish(el) ? 4 : estimateCompressedEventSize(el);
        }
        return size;
      }
      const obj = /** @type {!Object} */ (value);
      let size = 2;
      let first = true;
      for (const key in obj) {
        if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
        const val = obj[key];
        if (isUndefined(val)) continue;
        if (!first) size += 1;
        first = false;
        size += key.length + 3 + estimateCompressedEventSize(val);
      }
      return size;
    }
    default:
      return 0;
  }
}

/** @const {string} */ export const CONSOLE_LOG_PLUGIN_NAME = 'rrweb/console@1';

/**
 * Truncates console-log plugin payloads (upstream truncateLargeConsoleLogs).
 * @param {!Object} event
 * @return {!Object}
 */
export function truncateLargeConsoleLogs(event) {
  const MAX_STRING_SIZE = 2000;
  const MAX_STRINGS_PER_LOG = 10;
  if (event && isObject(event) && event['type'] === PLUGIN_EVENT_TYPE && isObject(event['data']) &&
      event['data']['plugin'] === CONSOLE_LOG_PLUGIN_NAME) {
    const p = event['data']['payload'];
    if (p['payload'].length > MAX_STRINGS_PER_LOG) {
      p['payload'] = p['payload'].slice(0, MAX_STRINGS_PER_LOG);
      p['payload'].push('...[truncated]');
    }
    const updated = [];
    for (let i = 0; i < p['payload'].length; i++) {
      const s = p['payload'][i];
      if (s && s.length > MAX_STRING_SIZE) updated.push(s.slice(0, MAX_STRING_SIZE) + '...[truncated]');
      else updated.push(s);
    }
    p['payload'] = updated;
  }
  return event;
}

/** @const {number} */ export const SEVEN_MEGABYTES = 1024 * 1024 * 7 * 0.9;

/**
 * A replay buffer. Quoted keys: it is parked in sessionStorage with the
 * same shape as upstream.
 * @typedef {{size: number, data: !Array<!Object>, sizes: !Array<number>, sessionId: string, windowId: string}}
 */
export let SnapshotBuffer;

/**
 * @param {!Array<number>} sizes
 * @return {number}
 */
function sum(sizes) {
  return sizes.reduce(function(a, b) {
    return a + b;
  }, 0);
}

/**
 * Recursively halves buffers larger than `sizeLimit` (upstream splitBuffer).
 * @param {!Object} buffer SnapshotBuffer with quoted keys
 * @param {number=} sizeLimit
 * @return {!Array<!Object>}
 */
export function splitBuffer(buffer, sizeLimit) {
  const limit = isUndefined(sizeLimit) ? SEVEN_MEGABYTES : /** @type {number} */ (sizeLimit);
  if (buffer['size'] >= limit && buffer['data'].length > 1) {
    const half = Math.floor(buffer['data'].length / 2);
    const firstSizes = buffer['sizes'].slice(0, half);
    const secondSizes = buffer['sizes'].slice(half);
    return splitBuffer({
      'size': sum(firstSizes), 'data': buffer['data'].slice(0, half), 'sizes': firstSizes,
      'sessionId': buffer['sessionId'], 'windowId': buffer['windowId'],
    }, limit).concat(splitBuffer({
      'size': sum(secondSizes), 'data': buffer['data'].slice(half), 'sizes': secondSizes,
      'sessionId': buffer['sessionId'], 'windowId': buffer['windowId'],
    }, limit));
  }
  return [buffer];
}

// ---------------------------------------------------------------------------
// flushed-size-tracker.ts

export class FlushedSizeTracker {
  /** @param {!PostHog} posthog */
  constructor(posthog) {
    if (!posthog.persistence) {
      throw new Error('it is not valid to not have persistence and be this far into setting up the application');
    }
    /** @private @const */
    this.posthog_ = posthog;
  }

  /**
   * @param {string} sessionId
   * @param {number} size
   */
  trackSize(sessionId, size) {
    if (!this.posthog_.persistence) return;
    this.posthog_.persistence.set_property(SESSION_RECORDING_FLUSHED_SIZE,
        {'sessionId': sessionId, 'size': this.currentTrackedSize(sessionId) + size});
  }

  /**
   * @param {string} sessionId
   * @return {number}
   */
  currentTrackedSize(sessionId) {
    const stored = this.posthog_.get_property(SESSION_RECORDING_FLUSHED_SIZE);
    return isObject(stored) && isString(stored['sessionId']) && isNumber(stored['size']) &&
        stored['sessionId'] === sessionId ? stored['size'] : 0;
  }
}

// ---------------------------------------------------------------------------
// @posthog/core BucketedRateLimiter

const ONE_DAY_IN_MS = 86400000;

export class BucketedRateLimiter {
  /**
   * @param {{bucketSize: number, refillRate: number, refillInterval: number,
   *     onBucketRateLimited: (function(number)|undefined)}} options
   */
  constructor(options) {
    /** @private @const */
    this.onBucketRateLimited_ = options.onBucketRateLimited;
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
   * @param {number} key
   * @return {boolean} true when rate limited
   */
  consumeRateLimit(key) {
    const now = Date.now();
    const keyStr = String(key);
    let bucket = this.buckets_[keyStr];
    if (!bucket) {
      bucket = {tokens: this.bucketSize_, lastAccess: now};
      this.buckets_[keyStr] = bucket;
    } else {
      const refillIntervals = Math.floor((now - bucket.lastAccess) / this.refillInterval_);
      if (refillIntervals > 0) {
        bucket.tokens = Math.min(bucket.tokens + refillIntervals * this.refillRate_, this.bucketSize_);
        bucket.lastAccess = bucket.lastAccess + refillIntervals * this.refillInterval_;
      }
    }
    if (bucket.tokens === 0) return true;
    bucket.tokens--;
    if (bucket.tokens === 0 && this.onBucketRateLimited_) this.onBucketRateLimited_(key);
    return bucket.tokens === 0;
  }

  stop() {
    this.buckets_ = {};
  }
}

// ---------------------------------------------------------------------------
// mutation-throttler.ts

/** @const {number} */ export const DEFAULT_MUTATION_BYTES_REFILL_RATE = 25 * 1024;
/** @const {number} */ export const DEFAULT_MUTATION_RESYNC_INTERVAL_MS = 5 * 60 * 1000;

/**
 * @typedef {{
 *   bucketSize: (number|undefined),
 *   refillRate: (number|undefined),
 *   bytesBucketSize: (number|undefined),
 *   bytesRefillRate: (number|undefined),
 *   resyncIntervalMs: (number|undefined),
 *   onBlockedNode: (function(number, ?Node)|undefined),
 *   onDroppedAttributeMutations: (function(number)|undefined),
 *   onDroppedOversizedMutation: (function(number)|undefined),
 *   requestFullSnapshot: (function()|undefined),
 * }}
 */
export let MutationThrottlerOptions;

export class MutationThrottler {
  /**
   * @param {?} rrweb the rrweb `record` function (with `.mirror`)
   * @param {!MutationThrottlerOptions} options
   */
  constructor(rrweb, options) {
    /** @private @const */
    this.rrweb_ = rrweb;
    /** @private @const */
    this.options_ = options;
    /** @private {!Object<string, boolean>} */
    this.loggedTracker_ = {};
    const self = this;
    /** @private @const */
    this.rateLimiter_ = new BucketedRateLimiter({
      bucketSize: isNullish(options.bucketSize) ? 100 : /** @type {number} */ (options.bucketSize),
      refillRate: isNullish(options.refillRate) ? 10 : /** @type {number} */ (options.refillRate),
      refillInterval: 1000,
      onBucketRateLimited: function(key) {
        self.onNodeRateLimited_(key);
      },
    });
    /** @private {number} */
    this.bytesBucketSize_ = isNullish(options.bytesBucketSize) ? 0 : /** @type {number} */ (options.bytesBucketSize);
    /** @private {number} */
    this.bytesRefillRate_ = isNullish(options.bytesRefillRate) ? DEFAULT_MUTATION_BYTES_REFILL_RATE :
        /** @type {number} */ (options.bytesRefillRate);
    /** @private {boolean} */
    this.byteBudgetDisabled_ = !isFinite(this.bytesBucketSize_) || this.bytesBucketSize_ <= 0;
    /** @private {number} */
    this.byteTokens_ = this.bytesBucketSize_;
    /** @private {number} */
    this.lastByteRefill_ = Date.now();
    const r = options.resyncIntervalMs;
    /** @private {number} */
    this.resyncIntervalMs_ = isNumber(r) && isFinite(r) && r > 0 ? /** @type {number} */ (r) :
        DEFAULT_MUTATION_RESYNC_INTERVAL_MS;
    /** @private {number|undefined} */
    this.resyncTimer_ = undefined;
    /** @private {number} */
    this.lastResyncAt_ = -Infinity;
  }

  /** @private */
  refillByteBudget_() {
    const now = Date.now();
    const elapsed = now - this.lastByteRefill_;
    if (elapsed <= 0) {
      this.lastByteRefill_ = now;
      return;
    }
    this.byteTokens_ = Math.min(this.bytesBucketSize_, this.byteTokens_ + (elapsed / 1000) * this.bytesRefillRate_);
    this.lastByteRefill_ = now;
  }

  /**
   * @param {number} key
   * @private
   */
  onNodeRateLimited_(key) {
    if (!this.loggedTracker_[String(key)]) {
      this.loggedTracker_[String(key)] = true;
      const node = this.getNode_(key);
      if (this.options_.onBlockedNode) this.options_.onBlockedNode(key, node);
    }
  }

  /**
   * @param {number} id
   * @return {?Node}
   * @private
   */
  getNode_(id) {
    return this.rrweb_['mirror']['getNode'](id);
  }

  /**
   * @param {number} id
   * @return {!Array<?>} [id, node]
   * @private
   */
  getNodeOrRelevantParent_(id) {
    const node = this.getNode_(id);
    if ((!node || node.nodeName !== 'svg') && node instanceof Element) {
      const closestSVG = node.closest('svg');
      if (closestSVG) return [this.rrweb_['mirror']['getId'](closestSVG), closestSVG];
    }
    return [id, node];
  }

  /**
   * @param {!Object} data
   * @return {number}
   * @private
   */
  numberOfChanges_(data) {
    const len = function(x) {
      return x ? x.length : 0;
    };
    return len(data['removes']) + len(data['attributes']) + len(data['texts']) + len(data['adds']);
  }

  /**
   * @param {!Object} event
   * @return {!Object|undefined} undefined when the event is dropped
   */
  throttleMutations(event) {
    if (event['type'] !== INCREMENTAL_SNAPSHOT_EVENT_TYPE || event['data']['source'] !== MUTATION_SOURCE_TYPE) {
      return event;
    }
    const data = event['data'];
    const initialMutationCount = this.numberOfChanges_(data);
    if (data['attributes']) {
      const beforeCount = data['attributes'].length;
      const self = this;
      data['attributes'] = data['attributes'].filter(function(attr) {
        const nodeId = self.getNodeOrRelevantParent_(attr['id'])[0];
        return !self.rateLimiter_.consumeRateLimit(nodeId);
      });
      const dropped = beforeCount - data['attributes'].length;
      if (dropped > 0 && this.options_.onDroppedAttributeMutations) this.options_.onDroppedAttributeMutations(dropped);
    }
    const mutationCount = this.numberOfChanges_(data);
    if (mutationCount === 0 && initialMutationCount !== mutationCount) return undefined;
    if (this.byteBudgetDisabled_) return event;
    this.refillByteBudget_();
    const eventBytes = estimateCompressedEventSize(event);
    if (eventBytes > this.byteTokens_) {
      if (this.options_.onDroppedOversizedMutation) this.options_.onDroppedOversizedMutation(eventBytes);
      this.scheduleResync_();
      return undefined;
    }
    this.byteTokens_ -= eventBytes;
    return event;
  }

  /** @private */
  scheduleResync_() {
    if (this.resyncTimer_) return;
    const delay = Math.max(0, this.resyncIntervalMs_ - (Date.now() - this.lastResyncAt_));
    const self = this;
    this.resyncTimer_ = setTimeout(function() {
      self.resyncTimer_ = undefined;
      self.lastResyncAt_ = Date.now();
      if (self.options_.requestFullSnapshot) self.options_.requestFullSnapshot();
    }, delay);
  }

  reset() {
    this.loggedTracker_ = {};
    if (this.resyncTimer_) {
      clearTimeout(this.resyncTimer_);
      this.resyncTimer_ = undefined;
    }
    this.lastResyncAt_ = Date.now();
  }

  stop() {
    this.rateLimiter_.stop();
    this.reset();
    this.byteTokens_ = this.bytesBucketSize_;
    this.lastByteRefill_ = Date.now();
    this.lastResyncAt_ = -Infinity;
  }
}

// ---------------------------------------------------------------------------
// config.ts: network plugin options

const REDACTED = 'redacted';
/** @const {number} */ export const MAX_PAYLOAD_SIZE_BYTES = 1000000;

/**
 * @param {!Object} options
 * @return {number}
 */
export function effectivePayloadLimitBytes(options) {
  const v = options['payloadSizeLimitBytes'];
  return Math.min(MAX_PAYLOAD_SIZE_BYTES, isNullish(v) ? MAX_PAYLOAD_SIZE_BYTES : v);
}

/** @return {!Object} upstream defaultNetworkOptions (quoted keys, as passed to the rrweb plugin) */
export function defaultNetworkOptions() {
  return {
    'initiatorTypes': ['audio', 'beacon', 'body', 'css', 'early-hint', 'embed', 'fetch', 'frame', 'iframe', 'icon',
      'image', 'img', 'input', 'link', 'navigation', 'object', 'ping', 'script', 'track', 'video', 'xmlhttprequest'],
    'maskRequestFn': function(data) {
      return data;
    },
    'recordHeaders': false,
    'recordBody': false,
    'recordInitialRequests': false,
    'recordPerformance': false,
    'performanceEntryTypeToObserve': ['first-input', 'navigation', 'paint', 'resource'],
    'payloadSizeLimitBytes': MAX_PAYLOAD_SIZE_BYTES,
    'payloadHostDenyList': ['.lr-ingest.io', '.ingest.sentry.io', '.clarity.ms', 'google-analytics.com',
      'analytics.google.com', 'nr-data.net', 'datadoghq.com', 'datadoghq.eu', 'ddog-gov.com', 'segment.io',
      'rudderstack.com', 'amplitude.com', 'mixpanel.com', 'hotjar.com', 'hotjar.io', 'fullstory.com'],
    'streamNetworkBody': false,
  };
}

const HEADER_DENY_LIST = ['authorization', 'x-forwarded-for', 'authorization', 'cookie', 'set-cookie', 'x-api-key',
  'x-real-ip', 'remote-addr', 'forwarded', 'proxy-authorization', 'x-csrf-token', 'x-csrftoken', 'x-xsrf-token'];
const PAYLOAD_CONTENT_DENY_LIST = ['password', 'secret', 'passwd', 'api_key', 'apikey', 'auth', 'credentials',
  'mysql_pwd', 'privatekey', 'private_key', 'token'];
const HEADER_DENY_SUBSTRINGS = ['auth', 'token', 'secret', 'session', 'api-key', 'apikey', 'api_key', 'credential',
  'password', 'passwd', 'cookie', 'csrf', 'xsrf'];

/**
 * @param {string} header
 * @return {boolean}
 */
function isDeniedHeader(header) {
  const l = header.toLowerCase();
  return HEADER_DENY_LIST.indexOf(l) !== -1 || HEADER_DENY_SUBSTRINGS.some(function(s) {
    return l.indexOf(s) !== -1;
  });
}

/** @param {?Object|undefined} headers */
function redactDeniedHeaders(headers) {
  if (!isNullish(headers)) {
    each(Object.keys(/** @type {!Object} */ (headers)), function(header) {
      if (isDeniedHeader(header)) headers[header] = REDACTED;
    });
  }
}

/**
 * @param {!Object} data
 * @return {!Object}
 */
function removeAuthorizationHeader(data) {
  redactDeniedHeaders(data['requestHeaders']);
  redactDeniedHeaders(data['responseHeaders']);
  return data;
}

const POSTHOG_PATHS_TO_IGNORE = ['/s/', '/e/', '/i/'];

/**
 * @param {!Object} data
 * @param {string} apiHostConfig
 * @param {(function(string): boolean)=} isIngestionEndpoint
 * @return {!Object|undefined}
 */
function ignorePostHogPaths(data, apiHostConfig, isIngestionEndpoint) {
  if (isIngestionEndpoint && isIngestionEndpoint(data['name'])) return undefined;
  const url = convertToURL(data['name']);
  let replaceValue = apiHostConfig.indexOf('http') === 0 ?
      (convertToURL(apiHostConfig) || {pathname: undefined}).pathname : apiHostConfig;
  if (replaceValue === '/') replaceValue = '';
  const pathname = url ? url.pathname.replace(replaceValue || '', '') : undefined;
  if (url && pathname && POSTHOG_PATHS_TO_IGNORE.some(function(p) {
    return pathname.indexOf(p) === 0;
  })) {
    return undefined;
  }
  return data;
}

/**
 * @param {?string|undefined} payload
 * @param {?Object|undefined} headers
 * @param {number} limit
 * @param {string} description
 * @return {?string|undefined}
 */
function enforcePayloadSizeLimit(payload, headers, limit, description) {
  if (isNullish(payload)) return payload;
  let len = (headers && headers['content-length']) || estimateStringBytes(payload);
  if (isString(len)) len = parseInt(len, 10);
  if (len > limit) return LOGGER_PREFIX + ' ' + description + ' body too large to record (' + len + ' bytes)';
  return payload;
}

/**
 * @param {!Object} options
 * @return {function((!Object|undefined)): (!Object|undefined)}
 */
function limitPayloadSize(options) {
  const limit = effectivePayloadLimitBytes(options);
  return function(data) {
    if (data && data['requestBody']) {
      data['requestBody'] = enforcePayloadSizeLimit(data['requestBody'], data['requestHeaders'], limit, 'Request');
    }
    if (data && data['responseBody']) {
      data['responseBody'] = enforcePayloadSizeLimit(data['responseBody'], data['responseHeaders'], limit, 'Response');
    }
    return data;
  };
}

// browser-common autocapture-utils shouldCaptureValue (anchored regexes).
const CC_PATTERN = '(4[0-9]{12}(?:[0-9]{3})?)|(5[1-5][0-9]{14})|(6(?:011|5[0-9]{2})[0-9]{12})|(3[47][0-9]{13})|' +
    '(3(?:0[0-5]|[68][0-9])[0-9]{11})|((?:2131|1800|35[0-9]{3})[0-9]{11})';
const ANCHORED_CC_REGEX = new RegExp('^(?:' + CC_PATTERN + ')$');
const ANCHORED_SSN_REGEX = new RegExp('^(\\d{3}-?\\d{2}-?\\d{4})$');

/**
 * @param {*} value
 * @return {boolean}
 */
export function shouldCaptureValue(value) {
  if (isNullish(value)) return false;
  if (isString(value)) {
    const v = trim(/** @type {string} */ (value));
    if (ANCHORED_CC_REGEX.test((v || '').replace(/[- ]/g, ''))) return false;
    if (ANCHORED_SSN_REGEX.test(v)) return false;
  }
  return true;
}

/**
 * @param {?string|undefined} payload
 * @param {string} label
 * @return {?string|undefined}
 */
function scrubPayload(payload, label) {
  if (isNullish(payload)) return payload;
  let scrubbed = /** @type {string} */ (payload);
  if (!shouldCaptureValue(scrubbed)) scrubbed = LOGGER_PREFIX + ' ' + label + ' body ' + REDACTED;
  each(PAYLOAD_CONTENT_DENY_LIST, function(text) {
    if (scrubbed && scrubbed.length && scrubbed.indexOf(text) !== -1) {
      scrubbed = LOGGER_PREFIX + ' ' + label + ' body ' + REDACTED + ' as might contain: ' + text;
    }
  });
  return scrubbed;
}

/**
 * @param {!Object|undefined} req
 * @return {!Object|undefined}
 */
function scrubPayloads(req) {
  if (isUndefined(req)) return undefined;
  req['requestBody'] = scrubPayload(req['requestBody'], 'Request');
  req['responseBody'] = scrubPayload(req['responseBody'], 'Response');
  return req;
}

/**
 * Upstream buildNetworkRequestOptions. Like upstream, a deprecated
 * `maskNetworkRequestFn` is adapted in place onto
 * `session_recording.maskCapturedNetworkRequestFn`.
 * @param {!Object} instanceConfig PostHog config
 * @param {!Object} remoteNetworkOptions {recordHeaders, recordBody, recordPerformance, payloadHostDenyList}
 * @param {(function(string): boolean)=} isIngestionEndpoint
 * @return {!Object}
 */
export function buildNetworkRequestOptions(instanceConfig, remoteNetworkOptions, isIngestionEndpoint) {
  const defaults = defaultNetworkOptions();
  const sr = instanceConfig['session_recording'];
  const config = {
    'payloadSizeLimitBytes': defaults['payloadSizeLimitBytes'],
    'performanceEntryTypeToObserve': defaults['performanceEntryTypeToObserve'].slice(),
    'payloadHostDenyList': (remoteNetworkOptions['payloadHostDenyList'] || []).concat(defaults['payloadHostDenyList']),
  };
  const canRecordHeaders = sr['recordHeaders'] === false ? false : remoteNetworkOptions['recordHeaders'];
  const canRecordBody = sr['recordBody'] === false ? false : remoteNetworkOptions['recordBody'];
  const canRecordPerformance = instanceConfig['capture_performance'] === false ? false :
      remoteNetworkOptions['recordPerformance'];
  const payloadLimiter = limitPayloadSize(config);
  /**
   * @param {!Object} d
   * @return {!Object|undefined}
   */
  const enforcedCleaningFn = function(d) {
    const ignored = ignorePostHogPaths(removeAuthorizationHeader(d), instanceConfig['api_host'], isIngestionEndpoint);
    return payloadLimiter(ignored);
  };
  const hasDeprecatedMaskFunction = isFunction(sr['maskNetworkRequestFn']);
  if (hasDeprecatedMaskFunction && isFunction(sr['maskCapturedNetworkRequestFn'])) {
    baseLogger.warn('Both `maskNetworkRequestFn` and `maskCapturedNetworkRequestFn` are defined. ' +
        '`maskNetworkRequestFn` will be ignored.');
  } else if (hasDeprecatedMaskFunction) {
    sr['maskCapturedNetworkRequestFn'] = function(data) {
      const cleanedURL = sr['maskNetworkRequestFn']({'url': data['name']});
      if (!cleanedURL && data['isInitial']) return undefined;
      const out = {};
      for (const k in data) out[k] = data[k];
      out['name'] = cleanedURL ? cleanedURL['url'] : undefined;
      return out;
    };
  }
  // Upstream marks the URL-less fallback below in a WeakSet that the network
  // plugin (bundled with it) checks to also drop the parent's derived server
  // timings. The plugin in recorder.js has its own WeakSet, so we drop those
  // derived entries here instead: the plugin passes each parent request and
  // then its server timings through this function, in order.
  let parentFellBack = false;
  config['maskRequestFn'] = isFunction(sr['maskCapturedNetworkRequestFn']) ? function(data) {
    if (data['entryType'] === 'serverTiming') {
      if (parentFellBack) return undefined;
    } else {
      parentFellBack = false;
    }
    const cleaned = enforcedCleaningFn(data);
    if (!cleaned) return undefined;
    const required = cleaned['isInitial'] ? {
      'name': '',
      'entryType': cleaned['entryType'],
      'startTime': cleaned['startTime'],
      'duration': cleaned['duration'],
      'endTime': cleaned['endTime'],
      'timeOrigin': cleaned['timeOrigin'],
      'timestamp': cleaned['timestamp'],
      'isInitial': true,
    } : undefined;
    const fn = sr['maskCapturedNetworkRequestFn'];
    const masked = fn ? fn(cleaned) : undefined;
    if (isNullish(masked) && required) {
      parentFellBack = true;
      return required;
    }
    return isNullish(masked) ? undefined : masked;
  } : function(data) {
    return scrubPayloads(enforcedCleaningFn(data));
  };
  const out = {};
  for (const k in defaults) out[k] = defaults[k];
  for (const k in config) out[k] = config[k];
  out['recordHeaders'] = canRecordHeaders;
  out['recordBody'] = canRecordBody;
  out['recordPerformance'] = canRecordPerformance;
  out['recordInitialRequests'] = canRecordPerformance;
  out['streamNetworkBody'] = sr['streamNetworkBody'] === true;
  return out;
}
