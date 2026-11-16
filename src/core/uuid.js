/**
 * @fileoverview UUIDv7 generator (time-ordered), matching upstream's event/session IDs.
 */
import {win} from './utils.js';

/**
 * @param {number} n
 * @return {!Array<number>}
 */
function randomBytes(n) {
  const out = new Array(n);
  const c = win ? (win.crypto || win['msCrypto']) : null;
  if (c && c.getRandomValues) {
    const buf = new Uint8Array(n);
    c.getRandomValues(buf);
    for (let i = 0; i < n; i++) out[i] = buf[i];
  } else {
    for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  }
  return out;
}

/** @type {number} */
let lastMs = 0;
/** @type {number} */
let seq = 0;

/**
 * Generates a UUIDv7 string. A 12-bit counter keeps IDs monotonic within the
 * same millisecond.
 * @param {number=} timestampMs
 * @return {string}
 */
export function uuidv7(timestampMs) {
  let ms = timestampMs === void 0 ? new Date().getTime() : timestampMs;
  if (ms <= lastMs) {
    seq = (seq + 1) & 0xfff;
    if (seq === 0) lastMs++;
    ms = lastMs;
  } else {
    lastMs = ms;
    seq = randomBytes(2)[0] & 0x7f; // leave headroom for increments
  }
  const bytes = randomBytes(16);
  // 48-bit big-endian timestamp. Avoid bitwise ops on >32-bit values.
  let t = ms;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = t % 256;
    t = Math.floor(t / 256);
  }
  bytes[6] = 0x70 | ((seq >> 8) & 0x0f);
  bytes[7] = seq & 0xff;
  bytes[8] = 0x80 | (bytes[8] & 0x3f);
  let hex = '';
  for (let i = 0; i < 16; i++) {
    hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    if (i === 3 || i === 5 || i === 7 || i === 9) hex += '-';
  }
  return hex;
}
