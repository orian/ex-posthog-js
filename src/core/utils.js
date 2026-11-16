/**
 * @fileoverview Small, dependency-free helpers shared by all modules.
 *
 * Closure note: anything that crosses the SDK boundary (user config, persisted
 * JSON, server responses, event payloads) is accessed with quoted keys so that
 * ADVANCED optimizations never rename it. Internal fields use dotted access.
 */

/** @const {?Window} */
export const win = typeof window !== 'undefined' ? window : null;

/** @const {?Document} */
export const doc = win ? win.document : null;

/** @const {?Navigator} */
export const nav = win ? win.navigator : null;

/** @const {string} */
export const userAgent = nav && nav.userAgent ? nav.userAgent : '';

/**
 * @param {*} x
 * @return {boolean}
 */
export function isUndefined(x) {
  return x === void 0;
}

/**
 * @param {*} x
 * @return {boolean}
 */
export function isNullish(x) {
  return x === void 0 || x === null;
}

/**
 * @param {*} x
 * @return {boolean}
 */
export function isString(x) {
  return typeof x === 'string';
}

/**
 * @param {*} x
 * @return {boolean}
 */
export function isNumber(x) {
  return typeof x === 'number' && x === x;
}

/**
 * @param {*} x
 * @return {boolean}
 */
export function isBoolean(x) {
  return typeof x === 'boolean';
}

/**
 * @param {*} x
 * @return {boolean}
 */
export function isFunction(x) {
  return typeof x === 'function';
}

/**
 * @param {*} x
 * @return {boolean}
 */
export function isArray(x) {
  return Object.prototype.toString.call(x) === '[object Array]';
}

/**
 * Plain object check (not null, not array).
 * @param {*} x
 * @return {boolean}
 */
export function isObject(x) {
  return x === Object(x) && !isArray(x) && !isFunction(x);
}

/**
 * @param {*} x
 * @return {boolean}
 */
export function isEmptyObject(x) {
  if (!isObject(x)) return false;
  for (const k in /** @type {!Object} */ (x)) {
    if (Object.prototype.hasOwnProperty.call(/** @type {!Object} */ (x), k)) return false;
  }
  return true;
}

/**
 * @param {!Object} obj
 * @param {string} key
 * @return {boolean}
 */
export function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Shallow-merges sources into target (later sources win), skipping undefined.
 * Non-object sources are ignored.
 * @param {!Object} target
 * @param {...*} sources
 * @return {!Object}
 */
export function extend(target, ...sources) {
  for (let i = 0; i < sources.length; i++) {
    if (!sources[i] || typeof sources[i] !== 'object') continue;
    const src = /** @type {!Object} */ (sources[i]);
    for (const k in src) {
      if (hasOwn(src, k) && !isUndefined(src[k])) {
        target[k] = src[k];
      }
    }
  }
  return target;
}

/**
 * @param {!Object} obj
 * @return {!Array<string>}
 */
export function keys(obj) {
  const out = [];
  for (const k in obj) {
    if (hasOwn(obj, k)) out.push(k);
  }
  return out;
}

/**
 * @param {!Array<T>} arr
 * @param {T} item
 * @return {boolean}
 * @template T
 */
export function includes(arr, item) {
  return arr.indexOf(item) !== -1;
}

/**
 * @param {string} s
 * @return {string}
 */
export function trim(s) {
  return s.replace(/^\s+|\s+$/g, '');
}

/** @return {number} */
export function now() {
  return new Date().getTime();
}

/**
 * Wraps a callback so an exception inside never breaks the host page.
 * @param {function()} fn
 * @param {function(*)=} onError
 */
export function safely(fn, onError) {
  try {
    fn();
  } catch (e) {
    if (onError) onError(e);
  }
}

/**
 * @param {*} value
 * @return {string}
 */
export function jsonStringify(value) {
  return JSON.stringify(value, function(_k, v) {
    // BigInt is not JSON-serialisable; send it as a string rather than throwing.
    return typeof v === 'bigint' ? String(v) : v;
  });
}

/**
 * @param {?string|undefined} s
 * @return {*}
 */
export function jsonParse(s) {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}

/**
 * Recursively truncates string values to maxLength (null/-1 disables).
 * @param {*} value
 * @param {?number} maxLength
 * @return {*}
 */
export function truncateStrings(value, maxLength) {
  if (isNullish(maxLength) || maxLength < 0) return value;
  if (isString(value)) {
    return /** @type {string} */ (value).slice(0, /** @type {number} */ (maxLength));
  }
  if (isArray(value)) {
    return /** @type {!Array} */ (value).map(function(v) {
      return truncateStrings(v, maxLength);
    });
  }
  if (isObject(value) && !(value instanceof Date)) {
    const out = {};
    for (const k in /** @type {!Object} */ (value)) {
      if (hasOwn(/** @type {!Object} */ (value), k)) {
        out[k] = truncateStrings(value[k], maxLength);
      }
    }
    return out;
  }
  return value;
}

/**
 * @param {string} url
 * @param {string} param
 * @return {string}
 */
export function getQueryParam(url, param) {
  const re = new RegExp('[\\?&#]' + param.replace(/[\[\]]/g, '\\$&') + '=([^&#]*)');
  const m = re.exec(url);
  if (!m || !isString(m[1])) return '';
  try {
    return decodeURIComponent(m[1].replace(/\+/g, ' '));
  } catch (e) {
    return m[1];
  }
}

/**
 * Appends query params to a URL.
 * @param {string} url
 * @param {!Object<string, string>} params
 * @return {string}
 */
export function addQueryParams(url, params) {
  const parts = [];
  for (const k in params) {
    if (hasOwn(params, k)) {
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
    }
  }
  if (!parts.length) return url;
  return url + (url.indexOf('?') === -1 ? '?' : '&') + parts.join('&');
}

/**
 * UTF-8 safe base64.
 * @param {string} s
 * @return {string}
 */
export function base64Encode(s) {
  return btoa(unescape(encodeURIComponent(s)));
}

/**
 * Adds a DOM event listener (capture-phase optional), returning a remover.
 * @param {?EventTarget} target
 * @param {string} type
 * @param {function(!Event)} handler
 * @param {boolean=} capture
 * @return {function()}
 */
export function addEventListener(target, type, handler, capture) {
  if (!target || !target.addEventListener) return function() {};
  target.addEventListener(type, handler, !!capture);
  return function() {
    target.removeEventListener(type, handler, !!capture);
  };
}
