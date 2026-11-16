/**
 * @fileoverview Rage click detection (port of upstream
 * browser-common/src/rageclick.ts) and the rageclick content ignorelists from
 * autocapture-utils.ts. It lives in the core because both autocapture and
 * heatmaps use it, and the core's date-gated `rageclick` default needs the
 * stepper list.
 */
import {isObject} from './utils.js';

/**
 * Pagers and carousel controls are built to be clicked repeatedly, in words or
 * in arrow glyphs (upstream DEFAULT_CONTENT_IGNORELIST).
 * @const {!Array<string>}
 */
export const DEFAULT_CONTENT_IGNORELIST = [
  'next', 'previous', 'prev', '>', '<', '→', '←', '›', '‹', '»', '«', '▶', '◀',
  '❯', '❮',
];

/**
 * +/- steppers too; the `rageclick` default from the 2026-05-30 config defaults
 * (upstream DEFAULT_CONTENT_IGNORELIST_WITH_STEPPERS).
 * @const {!Array<string>}
 */
export const DEFAULT_CONTENT_IGNORELIST_WITH_STEPPERS =
    DEFAULT_CONTENT_IGNORELIST.concat(['+', '-', '−', '–']);

const DEFAULT_THRESHOLD_PX = 30;
const DEFAULT_TIMEOUT_MS = 1000;
const DEFAULT_CLICK_COUNT = 3;

/**
 * Naive rage click detection: the mouse has not moved further than
 * `threshold_px` over `click_count` clicks with at most `timeout_ms` between
 * clicks.
 */
export class RageClick {
  /** @param {*} rageclickConfig `rageclick` config: boolean or {threshold_px, timeout_ms, click_count, ...} */
  constructor(rageclickConfig) {
    /** @type {boolean} */
    this.disabled = rageclickConfig === false;
    const conf = isObject(rageclickConfig) ? /** @type {!Object} */ (rageclickConfig) : {};
    /** @type {number} */
    this.thresholdPx = conf['threshold_px'] || DEFAULT_THRESHOLD_PX;
    /** @type {number} */
    this.timeoutMs = conf['timeout_ms'] || DEFAULT_TIMEOUT_MS;
    /** @type {number} */
    this.clickCount = conf['click_count'] || DEFAULT_CLICK_COUNT;
    /** @type {!Array<{x: number, y: number, timestamp: number}>} */
    this.clicks = [];
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} timestamp
   * @return {boolean}
   */
  isRageClick(x, y, timestamp) {
    if (this.disabled) return false;
    const last = this.clicks[this.clicks.length - 1];
    if (last && Math.abs(x - last.x) + Math.abs(y - last.y) < this.thresholdPx &&
        timestamp - last.timestamp < this.timeoutMs) {
      this.clicks.push({x: x, y: y, timestamp: timestamp});
      if (this.clicks.length === this.clickCount) return true;
    } else {
      this.clicks = [{x: x, y: y, timestamp: timestamp}];
    }
    return false;
  }
}
