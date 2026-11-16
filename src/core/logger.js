/**
 * @fileoverview Console logger gated by the `debug` config flag.
 */
import {win} from './utils.js';

const PREFIX = '[PostHog.js]';

/** Global debug switch; toggled by PostHog#debug / config.debug. */
export const logger = {
  /** @type {boolean} */
  enabled: false,

  /**
   * @param {string} level
   * @param {!Array<*>} args
   */
  log_(level, args) {
    const c = win ? win.console : null;
    if (!c) return;
    const fn = c[level] || c.log;
    fn.apply(c, [PREFIX].concat(args));
  },

  /** @param {...*} args */
  info(...args) {
    if (logger.enabled) logger.log_('log', args);
  },

  /** @param {...*} args */
  warn(...args) {
    if (logger.enabled) logger.log_('warn', args);
  },

  /** @param {...*} args */
  error(...args) {
    if (logger.enabled) logger.log_('error', args);
  },

  /** Always printed, regardless of debug mode. @param {...*} args */
  critical(...args) {
    logger.log_('error', args);
  },
};
