/**
 * @fileoverview Exception -> `$exception` properties, a port of upstream
 * core/src/error-tracking: error-properties-builder.ts, coercers/*,
 * chunk-ids.ts, release.ts and exception-steps.ts (portions derived from
 * getsentry/sentry-javascript, MIT).
 *
 * Internal intermediate values (`ExceptionLike`) use renamed (dotted)
 * properties; everything that ends up in the event (`$exception_list` items,
 * mechanisms, frames, steps) uses quoted keys.
 */
import {StackFrame, StackParser, createDefaultStackParser} from './stack-parser.js';
import {win} from '../core/utils.js';

/**
 * The global object (`globalThis`, or `window` where it is missing).
 * @const {?}
 */
const globalObj = typeof globalThis !== 'undefined' ? globalThis : win;

/**
 * @typedef {{
 *   type: (string|undefined),
 *   value: (string|undefined),
 *   stack: (string|undefined),
 *   cause: (?ExceptionLike|undefined),
 *   synthetic: (boolean|undefined),
 *   errors: (!Array<!ExceptionLike>|undefined),
 * }}
 */
export let ExceptionLike;

/**
 * Upstream ParsedException: as ExceptionLike, with parsed frames.
 * @typedef {{
 *   type: (string|undefined),
 *   value: (string|undefined),
 *   frames: (!Array<!StackFrame>|undefined),
 *   cause: (?ParsedException|undefined),
 *   synthetic: (boolean|undefined),
 *   errors: (!Array<!ParsedException>|undefined),
 * }}
 */
let ParsedException;

/**
 * Upstream EventHint. `mechanism` uses quoted keys (`handled`, `type`,
 * `synthetic`), like upstream's wire Mechanism.
 * @typedef {{
 *   mechanism: (!Object|undefined),
 *   syntheticException: (?Error|undefined),
 *   skipFirstLines: (number|undefined),
 * }}
 */
export let EventHint;

/** Upstream CoercingContext. */
export class CoercingContext {
  constructor() {
    /** @type {?Error|undefined} */
    this.syntheticException;
    /** @type {!Object} */
    this.mechanism;
    /** @type {number|undefined} */
    this.skipFirstLines;
    /**
     * Forwards to another coercer (wrappers such as ErrorEvent).
     * @type {function(*): !ExceptionLike}
     */
    this.apply;
    /**
     * Coerces a nested exception (cause / aggregate member).
     * @type {function(*): (!ExceptionLike|undefined)}
     */
    this.next;
  }
}

/**
 * @record
 */
export class Coercer {
  constructor() {
    /** @type {function(*): boolean} */
    this.match;
    /** @type {function(?, !CoercingContext): (!ExceptionLike|undefined)} */
    this.coerce;
  }
}

// ---------------------------------------------------------------------------
// Type helpers (upstream core/src/utils/type-utils.ts)

const toStr = Object.prototype.toString;

/**
 * @param {*} candidate
 * @param {string} className
 * @return {boolean}
 */
export function isBuiltin(candidate, className) {
  return toStr.call(candidate) === '[object ' + className + ']';
}

/**
 * @param {*} candidate
 * @param {*} base
 * @return {boolean}
 */
function isInstanceOf(candidate, base) {
  try {
    return candidate instanceof /** @type {?} */ (base);
  } catch (e) {
    return false;
  }
}

/**
 * @param {*} candidate
 * @return {boolean}
 */
export function isError(candidate) {
  switch (toStr.call(candidate)) {
    case '[object Error]':
    case '[object Exception]':
    case '[object DOMException]':
    case '[object DOMError]':
    case '[object WebAssembly.Exception]':
      return true;
    default:
      return isInstanceOf(candidate, Error);
  }
}

/**
 * @param {*} candidate
 * @return {boolean}
 */
export function isEvent(candidate) {
  return typeof Event !== 'undefined' && isInstanceOf(candidate, Event);
}

/**
 * @param {*} value
 * @return {boolean}
 */
export function isPrimitive(value) {
  return value === null || typeof value !== 'object';
}

/**
 * @param {*} x
 * @return {boolean}
 */
function isString(x) {
  return toStr.call(x) === '[object String]';
}

/**
 * Sorted keys joined with ', ', stopping before `maxLength` would be exceeded.
 * @param {!Object} err
 * @param {number=} maxLength
 * @return {string}
 */
export function extractExceptionKeysForMessage(err, maxLength) {
  const max = maxLength === undefined ? 40 : maxLength;
  const keys = Object.keys(err);
  keys.sort();
  if (!keys.length) return '[object has no keys]';
  let serialized = '';
  for (let i = 0; i < keys.length; i++) {
    const next = serialized ? serialized + ', ' + keys[i] : keys[i];
    if (next.length > max) break;
    serialized = next;
  }
  return serialized;
}

/**
 * @param {!CoercingContext} ctx
 * @return {string|undefined}
 */
function syntheticStack(ctx) {
  return ctx.syntheticException ? ctx.syntheticException.stack : undefined;
}

// ---------------------------------------------------------------------------
// Coercers (upstream coercers/*.ts), in the order the browser SDK uses them.

/** @const {!Coercer} */
export const domExceptionCoercer = {
  match: function(err) {
    return isBuiltin(err, 'DOMException') || isBuiltin(err, 'DOMError');
  },
  coerce: function(err, ctx) {
    const isDOMError = isBuiltin(err, 'DOMError');
    const name = err['name'] || (isDOMError ? 'DOMError' : 'DOMException');
    return {
      type: isDOMError ? 'DOMError' : 'DOMException',
      value: err['message'] ? name + ': ' + err['message'] : name,
      stack: isString(err['stack']) ? err['stack'] : undefined,
      cause: err['cause'] ? ctx.next(err['cause']) : undefined,
      synthetic: false,
    };
  },
};

/**
 * @param {*} err
 * @return {boolean}
 */
function isCustomEventWrappingRejection(err) {
  if (!isEvent(err)) return false;
  try {
    const detail = err['detail'];
    return detail != null && typeof detail === 'object' && 'reason' in detail;
  } catch (e) {
    return false;
  }
}

/**
 * @param {?} error
 * @return {*}
 */
function getUnhandledRejectionReason(error) {
  try {
    if ('reason' in error) return error['reason'];
    if ('detail' in error && error['detail'] != null && typeof error['detail'] === 'object' &&
        'reason' in error['detail']) {
      return error['detail']['reason'];
    }
  } catch (e) {}
  return error;
}

/** @const {!Coercer} */
export const promiseRejectionEventCoercer = {
  match: function(err) {
    return isBuiltin(err, 'PromiseRejectionEvent') || isCustomEventWrappingRejection(err);
  },
  coerce: function(err, ctx) {
    const reason = getUnhandledRejectionReason(err);
    if (isPrimitive(reason)) {
      return {
        type: 'UnhandledRejection',
        value: 'Non-Error promise rejection captured with value: ' + String(reason),
        stack: syntheticStack(ctx),
        synthetic: true,
      };
    }
    return ctx.apply(reason);
  },
};

/**
 * @param {?} err
 * @return {string|undefined}
 */
function buildLocationStack(err) {
  const lineno = err['lineno'] == null ? 0 : err['lineno'];
  const colno = err['colno'] == null ? 0 : err['colno'];
  if (!isString(err['filename']) || err['filename'].length === 0) return undefined;
  if (lineno === 0) return undefined;
  return 'Error\n    at ' + err['filename'] + ':' + lineno + ':' + colno;
}

/** @const {!Coercer} */
export const errorEventCoercer = {
  match: function(err) {
    if (!isBuiltin(err, 'ErrorEvent')) return false;
    const e = /** @type {?} */ (err);
    return e['error'] != undefined || (isString(e['message']) && e['message'].length > 0);
  },
  coerce: function(err, ctx) {
    if (err['error'] != undefined) return ctx.apply(err['error']);
    const exceptionLike = ctx.apply(err['message']);
    const location = buildLocationStack(err);
    return {
      type: exceptionLike.type,
      value: exceptionLike.value,
      stack: location === undefined ? exceptionLike.stack : location,
      cause: exceptionLike.cause,
      synthetic: true,
      errors: exceptionLike.errors,
    };
  },
};

/** @const {!Coercer} */
export const errorCoercer = {
  match: isError,
  coerce: function(err, ctx) {
    let stack;
    try {
      const stacktrace = err['stacktrace'];
      if (typeof stacktrace === 'string' && stacktrace.length > 0) {
        stack = stacktrace;
      } else {
        const s = err['stack'];
        stack = typeof s === 'string' && s.length > 0 ? s : undefined;
      }
    } catch (e) {
      stack = undefined;
    }
    const replacementStack = stack === undefined ? syntheticStack(ctx) : undefined;
    const message = err['message'];
    // Like upstream, a missing message throws here (caught by the builder).
    const value = message['error'] && typeof message['error']['message'] === 'string' ?
        String(message['error']['message']) : String(message);
    return {
      type: err['name'] || err.constructor.name,
      value: value,
      stack: stack === undefined ? replacementStack : stack,
      cause: err['cause'] ? ctx.next(err['cause']) : undefined,
      synthetic: !!replacementStack,
    };
  },
};

/** @const {!Coercer} */
export const eventCoercer = {
  match: isEvent,
  coerce: function(evt, ctx) {
    const constructorName = evt.constructor.name;
    return {
      type: constructorName,
      value: constructorName + ' captured as exception with keys: ' + extractExceptionKeysForMessage(evt),
      stack: syntheticStack(ctx),
      synthetic: true,
    };
  },
};

/**
 * @param {!Object} obj
 * @return {string|undefined}
 */
function getObjectClassName(obj) {
  try {
    const prototype = Object.getPrototypeOf(obj);
    return prototype ? prototype.constructor.name : undefined;
  } catch (e) {
    return undefined;
  }
}

/** @const {!Coercer} */
export const objectCoercer = {
  match: function(candidate) {
    return typeof candidate === 'object' && candidate !== null;
  },
  coerce: function(candidate, ctx) {
    for (const prop in candidate) {
      if (Object.prototype.hasOwnProperty.call(candidate, prop) && isError(candidate[prop])) {
        return ctx.apply(candidate[prop]);
      }
    }
    let type;
    if (isEvent(candidate)) {
      type = candidate.constructor.name;
    } else {
      const name = 'name' in candidate ? candidate['name'] : undefined;
      type = isString(name) && name.length > 0 ? name : 'Error';
    }
    let value;
    if ('name' in candidate && typeof candidate['name'] === 'string') {
      value = '\'' + candidate['name'] + '\' captured as exception';
      if ('message' in candidate && typeof candidate['message'] === 'string') {
        value += ' with message: \'' + candidate['message'] + '\'';
      }
    } else if ('message' in candidate && typeof candidate['message'] === 'string') {
      value = candidate['message'];
    } else {
      const className = getObjectClassName(candidate);
      value = (className && className !== 'Object' ? '\'' + className + '\'' : 'Object') +
          ' captured as exception with keys: ' + extractExceptionKeysForMessage(candidate);
    }
    let stack;
    try {
      if (isString(candidate['stacktrace']) && candidate['stacktrace'].length > 0) {
        stack = candidate['stacktrace'];
      } else {
        stack = isString(candidate['stack']) && candidate['stack'].length > 0 ? candidate['stack'] : undefined;
      }
    } catch (e) {
      stack = undefined;
    }
    return {
      type: type,
      value: value,
      stack: stack === undefined ? syntheticStack(ctx) : stack,
      synthetic: true,
    };
  },
};

const ERROR_TYPES_PATTERN =
    /^(?:[Uu]ncaught (?:exception: )?)?(?:((?:Eval|Internal|Range|Reference|Syntax|Type|URI|)Error): )?(.*)$/i;

/**
 * Upstream StringCoercer.getInfos.
 * @param {string} candidate
 * @return {!Array<string|undefined>} [type, value]
 */
export function getStringInfos(candidate) {
  let type = 'Error';
  let value = candidate;
  const groups = candidate.match(ERROR_TYPES_PATTERN);
  if (groups) {
    type = groups[1];
    value = groups[2];
  }
  return [type, value];
}

/** @const {!Coercer} */
export const stringCoercer = {
  match: function(input) {
    return typeof input === 'string';
  },
  coerce: function(input, ctx) {
    const infos = getStringInfos(input);
    return {
      type: infos[0] == null ? 'Error' : infos[0],
      value: infos[1] == null ? input : infos[1],
      stack: syntheticStack(ctx),
      synthetic: true,
    };
  },
};

/** @const {!Coercer} */
export const primitiveCoercer = {
  match: isPrimitive,
  coerce: function(value, ctx) {
    return {
      type: 'Error',
      value: 'Primitive value captured as exception: ' + String(value),
      stack: syntheticStack(ctx),
      synthetic: true,
    };
  },
};

/**
 * The browser SDK's coercers (upstream buildErrorPropertiesBuilder).
 * @return {!Array<!Coercer>}
 */
export function defaultCoercers() {
  return [domExceptionCoercer, promiseRejectionEventCoercer, errorEventCoercer, errorCoercer, eventCoercer,
    objectCoercer, stringCoercer, primitiveCoercer];
}

// ---------------------------------------------------------------------------
// Chunk ids (upstream chunk-ids.ts)

/** @type {?Object<string, string>} */
let parsedStackResults = null;
/** @type {?Object<string, string>|undefined} */
let lastPostHogChunkIds;
/** @type {?Object<string, string>|undefined} */
let lastNativeDebugIds;
/** @type {?Object<string, string>|undefined} */
let cachedFilenameChunkIds;

/**
 * @param {?Object<string, string>|undefined} chunkIds
 * @return {?Object<string, string>|undefined}
 */
function copyMap(chunkIds) {
  if (!chunkIds) return undefined;
  const out = {};
  for (const k in chunkIds) out[k] = chunkIds[k];
  return out;
}

/**
 * @param {?Object<string, string>|undefined} chunkIds
 * @param {!Array<string>} keys
 * @param {?Object<string, string>|undefined} snapshot
 * @return {boolean}
 */
function matchesSnapshot(chunkIds, keys, snapshot) {
  if (!chunkIds || !snapshot) return chunkIds === snapshot;
  return keys.length === Object.keys(snapshot).length && keys.every(function(key) {
    return chunkIds[key] === snapshot[key];
  });
}

/**
 * Maps script filenames to the chunk ids injected by the PostHog CLI
 * (`globalThis._posthogChunkIds`) or native debug ids (`globalThis._debugIds`).
 * @param {!StackParser} stackParser
 * @return {!Object<string, string>|undefined}
 */
export function getFilenameToChunkIdMap(stackParser) {
  const posthogChunkIds = /** @type {?Object<string, string>|undefined} */ (globalObj ? globalObj['_posthogChunkIds'] : undefined);
  const nativeDebugIds = /** @type {?Object<string, string>|undefined} */ (globalObj ? globalObj['_debugIds'] : undefined);
  if (!posthogChunkIds && !nativeDebugIds) return undefined;
  const posthogKeys = posthogChunkIds ? Object.keys(posthogChunkIds) : [];
  const nativeKeys = nativeDebugIds ? Object.keys(nativeDebugIds) : [];
  if (cachedFilenameChunkIds && matchesSnapshot(posthogChunkIds, posthogKeys, lastPostHogChunkIds) &&
      matchesSnapshot(nativeDebugIds, nativeKeys, lastNativeDebugIds)) {
    return cachedFilenameChunkIds;
  }
  lastPostHogChunkIds = copyMap(posthogChunkIds);
  lastNativeDebugIds = copyMap(nativeDebugIds);
  /** @type {!Object<string, string>} */
  const result = {};
  cachedFilenameChunkIds = result;
  if (!parsedStackResults) parsedStackResults = {};
  const cache = parsedStackResults;
  /**
   * @param {!Array<string>} keys
   * @param {!Object<string, string>} chunkIds
   */
  const addChunkIds = function(keys, chunkIds) {
    for (let k = 0; k < keys.length; k++) {
      const stackKey = keys[k];
      const chunkId = chunkIds[stackKey];
      if (!chunkId) continue;
      const cachedFilename = cache[stackKey];
      if (cachedFilename) {
        result[cachedFilename] = chunkId;
        continue;
      }
      const parsedStack = stackParser(stackKey);
      for (let i = parsedStack.length - 1; i >= 0; i--) {
        const filename = parsedStack[i] ? parsedStack[i]['filename'] : undefined;
        if (filename) {
          result[/** @type {string} */ (filename)] = chunkId;
          cache[stackKey] = /** @type {string} */ (filename);
          break;
        }
      }
    }
  };
  if (nativeDebugIds) addChunkIds(nativeKeys, nativeDebugIds);
  if (posthogChunkIds) addChunkIds(posthogKeys, posthogChunkIds);
  return result;
}

/** Test helper: forgets the chunk id cache (upstream tests reset modules). */
export function resetChunkIdCache() {
  parsedStackResults = null;
  lastPostHogChunkIds = undefined;
  lastNativeDebugIds = undefined;
  cachedFilenameChunkIds = undefined;
}

// ---------------------------------------------------------------------------
// Release id (upstream release.ts)

/**
 * `process.env.POSTHOG_RELEASE_ID` (trimmed), else a non-empty string in
 * `globalThis._posthogReleaseId`.
 * @return {string|undefined}
 */
export function getInjectedReleaseId() {
  const proc = globalObj ? globalObj['process'] : undefined;
  if (typeof proc !== 'undefined') {
    const env = proc['env'];
    const raw = env['POSTHOG_RELEASE_ID'];
    const fromEnvironment = raw == null ? undefined : raw['trim']();
    if (fromEnvironment) return fromEnvironment;
  }
  const injected = globalObj ? globalObj['_posthogReleaseId'] : undefined;
  return typeof injected === 'string' && injected.length > 0 ? injected : undefined;
}

// ---------------------------------------------------------------------------
// Builder (upstream error-properties-builder.ts)

const MAX_EXCEPTIONS = 50;
const MAX_AGGREGATE_MEMBER_INSPECTIONS = 1000;
const MAX_ERROR_PROTOTYPE_DEPTH = 100;
const MAX_WRAPPER_RECURSION = 4;

/**
 * @param {!CoercingContext} ctx
 * @return {!ExceptionLike}
 */
function coerceFallback(ctx) {
  return {type: 'Error', value: 'Unknown error', stack: syntheticStack(ctx), synthetic: true};
}

/**
 * @param {*} input
 * @return {!Array<*>|undefined}
 */
function getAggregateErrors(input) {
  try {
    if (isError(input)) {
      let prototype = Object.getPrototypeOf(/** @type {!Object} */ (input));
      for (let depth = 0; prototype && depth < MAX_ERROR_PROTOTYPE_DEPTH; depth++) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
        const ctor = descriptor ? descriptor.value : undefined;
        if (typeof ctor === 'function' && ctor.name === 'AggregateError') {
          const errors = input['errors'];
          return Array.isArray(errors) ? errors : undefined;
        }
        prototype = Object.getPrototypeOf(prototype);
      }
    }
  } catch (e) {}
  return undefined;
}

/** Thrown internally to signal that a coercer skipped (already seen) input. */
const SKIPPED = {};

export class ErrorPropertiesBuilder {
  /**
   * @param {!Array<!Coercer>} coercers
   * @param {!StackParser} stackParser
   */
  constructor(coercers, stackParser) {
    /** @private @const */
    this.coercers_ = coercers;
    /** @const {!StackParser} */
    this.stackParser = stackParser;
  }

  /**
   * @param {*} input
   * @param {!EventHint=} hint
   * @return {!Object} `{$exception_list, $exception_level}`
   */
  buildFromUnknown(input, hint) {
    const h = hint || {};
    const mechanism = h.mechanism || {'handled': true, 'type': 'generic'};
    const coercingContext = this.buildCoercingContext(mechanism, h, 0);
    const exceptionWithCause = coercingContext.apply(input);
    const chunkIdMap = getFilenameToChunkIdMap(this.stackParser);
    const skipFirstLines = h.skipFirstLines == null ? 1 : h.skipFirstLines;
    const exceptionWithStack = this.parseStacktrace_(exceptionWithCause, skipFirstLines, chunkIdMap);
    return {
      '$exception_list': this.convertToExceptionList_(exceptionWithStack, mechanism),
      '$exception_level': 'error',
    };
  }

  /**
   * @param {!ExceptionLike} err
   * @param {number} skipFirstLines
   * @param {!Object<string, string>|undefined} chunkIdMap
   * @return {!ParsedException}
   * @private
   */
  parseStacktrace_(err, skipFirstLines, chunkIdMap) {
    const self = this;
    let cause = undefined;
    if (err.cause != null) cause = this.parseStacktrace_(err.cause, skipFirstLines, chunkIdMap);
    let frames = undefined;
    if (err.stack != '' && err.stack != null) {
      try {
        frames = this.stackParser(err.stack, err.synthetic ? skipFirstLines : 0).map(function(frame) {
          if (frame['filename'] && chunkIdMap) frame['chunk_id'] = chunkIdMap[/** @type {string} */ (frame['filename'])];
          return frame;
        });
      } catch (e) {}
    }
    return {
      type: err.type,
      value: err.value,
      synthetic: err.synthetic,
      cause: cause,
      frames: frames,
      errors: err.errors ? err.errors.map(function(child) {
        return self.parseStacktrace_(child, skipFirstLines, chunkIdMap);
      }) : undefined,
    };
  }

  /**
   * @param {*} input
   * @param {!CoercingContext} ctx
   * @return {!ExceptionLike|undefined}
   * @private
   */
  applyCoercers_(input, ctx) {
    for (let i = 0; i < this.coercers_.length; i++) {
      if (this.coercers_[i].match(input)) return this.coercers_[i].coerce(input, ctx);
    }
    return coerceFallback(ctx);
  }

  /**
   * @param {!ParsedException} root
   * @param {!Object} mechanism
   * @return {!Array<!Object>}
   * @private
   */
  convertToExceptionList_(root, mechanism) {
    /** @type {!Array<!Object>} */
    const exceptionList = [];
    /**
     * @param {!ParsedException} exception
     * @param {number=} parentId
     * @param {string=} source
     */
    const append = function(exception, parentId, source) {
      const exceptionId = exceptionList.length;
      let entryMechanism;
      if (parentId === undefined) {
        entryMechanism = {
          'type': typeof mechanism['type'] === 'string' && mechanism['type'].length > 0 ? mechanism['type'] : 'generic',
        };
        if (typeof mechanism['handled'] === 'boolean') {
          entryMechanism['handled'] = mechanism['handled'];
        } else if (mechanism['handled'] === undefined) {
          entryMechanism['handled'] = true;
        }
        entryMechanism['synthetic'] = typeof mechanism['synthetic'] === 'boolean' ? mechanism['synthetic'] :
            exception.synthetic;
        entryMechanism['exception_id'] = exceptionId;
      } else {
        entryMechanism = {
          'type': 'chained',
          'source': source,
          'synthetic': exception.synthetic,
          'exception_id': exceptionId,
          'parent_id': parentId,
        };
      }
      const current = {'type': exception.type, 'value': exception.value, 'mechanism': entryMechanism};
      if (exception.frames) current['stacktrace'] = {'type': 'raw', 'frames': exception.frames};
      exceptionList.push(current);
      if (exception.cause) append(exception.cause, exceptionId, 'cause');
      const errors = exception.errors || [];
      for (let i = 0; i < errors.length; i++) append(errors[i], exceptionId, 'member');
    };
    append(root);
    return exceptionList;
  }

  /**
   * @param {!Object} mechanism
   * @param {!EventHint} hint
   * @param {number=} startDepth
   * @return {!CoercingContext}
   */
  buildCoercingContext(mechanism, hint, startDepth) {
    const self = this;
    let count = 0;
    let memberInspections = 0;
    let hasAggregate = false;
    /** @type {!Array<*>} */
    const seen = [];
    /** @type {!Array<*>} */
    const wrappers = [];

    /**
     * @param {number} depth
     * @param {number=} wrapperDepth
     * @return {!CoercingContext}
     */
    const createContext = function(depth, wrapperDepth) {
      const wd = wrapperDepth || 0;
      const ctx = new CoercingContext();
      ctx.skipFirstLines = hint.skipFirstLines;
      ctx.syntheticException = depth == 0 ? hint.syntheticException : undefined;
      ctx.mechanism = depth == 0 ? mechanism : {};
      ctx.apply = function(input) {
        const exception = coerce(input, depth, wd + 1);
        if (!exception) throw SKIPPED;
        return exception;
      };
      ctx.next = function(input) {
        return coerce(input, depth + 1);
      };
      return ctx;
    };

    /**
     * @param {*} input
     * @param {number} depth
     * @param {number=} wrapperDepth
     * @return {!ExceptionLike|undefined}
     */
    const coerce = function(input, depth, wrapperDepth) {
      const wd = wrapperDepth || 0;
      const ctx = createContext(depth, wd);
      const forward = ctx.apply;
      ctx.apply = function(nextInput) {
        wrappers.push(input);
        try {
          return forward(nextInput);
        } finally {
          wrappers.pop();
        }
      };
      if (wd > MAX_WRAPPER_RECURSION || (wd > 0 && wrappers.indexOf(input) !== -1)) return coerceFallback(ctx);
      const isReference = (typeof input === 'object' && input !== null) || typeof input === 'function';
      if ((wd === 0 && count >= MAX_EXCEPTIONS) || (isReference && seen.indexOf(input) !== -1)) return undefined;
      if (isReference) seen.push(input);
      if (wd === 0) count++;
      const errors = getAggregateErrors(input);
      hasAggregate = hasAggregate || !!errors;
      let exception;
      try {
        exception = self.applyCoercers_(input, ctx);
        if (!exception) throw SKIPPED;
      } catch (error) {
        if (error === SKIPPED) {
          if (wd === 0) count--;
          return undefined;
        }
        if (!hasAggregate) throw error;
        exception = coerceFallback(ctx);
      }
      if (!errors || count >= MAX_EXCEPTIONS) return exception;
      let length;
      try {
        length = errors.length;
      } catch (e) {
        return exception;
      }
      if (typeof length !== 'number' || !isFinite(length) || Math.floor(length) !== length || length < 0 ||
          length > 0xffffffff) {
        return exception;
      }
      /** @type {!Array<!ExceptionLike>} */
      const children = [];
      for (let index = 0;
        count < MAX_EXCEPTIONS && memberInspections < MAX_AGGREGATE_MEMBER_INSPECTIONS && index < length;
        index++) {
        memberInspections++;
        let child;
        try {
          child = ctx.next(errors[index]);
        } catch (e) {
          count++;
          child = coerceFallback(createContext(depth + 1));
        }
        if (child) children.push(child);
      }
      return {
        type: exception.type,
        value: exception.value,
        stack: exception.stack,
        cause: exception.cause,
        synthetic: exception.synthetic,
        errors: children,
      };
    };

    const depth0 = startDepth || 0;
    const context = createContext(depth0);
    context.apply = function(input) {
      const result = coerce(input, depth0);
      return result || coerceFallback(context);
    };
    return context;
  }
}

/** @return {!ErrorPropertiesBuilder} the browser SDK's builder */
export function buildErrorPropertiesBuilder() {
  return new ErrorPropertiesBuilder(defaultCoercers(), createDefaultStackParser());
}

// ---------------------------------------------------------------------------
// Exception steps (upstream exception-steps.ts)

export const EXCEPTION_STEP_MESSAGE = '$message';
export const EXCEPTION_STEP_TIMESTAMP = '$timestamp';
const DEFAULT_MAX_BYTES = 32768;

/** @typedef {{enabled: boolean, max_bytes: number}} */
export let ResolvedExceptionStepsConfig;

/**
 * @param {*} input
 * @param {number} fallback
 * @return {number}
 */
function normalizePositiveInteger(input, fallback) {
  if (toStr.call(input) != '[object Number]' || input !== input || input === Infinity || input === -Infinity) {
    return fallback;
  }
  const normalized = Math.floor(/** @type {number} */ (input));
  return normalized < 0 ? fallback : normalized;
}

/**
 * @param {*} config user `error_tracking.exception_steps` (quoted keys)
 * @return {!ResolvedExceptionStepsConfig}
 */
export function resolveExceptionStepsConfig(config) {
  if (!config) return {enabled: true, max_bytes: DEFAULT_MAX_BYTES};
  const enabled = config['enabled'];
  return {
    enabled: enabled == null ? true : !!enabled,
    max_bytes: normalizePositiveInteger(config['max_bytes'], DEFAULT_MAX_BYTES),
  };
}

/**
 * @param {?Object|undefined} properties
 * @return {{sanitizedProperties: !Object, droppedKeys: !Array<string>}}
 */
export function stripReservedExceptionStepFields(properties) {
  if (!properties) return {sanitizedProperties: {}, droppedKeys: []};
  const droppedKeys = [];
  const sanitizedProperties = {};
  Object.keys(properties).forEach(function(key) {
    if (key === EXCEPTION_STEP_MESSAGE || key === EXCEPTION_STEP_TIMESTAMP) {
      droppedKeys.push(key);
    } else {
      sanitizedProperties[key] = properties[key];
    }
  });
  return {sanitizedProperties: sanitizedProperties, droppedKeys: droppedKeys};
}

/**
 * Upstream core safeJsonStringify: BigInt as string, functions/symbols
 * dropped, Errors as {name, message, stack}, true cycles as '[Circular]'.
 * @param {*} value
 * @return {string}
 */
export function safeJsonStringify(value) {
  const ancestors = [];
  return JSON.stringify(value, /** @this {*} */ function(_key, v) {
    if (typeof v === 'bigint') return String(v);
    if (typeof v === 'function' || typeof v === 'symbol') return undefined;
    if (v instanceof Error) return {'name': v.name, 'message': v.message, 'stack': v.stack};
    if (v && typeof v === 'object') {
      while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
      if (ancestors.indexOf(v) !== -1) return '[Circular]';
      ancestors.push(v);
    }
    return v;
  }) || 'null';
}

/**
 * @param {string} value
 * @return {number}
 */
export function getUtf8ByteLength(value) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).length;
  const encoded = encodeURIComponent(value);
  let byteLength = 0;
  for (let i = 0; i < encoded.length; i++) {
    byteLength += 1;
    if (encoded[i] === '%') i += 2;
  }
  return byteLength;
}

/**
 * @param {!Object} step
 * @return {?{step: !Object, json: string}}
 */
function normalizeAndSerializeStep(step) {
  let json;
  try {
    json = safeJsonStringify(step);
  } catch (e) {
    return null;
  }
  try {
    const parsed = JSON.parse(json);
    if (parsed !== Object(parsed) || Array.isArray(parsed)) return null;
    const message = parsed[EXCEPTION_STEP_MESSAGE];
    const timestamp = parsed[EXCEPTION_STEP_TIMESTAMP];
    if (!isString(message) || message.trim().length === 0) return null;
    if (!isString(timestamp) && !(toStr.call(timestamp) == '[object Number]' && timestamp === timestamp)) return null;
    return {step: parsed, json: json};
  } catch (e) {
    return null;
  }
}

/** Upstream ExceptionStepsBuffer: a byte-bounded FIFO of breadcrumbs. */
export class ExceptionStepsBuffer {
  /** @param {*=} config */
  constructor(config) {
    /** @private {!Array<{step: !Object, bytes: number}>} */
    this.entries_ = [];
    /** @private {number} */
    this.totalBytes_ = 0;
    /** @private {!ResolvedExceptionStepsConfig} */
    this.config_ = resolveExceptionStepsConfig(config);
  }

  /** @param {*=} config */
  setConfig(config) {
    this.config_ = resolveExceptionStepsConfig(config);
    this.trimToMaxBytes_();
  }

  /** @param {!Object} step */
  add(step) {
    const serialized = normalizeAndSerializeStep(step);
    if (!serialized) return;
    const bytes = getUtf8ByteLength(serialized.json);
    if (bytes > this.config_.max_bytes) return;
    this.entries_.push({step: serialized.step, bytes: bytes});
    this.totalBytes_ += bytes;
    this.trimToMaxBytes_();
  }

  /** @return {!Array<!Object>} */
  getAttachable() {
    return this.entries_.map(function(e) {
      return e.step;
    });
  }

  clear() {
    this.entries_ = [];
    this.totalBytes_ = 0;
  }

  /** @return {number} */
  size() {
    return this.entries_.length;
  }

  /** @private */
  trimToMaxBytes_() {
    while (this.totalBytes_ > this.config_.max_bytes && this.entries_.length > 0) {
      const evicted = this.entries_.shift();
      if (evicted) this.totalBytes_ -= evicted.bytes;
    }
  }
}
