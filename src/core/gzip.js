/**
 * @fileoverview gzip for request bodies and replay fields.
 *
 * - Synchronous gzip (RFC 1952) with an LZ77 + fixed-Huffman deflate encoder.
 *   Stands in for upstream's fflate `gzipSync`, which upstream uses for
 *   beacons, `send_instantly` captures and when CompressionStream is
 *   unavailable or failed. The output is standard gzip (any inflater decodes
 *   it); the compression ratio is lower than fflate's dynamic-Huffman output.
 * - Native gzip: posthog core gzip.ts (isGzipSupported, gzipCompress with its
 *   output validation, isNativeAsyncGzipError / isNativeAsyncGzipReadError),
 *   used by the request path and by session replay.
 */
import {win} from './utils.js';

/**
 * CRC-32 lookup tables for slicing-by-8: table k (at k * 256) advances a byte
 * through k further zero bytes. Int32 entries keep the arithmetic in small
 * integers (a plain array of uint32 values holds doubles).
 * @type {?Int32Array}
 */
let crcTable = null;

/**
 * CRC-32 (IEEE, as in gzip), 8 bytes per step. Same value as the bytewise
 * table loop it replaces (test/gzip-crc.test.mjs checks it against zlib).
 * @param {!Uint8Array} bytes
 * @return {number}
 */
export function crc32(bytes) {
  let t = crcTable;
  if (!t) {
    t = crcTable = new Int32Array(256 * 8);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c;
    }
    for (let i = 0; i < 256; i++) {
      let c = t[i];
      for (let k = 1; k < 8; k++) {
        c = t[c & 0xff] ^ (c >>> 8);
        t[k * 256 + i] = c;
      }
    }
  }
  const b = bytes;
  const n = b.length;
  const end = n - (n & 7);
  let crc = -1;
  let i = 0;
  for (; i < end; i += 8) {
    const lo = crc ^ (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24));
    crc = t[1792 + (lo & 0xff)] ^ t[1536 + ((lo >>> 8) & 0xff)] ^ t[1280 + ((lo >>> 16) & 0xff)] ^
        t[1024 + (lo >>> 24)] ^ t[768 + b[i + 4]] ^ t[512 + b[i + 5]] ^ t[256 + b[i + 6]] ^ t[b[i + 7]];
  }
  for (; i < n; i++) crc = t[(crc ^ b[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/**
 * UTF-8 encoding for the sync gzip path. Uses TextEncoder when present; the
 * fallback loop produces exactly the same bytes (WHATWG UTF-8: surrogate
 * pairs become 4-byte sequences, a lone surrogate becomes U+FFFD, EF BF BD).
 *
 * Deliberate difference from upstream: upstream calls fflate's strToU8, whose
 * no-TextEncoder loop mis-encodes surrogates (`c & 1023 << 10` masks with
 * 1023 << 10, so it merges any surrogate with the next code unit, consuming
 * it even when it is a quote: U+1F600 becomes U+1DA00, a lone surrogate eats
 * the next character). We send correct UTF-8 instead; it is never longer.
 * It never throws, so the body is always gzipped.
 * @param {string} s
 * @return {!Uint8Array}
 */
export function strToU8(s) {
  const TE = win ? win['TextEncoder'] : undefined;
  if (TE) return /** @type {!Uint8Array} */ (new TE()['encode'](s));
  const l = s.length;
  let ar = new Uint8Array(l + (l >>> 1));
  let ai = 0;
  for (let i = 0; i < l; ++i) {
    if (ai + 5 > ar.length) {
      const n = new Uint8Array(ai + 8 + ((l - i) << 1));
      n.set(ar);
      ar = n;
    }
    let c = s.charCodeAt(i);
    if (c < 128) {
      ar[ai++] = c;
    } else if (c < 2048) {
      ar[ai++] = 192 | (c >>> 6);
      ar[ai++] = 128 | (c & 63);
    } else if (c >= 0xd800 && c <= 0xdfff) {
      const next = i + 1 < l ? s.charCodeAt(i + 1) : 0;
      if (c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        // Valid pair: one 4-byte sequence.
        c = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00);
        i++;
        ar[ai++] = 240 | (c >>> 18);
        ar[ai++] = 128 | ((c >>> 12) & 63);
        ar[ai++] = 128 | ((c >>> 6) & 63);
        ar[ai++] = 128 | (c & 63);
      } else {
        // Lone surrogate: U+FFFD, like TextEncoder; the next unit is kept.
        ar[ai++] = 0xef;
        ar[ai++] = 0xbf;
        ar[ai++] = 0xbd;
      }
    } else {
      ar[ai++] = 224 | (c >>> 12);
      ar[ai++] = 128 | ((c >>> 6) & 63);
      ar[ai++] = 128 | (c & 63);
    }
  }
  return ar.subarray(0, ai);
}

// Length codes 257..285: base lengths and extra bits.
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

class BitWriter {
  /** @param {number} capacity */
  constructor(capacity) {
    /** @type {!Uint8Array} */
    this.buf = new Uint8Array(capacity);
    /** @type {number} */
    this.pos = 0;
    /** @private {number} */
    this.bitBuf_ = 0;
    /** @private {number} */
    this.bitCount_ = 0;
  }

  /** @param {number} b */
  byte(b) {
    if (this.pos >= this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2 + 16);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.pos++] = b;
  }

  /**
   * Writes `n` bits of `value`, least significant bit first.
   * @param {number} value
   * @param {number} n
   */
  bits(value, n) {
    this.bitBuf_ |= value << this.bitCount_;
    this.bitCount_ += n;
    while (this.bitCount_ >= 8) {
      this.byte(this.bitBuf_ & 0xff);
      this.bitBuf_ >>>= 8;
      this.bitCount_ -= 8;
    }
  }

  /**
   * Writes a Huffman code (most significant bit first).
   * @param {number} code
   * @param {number} len
   */
  code(code, len) {
    let rev = 0;
    for (let i = 0; i < len; i++) {
      rev = (rev << 1) | ((code >>> i) & 1);
    }
    this.bits(rev, len);
  }

  flushBits() {
    if (this.bitCount_ > 0) this.byte(this.bitBuf_ & 0xff);
    this.bitBuf_ = 0;
    this.bitCount_ = 0;
  }
}

/**
 * @param {!BitWriter} w
 * @param {number} sym literal/length symbol 0..287
 */
function writeLitLen(w, sym) {
  if (sym < 144) w.code(0x30 + sym, 8);
  else if (sym < 256) w.code(0x190 + sym - 144, 9);
  else if (sym < 280) w.code(sym - 256, 7);
  else w.code(0xc0 + sym - 280, 8);
}

/**
 * @param {!BitWriter} w
 * @param {number} len 3..258
 * @param {number} dist 1..32768
 */
function writeMatch(w, len, dist) {
  let li = 28;
  while (LEN_BASE[li] > len) li--;
  writeLitLen(w, 257 + li);
  if (LEN_EXTRA[li]) w.bits(len - LEN_BASE[li], LEN_EXTRA[li]);
  let di = 29;
  while (DIST_BASE[di] > dist) di--;
  w.code(di, 5);
  if (DIST_EXTRA[di]) w.bits(dist - DIST_BASE[di], DIST_EXTRA[di]);
}

/**
 * Raw deflate of `data` as a single fixed-Huffman block.
 * @param {!Uint8Array} data
 * @param {!BitWriter} w
 */
function deflate(data, w) {
  const WINDOW = 32768;
  const HASH_SIZE = 1 << 15;
  const MAX_CHAIN = 32;
  const head = new Int32Array(HASH_SIZE);
  const prev = new Int32Array(WINDOW);
  for (let i = 0; i < HASH_SIZE; i++) head[i] = -1;
  const n = data.length;
  w.bits(1, 1); // BFINAL
  w.bits(1, 2); // BTYPE = fixed Huffman
  /**
   * @param {number} i
   * @return {number}
   */
  const hash = function(i) {
    return ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & (HASH_SIZE - 1);
  };
  /** @param {number} i */
  const insert = function(i) {
    if (i + 2 >= n) return;
    const h = hash(i);
    prev[i & (WINDOW - 1)] = head[h];
    head[h] = i;
  };
  let i = 0;
  while (i < n) {
    let bestLen = 0;
    let bestDist = 0;
    if (i + 2 < n) {
      let cand = head[hash(i)];
      let chain = MAX_CHAIN;
      const maxLen = Math.min(258, n - i);
      while (cand >= 0 && i - cand <= WINDOW && chain-- > 0) {
        if (data[cand + bestLen] === data[i + bestLen]) {
          let l = 0;
          while (l < maxLen && data[cand + l] === data[i + l]) l++;
          if (l > bestLen) {
            bestLen = l;
            bestDist = i - cand;
            if (l === maxLen) break;
          }
        }
        const p = prev[cand & (WINDOW - 1)];
        if (p >= cand) break;
        cand = p;
      }
    }
    if (bestLen >= 3) {
      writeMatch(w, bestLen, bestDist);
      for (let k = 0; k < bestLen; k++) insert(i + k);
      i += bestLen;
    } else {
      writeLitLen(w, data[i]);
      insert(i);
      i++;
    }
  }
  writeLitLen(w, 256);
  w.flushBits();
}

/**
 * gzip-compresses a string, UTF-8 encoded like upstream's
 * `gzipSync(strToU8(s), {mtime: 0})`.
 * @param {string} s
 * @return {!Uint8Array}
 */
export function gzipSync(s) {
  const data = strToU8(s);
  const w = new BitWriter(Math.max(64, (data.length >>> 1) + 32));
  [0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3].forEach(function(b) {
    w.byte(b);
  });
  deflate(data, w);
  const crc = crc32(data);
  const size = data.length >>> 0;
  for (let k = 0; k < 4; k++) w.byte((crc >>> (8 * k)) & 0xff);
  for (let k = 0; k < 4; k++) w.byte((size >>> (8 * k)) & 0xff);
  return w.buf.subarray(0, w.pos);
}

// ---- native gzip (CompressionStream), posthog core gzip.ts -----------------------------

/** @const {string} */
const NATIVE_GZIP_VALIDATION_ERROR = 'NativeGzipValidationError';

/** @return {boolean} posthog core isGzipSupported */
export function isGzipSupported() {
  const R = win ? win['Response'] : undefined;
  return !!win && 'CompressionStream' in win && 'TextEncoder' in win && 'Response' in win &&
      typeof R['prototype']['blob'] === 'function';
}

/**
 * @param {*} error
 * @return {string} the error's name, '' when it is not an object
 */
function errorName(error) {
  if (!error || typeof error !== 'object') return '';
  return 'name' in error ? String(error['name']) : '';
}

/**
 * posthog core isNativeAsyncGzipReadError: Safari 16's NotReadableError.
 * @param {*} error
 * @return {boolean}
 */
export function isNativeAsyncGzipReadError(error) {
  return errorName(error) === 'NotReadableError';
}

/**
 * posthog core isNativeAsyncGzipError: a read error or invalid output.
 * @param {*} error
 * @return {boolean}
 */
export function isNativeAsyncGzipError(error) {
  const name = errorName(error);
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
 * two blob slices, then (in its callers) the whole blob a third time; one read
 * of the whole blob gives the same bytes, so the same checks run in the same
 * order and fail with the same errors.
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
 * the validated compressed bytes (a view over the whole ArrayBuffer read from
 * the Blob) rather than the Blob they were read from.
 * @param {string} input
 * @return {!Promise<!Uint8Array>}
 */
export function gzipCompress(input) {
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
