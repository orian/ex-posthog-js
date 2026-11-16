/**
 * @fileoverview Stack trace parsing, a port of upstream
 * core/src/error-tracking/parsers/{index,base,chrome,gecko,safari}.ts
 * (itself derived from getsentry/sentry-javascript, MIT, and TraceKit).
 *
 * Frames cross the SDK boundary (they are sent in `$exception_list`), so they
 * use quoted keys: `platform`, `filename`, `function`, `in_app`, `lineno`,
 * `colno`, `chunk_id`.
 */

/** @typedef {!Object<string, *>} */
export let StackFrame;

/** @typedef {function(string, number=): !Array<!StackFrame>} */
export let StackParser;

/** @typedef {function(string, string): (!StackFrame|undefined)} */
let StackLineParser;

export const UNKNOWN_FUNCTION = '?';

const ANONYMOUS_FILENAME = '<anonymous>';
const URL_SCHEME = /^([a-z][a-z0-9.+-]+):/i;
const APP_URL_SCHEMES = [
  'http', 'https', 'file', 'blob', 'app', 'capacitor', 'ionic', 'webpack', 'webpack-internal', 'ng',
];

/**
 * Is this filename a script the app itself loaded (upstream isAppFilename)?
 * @param {string} filename
 * @return {boolean}
 */
function isAppFilename(filename) {
  if (!filename || filename === ANONYMOUS_FILENAME) return false;
  const scheme = URL_SCHEME.exec(filename);
  return !scheme || APP_URL_SCHEMES.indexOf(scheme[1].toLowerCase()) !== -1;
}

/**
 * @param {string} platform
 * @param {string} filename
 * @param {string} func
 * @param {number=} lineno
 * @param {number=} colno
 * @return {!StackFrame}
 */
export function createFrame(platform, filename, func, lineno, colno) {
  /** @type {!StackFrame} */
  const frame = {
    'platform': platform,
    'filename': filename,
    'function': func === '<anonymous>' ? UNKNOWN_FUNCTION : func,
    'in_app': isAppFilename(filename),
  };
  if (lineno !== undefined) frame['lineno'] = lineno;
  if (colno !== undefined) frame['colno'] = colno;
  return frame;
}

/**
 * Safari web extensions can produce frames-only stack traces (upstream
 * extractSafariExtensionDetails).
 * @param {string} func
 * @param {string} filename
 * @return {!Array<string>} [func, filename]
 */
export function extractSafariExtensionDetails(func, filename) {
  const isSafariExtension = func.indexOf('safari-extension') !== -1;
  const isSafariWebExtension = func.indexOf('safari-web-extension') !== -1;
  return isSafariExtension || isSafariWebExtension ? [
    func.indexOf('@') !== -1 ? func.split('@')[0] : UNKNOWN_FUNCTION,
    isSafariExtension ? 'safari-extension:' + filename : 'safari-web-extension:' + filename,
  ] : [func, filename];
}

const chromeRegexNoFnName = /^\s*at (\S+?)(?::(\d+))(?::(\d+))\s*$/i;
const chromeRegex =
    /^\s*at (?:(.+?\)(?: \[.+\])?|.*?) ?\((?:address at )?)?(?:async )?((?:<anonymous>|[-a-z]+:|.*bundle|\/)?.*?)(?::(\d+))?(?::(\d+))?\)?\s*$/i;
const chromeEvalRegex = /\((\S*)(?::(\d+))(?::(\d+))\)/;

/** @type {!StackLineParser} */
export const chromeStackLineParser = function(line, platform) {
  const noFnParts = chromeRegexNoFnName.exec(line);
  if (noFnParts) {
    return createFrame(platform, noFnParts[1], UNKNOWN_FUNCTION, +noFnParts[2], +noFnParts[3]);
  }
  const parts = chromeRegex.exec(line);
  if (parts) {
    const isEval = parts[2] && parts[2].indexOf('eval') === 0;
    if (isEval) {
      const subMatch = chromeEvalRegex.exec(parts[2]);
      if (subMatch) {
        parts[2] = subMatch[1];
        parts[3] = subMatch[2];
        parts[4] = subMatch[3];
      }
    }
    const details = extractSafariExtensionDetails(parts[1] || UNKNOWN_FUNCTION, parts[2]);
    return createFrame(platform, details[1], details[0], parts[3] ? +parts[3] : undefined,
        parts[4] ? +parts[4] : undefined);
  }
  return undefined;
};

const geckoREgex =
    /^\s*(.*?)(?:\((.*?)\))?(?:^|@)?((?:[-a-z]+)?:\/.*?|\[native code\]|[^@]*(?:bundle|\d+\.js)|\/[\w\-. /=]+)(?::(\d+))?(?::(\d+))?\s*$/i;
const geckoEvalRegex = /(\S+) line (\d+)(?: > eval line \d+)* > eval/i;

/** @type {!StackLineParser} */
export const geckoStackLineParser = function(line, platform) {
  const parts = geckoREgex.exec(line);
  if (parts) {
    const isEval = parts[3] && parts[3].indexOf(' > eval') > -1;
    if (isEval) {
      const subMatch = geckoEvalRegex.exec(parts[3]);
      if (subMatch) {
        parts[1] = parts[1] || 'eval';
        parts[3] = subMatch[1];
        parts[4] = subMatch[2];
        parts[5] = '';
      }
    }
    const details = extractSafariExtensionDetails(parts[1] || UNKNOWN_FUNCTION, parts[3]);
    return createFrame(platform, details[1], details[0], parts[4] ? +parts[4] : undefined,
        parts[5] ? +parts[5] : undefined);
  }
  return undefined;
};

const WEBPACK_ERROR_REGEXP = /\(error: (.*)\)/;
const STACKTRACE_FRAME_LIMIT = 50;
const MAX_REPEATED_CYCLE_LENGTH = 10;
const STACKTRACE_LINE_LIMIT = 1000;

/** @typedef {{start: number, length: number}} */
let RepeatedCycle;

/**
 * @param {!StackFrame} a
 * @param {!StackFrame} b
 * @return {boolean}
 */
function isSameFrame(a, b) {
  return a['filename'] === b['filename'] && a['function'] === b['function'] && a['module'] === b['module'] &&
      a['lineno'] === b['lineno'] && a['colno'] === b['colno'];
}

/**
 * Removes the cycle ending at the last frame when the frames before it are the
 * same cycle; reports where the kept copy sits.
 * @param {!Array<!StackFrame>} frames
 * @return {?RepeatedCycle}
 */
function collapseRepeatedCycle(frames) {
  for (let length = 1; length <= MAX_REPEATED_CYCLE_LENGTH; length++) {
    const start = frames.length - 2 * length;
    if (start < 0) return null;
    let isCycle = true;
    for (let offset = 0; offset < length; offset++) {
      if (!isSameFrame(frames[start + offset], frames[start + length + offset])) {
        isCycle = false;
        break;
      }
    }
    if (isCycle) {
      for (let offset = 0; offset < length; offset++) {
        frames[start + offset] = frames[start + length + offset];
      }
      frames.length = start + length;
      return {start: start, length: length};
    }
  }
  return null;
}

/**
 * @param {!Array<!StackFrame>} frames
 * @param {!RepeatedCycle} cycle
 */
function trimPartialCycle(frames, cycle) {
  const copyEnd = cycle.start + cycle.length;
  const partialLength = partialCycleLength(frames, cycle);
  if (partialLength) {
    frames.splice(copyEnd + partialLength === frames.length ? copyEnd : cycle.start, partialLength);
  }
}

/**
 * @param {!Array<!StackFrame>} frames
 * @param {!RepeatedCycle} cycle
 * @return {number}
 */
function innermostPartialCycleLength(frames, cycle) {
  let partialStart = cycle.start;
  while (partialStart > 0 && isSameFrame(frames[partialStart - 1], frames[partialStart - 1 + cycle.length])) {
    partialStart--;
  }
  return cycle.start - partialStart;
}

/**
 * @param {!Array<!StackFrame>} frames
 * @param {!RepeatedCycle} cycle
 * @return {number}
 */
function partialCycleLength(frames, cycle) {
  const copyEnd = cycle.start + cycle.length;
  let partialEnd = copyEnd;
  while (partialEnd < frames.length && isSameFrame(frames[partialEnd], frames[partialEnd - cycle.length])) {
    partialEnd++;
  }
  return partialEnd - copyEnd;
}

/**
 * @param {!Array<!StackFrame>} frames
 * @param {!Array<!RepeatedCycle>} cycles
 * @return {number}
 */
function survivingFrameCount(frames, cycles) {
  const innermostCycle = cycles[0];
  let count = frames.length - (innermostCycle ? innermostPartialCycleLength(frames, innermostCycle) : 0);
  for (let i = 0; i < cycles.length; i++) count -= partialCycleLength(frames, cycles[i]);
  return count;
}

/**
 * @param {!Array<!StackFrame>} frames
 */
function canonicalizeCycleRotation(frames) {
  const keys = frames.map(function(f) {
    return f['function'] + '|' + f['filename'] + '|' + f['lineno'] + '|' + f['colno'] + '|' + f['module'];
  });
  let first = 0;
  for (let i = 1; i < keys.length; i++) {
    if (isSmallerRotation(keys, i, first)) first = i;
  }
  const head = frames.splice(0, first);
  for (let i = 0; i < head.length; i++) frames.push(head[i]);
}

/**
 * @param {!Array<string>} keys
 * @param {number} candidate
 * @param {number} best
 * @return {boolean}
 */
function isSmallerRotation(keys, candidate, best) {
  for (let offset = 0; offset < keys.length; offset++) {
    const left = keys[(candidate + offset) % keys.length];
    const right = keys[(best + offset) % keys.length];
    if (left !== right) return left < right;
  }
  return false;
}

/**
 * @param {!Array<!StackFrame>} stack
 * @return {!Array<!StackFrame>}
 */
export function reverseAndStripFrames(stack) {
  if (!stack.length) return [];
  const localStack = stack.slice();
  localStack.reverse();
  const last = localStack[localStack.length - 1] || {};
  return localStack.slice(0, STACKTRACE_FRAME_LIMIT).map(function(frame) {
    const out = {};
    for (const k in frame) {
      if (Object.prototype.hasOwnProperty.call(frame, k)) out[k] = frame[k];
    }
    out['filename'] = frame['filename'] || last['filename'];
    out['function'] = frame['function'] || UNKNOWN_FUNCTION;
    return out;
  });
}

/**
 * @param {string} platform
 * @param {...!StackLineParser} parsers
 * @return {!StackParser}
 */
export function createStackParser(platform, ...parsers) {
  /** @type {!StackParser} */
  const parse = function(stack, skipFirstLines) {
    const skip = skipFirstLines || 0;
    /** @type {!Array<!StackFrame>} */
    const frames = [];
    const lines = stack.split('\n');
    const endLine = Math.min(lines.length, skip + STACKTRACE_LINE_LIMIT);
    /** @type {!Array<!RepeatedCycle>} */
    const repeatedCycles = [];

    for (let i = skip; i < endLine; i++) {
      const line = lines[i];
      if (line.length > 1024) continue;
      const cleanedLine = WEBPACK_ERROR_REGEXP.test(line) ? line.replace(WEBPACK_ERROR_REGEXP, '$1') : line;
      if (cleanedLine.match(/\S*Error: /)) continue;

      for (let p = 0; p < parsers.length; p++) {
        const frame = parsers[p](cleanedLine, platform);
        if (frame) {
          frames.push(frame);
          const cycle = collapseRepeatedCycle(frames);
          if (cycle) {
            for (let j = repeatedCycles.length - 1; j >= 0; j--) {
              const previous = repeatedCycles[j];
              if (previous.start + previous.length <= cycle.start) break;
              repeatedCycles.pop();
            }
            repeatedCycles.push(cycle);
          }
          break;
        }
      }

      if (survivingFrameCount(frames, repeatedCycles) >= STACKTRACE_FRAME_LIMIT) break;
    }

    const sections = repeatedCycles.slice().sort(function(a, b) {
      return b.start - a.start;
    });
    const innermostSection = sections[sections.length - 1];
    if (innermostSection) {
      const trimmed = innermostPartialCycleLength(frames, innermostSection);
      frames.splice(innermostSection.start - trimmed, trimmed);
      for (let i = 0; i < sections.length; i++) sections[i].start -= trimmed;
    }
    for (let i = 0; i < sections.length; i++) trimPartialCycle(frames, sections[i]);

    if (repeatedCycles.some(function(cycle) {
      return cycle.start === 0 && frames.length === cycle.length;
    })) {
      canonicalizeCycleRotation(frames);
    }
    return reverseAndStripFrames(frames);
  };
  return parse;
}

/** @return {!StackParser} */
export function createDefaultStackParser() {
  return createStackParser('web:javascript', chromeStackLineParser, geckoStackLineParser);
}
