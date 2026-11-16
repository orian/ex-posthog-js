/**
 * @fileoverview `metrics.network`: a duration histogram for every HTTP(S)
 * `fetch` and `XMLHttpRequest` the page makes, except the SDK's own and
 * server-sent event streams. Port of upstream
 * browser/src/extensions/network-metrics.ts.
 */
import {isPostHogXHR} from '../core/request.js';
import {logger as baseLogger} from '../core/logger.js';
import {addEventListener, doc, isFunction, isString, win} from '../core/utils.js';
import {patch} from '../otlp/otlp.js';

const logger = baseLogger.createLogger('[NetworkMetrics]');

const DEFAULT_METRIC_NAME = 'http.client.request.duration';
/** @const {!Object<string, number>} */
const DEFAULT_PORTS = {'http:': 80, 'https:': 443};
const KNOWN_HTTP_METHODS = ['CONNECT', 'DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT', 'TRACE'];

/**
 * The histogram sink (the metrics extension).
 * @typedef {function(string, number, !Object)}
 */
let RecordHistogram;

/** @typedef {{method: string, url: string}} */
let Observed;

/** @return {number} upstream utils/now */
function now() {
  return win && win.performance && win.performance.now ? win.performance.now() : new Date().getTime();
}

/**
 * Upstream convertToURL (an anchor element: it resolves relative URLs and has `port`).
 * @param {string} url
 * @return {?{href: string, hostname: string, port: string, pathname: string, protocol: string}}
 */
function toURL(url) {
  if (!doc) return null;
  const a = /** @type {!HTMLAnchorElement} */ (doc.createElement('a'));
  a.href = url;
  return {href: a.href, hostname: a.hostname, port: a.port, pathname: a.pathname, protocol: a.protocol};
}

/**
 * @param {string} segment
 * @return {boolean}
 */
function isIdLikeSegment(segment) {
  return /^\d+$/.test(segment) || (segment.length >= 8 && /^[0-9a-f-]*\d[0-9a-f-]*$/i.test(segment));
}

/**
 * @param {string} pathname
 * @return {string}
 */
function templatePath(pathname) {
  return pathname.split('/').map(function(s) {
    return isIdLikeSegment(s) ? ':id' : s;
  }).join('/');
}

/**
 * @param {*} status
 * @param {*} failure
 * @return {string|undefined}
 */
function errorType(status, failure) {
  if (status) return /** @type {number} */ (status) >= 400 ? String(status) : undefined;
  return /** @type {string} */ ((failure && failure['name']) || '_OTHER');
}

/**
 * @param {?} instance
 * @return {?Object}
 */
function networkConfig(instance) {
  const metrics = instance.config ? instance.config['metrics'] : undefined;
  const network = metrics ? metrics['network'] : undefined;
  return network === true ? {} : network || null;
}

/**
 * @param {?} contentType
 * @return {boolean}
 */
function isEventStream(contentType) {
  return isString(contentType) && contentType.toLowerCase().indexOf('text/event-stream') === 0;
}

/**
 * @param {function(): *} read
 * @return {*}
 */
function safeContentType(read) {
  try {
    return read();
  } catch (e) {
    return undefined;
  }
}

/**
 * @param {*} method
 * @param {*} url
 * @return {!Observed}
 */
function observe(method, url) {
  const observedUrl = String(url);
  const parsed = toURL(observedUrl);
  return {method: String(method).toUpperCase(), url: (parsed && parsed.href) || observedUrl};
}

/**
 * @param {!RecordHistogram} recordHistogram
 * @param {!Observed} observed
 * @param {*} status
 * @param {number} start
 * @param {function(): ?Object} enabled
 * @param {*=} failure
 * @param {boolean=} fulfilled
 */
function record(recordHistogram, observed, status, start, enabled, failure, fulfilled) {
  try {
    const config = enabled();
    if (!config) return;
    const normalisedStatus = status || undefined;
    const durationMs = now() - start;
    const url = toURL(observed.url);
    if (url && url.protocol !== 'http:' && url.protocol !== 'https:') return;
    const request = {'url': (url && url.href) || observed.url, 'method': observed.method};
    const configuredName = config['name'];
    const name = isFunction(configuredName) ? configuredName(request) :
      isString(configuredName) ? configuredName : DEFAULT_METRIC_NAME;
    if (!name) return;
    const error = fulfilled && !normalisedStatus ? undefined : errorType(normalisedStatus, failure);
    const method = request['method'];
    const original = KNOWN_HTTP_METHODS.indexOf(method) !== -1 ? method : '_OTHER';
    const attributes = {'http.request.method': original};
    if (original === '_OTHER' && method !== original) attributes['http.request.method_original'] = method;
    if (url) {
      const host = url.hostname;
      attributes['server.address'] = host.charAt(0) === '[' && host.charAt(host.length - 1) === ']' ?
        host.slice(1, -1) : host;
      attributes['server.port'] = Number(url.port) || DEFAULT_PORTS[url.protocol];
      attributes['url.scheme'] = url.protocol.slice(0, -1);
      attributes['url.template'] = templatePath(url.pathname);
    }
    if (normalisedStatus) attributes['http.response.status_code'] = normalisedStatus;
    if (error) attributes['error.type'] = error;
    const extra = config['attributes'];
    if (isFunction(extra)) {
      const added = extra(request, {'status': normalisedStatus, 'durationMs': durationMs});
      for (const k in added) attributes[k] = added[k];
    }
    recordHistogram(/** @type {string} */ (name), durationMs, {'unit': 'ms', 'attributes': attributes});
  } catch (e) {
    logger.error('Failed to record network metric', e);
  }
}

const noop = function() {};

/**
 * @param {!RecordHistogram} recordHistogram
 * @param {function(): ?Object} enabled
 * @return {function()}
 */
function patchFetch(recordHistogram, enabled) {
  if (!win || !isFunction(win.fetch)) return noop;
  return patch(win, 'fetch', function(originalFetch) {
    return function(...args) {
      const start = now();
      const result = originalFetch.apply(this, args);
      if (!enabled()) return result;
      try {
        const input = args[0];
        const init = args[1];
        const method = (init && init['method']) || (input && input['method']) || 'GET';
        const observed = observe(method, (input && input['url']) || input);
        return result.then(function(response) {
          if (!isEventStream(safeContentType(function() {
            return response && response.headers ? response.headers.get('content-type') : undefined;
          }))) {
            record(recordHistogram, observed, response ? response.status : undefined, start, enabled, undefined, true);
          }
          return response;
        }, function(error) {
          record(recordHistogram, observed, undefined, start, enabled, error);
          throw error;
        });
      } catch (e) {
        logger.error('Failed to observe fetch', e);
        return result;
      }
    };
  });
}

/**
 * @param {!RecordHistogram} recordHistogram
 * @param {function(): ?Object} enabled
 * @return {function()}
 */
function patchXHR(recordHistogram, enabled) {
  const XHR = win ? win['XMLHttpRequest'] : undefined;
  const prototype = XHR ? XHR.prototype : undefined;
  if (!prototype || typeof WeakMap === 'undefined') return noop;
  /** @type {!WeakMap<!Object, !Observed>} */
  const requests = new WeakMap();
  const restoreOpen = patch(prototype, 'open', function(originalOpen) {
    return /** @this {!XMLHttpRequest} */ function(...args) {
      try {
        if (!isPostHogXHR(this)) requests.set(this, observe(args[0], args[1]));
      } catch (e) {
        logger.error('Failed to observe XHR open', e);
      }
      return originalOpen.apply(this, args);
    };
  });
  const restoreSend = patch(prototype, 'send', function(originalSend) {
    return /** @this {!XMLHttpRequest} */ function(...args) {
      const xhr = this;
      let onLoadEnd = null;
      let onReadyStateChange = null;
      try {
        const observed = requests.get(xhr);
        if (observed && enabled()) {
          const start = now();
          const readIsEventStream = function() {
            return isEventStream(safeContentType(function() {
              return xhr.getResponseHeader('content-type');
            }));
          };
          let eventStream = false;
          onReadyStateChange = function() {
            if (xhr.readyState === 2) eventStream = readIsEventStream();
          };
          onLoadEnd = function() {
            xhr.removeEventListener('loadend', onLoadEnd);
            xhr.removeEventListener('readystatechange', onReadyStateChange);
            if (!eventStream && !readIsEventStream()) record(recordHistogram, observed, xhr.status, start, enabled);
          };
          addEventListener(xhr, 'readystatechange', onReadyStateChange);
          addEventListener(xhr, 'loadend', onLoadEnd);
        }
      } catch (e) {
        logger.error('Failed to observe XHR send', e);
      }
      try {
        return originalSend.apply(xhr, args);
      } catch (e) {
        if (onLoadEnd) xhr.removeEventListener('loadend', onLoadEnd);
        if (onReadyStateChange) xhr.removeEventListener('readystatechange', onReadyStateChange);
        throw e;
      }
    };
  });
  return function() {
    restoreOpen();
    restoreSend();
  };
}

/**
 * Installs the fetch / XHR wrappers; returns the function that removes them.
 * @param {*} instance the PostHog instance (for its live `metrics.network` config)
 * @param {!RecordHistogram} recordHistogram
 * @return {function()}
 */
export function startNetworkMetrics(instance, recordHistogram) {
  let active = true;
  const enabled = function() {
    return active ? networkConfig(instance) : null;
  };
  const restoreFetch = patchFetch(recordHistogram, enabled);
  const restoreXHR = patchXHR(recordHistogram, enabled);
  return function() {
    active = false;
    restoreFetch();
    restoreXHR();
  };
}
