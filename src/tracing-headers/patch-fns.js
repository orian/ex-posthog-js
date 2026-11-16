/**
 * @fileoverview Port of upstream browser/src/entrypoints/tracing-headers.ts:
 * the fetch / XMLHttpRequest patches that add `X-POSTHOG-SESSION-ID`,
 * `X-POSTHOG-WINDOW-ID` and `X-POSTHOG-DISTINCT-ID` to requests for the
 * configured hostnames, and a fresh W3C `traceparent` to requests for
 * `trace_propagation_targets`. Upstream lazy-loads these from
 * `/static/tracing-headers.js`: they are the lazy part `tracing-headers`
 * (registered by lazy.js), compiled in except in the lazy build.
 */
import {SessionManager} from '../core/session.js';
import {COOKIELESS_SENTINEL_VALUE} from '../core/constants.js';
import {isArray, isFunction, isNull, isString, isUndefined, win} from '../core/utils.js';
import {patch} from './patch.js';
import {TraceparentTargets, TracingHeadersHostnames} from './types.js';

const SESSION_ID_HEADER = 'X-POSTHOG-SESSION-ID';
const WINDOW_ID_HEADER = 'X-POSTHOG-WINDOW-ID';
const DISTINCT_ID_HEADER = 'X-POSTHOG-DISTINCT-ID';
const TRACING_HEADERS = [SESSION_ID_HEADER, WINDOW_ID_HEADER, DISTINCT_ID_HEADER];
// W3C Trace Context, https://www.w3.org/TR/trace-context/#traceparent-header
const TRACEPARENT_HEADER = 'traceparent';
const REQUEST_INIT_KEYS = [
  'attributionReporting', 'body', 'browsingTopics', 'cache', 'credentials', 'dispatcher', 'duplex', 'integrity',
  'keepalive', 'method', 'mode', 'priority', 'redirect', 'referrer', 'referrerPolicy', 'signal', 'window',
];


/**
 * @param {!Object} value
 * @param {*} property
 * @return {boolean}
 */
function hasOwnProperty(value, property) {
  return Object.prototype.hasOwnProperty.call(value, property);
}

/**
 * @param {*} value
 * @return {boolean}
 */
function isObjectLike(value) {
  return (typeof value === 'object' && !isNull(value)) || isFunction(value);
}

/**
 * @param {*} value
 * @return {boolean}
 */
function isRequest(value) {
  return typeof Request !== 'undefined' &&
      (value instanceof Request || Object.prototype.toString.call(value) === '[object Request]');
}

/**
 * @param {*} url
 * @return {string|undefined}
 */
function getRequestUrl(url) {
  try {
    if (isRequest(url)) {
      return /** @type {!Request} */ (url).url;
    }
    const base = win && win.location ? win.location.href : undefined;
    return new URL(url instanceof URL ? url.toString() : String(url), base).toString();
  } catch (e) {
    return undefined;
  }
}

/**
 * RequestInit is a WebIDL dictionary: native fetch reads known keys via
 * property access, including inherited and non-enumerable properties. Instead
 * of `{...init, headers}` (which can drop body/signal/duplex/...), overlay only
 * `headers` and forward every other lookup to the caller's original init.
 * @param {*} init
 * @param {!Headers} headers
 * @return {?Object|undefined}
 */
function createFetchInitWithHeaders(init, headers) {
  if (isUndefined(init) || isNull(init)) {
    return {'headers': headers};
  }
  if (!isObjectLike(init)) {
    return undefined;
  }
  const originalInit = /** @type {!Object} */ (init);

  if (typeof Proxy === 'undefined' || typeof Reflect === 'undefined') {
    // Older browsers without Proxy still get an inherited overlay.
    const initWithHeaders = Object.create(originalInit);
    Object.defineProperty(initWithHeaders, 'headers', {
      configurable: true, enumerable: true, value: headers, writable: true,
    });
    return initWithHeaders;
  }

  const target = {'headers': headers};
  const handler = {
    'get': function(t, property) {
      if (hasOwnProperty(t, property)) {
        return Reflect.get(t, property);
      }
      return Reflect.get(originalInit, property, originalInit);
    },
    'has': function(t, property) {
      return hasOwnProperty(t, property) || property in originalInit;
    },
    'ownKeys': function(t) {
      const keys = [];
      const add = function(key) {
        if (keys.indexOf(key) === -1) keys.push(key);
      };
      Reflect.ownKeys(t).forEach(add);
      Reflect.ownKeys(originalInit).forEach(add);
      REQUEST_INIT_KEYS.forEach(function(key) {
        if (key in originalInit) add(key);
      });
      return keys;
    },
    'getOwnPropertyDescriptor': function(t, property) {
      const targetDescriptor = Reflect.getOwnPropertyDescriptor(t, property);
      if (targetDescriptor) {
        return targetDescriptor;
      }
      if (typeof property === 'string' && REQUEST_INIT_KEYS.indexOf(property) !== -1 && property in originalInit) {
        return {
          configurable: true,
          enumerable: true,
          get: function() {
            return Reflect.get(originalInit, property, originalInit);
          },
        };
      }
      const descriptor = Reflect.getOwnPropertyDescriptor(originalInit, property);
      if (!descriptor) return undefined;
      const copy = {};
      for (const k in descriptor) copy[k] = descriptor[k];
      copy['configurable'] = true;
      return copy;
    },
    'getPrototypeOf': function() {
      return Object.getPrototypeOf(originalInit);
    },
  };
  return /** @type {!Object} */ (new Proxy(target, /** @type {?} */ (handler)));
}

/**
 * @param {string|function(): (string|undefined)} distinctId
 * @return {string|undefined}
 */
function getDistinctId(distinctId) {
  return isFunction(distinctId) ? /** @type {function(): (string|undefined)} */ (distinctId)() :
      /** @type {string} */ (distinctId);
}

/**
 * @param {TracingHeadersHostnames} hostnames
 * @param {string|function(): (string|undefined)} distinctId
 * @param {?SessionManager|undefined} sessionManager
 * @param {string} url
 * @param {!Headers} headers
 * @return {boolean}
 */
function addTracingHeaders(hostnames, distinctId, sessionManager, url, headers) {
  let reqHostname;
  try {
    reqHostname = new URL(url).hostname;
  } catch (e) {
    // If the URL is invalid, we skip adding tracing headers
    return false;
  }
  if (!hostnames) {
    return false;
  }
  if (isArray(hostnames) && /** @type {!Array<string>} */ (hostnames).indexOf(reqHostname) === -1) {
    return false;
  }

  let hasAddedHeaders = false;
  if (sessionManager) {
    const ids = sessionManager.checkAndGetSessionAndWindowId(true);
    headers.set(SESSION_ID_HEADER, ids.sessionId);
    headers.set(WINDOW_ID_HEADER, ids.windowId);
    hasAddedHeaders = true;
  }
  const currentDistinctId = getDistinctId(distinctId);
  if (currentDistinctId && currentDistinctId !== COOKIELESS_SENTINEL_VALUE) {
    headers.set(DISTINCT_ID_HEADER, currentDistinctId);
    hasAddedHeaders = true;
  }
  return hasAddedHeaders;
}

/**
 * @param {number} byteLength
 * @return {string}
 */
function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  const crypto = win ? win.crypto : undefined;
  if (crypto && isFunction(crypto.getRandomValues)) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < byteLength; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let hex = '';
  for (let i = 0; i < byteLength; i++) {
    hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  }
  return hex;
}

/**
 * All-zero trace and span ids are invalid, so regenerate in that case.
 * @param {number} byteLength
 * @return {string}
 */
function randomNonZeroHex(byteLength) {
  let hex = randomHex(byteLength);
  while (/^0+$/.test(hex)) {
    hex = randomHex(byteLength);
  }
  return hex;
}

/**
 * @param {string} url
 * @return {boolean}
 */
function isSameOrigin(url) {
  try {
    return !!win && new URL(url, win.location.href).origin === win.location.origin;
  } catch (e) {
    return false;
  }
}

/**
 * OpenTelemetry's XHR instrumentation wraps send() with shimmer (marked
 * `__wrapped`) and injects traceparent from inside it. If it wrapped send()
 * before us, it runs after our injection and the header would get two values:
 * leave same-origin requests to it.
 * @param {*} next
 * @return {boolean}
 */
function otelWrapsSendBelow(next) {
  try {
    let current = next;
    // Other posthog/rrweb patch layers can sit between us and it.
    for (let depth = 0; isFunction(current) && depth < 20; depth++) {
      const fn = /** @type {!Object} */ (current);
      if (fn['__wrapped']) {
        const otel = win ? win[Symbol.for('opentelemetry.js.api.1')] : undefined;
        return !!(otel ? otel['propagation'] : undefined);
      }
      const posthogLayer = fn['__posthog_layer__'];
      const layer = posthogLayer != null ? posthogLayer : fn['__rrweb_layer__'];
      current = layer ? layer['next'] : undefined;
    }
    return false;
  } catch (e) {
    return false;
  }
}

/**
 * @param {*} name
 * @return {boolean}
 */
function isTraceparentHeaderName(name) {
  try {
    // Native XHR converts the name with String().
    return String(name).toLowerCase() === TRACEPARENT_HEADER;
  } catch (e) {
    return false;
  }
}

/**
 * A fresh trace per request, version 00, sampled flag 01.
 * @return {string}
 */
function createTraceparent() {
  return '00-' + randomNonZeroHex(16) + '-' + randomNonZeroHex(8) + '-01';
}

/**
 * @param {string} target
 * @return {string|undefined}
 */
function targetOrigin(target) {
  try {
    return new URL(target).origin;
  } catch (e) {
    return undefined;
  }
}

/**
 * Targets are matched exactly: entries containing `://` against the request
 * origin, anything else against the request hostname.
 * @param {TraceparentTargets} targets
 * @param {string} url
 * @return {boolean}
 */
export function isTraceparentTarget(targets, url) {
  if (!isArray(targets) || targets.length === 0) {
    return false;
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return false;
  }
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    if (!isString(target)) {
      continue;
    }
    if (target.indexOf('://') > -1) {
      // Parse the target too, so default ports and case match URL.origin.
      if (targetOrigin(target) === parsed.origin) {
        return true;
      }
    } else if (target.toLowerCase() === parsed.hostname) {
      return true;
    }
  }
  return false;
}

/**
 * @param {TraceparentTargets} targets
 * @param {string} url
 * @param {!Headers} headers
 * @return {boolean}
 */
function addTraceparentHeader(targets, url, headers) {
  // Never overwrite a traceparent the app (or another instrumentation) already set.
  if (headers.has(TRACEPARENT_HEADER) || !isTraceparentTarget(targets, url)) {
    return false;
  }
  headers.set(TRACEPARENT_HEADER, createTraceparent());
  return true;
}

/**
 * @param {TracingHeadersHostnames} hostnames
 * @param {string|function(): (string|undefined)} distinctId
 * @param {?SessionManager|undefined} sessionManager
 * @param {TraceparentTargets=} traceparentTargets
 * @return {function()} restore
 */
export function patchFetch(hostnames, distinctId, sessionManager, traceparentTargets) {
  if (!win) return function() {};
  return patch(win, 'fetch', function(originalFetch) {
    return /** @this {*} */ function(url, init) {
      const originalArgs = arguments.length > 1 ? [url, init] : [url];
      let fetchArgs = originalArgs;
      try {
        const requestUrl = getRequestUrl(url);
        if (requestUrl) {
          if (isRequest(url)) {
            // For fetch(Request, init), construct a new Request so init
            // overrides apply and the caller's Request is not mutated.
            const req = new Request(/** @type {!Request} */ (url), /** @type {?} */ (init));
            addTracingHeaders(hostnames, distinctId, sessionManager, req.url, req.headers);
            addTraceparentHeader(traceparentTargets, req.url, req.headers);
            fetchArgs = [req];
          } else {
            const headers = new Headers(isObjectLike(init) ? init['headers'] : undefined);
            const addedTracingHeaders = addTracingHeaders(hostnames, distinctId, sessionManager, requestUrl, headers);
            const addedTraceparent = addTraceparentHeader(traceparentTargets, requestUrl, headers);
            if (addedTracingHeaders || addedTraceparent) {
              const initWithHeaders = createFetchInitWithHeaders(init, headers);
              if (initWithHeaders) {
                fetchArgs = [url, initWithHeaders];
              }
            }
          }
        }
      } catch (e) {
        fetchArgs = originalArgs;
      }
      return originalFetch.apply(this, fetchArgs);
    };
  });
}

/**
 * @param {TracingHeadersHostnames} hostnames
 * @param {string|function(): (string|undefined)} distinctId
 * @param {?SessionManager|undefined} sessionManager
 * @param {TraceparentTargets=} traceparentTargets
 * @return {function()} restore
 */
export function patchXHR(hostnames, distinctId, sessionManager, traceparentTargets) {
  if (!win || !win.XMLHttpRequest) return function() {};
  // The app sets its own XHR headers after open(), and setRequestHeader
  // appends, so the url is remembered in open() and traceparent is decided
  // and set in send(), unless the app set one in between.
  /** @type {?WeakMap<!XMLHttpRequest, string>} */
  const pendingTraceparents = isArray(traceparentTargets) && typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  const xhrPrototype = /** @type {!Object} */ (win.XMLHttpRequest.prototype);

  const restoreOpen = patch(xhrPrototype, 'open', function(originalOpen) {
    return /** @this {!XMLHttpRequest} */ function(method, url, async, username, password) {
      const xhr = this;
      const headers = new Headers();
      const requestUrl = getRequestUrl(url);
      if (requestUrl) {
        addTracingHeaders(hostnames, distinctId, sessionManager, requestUrl, headers);
      }
      if (pendingTraceparents) {
        pendingTraceparents.delete(xhr);
        if (requestUrl) {
          pendingTraceparents.set(xhr, requestUrl);
        }
      }

      const result = originalOpen.call(xhr, method, url, async === undefined ? true : async, username, password);

      TRACING_HEADERS.forEach(function(header) {
        const value = headers.get(header);
        if (value) {
          try {
            xhr.setRequestHeader(header, value);
          } catch (e) {
            // Do not let tracing header injection break the host app's XHR.
          }
        }
      });
      return result;
    };
  });

  if (!pendingTraceparents) {
    return restoreOpen;
  }

  const restoreSetRequestHeader = patch(xhrPrototype, 'setRequestHeader', function(originalSetRequestHeader) {
    return /** @this {!XMLHttpRequest} */ function(name, value) {
      if (isTraceparentHeaderName(name)) {
        pendingTraceparents.delete(this);
      }
      return originalSetRequestHeader.call(this, name, value);
    };
  });
  /** @type {?Object|undefined} */
  let sendLayer;
  const restoreSend = patch(xhrPrototype, 'send', function(originalSend) {
    return /** @this {!XMLHttpRequest} */ function() {
      const requestUrl = pendingTraceparents.get(this);
      if (requestUrl) {
        pendingTraceparents.delete(this);
        try {
          if (isTraceparentTarget(traceparentTargets, requestUrl) &&
              !(isSameOrigin(requestUrl) && otelWrapsSendBelow(sendLayer ? sendLayer['next'] : undefined))) {
            this.setRequestHeader(TRACEPARENT_HEADER, createTraceparent());
          }
        } catch (e) {
          // Do not let traceparent injection break the host app's XHR.
        }
      }
      return originalSend.apply(this, arguments);
    };
  });

  // patch() hands the wrapper a delegate, so read what sits beneath it from the installed layer.
  const send = xhrPrototype['send'];
  sendLayer = send ? send['__posthog_layer__'] : undefined;

  return function() {
    restoreSend();
    restoreSetRequestHeader();
    restoreOpen();
  };
}
