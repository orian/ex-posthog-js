/**
 * @fileoverview OTLP helpers shared by the logs and metrics modules (the `otlp`
 * chunk). Ports of upstream core/src/utils/otlp-any-value.ts,
 * otlp-resource.ts, json-utils.ts (sanitizeString, assignUserAttributes),
 * flush-timer.ts and backoff.ts, and browser-common utils/patch.ts.
 *
 * Upstream's `RetryAfterWindow` is not ported: the browser's logs and metrics
 * senders never report a `Retry-After` delay (their outcomes carry no
 * `retryAfterMs`), so the window can never open there and every check of it
 * reads "closed".
 */
import {detectOS} from '../core/user-agent.js';
import {isArray, isFunction, isNullish, win} from '../core/utils.js';

/** @const {number} */ export const MAX_JSON_SAFE_VALUE_DEPTH = 20;
/** @const {number} */ export const MAX_JSON_SAFE_VALUE_ITEMS = 1000;
/** @const {number} */ export const MAX_JSON_SAFE_VALUE_NODES = 10000;
/** @const {string} */ export const CIRCULAR_VALUE = '[Circular]';
/** @const {string} */ export const TRUNCATED_VALUE = '[Truncated]';
/** @const {string} */ export const UNSERIALIZABLE_VALUE = '[Unserializable]';
/** @const {string} */ export const FUNCTION_VALUE = '[Function]';

// 2^63, one past int64 max.
const INT64_RANGE_LIMIT = 9223372036854775808;
const INT64_RANGE_LIMIT_DECIMAL = '9223372036854775808';
const MAX_SAFE_INTEGER = 9007199254740991;

const propertyIsEnumerable = Object.prototype.propertyIsEnumerable;

/**
 * The BigInt constructor where the runtime has one (ES2020).
 * @return {?function(*): ?}
 */
function bigIntCtor() {
  return typeof BigInt === 'function' ? /** @type {function(*): ?} */ (BigInt) : null;
}

/**
 * Minimal debug logger the encoder reports to (upstream passes the module logger).
 * @typedef {?{info: function(...*)}}
 */
export let EncoderLogger;

/**
 * Replaces unpaired surrogates with U+FFFD (upstream sanitizeString).
 * @param {string} value
 * @return {string}
 */
export function sanitizeString(value) {
  let output = '';
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        output += value[index] + value[index + 1];
        index++;
      } else {
        output += '�';
      }
    } else {
      output += codeUnit >= 0xdc00 && codeUnit <= 0xdfff ? '�' : value[index];
    }
  }
  return output;
}

/**
 * Copies own enumerable keys of `source` onto `target`, key by key (a throwing
 * getter becomes `[Unserializable]`), with defineProperty so `__proto__` survives.
 * @param {!Object} target
 * @param {*} source
 * @return {!Object}
 */
export function assignUserAttributes(target, source) {
  if (!source) return target;
  let names = [];
  try {
    names = Object.keys(/** @type {!Object} */ (source));
  } catch (e) {
    names = [];
  }
  for (let i = 0; i < names.length; i++) {
    const key = names[i];
    let value;
    try {
      value = source[key];
    } catch (e) {
      value = UNSERIALIZABLE_VALUE;
    }
    Object.defineProperty(target, key, {value: value, enumerable: true, writable: true, configurable: true});
  }
  return target;
}

/**
 * @param {*} value
 * @return {boolean}
 */
export function isFiniteNumber(value) {
  return typeof value === 'number' && isFinite(value);
}

/**
 * @typedef {{ancestors: !Array<*>, remainingNodes: number}}
 */
let EncodeState;

/** @return {!EncodeState} */
function newState() {
  return {ancestors: [], remainingNodes: MAX_JSON_SAFE_VALUE_NODES};
}

/**
 * @param {*} value
 * @param {EncoderLogger=} logger
 * @return {!Object}
 */
export function toOtlpAnyValue(value, logger) {
  try {
    return encodeAnyValue(value, logger, newState(), 0);
  } catch (e) {
    return {'stringValue': UNSERIALIZABLE_VALUE};
  }
}

/**
 * @param {*} attrs
 * @param {EncoderLogger=} logger
 * @return {!Array<!Object>}
 */
export function toOtlpKeyValueList(attrs, logger) {
  try {
    return encodeKeyValueList(attrs, logger, newState(), 0);
  } catch (e) {
    return [];
  }
}

/**
 * @param {EncoderLogger|undefined} logger
 * @param {string} message
 */
function debug(logger, message) {
  if (logger) logger.info(message);
}

/**
 * @param {?} value a bigint
 * @param {EncoderLogger|undefined} logger
 * @return {!Object}
 */
function encodeBigInt(value, logger) {
  const decimal = value.toString();
  const limit = /** @type {function(*): ?} */ (bigIntCtor())(INT64_RANGE_LIMIT_DECIMAL);
  if (value >= limit || value < -limit) {
    debug(logger, 'Attribute ' + decimal + ' is outside the int64 range; encoding it as a string');
    return {'stringValue': decimal};
  }
  return {'intValue': decimal};
}

/**
 * @param {*} value
 * @param {EncoderLogger|undefined} logger
 * @param {!EncodeState} state
 * @param {number} depth
 * @return {!Object}
 */
function encodeAnyValue(value, logger, state, depth) {
  if (state.remainingNodes <= 0) return {'stringValue': TRUNCATED_VALUE};
  state.remainingNodes--;

  if (typeof value === 'boolean') return {'boolValue': value};
  if (typeof value === 'bigint') return encodeBigInt(value, logger);
  if (typeof value === 'number') {
    if (!isFinite(value)) return {'stringValue': String(value)};
    if (Math.floor(value) === value) {
      if (Math.abs(value) <= MAX_SAFE_INTEGER) return {'intValue': String(value)};
      const BigIntCtor = bigIntCtor();
      if (!BigIntCtor) return {'stringValue': String(value)};
      const decimal = BigIntCtor(value).toString();
      if (value >= INT64_RANGE_LIMIT || value < -INT64_RANGE_LIMIT) {
        debug(logger, 'Attribute ' + decimal + ' is outside the int64 range; encoding it as a string');
        return {'stringValue': decimal};
      }
      return {'intValue': decimal};
    }
    return {'doubleValue': value};
  }
  if (typeof value === 'string') return {'stringValue': sanitizeString(value)};
  if (typeof value === 'function') return {'stringValue': FUNCTION_VALUE};
  if (typeof value === 'symbol') return {'stringValue': String(value)};
  if (typeof value === 'object' && value !== null) {
    if (state.ancestors.indexOf(value) !== -1) return {'stringValue': CIRCULAR_VALUE};
    if (depth >= MAX_JSON_SAFE_VALUE_DEPTH) return {'stringValue': TRUNCATED_VALUE};
    if (value instanceof Date) {
      const time = value.getTime();
      const iso = isFinite(time) ? value.toISOString() : String(value);
      return {'stringValue': typeof iso === 'string' ? sanitizeString(iso) : String(iso)};
    }
    state.ancestors.push(value);
    try {
      try {
        const toJSON = value['toJSON'];
        if (typeof toJSON === 'function') return encodeAnyValue(toJSON.call(value), logger, state, depth + 1);
      } catch (e) {
        // A throwing toJSON falls through to the plain walk.
      }
      if (isArray(value)) {
        return {'arrayValue': {'values': encodeArrayValues(/** @type {!Array} */ (value), logger, state, depth + 1)}};
      }
      return {'kvlistValue': {'values': encodeKeyValueList(value, logger, state, depth + 1)}};
    } finally {
      const at = state.ancestors.lastIndexOf(value);
      if (at !== -1) state.ancestors.splice(at, 1);
    }
  }
  return {'stringValue': sanitizeString(String(value))};
}

/**
 * @param {!Array} values
 * @param {EncoderLogger|undefined} logger
 * @param {!EncodeState} state
 * @param {number} depth
 * @return {!Array<!Object>}
 */
function encodeArrayValues(values, logger, state, depth) {
  const result = [];
  const itemCount = Math.min(values.length, MAX_JSON_SAFE_VALUE_ITEMS);
  let index = 0;
  for (; index < itemCount && state.remainingNodes > 0; index++) {
    try {
      const element = index in values ? values[index] : undefined;
      if (isNullish(element)) continue;
      result.push(encodeAnyValue(element, logger, state, depth));
    } catch (e) {
      result.push({'stringValue': UNSERIALIZABLE_VALUE});
    }
  }
  if (values.length > index) result.push({'stringValue': TRUNCATED_VALUE});
  return result;
}

/**
 * @param {?} attrs
 * @param {EncoderLogger|undefined} logger
 * @param {!EncodeState} state
 * @param {number} depth
 * @return {!Array<!Object>}
 */
function encodeKeyValueList(attrs, logger, state, depth) {
  const result = [];
  for (const key in attrs) {
    if (!propertyIsEnumerable.call(attrs, key)) continue;
    if (!key) {
      debug(logger, 'Dropping an attribute with an empty key');
      continue;
    }
    if (result.length >= MAX_JSON_SAFE_VALUE_ITEMS || state.remainingNodes <= 0) {
      debug(logger, 'Attributes truncated: the value exceeds the OTLP encoder budget');
      break;
    }
    try {
      const value = attrs[key];
      if (value === null || value === undefined) continue;
      result.push({'key': sanitizeString(key), 'value': encodeAnyValue(value, logger, state, depth)});
    } catch (e) {
      result.push({'key': sanitizeString(key), 'value': {'stringValue': UNSERIALIZABLE_VALUE}});
    }
  }
  return result;
}

/**
 * Resource attribution shared by the logs and metrics resolved configs.
 * @typedef {{
 *   serviceName: (string|undefined),
 *   serviceVersion: (string|undefined),
 *   environment: (string|undefined),
 *   resourceAttributes: (?Object|undefined)
 * }}
 */
export let OtlpResourceConfig;

/**
 * Upstream buildOtlpResourceAttributes: user `resourceAttributes` first, SDK keys on top.
 * @param {!OtlpResourceConfig} config
 * @param {string} sdkName
 * @param {string} sdkVersion
 * @return {!Object}
 */
export function buildOtlpResourceAttributes(config, sdkName, sdkVersion) {
  const out = assignUserAttributes({}, config.resourceAttributes);
  out['service.name'] = config.serviceName || 'unknown_service';
  if (config.environment) out['deployment.environment'] = config.environment;
  if (config.serviceVersion) out['service.version'] = config.serviceVersion;
  out['telemetry.sdk.name'] = sdkName;
  out['telemetry.sdk.version'] = sdkVersion;
  return out;
}

const SDK_RESOURCE_KEYS = ['service.name', 'deployment.environment', 'service.version', 'telemetry.sdk.name',
  'telemetry.sdk.version'];

/**
 * Encodes resource attributes, the SDK keys on a budget of their own after the user's.
 * @param {!Object} attributes
 * @param {EncoderLogger=} logger
 * @return {!Array<!Object>}
 */
export function toOtlpResourceKeyValueList(attributes, logger) {
  const user = assignUserAttributes({}, attributes);
  const sdk = {};
  for (let i = 0; i < SDK_RESOURCE_KEYS.length; i++) {
    const key = SDK_RESOURCE_KEYS[i];
    if (Object.prototype.hasOwnProperty.call(user, key)) {
      sdk[key] = user[key];
      delete user[key];
    }
  }
  return toOtlpKeyValueList(user, logger).concat(toOtlpKeyValueList(sdk, logger));
}

/** @const {!Object<string, string>} */
const OS_NAMES = {
  'darwin': 'macOS', 'win32': 'Windows', 'cygwin': 'Windows', 'linux': 'Linux', 'android': 'Android',
  'freebsd': 'FreeBSD', 'openbsd': 'OpenBSD', 'netbsd': 'NetBSD', 'sunos': 'SunOS', 'aix': 'AIX', 'haiku': 'Haiku',
  'Mac OS X': 'macOS',
};

/**
 * @param {string|undefined} name
 * @return {string|undefined}
 */
export function normalizeOsName(name) {
  if (!name) return undefined;
  return Object.prototype.hasOwnProperty.call(OS_NAMES, name) ? OS_NAMES[name] : name;
}

/**
 * `os.name` / `os.version`, each omitted when unknown.
 * @param {string|undefined} name
 * @param {string|undefined} version
 * @return {!Object<string, string>}
 */
export function osResourceAttributes(name, version) {
  const osName = normalizeOsName(name);
  const out = {};
  if (osName) out['os.name'] = osName;
  if (version) out['os.version'] = version;
  return out;
}

/**
 * The browser's default resource attributes (the visitor's OS), never throwing.
 * @return {!Object<string, string>}
 */
export function defaultResourceAttributes() {
  let osName = '';
  let osVersion = '';
  try {
    const ua = win && win.navigator ? win.navigator.userAgent : undefined;
    if (ua) {
      const os = detectOS(ua);
      osName = os[0];
      osVersion = os[1];
    }
  } catch (e) {
    // no OS attributes
  }
  return osResourceAttributes(osName, osVersion);
}

/**
 * Epoch millis as the unix-nanos string OTLP requires.
 * @param {number} ms
 * @return {string}
 */
export function msToUnixNano(ms) {
  return String(ms) + '000000';
}

// ---- export queue timing (upstream flush-timer.ts, backoff.ts) ---------------------

/** @const {number} */ export const MAX_FLUSH_BACKOFF_EXPONENT = 6;
/** @const {number} */ export const MAX_FLUSH_BACKOFF_MS = 30000;
const JITTER = 0.25;
/** @const {number} */ export const NO_JITTER = 1;

/** @return {number} */
export function drawJitter() {
  return 1 - JITTER + Math.random() * JITTER * 2;
}

/**
 * @param {number} baseMs
 * @param {number} failures
 * @param {number} jitter
 * @param {number=} maxMs
 * @return {number}
 */
export function backoffDelayMs(baseMs, failures, jitter, maxMs) {
  const exponent = Math.min(Math.max(0, failures - 1), MAX_FLUSH_BACKOFF_EXPONENT);
  const delay = baseMs * Math.pow(2, exponent);
  const capped = maxMs === undefined ? delay : Math.min(delay, Math.max(maxMs, baseMs));
  return Math.round(capped * jitter);
}

/** The pending flush timer of an export queue and when it is due. */
export class FlushTimer {
  /** @param {function()} onFire */
  constructor(onFire) {
    /** @private @const */
    this.onFire_ = onFire;
    /** @private {number|undefined} */
    this.timer_ = undefined;
    /** @private {number} */
    this.firesAt_ = 0;
  }

  /** @return {boolean} */
  get pending() {
    return !!this.timer_;
  }

  /** @param {number} delayMs */
  arm(delayMs) {
    this.clear();
    this.firesAt_ = new Date().getTime() + delayMs;
    const self = this;
    this.timer_ = setTimeout(function() {
      self.timer_ = undefined;
      try {
        self.onFire_();
      } catch (e) {
        // upstream safeSetTimeout swallows callback errors
      }
    }, delayMs);
  }

  /** @param {number} delayMs */
  armNoEarlierThan(delayMs) {
    if (this.timer_ && new Date().getTime() + delayMs <= this.firesAt_) return;
    this.arm(delayMs);
  }

  clear() {
    if (this.timer_) {
      clearTimeout(this.timer_);
      this.timer_ = undefined;
    }
  }
}

/**
 * Tagged outcome of one export request (upstream SendLogsBatchOutcome /
 * SendMetricsBatchOutcome): kind is 'ok' | 'retry-later' | 'too-large' | 'fatal'.
 * @typedef {{kind: string, error: *}}
 */
export let SendOutcome;

/**
 * Classifies an ingestion response the way both senders do.
 * @param {number} status
 * @param {*} error
 * @param {string} what 'logs' | 'metrics'
 * @return {!SendOutcome}
 */
export function classifyStatus(status, error, what) {
  if (status >= 200 && status < 300) return {kind: 'ok', error: undefined};
  if (status === 413) return {kind: 'too-large', error: undefined};
  if (status === 0 || status === 408 || status === 429 || status >= 500) {
    return {kind: 'retry-later', error: error || new Error(what + ' request failed with status ' + status)};
  }
  return {kind: 'fatal', error: new Error(what + ' request failed with status ' + status)};
}

/**
 * upstream request-reachability isBrowserOnline
 * @return {boolean}
 */
export function isBrowserOnline() {
  try {
    return !!win && win.navigator.onLine !== false;
  } catch (e) {
    return false;
  }
}

// ---- patch (upstream utils/patch.ts) ------------------------------------------------

const noop = function() {};

/**
 * @param {*} method
 * @return {?{next: !Function}}
 */
function spliceableLayer(method) {
  if (!isFunction(method)) return null;
  return method['__posthog_layer__'] || method['__rrweb_layer__'] || null;
}

/**
 * Installs a spliceable wrapper layer over `source[name]`; returns its remover.
 * @param {!Object} source
 * @param {string} name
 * @param {function(!Function): *} replacement receives a delegate to the layer below
 * @return {function()}
 */
export function patch(source, name, replacement) {
  try {
    if (!(name in source)) return noop;
    const original = source[name];
    const layer = {next: original};
    const callNext = function(...args) {
      return layer.next.apply(this, args);
    };
    const wrapped = /** @type {?} */ (replacement(callNext));
    if (isFunction(wrapped)) {
      wrapped.prototype = wrapped.prototype || {};
      Object.defineProperties(wrapped, {
        '__posthog_wrapped__': {enumerable: false, value: true},
        '__posthog_layer__': {enumerable: false, value: layer},
      });
    }
    source[name] = wrapped;
    return function() {
      if (source[name] === wrapped) {
        source[name] = layer.next;
        return;
      }
      let current = source[name];
      let currentLayer = spliceableLayer(current);
      while (currentLayer) {
        if (currentLayer.next === wrapped) {
          currentLayer.next = layer.next;
          return;
        }
        current = currentLayer.next;
        currentLayer = spliceableLayer(current);
      }
    };
  } catch (e) {
    return noop;
  }
}
