/**
 * @fileoverview Scroll tracking (port of upstream scroll-manager.ts). Feeds the
 * `$prev_pageview_*` scroll metrics and is exposed to extensions (heatmaps,
 * autocapture) as `posthog.scrollManager`.
 */
import {addEventListener, isArray, win} from './utils.js';

/**
 * @typedef {{
 *   maxScrollHeight: (number|undefined),
 *   maxScrollY: (number|undefined),
 *   lastScrollY: (number|undefined),
 *   maxContentHeight: (number|undefined),
 *   maxContentY: (number|undefined),
 *   lastContentY: (number|undefined)
 * }}
 */
export let ScrollContext;

export class ScrollManager {
  /** @param {function(): !Object} getConfig returns the live PostHog config */
  constructor(getConfig) {
    /** @private @const */
    this.getConfig_ = getConfig;
    /** @private {!ScrollContext|undefined} */
    this.context_ = undefined;
    const self = this;
    /** @private @const {function()} */
    this.update_ = function() {
      self.updateScrollData_();
    };
  }

  /** @return {*} @private */
  scrollRoot_() {
    return this.getConfig_()['scroll_root_selector'];
  }

  /** @return {!ScrollContext|undefined} */
  getContext() {
    return this.context_;
  }

  /** @return {!ScrollContext|undefined} */
  resetContext() {
    const ctx = this.context_;
    this.context_ = undefined;
    setTimeout(this.update_, 0);
    return ctx;
  }

  /** @private */
  updateScrollData_() {
    if (!this.context_) {
      this.context_ = /** @type {!ScrollContext} */ ({});
    }
    const c = this.context_;
    const el = this.scrollElement();
    const scrollY = this.scrollY();
    const scrollHeight = el ? Math.max(0, el.scrollHeight - el.clientHeight) : 0;
    const contentY = scrollY + ((el && el.clientHeight) || 0);
    const contentHeight = (el && el.scrollHeight) || 0;
    c.lastScrollY = Math.ceil(scrollY);
    c.maxScrollY = Math.max(scrollY, c.maxScrollY || 0);
    c.maxScrollHeight = Math.max(scrollHeight, c.maxScrollHeight || 0);
    c.lastContentY = contentY;
    c.maxContentY = Math.max(contentY, c.maxContentY || 0);
    c.maxContentHeight = Math.max(contentHeight, c.maxContentHeight || 0);
  }

  /** Starts listening to scroll/scrollend/resize (capture phase). */
  startMeasuringScrollPosition() {
    addEventListener(win, 'scroll', this.update_, {capture: true, passive: undefined});
    addEventListener(win, 'scrollend', this.update_, {capture: true, passive: undefined});
    addEventListener(win, 'resize', this.update_);
  }

  /** @return {?Element|undefined} the configured scroll root, or documentElement */
  scrollElement() {
    const root = this.scrollRoot_();
    if (root) {
      const selectors = /** @type {!Array<string>} */ (isArray(root) ? root : [root]);
      for (let i = 0; i < selectors.length; i++) {
        const el = win && win.document ? win.document.querySelector(selectors[i]) : null;
        if (el) return el;
      }
      return undefined;
    }
    return win && win.document ? win.document.documentElement : undefined;
  }

  /**
   * @param {string} axis 'x' | 'y'
   * @return {number}
   * @private
   */
  scrollPosition_(axis) {
    const key = axis === 'y' ? 'scrollTop' : 'scrollLeft';
    if (this.scrollRoot_()) {
      const el = this.scrollElement();
      return (el && el[key]) || 0;
    }
    if (!win) return 0;
    const de = win.document ? win.document.documentElement : null;
    return axis === 'y' ?
        win.scrollY || win.pageYOffset || (de && de.scrollTop) || 0 :
        win.scrollX || win.pageXOffset || (de && de.scrollLeft) || 0;
  }

  /** @return {number} */
  scrollY() {
    return this.scrollPosition_('y');
  }

  /** @return {number} */
  scrollX() {
    return this.scrollPosition_('x');
  }
}
