/**
 * @fileoverview Small, dependency-free helpers shared by all modules. Ports of
 * upstream's @posthog/core type-utils / string-utils and browser-common's
 * general-utils / request-utils / encode-utils.
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

/** @const {?Location} */
export const loc = win ? win.location : null;

/** @const {string} */
export const userAgent = nav && nav.userAgent ? nav.userAgent : '';

const toStr = Object.prototype.toString;

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
export function isNull(x) {
  return x === null;
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
  return toStr.call(x) == '[object String]';
}

/**
 * @param {*} x
 * @return {boolean}
 */
export function isEmptyString(x) {
  return isString(x) && /** @type {string} */ (x).replace(/^\s+|\s+$/g, '').length === 0;
}

/**
 * @param {*} x
 * @return {boolean}
 */
export function isNumber(x) {
  return toStr.call(x) == '[object Number]' && x === x;
}

/**
 * @param {*} x
 * @return {boolean}
 */
export function isPositiveNumber(x) {
  return isNumber(x) && /** @type {number} */ (x) > 0;
}

/**
 * @param {*} x
 * @return {boolean}
 */
export function isBoolean(x) {
  return toStr.call(x) === '[object Boolean]';
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
  return toStr.call(x) === '[object Array]';
}

/**
 * Upstream's isObject: plain objects (and arrays-not).
 * @param {*} x
 * @return {boolean}
 */
export function isObject(x) {
  return x === Object(x) && !isArray(x);
}

/**
 * @param {*} x
 * @return {boolean}
 */
export function isEmptyObject(x) {
  if (isObject(x)) {
    for (const k in /** @type {!Object} */ (x)) {
      if (Object.prototype.hasOwnProperty.call(/** @type {!Object} */ (x), k)) return false;
    }
    return true;
  }
  return false;
}

/**
 * @param {*} x
 * @return {boolean}
 */
export function isError(x) {
  switch (toStr.call(x)) {
    case '[object Error]':
    case '[object Exception]':
    case '[object DOMException]':
    case '[object DOMError]':
      return true;
    default:
      try {
        return x instanceof Error;
      } catch (e) {
        return false;
      }
  }
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
 * Upstream `extend`: later sources win, undefined values are skipped.
 * @param {!Object} target
 * @param {...*} sources
 * @return {!Object}
 */
export function extend(target, ...sources) {
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    if (isNullish(src)) continue;
    for (const k in /** @type {!Object} */ (src)) {
      if (src[k] !== void 0) target[k] = src[k];
    }
  }
  return target;
}

/**
 * Shallow copy of own enumerable properties (like `{...obj}`).
 * @param {*} obj
 * @return {!Object}
 */
export function assign(obj) {
  const out = {};
  if (isNullish(obj)) return out;
  for (const k in /** @type {!Object} */ (obj)) {
    if (hasOwn(/** @type {!Object} */ (obj), k)) out[k] = obj[k];
  }
  return out;
}

/**
 * Iterates arrays and plain objects (own keys).
 * @param {*} obj
 * @param {function(?, ?)} iterator
 */
export function each(obj, iterator) {
  if (isNullish(obj)) return;
  if (isArray(obj)) {
    /** @type {!Array} */ (obj).forEach(iterator);
    return;
  }
  for (const k in /** @type {!Object} */ (obj)) {
    if (hasOwn(/** @type {!Object} */ (obj), k)) iterator(obj[k], k);
  }
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
 * @param {(!Array|string)} arr
 * @param {*} item
 * @return {boolean}
 */
export function includes(arr, item) {
  return arr.indexOf(/** @type {?} */ (item)) !== -1;
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
 * @param {string} s
 * @return {string}
 */
export function stripLeadingDollar(s) {
  return s.replace(/^\$/, '');
}

/**
 * @param {string|undefined} url
 * @return {string|undefined}
 */
export function stripUrlHash(url) {
  if (!url) return url;
  return url.split('#')[0];
}

/** @const {!Array<*>} */
const YES_LIKE = [true, 'true', 1, '1', 'yes'];
/** @const {!Array<*>} */
const NO_LIKE = [false, 'false', 0, '0', 'no'];

/**
 * @param {*} v
 * @return {boolean}
 */
export function isYesLike(v) {
  return YES_LIKE.indexOf(v) !== -1;
}

/**
 * @param {*} v
 * @return {boolean}
 */
export function isNoLike(v) {
  return NO_LIKE.indexOf(v) !== -1;
}

/**
 * Upstream clampToRange (logging omitted).
 * @param {*} value
 * @param {number} min
 * @param {number} max
 * @param {number=} fallback
 * @return {number}
 */
export function clampToRange(value, min, max, fallback) {
  if (min > max) min = max;
  if (!isNumber(value)) return clampToRange(isUndefined(fallback) ? max : fallback, min, max);
  const v = /** @type {number} */ (value);
  if (v > max) return max;
  if (v < min) return min;
  return v;
}

/**
 * Keeps only non-empty strings and numbers (upstream stripEmptyProperties).
 * @param {!Object} p
 * @return {!Object}
 */
export function stripEmptyProperties(p) {
  const ret = {};
  each(p, function(v, k) {
    if ((isString(v) && v.length > 0) || isNumber(v)) ret[k] = v;
  });
  return ret;
}

/**
 * @param {!Error} error
 * @return {!Object}
 */
function errorToProperties(error) {
  const copy = assign(error);
  ['name', 'message', 'stack', 'cause', 'errors'].forEach(function(d) {
    try {
      if (d in error) copy[d] = error[d];
    } catch (e) {}
  });
  return copy;
}

/**
 * JSON.stringify that serialises BigInt and Error values like upstream.
 * @param {*} value
 * @return {string}
 */
export function jsonStringify(value) {
  try {
    return JSON.stringify(value, function(_k, v) {
      if (isError(v)) return errorToProperties(/** @type {!Error} */ (v));
      return typeof v === 'bigint' ? String(v) : v;
    });
  } catch (e) {
    const ancestors = [];
    return JSON.stringify(value, /** @this {*} */ function(_k, v) {
      if (typeof v === 'bigint') return String(v);
      if (typeof v === 'function') return undefined;
      if (v && typeof v === 'object') {
        while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
        if (ancestors.indexOf(v) !== -1) return '[Circular]';
        ancestors.push(v);
      }
      return v;
    }) || 'null';
  }
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
 * Upstream _copyAndTruncateStrings: deep copy that drops circular references
 * and truncates every string to maxStringLength.
 * @param {!Object} object
 * @param {?number} maxStringLength
 * @return {!Object}
 */
export function copyAndTruncateStrings(object, maxStringLength) {
  const inProgress = [];
  /**
   * @param {*} value
   * @return {*}
   */
  function copy(value) {
    if (value !== Object(value)) {
      return isString(value) ? /** @type {string} */ (value).slice(0, /** @type {number} */ (maxStringLength)) : value;
    }
    if (inProgress.indexOf(value) !== -1) return undefined;
    inProgress.push(value);
    if (isArray(value)) {
      const arr = [];
      /** @type {!Array} */ (value).forEach(function(it) {
        arr.push(copy(it));
      });
      return arr;
    }
    const obj = {};
    each(isError(value) ? errorToProperties(/** @type {!Error} */ (value)) : value, function(val, key) {
      if (inProgress.indexOf(val) === -1) obj[key] = copy(val);
    });
    return obj;
  }
  return /** @type {!Object} */ (copy(object));
}

/**
 * Upstream getQueryParam (browser-common request-utils).
 * @param {string} url
 * @param {string} param
 * @return {string}
 */
export function getQueryParam(url, param) {
  const withoutHash = url.split('#')[0] || '';
  const queryParams = withoutHash.split(/\?(.*)/)[1] || '';
  const cleaned = queryParams.replace(/^\?+/g, '');
  const parts = cleaned.split('&');
  let kv;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].split(/=(.*)/);
    if (p[0] === param) {
      kv = p;
      break;
    }
  }
  if (!isArray(kv) || kv.length < 2) return '';
  let result = kv[1].replace(/\+/g, ' ');
  try {
    result = decodeURIComponent(result);
  } catch (e) {}
  return result;
}

/**
 * Upstream maskQueryParams.
 * @param {string|undefined} url
 * @param {!Array<string>|undefined} masked
 * @param {string} mask
 * @return {string|undefined}
 */
export function maskQueryParams(url, masked, mask) {
  if (!url || !masked || !masked.length) return url;
  const splitHash = url.split(/#(.*)/);
  const withoutHash = splitHash[0] || '';
  const hash = splitHash[1];
  const splitQuery = withoutHash.split(/\?(.*)/);
  const queryString = splitQuery[1];
  const base = splitQuery[0];
  const queryParts = (queryString || '').split('&');
  const out = [];
  for (let i = 0; i < queryParts.length; i++) {
    const pieces = queryParts[i].split('?');
    let j = 0;
    while (j < pieces.length && masked.indexOf(pieces[j].split('=')[0]) === -1) j++;
    if (j < pieces.length) {
      out.push(pieces.slice(0, j).concat(pieces[j].split('=')[0] + '=' + mask).join('?'));
    } else {
      out.push(queryParts[i]);
    }
  }
  let result = base;
  if (queryString != null) result += '?' + out.join('&');
  if (hash != null) result += '#' + hash;
  return result;
}

/**
 * Upstream formDataToQuery.
 * @param {!Object} data
 * @return {string}
 */
export function formDataToQuery(data) {
  const arr = [];
  each(data, function(val, key) {
    if (isUndefined(val) || isUndefined(key) || key === 'undefined') return;
    arr.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(val)));
  });
  return arr.join('&');
}

/**
 * Upstream extendURLParams.
 * @param {string} url
 * @param {!Object} params
 * @param {boolean=} replace default true
 * @return {string}
 */
export function extendURLParams(url, params, replace) {
  const doReplace = replace !== false;
  const parts = url.split('?');
  const baseUrl = parts[0];
  const search = parts[1];
  const newParams = assign(params);
  const updated = isUndefined(search) ? [] : search.split('&').map(function(pair) {
    const kv = pair.split('=');
    const key = kv[0];
    const value = doReplace ? (isNullish(newParams[key]) ? kv[1] : newParams[key]) : kv[1];
    delete newParams[key];
    return key + '=' + value;
  });
  const remaining = formDataToQuery(newParams);
  if (remaining) updated.push(remaining);
  return updated.length > 0 ? baseUrl + '?' + updated.join('&') : baseUrl;
}

/**
 * Upstream removeURLParam.
 * @param {string} url
 * @param {string} param
 * @return {string}
 */
export function removeURLParam(url, param) {
  const h = url.split('#');
  const q = h[0].split('?');
  const search = q[1];
  if (!search) return url;
  const updated = search.split('&').filter(function(pair) {
    return pair.split('=')[0] !== param;
  }).join('&');
  return q[0] + (updated ? '?' + updated : '') + (h[1] ? '#' + h[1] : '');
}

/**
 * Upstream convertToURL: parses with an anchor element (or URL), returning
 * null when the input cannot be parsed.
 * @param {string} url
 * @return {?{href: string, host: string, hostname: string, pathname: string, protocol: string, search: string}}
 */
export function convertToURL(url) {
  try {
    const U = win ? win['URL'] : null;
    let u;
    if (U) {
      u = new U(url, win.location.href);
    } else if (doc) {
      u = doc.createElement('a');
      u['href'] = url;
    } else {
      return null;
    }
    return {
      href: u['href'], host: u['host'], hostname: u['hostname'], pathname: u['pathname'],
      protocol: u['protocol'], search: u['search'],
    };
  } catch (e) {
    return null;
  }
}

/**
 * Upstream _base64Encode (UTF-8 safe).
 * @param {string} data
 * @return {string}
 */
export function base64Encode(data) {
  if (!data) return data;
  return btoa(encodeURIComponent(data).replace(/%([0-9A-F]{2})/g, function(_m, p1) {
    return String.fromCharCode(parseInt(p1, 16));
  }));
}

/**
 * Upstream addEventListener helper: passive by default.
 * @param {?EventTarget|undefined} target
 * @param {string} type
 * @param {function(?)} handler
 * @param {{capture: (boolean|undefined), passive: (boolean|undefined)}=} options
 */
export function addEventListener(target, type, handler, options) {
  if (!target || !target.addEventListener) return;
  const o = options || {capture: undefined, passive: undefined};
  target.addEventListener(type, handler, /** @type {?} */ ({
    'capture': !!o.capture,
    'passive': isUndefined(o.passive) ? true : o.passive,
  }));
}

/**
 * @param {*} value
 * @return {boolean}
 */
export function isValidUUID(value) {
  return isString(value) && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(/** @type {string} */ (value));
}

/**
 * Recursively sorts object keys (deterministic JSON).
 * @param {*} value
 * @return {*}
 */
function deepSortKeys(value) {
  if (value === null || typeof value !== 'object') return value;
  if (isArray(value)) return /** @type {!Array} */ (value).map(deepSortKeys);
  const out = {};
  keys(/** @type {!Object} */ (value)).sort().forEach(function(k) {
    out[k] = deepSortKeys(value[k]);
  });
  return out;
}

/**
 * Upstream getPersonPropertiesHash.
 * @param {string} distinctId
 * @param {?Object|undefined} set
 * @param {?Object|undefined} setOnce
 * @return {string}
 */
export function getPersonPropertiesHash(distinctId, set, setOnce) {
  return JSON.stringify({
    'distinct_id': distinctId,
    'userPropertiesToSet': set ? deepSortKeys(set) : undefined,
    'userPropertiesToSetOnce': setOnce ? deepSortKeys(setOnce) : undefined,
  });
}

/**
 * Upstream getCookieValue.
 * @param {string} name
 * @return {?string|undefined}
 */
export function getCookieValue(name) {
  if (!doc) return undefined;
  try {
    const nameEQ = name + '=';
    const cookies = doc.cookie.split(';').filter(function(c) {
      return c.length;
    });
    for (let i = 0; i < cookies.length; i++) {
      let c = cookies[i];
      while (c.charAt(0) == ' ') c = c.substring(1, c.length);
      if (c.indexOf(nameEQ) === 0) return decodeURIComponent(c.substring(nameEQ.length, c.length));
    }
  } catch (e) {}
  return null;
}

/**
 * Runs `fn` on the next microtask when Promise exists, else on a timer.
 * @param {function()} fn
 */
export function microtask(fn) {
  const P = win ? win['Promise'] : null;
  if (P) P['resolve']()['then'](fn);
  else setTimeout(fn, 0);
}
