/**
 * @fileoverview HTTP transports (port of upstream request.ts): fetch, XHR and
 * sendBeacon, gzip (native CompressionStream with upstream's output
 * validation when async is allowed, the sync encoder in gzip.js otherwise)
 * and base64 form encoding, plus the
 * `timestampMode` body/query `sent_at` handling.
 */
import {
  assign, base64Encode, extendURLParams, getQueryParam, isArray, isUndefined, jsonStringify, nav,
  removeURLParam, utf8ByteLength, win,
} from './utils.js';
import {logger} from './logger.js';
import {gzipCompress, gzipSync, isNativeAsyncGzipError, isNativeAsyncGzipReadError} from './gzip.js';

/** @const {string} */ export const COMPRESSION_GZIP_JS = 'gzip-js';
/** @const {string} */ export const COMPRESSION_BASE64 = 'base64';

/**
 * A request. `compression` is 'gzip-js' | 'base64' | 'best-available' |
 * undefined; `transport` is 'fetch' | 'XHR' | 'sendBeacon' | undefined;
 * `timestampMode` is 'capture-body' | 'body' | 'query' | undefined.
 * @record
 */
export class RequestOptions {
  constructor() {
    /** @type {string} */
    this.url;
    /** @type {string|undefined} */
    this.method;
    /** @type {*} */
    this.data;
    /** @type {!Object<string, string>|undefined} */
    this.headers;
    /** @type {string|undefined} */
    this.transport;
    /** @type {string|undefined} */
    this.compression;
    /** @type {string|undefined} */
    this.compressionFallback;
    /** @type {boolean|undefined} */
    this.preferSyncCompression;
    /** @type {string|undefined} */
    this.timestampMode;
    /** @type {string|undefined} */
    this.batchKey;
    /** @type {string|undefined} */
    this.batchGroup;
    /** @type {(function(!PHResponse)|undefined)} */
    this.callback;
    /** @type {boolean|undefined} */
    this.fireCallbackOnDrop;
    /** @type {number|undefined} */
    this.timeout;
    /** @type {!Array<string>|undefined} */
    this.disableTransport;
    /** @type {!Object|undefined} */
    this.fetchOptions;
    /** @type {number|undefined} */
    this.retriesPerformedSoFar;
    /** @type {(function()|undefined)} */
    this.onDispatch;
  }
}

/**
 * Transport-level completion: (response, retryAfterMs).
 * @typedef {function(!PHResponse, (number|undefined))}
 */
export let TransportCallback;

/** @typedef {{contentType: string, body: *, estimatedSize: number}} */
let EncodedBody;

const CONTENT_TYPE_PLAIN = 'text/plain';
const CONTENT_TYPE_JSON = 'application/json';
const CONTENT_TYPE_FORM = 'application/x-www-form-urlencoded';
const KEEP_ALIVE_THRESHOLD = 64 * 1024 * 0.8;
const BEACON_SPLIT_FLOOR_BYTES = 16 * 1024;

let pendingKeepaliveBytes = 0;
let nativeAsyncGzipDisabled = false;

/** @return {boolean} */
function hasFetch() {
  return !!(win && win.fetch);
}

/** @return {boolean} */
function hasXHR() {
  return !!(win && win['XMLHttpRequest']);
}

/** @return {boolean} */
function hasBeacon() {
  return !!(nav && nav.sendBeacon);
}

/** @const {boolean} */
export const SUPPORTS_REQUEST = hasXHR() || hasFetch();

/**
 * @param {string} s
 * @return {number}
 */
function byteSize(s) {
  try {
    return utf8ByteLength(s); // == new Blob([s]).size
  } catch (e) {
    return s.length;
  }
}

/**
 * @param {!Uint8Array} u8
 * @return {!ArrayBuffer}
 */
function toArrayBuffer(u8) {
  if (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) return /** @type {!ArrayBuffer} */ (u8.buffer);
  return /** @type {!ArrayBuffer} */ (u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
}

/**
 * @param {!RequestOptions} options
 * @param {?EncodedBody=} preEncoded
 * @return {?EncodedBody|undefined}
 */
function encodePostData(options, preEncoded) {
  if (preEncoded) return preEncoded;
  const data = options.data;
  if (!data) return undefined;
  if (options.compression === COMPRESSION_GZIP_JS) {
    const gz = gzipSync(jsonStringify(data));
    return {contentType: CONTENT_TYPE_PLAIN, body: toArrayBuffer(gz), estimatedSize: gz.byteLength};
  }
  if (options.compression === COMPRESSION_BASE64) {
    const body = 'data=' + encodeURIComponent(base64Encode(jsonStringify(data)));
    return {contentType: CONTENT_TYPE_FORM, body: body, estimatedSize: byteSize(body)};
  }
  const json = jsonStringify(data);
  return {contentType: CONTENT_TYPE_JSON, body: json, estimatedSize: byteSize(json)};
}

/**
 * @param {*} body
 * @return {boolean}
 */
function isGzipData(body) {
  if (body instanceof ArrayBuffer) {
    const b = new Uint8Array(body);
    return b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;
  }
  return false;
}

/**
 * @param {*} compression
 * @param {*} urlCompression
 * @return {boolean}
 */
function isGzipRequest(compression, urlCompression) {
  return compression === COMPRESSION_GZIP_JS || urlCompression === COMPRESSION_GZIP_JS || urlCompression === 'gzip';
}

/**
 * @param {!RequestOptions} options
 * @param {?EncodedBody=} preEncoded
 * @return {{url: string, encodedBody: (?EncodedBody|undefined)}}
 */
function encodePostDataSafely(options, preEncoded) {
  const fallback = function() {
    const copy = /** @type {!RequestOptions} */ (assign(options));
    if (options.transport === 'sendBeacon') {
      copy.compression = COMPRESSION_BASE64;
      return {url: extendURLParams(options.url, {'compression': COMPRESSION_BASE64}), encodedBody: encodePostData(copy)};
    }
    copy.compression = undefined;
    return {url: removeURLParam(options.url, 'compression'), encodedBody: encodePostData(copy)};
  };
  let encoded;
  try {
    encoded = encodePostData(options, preEncoded);
  } catch (e) {
    if (isGzipRequest(options.compression, getQueryParam(options.url, 'compression'))) {
      logger.error('Failed to gzip request body, sending uncompressed payload', e);
      return fallback();
    }
    throw e;
  }
  if (!encoded || !isGzipRequest(options.compression, getQueryParam(options.url, 'compression')) ||
      isGzipData(encoded.body)) {
    return {url: options.url, encodedBody: encoded};
  }
  nativeAsyncGzipDisabled = true;
  return fallback();
}

/**
 * @param {!RequestOptions} options
 * @param {?EncodedBody=} preEncoded
 * @return {{url: string, encodedBody: (?EncodedBody|undefined)}|undefined}
 */
function encodeRequest(options, preEncoded) {
  try {
    return encodePostDataSafely(options, preEncoded);
  } catch (error) {
    logger.error(error);
    if (options.callback) options.callback(/** @type {!PHResponse} */ ({statusCode: 0, error: error}));
    return undefined;
  }
}

/**
 * @param {number|undefined} timeout
 * @return {!Error}
 */
function timeoutAbortReason(timeout) {
  const error = new Error('PostHog request timed out' + (timeout ? ' after ' + timeout + 'ms' : ''));
  try {
    Object.defineProperty(error, 'name', {value: 'AbortError', writable: true, enumerable: true, configurable: true});
  } catch (e) {}
  return error;
}

/**
 * @param {*} error
 * @return {boolean}
 */
function isExpectedNetworkError(error) {
  return !!error && error['name'] === 'TypeError' && /Failed to fetch|NetworkError|Load failed/i.test(error['message'] || '');
}

/**
 * @param {function(): ?string} getHeader
 * @return {number|undefined}
 */
function readRetryAfter(getHeader) {
  try {
    const raw = getHeader();
    if (!raw) return undefined;
    const trimmed = raw.replace(/^\s+|\s+$/g, '');
    let delay;
    if (/^\d+$/.test(trimmed)) {
      delay = parseInt(trimmed, 10) * 1000;
    } else {
      const date = Date.parse(trimmed);
      if (isNaN(date)) return undefined;
      delay = Math.max(0, date - new Date().getTime());
    }
    return Math.min(delay, 30000);
  } catch (e) {
    return undefined;
  }
}

/**
 * The SDK's own XHRs, so observers such as network metrics skip them (upstream
 * `isPostHogXHR`). Created on the SDK's first XHR.
 * @type {?WeakMap<!XMLHttpRequest, boolean>}
 */
let posthogXHRs = null;

/** @param {!XMLHttpRequest} req */
function markPostHogXHR(req) {
  if (!posthogXHRs && typeof WeakMap !== 'undefined') posthogXHRs = new WeakMap();
  if (posthogXHRs) posthogXHRs.set(req, true);
}

/**
 * @param {!XMLHttpRequest} req
 * @return {boolean}
 */
export function isPostHogXHR(req) {
  return !!posthogXHRs && posthogXHRs.has(req);
}

/**
 * @param {!RequestOptions} options
 * @param {?EncodedBody=} preEncoded
 */
function xhr(options, preEncoded) {
  const encoded = encodeRequest(options, preEncoded);
  if (!encoded) return;
  const req = new XMLHttpRequest();
  markPostHogXHR(req);
  req.open(options.method || 'GET', encoded.url, true);
  const body = encoded.encodedBody ? encoded.encodedBody.body : undefined;
  const headers = options.headers || {};
  for (const name in headers) req.setRequestHeader(name, headers[name]);
  if (encoded.encodedBody) req.setRequestHeader('Content-Type', encoded.encodedBody.contentType);
  if (options.timeout) req.timeout = options.timeout;
  let timedOut = false;
  req.ontimeout = function() {
    timedOut = true;
  };
  req.onloadend = function() {
    if (timedOut) {
      const error = timeoutAbortReason(options.timeout);
      logger.warn(error);
      if (options.callback) options.callback(/** @type {!PHResponse} */ ({statusCode: 0, error: error}));
      return;
    }
    const response = /** @type {!PHResponse} */ ({statusCode: req.status, text: req.responseText});
    if (req.status === 200) {
      try {
        response.json = JSON.parse(req.responseText);
      } catch (e) {}
    }
    if (options.callback) {
      /** @type {!TransportCallback} */ (options.callback)(response, readRetryAfter(function() {
        return req.getResponseHeader('Retry-After');
      }));
    }
  };
  req.send(/** @type {?} */ (body));
}

/**
 * @param {!RequestOptions} options
 * @param {?EncodedBody=} preEncoded
 * @param {boolean=} keepaliveDisabled
 */
function fetchTransport(options, preEncoded, keepaliveDisabled) {
  const encoded = encodeRequest(options, preEncoded);
  if (!encoded) return;
  const url = encoded.url;
  const eb = encoded.encodedBody;
  const body = eb ? eb.body : undefined;
  const headers = new Headers();
  const h = options.headers || {};
  for (const name in h) headers.append(name, h[name]);
  if (eb) headers.append('Content-Type', eb.contentType);

  let timedOut = false;
  let settled = false;
  let controller = null;
  let timer = 0;
  /** @param {*} error */
  const handleError = function(error) {
    if (settled) return;
    settled = true;
    if ((timedOut && error && error['name'] === 'AbortError') || isExpectedNetworkError(error)) {
      logger.warn(error);
    } else {
      logger.error(error);
    }
    if (options.callback) options.callback(/** @type {!PHResponse} */ ({statusCode: 0, error: error}));
  };
  const AC = win['AbortController'];
  if (AC) {
    controller = new AC();
    timer = setTimeout(function() {
      timedOut = true;
      try {
        controller['abort'](timeoutAbortReason(options.timeout));
      } catch (e) {
        handleError(e);
      }
    }, options.timeout);
  }
  let reserved = 0;
  const cleanup = function() {
    pendingKeepaliveBytes -= reserved;
    reserved = 0;
    if (controller) clearTimeout(timer);
  };
  try {
    const init = {
      'method': options.method || 'GET',
      'headers': headers,
      'referrerPolicy': 'strict-origin',
      'body': body,
      'signal': controller ? controller['signal'] : undefined,
    };
    const fo = options.fetchOptions || {};
    for (const k in fo) init[k] = fo[k];
    const requestSize = eb ? eb.estimatedSize : (isUndefined(body) ? 0 : undefined);
    init['keepalive'] = init['method'] === 'POST' && !keepaliveDisabled && init['keepalive'] !== false &&
        init['body'] === body && !isUndefined(requestSize) && requestSize >= 0 &&
        pendingKeepaliveBytes + /** @type {number} */ (requestSize) < KEEP_ALIVE_THRESHOLD;
    if (init['keepalive']) {
      reserved = /** @type {number} */ (requestSize);
      pendingKeepaliveBytes += reserved;
    }
    win.fetch(url, /** @type {!RequestInit} */ (init)).then(function(response) {
      return response.text().then(function(responseText) {
        if (settled) return;
        const res = /** @type {!PHResponse} */ ({statusCode: response.status, text: responseText});
        if (response.status === 200) {
          try {
            res.json = JSON.parse(responseText);
          } catch (e) {
            logger.error(e);
          }
        }
        settled = true;
        cleanup();
        if (options.callback) {
          /** @type {!TransportCallback} */ (options.callback)(res, readRetryAfter(function() {
            return response.headers ? response.headers.get('Retry-After') : null;
          }));
        }
      });
    })['catch'](function(error) {
      cleanup();
      handleError(error);
    });
  } catch (error) {
    cleanup();
    handleError(error);
  }
}

/**
 * @param {!RequestOptions} options
 */
function sendBeaconTransport(options) {
  try {
    const encoded = encodePostDataSafely(options);
    const eb = encoded.encodedBody;
    if (!eb || !eb.body) return;
    const blob = eb.body instanceof Blob ? eb.body : new Blob([eb.body], {type: eb.contentType});
    if (nav.sendBeacon(encoded.url, /** @type {!Blob} */ (blob))) return;
    const data = options.data;
    const batch = /** @type {?} */ (isArray(data) ? data : (data ? data['batch'] : undefined));
    if (isArray(batch) && batch.length > 1 && (eb.estimatedSize || 0) > BEACON_SPLIT_FLOOR_BYTES) {
      const mid = Math.ceil(batch.length / 2);
      const split = function(events) {
        if (isArray(data)) return events;
        const copy = assign(data);
        copy['batch'] = events;
        return copy;
      };
      const a = /** @type {!RequestOptions} */ (assign(options));
      a.data = split(batch.slice(0, mid));
      sendBeaconTransport(a);
      const b = /** @type {!RequestOptions} */ (assign(options));
      b.data = split(batch.slice(mid));
      sendBeaconTransport(b);
      return;
    }
    logger.warn('Beacon of ~' + (eb.estimatedSize || 0) + ' bytes was rejected by the browser, falling back to ' +
        (hasFetch() ? 'fetch' : 'XHR'));
    if (hasFetch()) fetchTransport(options, undefined, true);
    else xhr(options);
  } catch (error) {
    logger.warn('Beacon send failed', error);
  }
}

/**
 * @param {*} data
 * @return {*}
 */
function addSentAtToBody(data) {
  const sentAt = new Date().toISOString();
  if (!isArray(data)) {
    const copy = assign(data);
    copy['sent_at'] = sentAt;
    return copy;
  }
  return /** @type {!Array} */ (data).map(function(item) {
    const copy = assign(item);
    copy['sent_at'] = sentAt;
    return copy;
  });
}

/**
 * @param {*} data
 * @return {!Object}
 */
function addSentAtToCaptureBody(data) {
  const batch = (isArray(data) ? /** @type {!Array} */ (data) : [data]).map(function(event) {
    const copy = assign(event);
    const ts = event['timestamp'];
    if (ts instanceof Date && !isNaN(ts.getTime())) copy['timestamp'] = ts.toISOString();
    return copy;
  });
  const first = batch[0];
  const props = first ? first['properties'] : undefined;
  return {
    'api_key': props && !isUndefined(props['token']) && props['token'] !== null ? props['token'] :
        (first ? first['token'] : undefined),
    'batch': batch,
    'sent_at': new Date().toISOString(),
  };
}

/**
 * @param {string} url
 * @param {string|undefined} method
 * @param {string|undefined} compression
 * @param {string|undefined} timestampMode
 * @return {string}
 */
function buildRequestURL(url, method, compression, timestampMode) {
  const tsParam = timestampMode === 'query' ? (method === 'POST' ? 'sent_at' : '_') : undefined;
  const params = {};
  if (tsParam) params[tsParam] = String(new Date().getTime());
  if (compression !== COMPRESSION_GZIP_JS) params['compression'] = compression;
  return extendURLParams(compression === COMPRESSION_GZIP_JS ? removeURLParam(url, 'compression') : url, params);
}

/**
 * Upstream preEncodeAsync: the body gzipped by the validated native
 * gzipCompress (core/gzip.js). Rejects with the compression error.
 * @param {!RequestOptions} options
 * @return {!Promise<!EncodedBody>}
 */
function preEncodeAsync(options) {
  let json;
  try {
    json = jsonStringify(options.data);
  } catch (e) {
    return Promise.reject(e);
  }
  return gzipCompress(json).then(function(bytes) {
    const body = toArrayBuffer(bytes);
    return /** @type {!EncodedBody} */ ({contentType: CONTENT_TYPE_PLAIN, body: body, estimatedSize: body.byteLength});
  });
}

/**
 * Entry point: sanitises the options and dispatches to a transport.
 * @param {!RequestOptions} _options
 * @param {!TransportCallback=} onResponse
 */
export function request(_options, onResponse) {
  const options = /** @type {!RequestOptions} */ (assign(_options));
  options.callback = onResponse ? /** @type {?} */ (onResponse) : function(response) {
    if (_options.callback) _options.callback(response);
  };
  options.timeout = options.timeout || 60000;
  const transport = isUndefined(options.transport) ? 'fetch' : options.transport;
  if (transport === 'sendBeacon' && isUndefined(options.compression) && options.data) {
    options.compression = COMPRESSION_BASE64;
  }
  if (options.method === 'POST' && options.data) {
    if (options.timestampMode === 'capture-body') options.data = addSentAtToCaptureBody(options.data);
    else if (options.timestampMode === 'body') options.data = addSentAtToBody(options.data);
  }
  options.url = buildRequestURL(options.url, options.method, options.compression, options.timestampMode);

  /** @type {!Array<{t: string, m: function(!RequestOptions, ?EncodedBody=)}>} */
  const available = [];
  if (hasFetch()) available.push({t: 'fetch', m: function(o, pre) {
    fetchTransport(o, pre);
  }});
  if (hasXHR()) available.push({t: 'XHR', m: xhr});
  if (hasBeacon()) available.push({t: 'sendBeacon', m: function(o) {
    sendBeaconTransport(o);
  }});
  const usable = available.filter(function(a) {
    return !options.disableTransport || options.disableTransport.indexOf(a.t) === -1;
  });
  let method = null;
  for (let i = 0; i < usable.length; i++) {
    if (usable[i].t === transport) method = usable[i].m;
  }
  if (!method && usable.length) method = usable[0].m;
  if (!method) throw new Error('No available transport method');
  const transportMethod = method;

  /**
   * @param {!RequestOptions} opts
   * @param {?EncodedBody=} pre
   */
  const safeTransport = function(opts, pre) {
    try {
      transportMethod(opts, pre);
    } catch (error) {
      if (isExpectedNetworkError(error)) logger.warn(error);
      else logger.error(error);
      if (options.callback) options.callback(/** @type {!PHResponse} */ ({statusCode: 0, error: error}));
    }
  };

  if (transport !== 'sendBeacon' && !options.preferSyncCompression && options.data &&
      options.compression === COMPRESSION_GZIP_JS && win['CompressionStream'] && win['Promise'] &&
      !nativeAsyncGzipDisabled) {
    preEncodeAsync(options).then(function(encoded) {
      safeTransport(options, encoded);
    })['catch'](function(error) {
      if (isNativeAsyncGzipReadError(error)) {
        // Safari 16: native gzip is off for good and this body goes uncompressed.
        nativeAsyncGzipDisabled = true;
        const copy = /** @type {!RequestOptions} */ (assign(options));
        copy.compression = undefined;
        copy.url = buildRequestURL(_options.url, _options.method, undefined, _options.timestampMode);
        safeTransport(copy);
        return;
      }
      // Invalid native output turns native gzip off; either way this body falls
      // back to the sync encoder.
      if (isNativeAsyncGzipError(error)) nativeAsyncGzipDisabled = true;
      safeTransport(options);
    });
  } else {
    safeTransport(options);
  }
}
