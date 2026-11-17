/**
 * @fileoverview gzip for request bodies and replay fields.
 *
 * - Synchronous gzip (RFC 1952): our own deflate encoder (lazy LZ77 matching,
 *   dynamic or fixed Huffman or stored blocks, whichever is smallest). Stands
 *   in for upstream's fflate `gzipSync`, which upstream uses for beacons,
 *   `send_instantly` captures and when CompressionStream is unavailable or
 *   failed. The bytes differ from fflate's (any inflater decodes them); the
 *   output is a little smaller.
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

/** The TextEncoder strToU8 reuses, and the constructor it came from. */
let encoder = null;
/** @type {*} */
let encoderClass = null;

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
  if (TE) {
    if (TE !== encoderClass) {
      encoderClass = TE;
      encoder = new TE();
    }
    return /** @type {!Uint8Array} */ (encoder['encode'](s));
  }
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

// ---- deflate (RFC 1951) ----------------------------------------------------------------
//
// LZ77 with hash chains and lazy matching, then per block the smallest of a dynamic
// Huffman, fixed Huffman or stored encoding, computed exactly.

/** Order in which the code length code lengths are sent. */
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** Shell sort gaps (Ciura) for sorting up to 288 symbols. */
const SHELL_GAPS = [132, 57, 23, 10, 4, 1];

/** Symbols (literals and matches) per block. */
const BLOCK_SYMBOLS = 8192;
// Match finder, tuned on test/bench/gzip.mjs: zlib level 6's good_length, a lazy match
// search at every position (zlib's max_lazy at its maximum) and a shorter chain.
const GOOD_LENGTH = 8;
const MAX_CHAIN = 64;
/** Farthest match distance (zlib's MAX_DIST: the window minus the lookahead). */
const MAX_DIST = 32768 - 262;

/**
 * @typedef {{lenBase: !Uint16Array, lenExtra: !Uint8Array, distBase: !Uint16Array,
 *     distExtra: !Uint8Array, lenCode: !Uint8Array, distCode: !Uint8Array,
 *     fixedLitLen: !Uint8Array, fixedLitCodes: !Uint16Array, fixedDistLen: !Uint8Array,
 *     fixedDistCodes: !Uint16Array}}
 */
let DeflateTables;

/** @type {?DeflateTables} */
let tables = null;

/**
 * Tables built on first use: base value and extra bits of the length codes 257..285
 * and the distance codes; length - 3 -> length code index (0..28); distance - 1 ->
 * distance code (zlib's d_code: 0..255 directly, then 256 + (d >> 7)); the fixed
 * Huffman code lengths and codes.
 * @return {!DeflateTables}
 */
function getTables() {
  if (tables) return tables;
  const lenBase = new Uint16Array(29);
  const lenExtra = new Uint8Array(29);
  const lenCode = new Uint8Array(256);
  for (let c = 0, base = 3; c < 29; c++) {
    lenExtra[c] = c < 8 || c === 28 ? 0 : (c >> 2) - 1;
    lenBase[c] = c === 28 ? 258 : base;
    base += 1 << lenExtra[c];
    for (let l = lenBase[c]; l < base && l <= 258; l++) lenCode[l - 3] = c;
  }
  const distBase = new Uint16Array(30);
  const distExtra = new Uint8Array(30);
  const distCode = new Uint8Array(512);
  for (let c = 0, base = 1; c < 30; c++) {
    distExtra[c] = c < 4 ? 0 : (c >> 1) - 1;
    distBase[c] = base;
    base += 1 << distExtra[c];
    for (let d = distBase[c] - 1; d < base - 1; d++) distCode[d < 256 ? d : 256 + (d >>> 7)] = c;
  }
  const fixedLitLen = new Uint8Array(288);
  for (let i = 0; i < 288; i++) fixedLitLen[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
  const fixedDistLen = new Uint8Array(30);
  for (let i = 0; i < 30; i++) fixedDistLen[i] = 5;
  return tables = {
    lenBase: lenBase,
    lenExtra: lenExtra,
    distBase: distBase,
    distExtra: distExtra,
    lenCode: lenCode,
    distCode: distCode,
    fixedLitLen: fixedLitLen,
    fixedLitCodes: huffmanCodes(fixedLitLen),
    fixedDistLen: fixedDistLen,
    fixedDistCodes: huffmanCodes(fixedDistLen),
  };
}

/**
 * Huffman code lengths for the symbol frequencies `freq`, at most `maxBits` long
 * (lengths over the limit are fixed like miniz's tdefl_huffman_enforce_max_code_size).
 * With fewer than two used symbols, two codes of length 1 are returned (zlib does
 * the same: a single code still takes a bit, and the code length code must be
 * complete).
 * @param {!Int32Array} freq
 * @param {number} maxBits
 * @param {!Int32Array} scratch at least 288 entries
 * @return {!Uint8Array}
 */
function huffmanLengths(freq, maxBits, scratch) {
  const n = freq.length;
  const lengths = new Uint8Array(n);
  // Used symbols sorted by (frequency, symbol), as frequency << 9 | symbol (frequencies
  // stay below 2^22: a block has 8192 symbols). Shell sort (Ciura's gaps): at most 286
  // keys, no comparator calls, no allocation.
  const syms = scratch;
  let m = 0;
  for (let i = 0; i < n; i++) {
    if (freq[i]) syms[m++] = freq[i] << 9 | i;
  }
  for (let g = 0; g < 6; g++) {
    const gap = SHELL_GAPS[g];
    for (let i = gap; i < m; i++) {
      const key = syms[i];
      let j = i;
      for (; j >= gap && syms[j - gap] > key; j -= gap) syms[j] = syms[j - gap];
      syms[j] = key;
    }
  }
  if (m < 2) {
    const only = m ? syms[0] & 511 : 0;
    lengths[m ? only : 1] = 1;
    lengths[m && !only ? 1 : 0] = 1;
    return lengths;
  }
  for (let i = 0; i < m; i++) syms[i] &= 511;
  // Two-queue Huffman construction: leaves 0..m-1 (ascending weight), internal nodes
  // m..2m-2 (created in ascending weight order).
  const weight = new Int32Array(2 * m);
  const parent = new Int32Array(2 * m);
  for (let i = 0; i < m; i++) weight[i] = freq[syms[i]];
  let leaf = 0;
  let node = m;
  for (let k = m; k < 2 * m - 1; k++) {
    for (let t = 0; t < 2; t++) {
      const x = leaf < m && (node >= k || weight[leaf] <= weight[node]) ? leaf++ : node++;
      weight[k] += weight[x];
      parent[x] = k;
    }
  }
  // Depths, root first (a parent comes after its children); reuses `weight`.
  const depth = weight;
  depth[2 * m - 2] = 0;
  for (let k = 2 * m - 3; k >= 0; k--) depth[k] = depth[parent[k]] + 1;
  const count = new Int32Array(maxBits + 1);
  for (let i = 0; i < m; i++) count[depth[i] < maxBits ? depth[i] : maxBits]++;
  // Clamping made the code over-full (Kraft sum above 1); move leaves down until it fits.
  let kraft = 0;
  for (let b = 1; b <= maxBits; b++) kraft += count[b] << (maxBits - b);
  for (; kraft > 1 << maxBits; kraft--) {
    count[maxBits]--;
    for (let b = maxBits - 1; b > 0; b--) {
      if (count[b]) {
        count[b]--;
        count[b + 1] += 2;
        break;
      }
    }
  }
  // The least frequent symbols get the longest codes.
  let s = 0;
  for (let b = maxBits; b > 0; b--) {
    for (let c = count[b]; c > 0; c--) lengths[syms[s++]] = b;
  }
  return lengths;
}

/**
 * Canonical Huffman codes for `lengths`, bit-reversed (deflate sends codes most
 * significant bit first into an LSB-first stream).
 * @param {!Uint8Array} lengths
 * @return {!Uint16Array}
 */
function huffmanCodes(lengths) {
  const n = lengths.length;
  const count = new Uint16Array(16);
  const next = new Uint16Array(16);
  const codes = new Uint16Array(n);
  for (let i = 0; i < n; i++) count[lengths[i]]++;
  count[0] = 0;
  for (let b = 1, code = 0; b < 16; b++) next[b] = code = (code + count[b - 1]) << 1;
  for (let i = 0; i < n; i++) {
    const len = lengths[i];
    if (!len) continue;
    let c = next[len]++;
    let r = 0;
    for (let k = 0; k < len; k++) {
      r = (r << 1) | (c & 1);
      c >>>= 1;
    }
    codes[i] = r;
  }
  return codes;
}

// ---- encoder state, reused between calls ----------------------------------------------
//
// Allocating and zeroing the match finder's tables and the symbol buffer cost more than
// compressing a short replay field. They are kept between calls instead:
// - head/prev hold positions as `base + i + 1`; every call moves `base` past the values
//   the previous one stored, so older entries read as "no position" (<= base) and the
//   tables never need clearing (they are reallocated when `base` nears 2^31);
// - the output buffer is written through a bit accumulator, so it needs no zeroing
//   either; the result is copied out of it.
// The calls are synchronous and run no outside code, so they cannot interleave; a call
// that throws midway leaves nothing a later call reads (it reserved its range of `base`
// first). Memory: up to 2 x 128 KB of hash tables (32 KB window), 32 KB of symbols and a
// 64 KB output buffer. Tables above 16 KB each (inputs over 4 KB) and the output buffer
// are dropped by the next call that does not need them once none has for RELEASE_MS:
// they only grow on large inputs (unload beacons, replay batches), which come rarely.

/** Hash table sizes (log2) kept indefinitely: 4096 entries, 16 KB each. */
const SMALL_HASH_BITS = 12;
/** Largest output buffer kept between calls. */
const KEEP_OUT_BYTES = 65536;
/** Idle time after which large buffers are dropped (checked by the next call). */
const RELEASE_MS = 10000;

/**
 * @typedef {{head: !Int32Array, prev: !Int32Array, bits: number, base: number,
 *     syms: !Int32Array, litFreq: !Int32Array, distFreq: !Int32Array, sort: !Int32Array,
 *     out: ?Uint8Array, lastLarge: number}}
 */
let EncoderState;

/** @type {?EncoderState} */
let state = null;

/**
 * Tests only (unused in the builds, so compiled out): the reused state, or null.
 * @return {?EncoderState}
 */
export function encoderStateForTest() {
  return state;
}

/**
 * The reused encoder state, with hash tables of at least 2^bits entries and room in
 * `base` for `n` more positions.
 * @param {number} bits
 * @param {number} n
 * @return {!EncoderState}
 */
function getState(bits, n) {
  let st = state;
  if (!st) {
    st = state = {
      head: new Int32Array(1 << SMALL_HASH_BITS),
      prev: new Int32Array(1 << SMALL_HASH_BITS),
      bits: SMALL_HASH_BITS,
      base: 0,
      syms: new Int32Array(BLOCK_SYMBOLS),
      litFreq: new Int32Array(286),
      distFreq: new Int32Array(30),
      sort: new Int32Array(288),
      out: null,
      lastLarge: 0,
    };
  }
  const now = Date.now();
  if (bits > SMALL_HASH_BITS || n > KEEP_OUT_BYTES / 2) {
    st.lastLarge = now;
  } else if (now - st.lastLarge > RELEASE_MS) {
    if (st.bits > SMALL_HASH_BITS) {
      st.head = new Int32Array(1 << SMALL_HASH_BITS);
      st.prev = new Int32Array(1 << SMALL_HASH_BITS);
      st.bits = SMALL_HASH_BITS;
      st.base = 0;
    }
    if (st.out && st.out.length > 4096) st.out = null;
  }
  if (bits > st.bits || st.base + n + 1 > 0x3fffffff) {
    if (bits > st.bits) st.bits = bits;
    st.head = new Int32Array(1 << st.bits);
    st.prev = new Int32Array(1 << st.bits);
    st.base = 0;
  }
  return st;
}

/**
 * The part of the hash tables an input uses: it grows with the input up to the 32 KB
 * window.
 * @param {number} n input length
 * @return {number} log2 of the table size, 9..15
 */
function hashBitsFor(n) {
  let bits = 9;
  while (bits < 15 && 1 << bits < n) bits++;
  return bits;
}

/**
 * Raw deflate of `data` into `out` from byte `o`.
 * @param {!Uint8Array} data
 * @param {!Uint8Array} out at least data.length + 6 * ((data.length >>> 12) + 2) + 3
 *     bytes past `o`: no block is larger than storing it
 * @param {number} o
 * @param {!EncoderState} st from getState(hashBitsFor(data.length), data.length)
 * @return {number} the byte position after the final block
 */
function deflate(data, out, o, st) {
  const t = getTables();
  const lenCode = t.lenCode;
  const distCode = t.distCode;
  const lenBase = t.lenBase;
  const lenExtra = t.lenExtra;
  const distBase = t.distBase;
  const distExtra = t.distExtra;
  const n = data.length;
  // Multiplicative hash of the next 4 bytes (3 for inputs up to 8 KB, where 3-byte
  // matches pay off; 4 keeps the chains short in replay's cv '2024-10' strings, gzip
  // bytes as latin1 whose UTF-8 is mostly 0xC2/0xC3 every other byte).
  const hashBits = hashBitsFor(n);
  const hashShift = 32 - hashBits;
  const fourth = n > 8192 ? 255 : 0;
  const windowMask = (1 << hashBits) - 1; // the whole input, or the 32 KB window
  // Positions as base + i + 1 (<= base: none, from an earlier call). prev links each
  // position to the previous one with its hash.
  const head = st.head;
  const prev = st.prev;
  const base = st.base;
  st.base = base + n;
  const unset = ~base; // -base - 1, as an int: head/prev value + unset = position (negative: none)
  const syms = st.syms;
  const litFreq = st.litFreq;
  const distFreq = st.distFreq;
  for (let i = 0; i < 286; i++) litFreq[i] = 0;
  for (let i = 0; i < 30; i++) distFreq[i] = 0;
  let nsyms = 0;
  let blockStart = 0;
  let emitted = 0;
  // Bit accumulator: `bc` pending bits (fewer than 8 between writes) in `bb`, LSB first.
  let bb = 0;
  let bc = 0;

  /**
   * Writes the `bits` low bits of `v` (at most 16), LSB first.
   * @param {number} v
   * @param {number} bits
   */
  const put = function(v, bits) {
    bb |= v << bc;
    bc += bits;
    while (bc >= 8) {
      out[o++] = bb;
      bb >>>= 8;
      bc -= 8;
    }
  };

  /** @param {number} i */
  const insert = function(i) {
    const h = (((data[i] | data[i + 1] << 8 | data[i + 2] << 16 | (data[i + 3] & fourth) << 24) >>> 0) * 40503) >>>
        hashShift;
    prev[i & windowMask] = head[h];
    head[h] = base + i + 1;
  };

  /**
   * Ends the block of symbols covering data[blockStart, emitted).
   * @param {number} last 1 for the final block
   */
  const flush = function(last) {
    litFreq[256] = 1;
    const litLen = huffmanLengths(litFreq, 15, st.sort);
    const distLen = huffmanLengths(distFreq, 15, st.sort);
    let hlit = 286;
    while (hlit > 257 && !litLen[hlit - 1]) hlit--;
    let hdist = 30;
    while (hdist > 1 && !distLen[hdist - 1]) hdist--;
    // Code lengths, run-length encoded (16: repeat the previous 3-6 times; 17, 18:
    // 3-10 and 11-138 zeros), as symbol | repeat count << 5.
    const lens = new Uint8Array(hlit + hdist);
    lens.set(litLen.subarray(0, hlit));
    lens.set(distLen.subarray(0, hdist), hlit);
    /** @type {!Array<number>} */
    const rle = [];
    const clFreq = new Int32Array(19);
    for (let i = 0; i < lens.length;) {
      const len = lens[i];
      let run = 1;
      while (i + run < lens.length && lens[i + run] === len) run++;
      i += run;
      if (!len) {
        for (; run >= 11; run -= 138) {
          rle.push(18 | ((run < 138 ? run : 138) - 11) << 5);
          clFreq[18]++;
        }
        if (run >= 3) {
          rle.push(17 | (run - 3) << 5);
          clFreq[17]++;
          run = 0;
        }
      } else {
        rle.push(len);
        clFreq[len]++;
        for (run--; run >= 3; run -= 6) {
          rle.push(16 | ((run < 6 ? run : 6) - 3) << 5);
          clFreq[16]++;
        }
      }
      for (; run > 0; run--) {
        rle.push(len);
        clFreq[len]++;
      }
    }
    const clLen = huffmanLengths(clFreq, 7, st.sort);
    let hclen = 19;
    while (hclen > 4 && !clLen[CL_ORDER[hclen - 1]]) hclen--;

    // Exact sizes in bits of each encoding.
    let extra = 0;
    for (let i = 0; i < 29; i++) extra += litFreq[257 + i] * lenExtra[i];
    for (let i = 0; i < 30; i++) extra += distFreq[i] * distExtra[i];
    let dynamicBits = 17 + 3 * hclen + 2 * clFreq[16] + 3 * clFreq[17] + 7 * clFreq[18] + extra;
    let fixedBits = 3 + extra;
    for (let i = 0; i < 19; i++) dynamicBits += clFreq[i] * clLen[i];
    for (let i = 0; i < 286; i++) {
      dynamicBits += litFreq[i] * litLen[i];
      fixedBits += litFreq[i] * t.fixedLitLen[i];
    }
    for (let i = 0; i < 30; i++) {
      dynamicBits += distFreq[i] * distLen[i];
      fixedBits += distFreq[i] * 5;
    }
    const size = emitted - blockStart;
    const chunks = size ? Math.ceil(size / 65535) : 1;
    // 3 header bits, padding to a byte, LEN/NLEN and the bytes; then 1 byte (3 bits
    // and padding) + 4 per further 65535-byte chunk.
    const storedBits = 3 + ((8 - ((bc + 3) & 7)) & 7) + 8 * size + 32 * chunks + 8 * (chunks - 1);

    if (storedBits <= dynamicBits && storedBits <= fixedBits) {
      for (let s = blockStart; ;) {
        const e = s + 65535 < emitted ? s + 65535 : emitted;
        put(last && e === emitted ? 1 : 0, 3);
        if (bc) out[o++] = bb;
        bb = bc = 0;
        const l = e - s;
        out[o] = l & 255;
        out[o + 1] = l >>> 8;
        out[o + 2] = ~l & 255;
        out[o + 3] = (~l >>> 8) & 255;
        out.set(data.subarray(s, e), o + 4);
        o += l + 4;
        s = e;
        if (s >= emitted) break;
      }
    } else {
      let litCodes = t.fixedLitCodes;
      let distCodes = t.fixedDistCodes;
      let ll = t.fixedLitLen;
      let dl = t.fixedDistLen;
      if (dynamicBits < fixedBits) {
        put(last | 4, 3);
        put(hlit - 257, 5);
        put(hdist - 1, 5);
        put(hclen - 4, 4);
        for (let i = 0; i < hclen; i++) put(clLen[CL_ORDER[i]], 3);
        const clCodes = huffmanCodes(clLen);
        for (let i = 0; i < rle.length; i++) {
          const sym = rle[i] & 31;
          put(clCodes[sym], clLen[sym]);
          if (sym > 15) put(rle[i] >>> 5, sym === 16 ? 2 : sym === 17 ? 3 : 7);
        }
        litCodes = huffmanCodes(litLen);
        distCodes = huffmanCodes(distLen);
        ll = litLen;
        dl = distLen;
      } else {
        put(last | 2, 3);
      }
      for (let i = 0; i < nsyms; i++) {
        const v = syms[i];
        if (v < 256) {
          put(litCodes[v], ll[v]);
          continue;
        }
        const len = v & 255;
        const lc = lenCode[len];
        put(litCodes[257 + lc], ll[257 + lc]);
        if (lenExtra[lc]) put(len + 3 - lenBase[lc], lenExtra[lc]);
        const d = (v >>> 8) - 1;
        const dc = distCode[d < 256 ? d : 256 + (d >>> 7)];
        put(distCodes[dc], dl[dc]);
        if (distExtra[dc]) put(d + 1 - distBase[dc], distExtra[dc]);
      }
      put(litCodes[256], ll[256]);
    }
    for (let i = 0; i < 286; i++) litFreq[i] = 0;
    for (let i = 0; i < 30; i++) distFreq[i] = 0;
    nsyms = 0;
    blockStart = emitted;
  };

  /** @param {number} b */
  const literal = function(b) {
    syms[nsyms++] = b;
    litFreq[b]++;
    emitted++;
    if (nsyms === BLOCK_SYMBOLS) flush(0);
  };

  /**
   * @param {number} len 3..258
   * @param {number} dist 1..32768
   */
  const match = function(len, dist) {
    syms[nsyms++] = (dist << 8) | (len - 3);
    litFreq[257 + lenCode[len - 3]]++;
    const d = dist - 1;
    distFreq[distCode[d < 256 ? d : 256 + (d >>> 7)]]++;
    emitted += len;
    if (nsyms === BLOCK_SYMBOLS) flush(0);
  };

  // Lazy matching (zlib deflate_slow): a match at i is only taken if the match at
  // i + 1 is not longer; otherwise data[i] goes out as a literal.
  let prevLen = 2;
  let prevDist = 0;
  let pending = false;
  let i = 0;
  while (i < n) {
    let curLen = 2;
    let curDist = 0;
    if (i + 2 < n) {
      insert(i);
      const maxLen = n - i < 258 ? n - i : 258;
      if (prevLen < maxLen) {
        const limit = i - MAX_DIST;
        let best = prevLen;
        let chain = prevLen >= GOOD_LENGTH ? MAX_CHAIN >> 2 : MAX_CHAIN;
        let cand = prev[i & windowMask] + unset;
        while (cand >= limit && cand >= 0 && chain-- > 0) {
          if (data[cand + best] === data[i + best] && data[cand] === data[i] && data[cand + 1] === data[i + 1]) {
            let l = 2;
            while (l < maxLen && data[cand + l] === data[i + l]) l++;
            if (l > best) {
              best = l;
              curDist = i - cand;
              if (l >= maxLen) break;
            }
          }
          const p = prev[cand & windowMask] + unset;
          if (p >= cand) break; // the slot was reused by a newer position
          cand = p;
        }
        if (curDist) curLen = best;
        // A 3-byte match far away costs more than its literals (zlib's TOO_FAR).
        if (curLen === 3 && curDist > 4096) curLen = 2;
      }
    }
    if (prevLen >= 3 && curLen <= prevLen) {
      match(prevLen, prevDist);
      const end = i - 1 + prevLen;
      for (let k = i + 1; k < end; k++) {
        if (k + 2 < n) insert(k);
      }
      i = end;
      pending = false;
      prevLen = 2;
    } else {
      if (pending) literal(data[i - 1]);
      pending = true;
      prevLen = curLen;
      prevDist = curDist;
      i++;
    }
  }
  if (pending) literal(data[n - 1]);
  flush(1);
  if (bc) out[o++] = bb;
  return o;
}

/**
 * gzip-compresses a string, UTF-8 encoded like upstream's
 * `gzipSync(strToU8(s), {mtime: 0})`.
 * @param {string} s
 * @return {!Uint8Array}
 */
export function gzipSync(s) {
  return gzipBytes(strToU8(s));
}

/**
 * gzip (RFC 1952) of `data`: no name, mtime 0, OS 3 (Unix), like fflate's.
 * @param {!Uint8Array} data
 * @return {!Uint8Array} a new array, or for large inputs a view of one
 */
export function gzipBytes(data) {
  const n = data.length;
  const cap = n + 6 * ((n >>> 12) + 2) + 21;
  // Small outputs are written to the kept buffer and copied out; large ones get their
  // own buffer, returned as a view.
  const keep = cap <= KEEP_OUT_BYTES;
  const st = getState(hashBitsFor(n), n);
  let out = keep ? st.out : null;
  if (!out || out.length < cap) out = new Uint8Array(keep && cap < 4096 ? 4096 : cap);
  out[0] = 0x1f;
  out[1] = 0x8b;
  out[2] = 8;
  for (let k = 3; k < 9; k++) out[k] = 0;
  out[9] = 3;
  let o = deflate(data, out, 10, st);
  if (keep) st.out = out;
  const crc = crc32(data);
  for (let k = 0; k < 4; k++) out[o++] = (crc >>> (8 * k)) & 0xff;
  for (let k = 0; k < 4; k++) out[o++] = (n >>> (8 * k)) & 0xff;
  if (!keep) return out.subarray(0, o);
  const result = new Uint8Array(o);
  result.set(out.subarray(0, o));
  return result;
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
