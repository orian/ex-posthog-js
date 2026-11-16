/**
 * @fileoverview Console logger (upstream browser-common logger.ts). Output is
 * gated by `Config.DEBUG` / `window.POSTHOG_DEBUG`; `critical` always prints.
 */
import {Config} from './constants.js';
import {win} from './utils.js';

/**
 * @record
 */
export class Logger {
  constructor() {}
  /** @param {...*} args */
  info(args) {}
  /** @param {...*} args */
  warn(args) {}
  /** @param {...*} args */
  error(args) {}
  /** @param {...*} args */
  critical(args) {}
  /** @param {string} method */
  uninitializedWarning(method) {}
  /**
   * @param {string} prefix
   * @return {!Logger}
   */
  createLogger(prefix) {}
}

/**
 * @param {string} prefix
 * @return {!Logger}
 */
function createLogger(prefix) {
  /**
   * @param {string} level
   * @param {!Array<*>} args
   */
  const log = function(level, args) {
    if (win && (Config.DEBUG || win['POSTHOG_DEBUG']) && win.console) {
      const c = win.console;
      const fn = c[level] && c[level]['__rrweb_original__'] ? c[level]['__rrweb_original__'] : c[level];
      fn.apply(c, [prefix].concat(args));
    }
  };
  /** @type {!Logger} */
  const l = /** @type {!Logger} */ ({
    info: function(...args) {
      log('log', args);
    },
    warn: function(...args) {
      log('warn', args);
    },
    error: function(...args) {
      log('error', args);
    },
    critical: function(...args) {
      if (win && win.console) win.console.error.apply(win.console, [prefix].concat(args));
    },
    uninitializedWarning: function(method) {
      log('error', ['You must initialize PostHog before calling ' + method]);
    },
    createLogger: function(p) {
      return createLogger(prefix + ' ' + p);
    },
  });
  return l;
}

/** @const {!Logger} */
export const logger = createLogger('[PostHog.js]');
