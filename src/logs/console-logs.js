/**
 * @fileoverview Console log capture. Port of upstream
 * browser-common/src/console-logs.ts (what upstream's lazy `logs.js` entrypoint
 * runs: the `console.*` wrappers and the replay of the main bundle's pre-load
 * buffer): the lazy part `logs`, registered with provideLazy.
 */
import {isArray, isBoolean, isFunction, isNumber, isObject} from '../core/utils.js';
import {LogSdkContext} from './logs-core.js';
import {patch} from '../otlp/otlp.js';
import {provideLazy} from '../core/lazy.js';
import {
  BufferedConsoleEntry, ConsoleLogsHost, ConsoleLogsPart, LOGS_KIND, originalConsoleMethod,
} from './console-types.js';

/** @const {!Object<string, string>} */
const LEVEL_MAP = {'debug': 'debug', 'log': 'info', 'warn': 'warn', 'error': 'error', 'info': 'info'};

const LOG_BODY_SIZE_LIMIT = 10000;
const LOG_ATTRIBUTES_LIMIT = 50;


// ---- argument serialisation -----------------------------------------------------------

/** @typedef {{remaining: number, truncated: boolean}} */
let StringifyBudget;

/** @typedef {{result: !Object, keysRemaining: number, sizeRemaining: number, truncated: boolean, seen: !Array<*>}} */
let AttributeCollector;

/**
 * @param {!Array<string>} parts
 * @param {string} text
 * @param {!StringifyBudget} budget
 * @return {boolean}
 */
function appendWithLimit(parts, text, budget) {
  if (budget.remaining <= 0) {
    budget.truncated = true;
    return false;
  }
  if (text.length <= budget.remaining) {
    parts.push(text);
    budget.remaining -= text.length;
    return true;
  }
  parts.push(text.slice(0, budget.remaining));
  budget.remaining = 0;
  budget.truncated = true;
  return false;
}

/**
 * @param {string} value
 * @param {!Array<string>} parts
 * @param {!StringifyBudget} budget
 * @return {boolean}
 */
function stringifyStringWithLimit(value, parts, budget) {
  const serialized = JSON.stringify(value);
  if (serialized.length <= budget.remaining) return appendWithLimit(parts, serialized, budget);
  budget.truncated = true;
  if (budget.remaining < 2) return false;
  let low = 0;
  let high = Math.min(value.length, budget.remaining - 2);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (JSON.stringify(value.slice(0, mid)).length <= budget.remaining) low = mid;
    else high = mid - 1;
  }
  return appendWithLimit(parts, JSON.stringify(value.slice(0, low)), budget);
}

/**
 * @param {*} value
 * @return {boolean}
 */
function isJSONSerializablePrimitive(value) {
  const t = typeof value;
  return t !== 'undefined' && t !== 'function' && t !== 'symbol' && t !== 'bigint';
}

/**
 * @param {*} value
 * @return {boolean}
 */
function isNumberOrBoolean(value) {
  try {
    return isNumber(value) || isBoolean(value);
  } catch (e) {
    return false;
  }
}

/**
 * @param {string} key
 * @param {*} value
 * @param {!AttributeCollector} collector
 */
function collectAttributeValue(key, value, collector) {
  if (collector.truncated) return;
  collector.keysRemaining -= 1;
  collector.sizeRemaining -= String(value).length + key.length;
  if (collector.keysRemaining <= 0 || collector.sizeRemaining <= 0) {
    collector.truncated = true;
    collector.result['attributes_truncated'] = true;
    return;
  }
  collector.result[key] = value;
}

/**
 * @param {?} value
 * @param {string} key
 * @param {!AttributeCollector} collector
 */
function collectFlattenedAttributes(value, key, collector) {
  if (collector.truncated) return;
  if (isObject(value)) {
    if (collector.seen.indexOf(value) !== -1) {
      collectAttributeValue(key || 'circular', '[Circular]', collector);
      return;
    }
    collector.seen.push(value);
    // An enumeration that throws (a hostile proxy) propagates to the caller, which
    // keeps what was collected, as upstream's surrounding try does.
    for (const childKey in value) {
      try {
        if (!Object.prototype.hasOwnProperty.call(value, childKey)) continue;
        collectFlattenedAttributes(value[childKey], key ? key + '.' + childKey : childKey, collector);
        if (collector.truncated) return;
      } catch (e) {
        continue;
      }
    }
    return;
  }
  collectAttributeValue(key, value, collector);
}

/**
 * @param {?} value
 * @param {!Array<string>} parts
 * @param {!StringifyBudget} budget
 * @param {!Array<*>} seen
 * @param {boolean=} inArray
 * @param {?AttributeCollector=} attributeCollector
 * @return {boolean}
 */
function stringifyValueWithLimit(value, parts, budget, seen, inArray, attributeCollector) {
  if (!isJSONSerializablePrimitive(value)) return inArray ? appendWithLimit(parts, 'null', budget) : true;
  if (value === null || isNumberOrBoolean(value)) return appendWithLimit(parts, JSON.stringify(value), budget);
  if (typeof value === 'string') return stringifyStringWithLimit(value, parts, budget);
  if (!isObject(value) && !isArray(value)) return appendWithLimit(parts, JSON.stringify(value), budget);
  if (seen.indexOf(value) !== -1) return stringifyStringWithLimit('[Circular]', parts, budget);
  seen.push(value);

  try {
    const toJSON = value['toJSON'];
    if (isFunction(toJSON)) return stringifyValueWithLimit(toJSON.call(value), parts, budget, seen, inArray);
  } catch (e) {
    // fall through to safe property enumeration
  }
  try {
    const tag = Object.prototype.toString.call(value);
    if (tag === '[object String]') return stringifyStringWithLimit(String(value.valueOf()), parts, budget);
    if (tag === '[object Number]' || tag === '[object Boolean]') {
      return appendWithLimit(parts, JSON.stringify(value.valueOf()), budget);
    }
  } catch (e) {
    // fall through
  }
  if (value instanceof Error) {
    const errorObject = {};
    try {
      for (const key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key)) errorObject[key] = value[key];
      }
    } catch (e) {
      // ignore
    }
    try {
      errorObject['name'] = value.name;
    } catch (e) {
      // ignore
    }
    try {
      errorObject['message'] = value.message;
    } catch (e) {
      // ignore
    }
    try {
      errorObject['stack'] = value['stack'];
    } catch (e) {
      // ignore
    }
    return stringifyValueWithLimit(errorObject, parts, budget, seen, inArray, attributeCollector);
  }
  if (isArray(value)) {
    if (!appendWithLimit(parts, '[', budget)) return false;
    for (let i = 0; i < value.length; i++) {
      if (i > 0 && !appendWithLimit(parts, ',', budget)) return false;
      let item;
      try {
        item = value[i];
      } catch (e) {
        item = undefined;
      }
      if (!stringifyValueWithLimit(item, parts, budget, seen, true)) return false;
    }
    return appendWithLimit(parts, ']', budget);
  }

  if (!appendWithLimit(parts, '{', budget)) return false;
  let isFirst = true;
  try {
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (budget.remaining <= 0) {
        budget.truncated = true;
        return false;
      }
      let propertyValue;
      try {
        propertyValue = value[key];
      } catch (e) {
        continue;
      }
      if (attributeCollector) {
        try {
          collectFlattenedAttributes(propertyValue, key, attributeCollector);
        } catch (e) {
          // unreadable attributes are omitted
        }
      }
      if (!isJSONSerializablePrimitive(propertyValue)) continue;
      const propertyPrefix = (isFirst ? '' : ',') + JSON.stringify(key) + ':';
      if (propertyPrefix.length >= budget.remaining) {
        budget.truncated = true;
        return false;
      }
      const partsBeforeProperty = parts.length;
      const remainingBeforeProperty = budget.remaining;
      const truncatedBeforeProperty = budget.truncated;
      if (!appendWithLimit(parts, propertyPrefix, budget)) return false;
      const partsBeforeValue = parts.length;
      const serialized = stringifyValueWithLimit(propertyValue, parts, budget, seen, false);
      const truncatedAfterValue = budget.truncated;
      if (parts.length === partsBeforeValue) {
        parts.length = partsBeforeProperty;
        budget.remaining = remainingBeforeProperty;
        budget.truncated = serialized ? truncatedBeforeProperty : truncatedAfterValue;
        if (!serialized) return false;
        continue;
      }
      isFirst = false;
      if (!serialized) return false;
    }
  } catch (e) {
    // the object's properties cannot be enumerated
  }
  return appendWithLimit(parts, '}', budget);
}

/**
 * Upstream stringifyArgsSafely: the console call as one body string, plus the
 * first argument's properties flattened into attributes when it is an object.
 * @param {!Array<*>} args
 * @param {number} sizeLimit
 * @return {{body: string, truncated: boolean, attributes: !Object}}
 */
export function stringifyArgsSafely(args, sizeLimit) {
  const parts = [];
  const budget = {remaining: sizeLimit, truncated: false};
  const collector = isObject(args[0]) ? {
    result: {},
    keysRemaining: LOG_ATTRIBUTES_LIMIT,
    sizeRemaining: LOG_BODY_SIZE_LIMIT,
    truncated: false,
    seen: [args[0]],
  } : null;
  for (let i = 0; i < args.length; i++) {
    if (i > 0 && !appendWithLimit(parts, ' ', budget)) break;
    if (!stringifyValueWithLimit(args[i], parts, budget, [], false, i === 0 ? collector : null)) break;
  }
  return {
    body: parts.join('') + (budget.truncated ? '...' : ''),
    truncated: budget.truncated,
    attributes: collector ? collector.result : {},
  };
}

/**
 * Builds the log options for one console call (same shape on the live and replay paths).
 * @param {string} level console method
 * @param {!Array<*>} args
 * @param {string} hostname
 * @return {!Object}
 */
function consoleLogOptions(level, args, hostname) {
  const s = stringifyArgsSafely(args, LOG_BODY_SIZE_LIMIT);
  const attributes = {'log.source': 'console.' + level, 'host': hostname};
  if (s.truncated) attributes['body_truncated'] = 'true';
  for (const k in s.attributes) attributes[k] = s.attributes[k];
  return {'level': LEVEL_MAP[level], 'body': s.body, 'attributes': attributes};
}

/**
 * Wraps the console methods; returns the function that removes the wrappers.
 * @param {!ConsoleLogsHost} host
 * @return {function()}
 */
export function initializeLogs(host) {
  const console = host.console;
  let currentHost = host;
  const restoreConsoleMethods = [];
  let isCapturingLog = false;

  const dispose = function() {
    currentHost = null;
    for (let i = 0; i < restoreConsoleMethods.length; i++) {
      try {
        restoreConsoleMethods[i]();
      } catch (e) {
        // other console layers still need cleanup
      }
    }
  };
  try {
    Object.keys(LEVEL_MAP).forEach(function(level) {
      const logWrapper = function(next) {
        return function(...args) {
          let acquiredGuard = false;
          try {
            const activeHost = currentHost;
            if (args.length > 0 && !isCapturingLog && activeHost) {
              const logs = activeHost.getCapturingLogs();
              if (logs) {
                isCapturingLog = true;
                acquiredGuard = true;
                logs.captureConsoleLog(consoleLogOptions(level, args, activeHost.hostname));
              }
            }
          } catch (e) {
            // capture must never break the page's own console output
          } finally {
            if (acquiredGuard) isCapturingLog = false;
            next.apply(console, args);
          }
        };
      };
      const consoleBeforePatch = console[level];
      restoreConsoleMethods.push(patch(console, level, function(next) {
        const wrapped = logWrapper(next);
        wrapped['__rrweb_original__'] = originalConsoleMethod(consoleBeforePatch);
        return wrapped;
      }));
    });
  } catch (error) {
    dispose();
    throw error;
  }
  return dispose;
}

/**
 * Replays console calls recorded before capture took over.
 * @param {!ConsoleLogsHost} host
 * @param {!Array<!BufferedConsoleEntry>} entries
 */
export function replayConsoleBuffer(host, entries) {
  const logs = host.getCapturingLogs();
  if (!logs) return;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    try {
      logs.captureBufferedConsoleLog(consoleLogOptions(entry.level, entry.args, host.hostname), entry.context,
          entry.occurredAtMs);
    } catch (e) {
      // one entry that cannot be captured must not drop the rest
    }
  }
}

provideLazy(LOGS_KIND, /** @type {!ConsoleLogsPart} */ ({
  initializeLogs: initializeLogs,
  replayConsoleBuffer: replayConsoleBuffer,
}));
