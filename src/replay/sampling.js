/**
 * @fileoverview Port of upstream extensions/sampling.ts.
 */
import {clampToRange, isArray, isUndefined} from '../core/utils.js';

/**
 * @param {!Array<string>|undefined} currentValue
 * @param {string|!Array<string>} sampleType
 * @return {!Array<string>}
 */
export function appendArray(currentValue, sampleType) {
  return (currentValue ? currentValue : []).concat(isArray(sampleType) ? sampleType : [sampleType]);
}

/**
 * @param {number|undefined} currentValue
 * @param {number} percent
 * @return {number}
 */
export function updateThreshold(currentValue, percent) {
  return (isUndefined(currentValue) ? 1 : /** @type {number} */ (currentValue)) * percent;
}

/**
 * Java-style string hash, made positive.
 * @param {string} str
 * @return {number}
 */
export function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i); // (hash * 31) + char code
    hash |= 0; // Convert to 32bit integer
  }
  return Math.abs(hash);
}

/**
 * @param {string} prop
 * @param {number} percent between 0 and 1
 * @return {boolean}
 */
export function sampleOnProperty(prop, percent) {
  return simpleHash(prop) % 100 < clampToRange(percent * 100, 0, 100);
}
