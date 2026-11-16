/**
 * @fileoverview SPA pageviews (port of upstream extensions/history-autocapture.ts).
 * Captures `$pageview` with `navigation_type` when the selected URL parts
 * change through pushState/replaceState, popstate or hashchange.
 */
import {addEventListener, convertToURL, isNullish, isObject, microtask, win} from './utils.js';
import {logger} from './logger.js';
import {EVENT_PAGEVIEW} from './constants.js';

/** @typedef {{pathname: string, search: string, hash: string}} */
let HistoryLocation;

export class HistoryAutocapture {
  /**
   * @param {function(): !Object} getConfig
   * @param {function(string, !Object)} capture
   */
  constructor(getConfig, capture) {
    /** @private @const */
    this.getConfig_ = getConfig;
    /** @private @const */
    this.capture_ = capture;
    /** @private {function()|undefined} */
    this.popstateListener_ = undefined;
    /** @private {function()|undefined} */
    this.hashchangeListener_ = undefined;
    /** @private {?HistoryLocation|undefined} */
    this.lastLocation_ = this.currentLocation_();
    /** @private {function()|undefined} */
    this.pendingPageview_ = undefined;
    /** @private {boolean} */
    this.isFlushing_ = false;
  }

  initialize() {
    this.startIfEnabled();
  }

  /** @return {boolean} */
  isEnabled() {
    const o = this.options_();
    return !!(o['path'] || o['search'] || this.captureHash_(o));
  }

  startIfEnabled() {
    if (this.isEnabled()) {
      logger.info('History API monitoring enabled, starting...');
      this.monitorHistoryChanges();
    }
  }

  startIfEnabledOrStop() {
    this.stop();
    this.lastLocation_ = this.currentLocation_();
    this.startIfEnabled();
  }

  stop() {
    if (this.popstateListener_) this.popstateListener_();
    this.popstateListener_ = undefined;
    if (this.hashchangeListener_) this.hashchangeListener_();
    this.hashchangeListener_ = undefined;
    logger.info('History API monitoring stopped');
  }

  monitorHistoryChanges() {
    if (!win || !win.history) return;
    this.patch_('pushState');
    this.patch_('replaceState');
    this.setupPopstate_();
    if (this.captureHash_()) this.setupHashchange_();
  }

  /**
   * @param {string} method
   * @private
   */
  patch_(method) {
    const history = /** @type {!Object} */ (win.history);
    const original = history[method];
    if (!original || original['__posthog_wrapped__']) return;
    const self = this;
    const wrapped = /** @this {*} */ function(state, title, url) {
      if (self.isUrlChanging_(url)) self.flushPending_();
      original.call(this, state, title, url);
      const ev = win['event'];
      self.capturePageview_(method, !self.isFlushing_ && !(ev && ev.type === 'popstate'));
    };
    wrapped['__posthog_wrapped__'] = true;
    try {
      history[method] = wrapped;
    } catch (e) {}
  }

  /** @return {?HistoryLocation|undefined} @private */
  currentLocation_() {
    const l = win ? win.location : null;
    if (!l || !l.pathname) return undefined;
    return {pathname: l.pathname, search: l.search, hash: l.hash};
  }

  /** @return {!Object} @private */
  options_() {
    const cp = this.getConfig_()['capture_pageview'];
    if (cp === 'history_change') return {'path': true};
    return isObject(cp) ? /** @type {!Object} */ (cp) : {};
  }

  /**
   * @param {!Object=} options
   * @return {boolean}
   * @private
   */
  captureHash_(options) {
    const o = options || this.options_();
    return !!o['hash'] && !this.getConfig_()['disable_capture_url_hashes'];
  }

  /**
   * @param {!HistoryLocation} current
   * @return {boolean}
   * @private
   */
  hasChanged_(current) {
    const o = this.options_();
    const last = this.lastLocation_;
    return !!(last && ((o['path'] && current.pathname !== last.pathname) ||
        (o['search'] && current.search !== last.search) ||
        (this.captureHash_(o) && current.hash !== last.hash)));
  }

  /**
   * @param {string} navigationType
   * @param {boolean=} defer
   * @private
   */
  capturePageview_(navigationType, defer) {
    try {
      if (!defer) this.flushPending_();
      const current = this.currentLocation_();
      if (!current) return;
      if (this.hasChanged_(current)) {
        const self = this;
        const capture = function() {
          self.capture_(EVENT_PAGEVIEW, {'navigation_type': navigationType});
        };
        if (defer) {
          this.pendingPageview_ = capture;
          microtask(function() {
            self.flushPending_();
          });
        } else {
          capture();
        }
      }
      this.lastLocation_ = current;
    } catch (e) {
      logger.error('Error capturing ' + navigationType + ' pageview', e);
    }
  }

  /**
   * @param {*} url
   * @return {boolean}
   * @private
   */
  isUrlChanging_(url) {
    if (isNullish(url) || !win) return false;
    const parsed = convertToURL(String(url));
    return (parsed ? parsed.href : undefined) !== win.location.href;
  }

  /** @private */
  flushPending_() {
    const pending = this.pendingPageview_;
    if (!pending) return;
    this.pendingPageview_ = undefined;
    this.isFlushing_ = true;
    try {
      pending();
    } catch (e) {
      logger.error('Error capturing deferred pageview', e);
    } finally {
      this.isFlushing_ = false;
    }
    this.lastLocation_ = this.currentLocation_();
  }

  /** @private */
  setupPopstate_() {
    if (this.popstateListener_) return;
    const self = this;
    const handler = function() {
      self.capturePageview_('popstate');
    };
    addEventListener(win, 'popstate', handler);
    this.popstateListener_ = function() {
      if (win) win.removeEventListener('popstate', handler);
    };
  }

  /** @private */
  setupHashchange_() {
    if (this.hashchangeListener_) return;
    const self = this;
    const handler = function() {
      self.capturePageview_('hashchange');
    };
    addEventListener(win, 'hashchange', handler);
    this.hashchangeListener_ = function() {
      if (win) win.removeEventListener('hashchange', handler);
    };
  }
}
