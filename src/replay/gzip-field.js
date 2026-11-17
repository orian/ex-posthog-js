/**
 * @fileoverview Per-event `cv: '2024-10'` compression helpers from upstream
 * lazy-loaded-session-recorder.ts (gzipToString, gzipToStringAsync,
 * gzipField[Async]). Native gzip and its output validation (posthog core
 * gzip.ts) live in core/gzip.js, shared with the request path.
 *
 * The async path uses the browser's CompressionStream exactly like upstream,
 * so it produces the same bytes. The sync path (used when draining on unload,
 * or after native gzip failed) uses the core encoder instead of fflate: the
 * output differs but decodes to the same data.
 */
import {gzipCompress, gzipSync} from '../core/gzip.js';
import {isArray} from '../core/utils.js';

/**
 * fflate strFromU8(bytes, true): one char per byte.
 * @param {!Uint8Array} bytes
 * @return {string}
 */
export function latin1FromBytes(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 16384) {
    out += String.fromCharCode.apply(null, /** @type {?} */ (bytes.subarray(i, i + 16384)));
  }
  return out;
}

/**
 * Upstream serializeForCompression: plain stringify, falling back to the
 * circular-reference replacer (but never for RangeError).
 * @param {*} data
 * @param {function(): function(this:?, string, *): *} replacerFactory
 * @return {string}
 */
export function serializeForCompression(data, replacerFactory) {
  try {
    return JSON.stringify(data);
  } catch (e) {
    if (e instanceof RangeError) throw e;
    return JSON.stringify(data, replacerFactory());
  }
}

/** @type {string|undefined} */
let gzippedEmptyArray = undefined;
/** @type {?Promise<string>} */
let gzippedEmptyArrayPromise = null;

/**
 * @param {string} serialized
 * @return {string}
 */
export function gzipStringToString(serialized) {
  return latin1FromBytes(gzipSync(serialized));
}

/**
 * @param {*} data
 * @param {function(): function(this:?, string, *): *} replacer
 * @return {string}
 */
export function gzipToString(data, replacer) {
  return gzipStringToString(serializeForCompression(data, replacer));
}

/**
 * @param {*} data
 * @param {function(): function(this:?, string, *): *} replacer
 * @return {!Promise<string>}
 */
export function gzipToStringAsync(data, replacer) {
  let serialized;
  try {
    serialized = serializeForCompression(data, replacer);
  } catch (e) {
    return Promise.reject(e);
  }
  return gzipCompress(serialized).then(latin1FromBytes);
}

/**
 * @param {*} data
 * @param {function(): function(this:?, string, *): *} replacer
 * @return {string}
 */
export function gzipField(data, replacer) {
  if (isArray(data) && /** @type {!Array<*>} */ (data).length === 0) {
    if (gzippedEmptyArray === undefined) gzippedEmptyArray = gzipToString([], replacer);
    return gzippedEmptyArray;
  }
  return gzipToString(data, replacer);
}

/**
 * @param {*} data
 * @param {function(): function(this:?, string, *): *} replacer
 * @return {!Promise<string>}
 */
export function gzipFieldAsync(data, replacer) {
  if (isArray(data) && /** @type {!Array<*>} */ (data).length === 0) {
    if (gzippedEmptyArray !== undefined) return Promise.resolve(gzippedEmptyArray);
    if (!gzippedEmptyArrayPromise) {
      gzippedEmptyArrayPromise = gzipToStringAsync([], replacer).then(function(c) {
        gzippedEmptyArray = c;
        return c;
      }, function(error) {
        gzippedEmptyArray = undefined;
        gzippedEmptyArrayPromise = null;
        throw error;
      });
    }
    return gzippedEmptyArrayPromise;
  }
  return gzipToStringAsync(data, replacer);
}

