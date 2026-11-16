/**
 * @fileoverview Per-event `cv: '2024-10'` compression helpers from upstream
 * lazy-loaded-session-recorder.ts (gzipToString, gzipToStringAsync,
 * gzipField[Async]) and posthog core gzip.ts (isGzipSupported,
 * gzipCompress with native output validation, isNativeAsyncGzipError).
 *
 * The async path uses the browser's CompressionStream exactly like upstream,
 * so it produces the same bytes. The sync path (used when draining on unload,
 * or after native gzip failed) uses the core encoder instead of fflate: the
 * output differs but decodes to the same data.
 */
import {crc32, gzipSync} from '../core/gzip.js';
import {isArray, win} from '../core/utils.js';

const NATIVE_GZIP_VALIDATION_ERROR = 'NativeGzipValidationError';

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

/** @return {boolean} posthog core isGzipSupported */
export function isGzipSupported() {
  const R = win ? win['Response'] : undefined;
  return !!win && 'CompressionStream' in win && 'TextEncoder' in win && 'Response' in win &&
      typeof R['prototype']['blob'] === 'function';
}

/**
 * @param {*} error
 * @return {boolean}
 */
export function isNativeAsyncGzipError(error) {
  if (!error || typeof error !== 'object') return false;
  const name = 'name' in error ? String(error['name']) : '';
  return name === 'NotReadableError' || name === NATIVE_GZIP_VALIDATION_ERROR;
}

/**
 * @param {string} reason
 * @return {!Error}
 */
function validationError(reason) {
  const e = new Error('Native gzip produced invalid output: ' + reason);
  e.name = NATIVE_GZIP_VALIDATION_ERROR;
  return e;
}

/**
 * Upstream validateNativeGzip(compressed, inputBytes), on the compressed bytes
 * read back once. Upstream reads the 10-byte header and the 8-byte trailer as
 * two blob slices, then (in gzipToStringAsync) the whole blob a third time;
 * one read of the whole blob gives the same bytes, so the same checks run in
 * the same order and fail with the same errors.
 * @param {?} compressed Blob
 * @param {!Uint8Array} inputBytes
 * @return {!Promise<!Uint8Array>} the compressed bytes
 */
function readValidatedNativeGzip(compressed, inputBytes) {
  if (compressed['size'] < 18) return Promise.reject(validationError('too-short'));
  return compressed['arrayBuffer']().then(function(buf) {
    const bytes = new Uint8Array(/** @type {!ArrayBuffer} */ (buf));
    // The header is bytes 0-9; size >= 18, so upstream's `length >= 2` check holds.
    if (!(bytes[0] === 0x1f && bytes[1] === 0x8b) || bytes[2] !== 0x08) throw validationError('invalid-header');
    const trailer = new DataView(/** @type {!ArrayBuffer} */ (buf), bytes.length - 8, 8);
    if (trailer.getUint32(0, true) !== crc32(inputBytes)) throw validationError('invalid-crc');
    if (trailer.getUint32(4, true) !== (inputBytes.length >>> 0)) throw validationError('invalid-size');
    return bytes;
  });
}

/**
 * posthog core gzipCompress(input, isDebug, {rethrow: true}), resolving with
 * the validated compressed bytes rather than the Blob they were read from.
 * @param {string} input
 * @return {!Promise<!Uint8Array>}
 */
function gzipCompress(input) {
  try {
    const TE = win['TextEncoder'];
    const inputBytes = /** @type {!Uint8Array} */ (new TE()['encode'](input));
    const CS = win['CompressionStream'];
    const stream = new CS('gzip');
    const writer = stream['writable']['getWriter']();
    const writePromise = writer['write'](inputBytes)['then'](function() {
      return writer['close']();
    })['catch'](function(err) {
      let aborted;
      try {
        aborted = Promise.resolve(writer['abort'](err));
      } catch (e) {
        aborted = Promise.resolve();
      }
      return aborted.then(function() {
        throw err;
      }, function() {
        throw err;
      });
    });
    // Still collected as a Blob like upstream: Safari 16's NotReadableError,
    // which turns native gzip off, is a blob read error.
    const R = win['Response'];
    const responsePromise = new R(stream['readable'])['blob']();
    return Promise.all([responsePromise, writePromise]).then(function(results) {
      return readValidatedNativeGzip(results[0], inputBytes);
    });
  } catch (e) {
    return Promise.reject(e);
  }
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

