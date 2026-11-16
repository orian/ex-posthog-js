/**
 * @fileoverview Pageview state (port of upstream page-view.ts): `$pageview_id`
 * and the `$prev_pageview_*` properties, including scroll depth.
 */
import {ScrollManager} from './scroll-manager.js';
import {SessionManager} from './session.js';
import {clampToRange, extend, isUndefined, win} from './utils.js';

export class PageViewManager {
  /**
   * @param {function(): !Object} getConfig
   * @param {!ScrollManager} scrollManager
   * @param {?SessionManager} sessionManager subscribed for rotations when given
   */
  constructor(getConfig, scrollManager, sessionManager) {
    /** @private @const */
    this.getConfig_ = getConfig;
    /** @private @const {!ScrollManager} */
    this.scrollManager_ = scrollManager;
    /** @type {{timestamp: !Date, pageViewId: (string|undefined), pathname: (string|undefined)}|undefined} */
    this.currentPageview = undefined;
    const self = this;
    /** @private {function()|undefined} */
    this.unsubscribe_ = sessionManager ? sessionManager.onSessionId(function(_s, _w, reason) {
      if (!reason) return;
      if (reason['noSessionId'] || reason['activityTimeout'] || reason['sessionPastMaximumLength'] ||
          reason['crossTabAdoption']) {
        self.currentPageview = undefined;
        self.scrollManager_.resetContext();
      }
    }) : undefined;
  }

  destroy() {
    if (this.unsubscribe_) this.unsubscribe_();
    this.unsubscribe_ = undefined;
  }

  /**
   * @param {!Date} timestamp
   * @param {string=} pageViewId
   * @return {!Object}
   */
  doPageView(timestamp, pageViewId) {
    const response = this.previous_(timestamp, pageViewId);
    this.currentPageview = {pathname: win ? win.location.pathname : '', pageViewId: pageViewId, timestamp: timestamp};
    this.scrollManager_.resetContext();
    return response;
  }

  /**
   * @param {!Date} timestamp
   * @return {!Object}
   */
  doPageLeave(timestamp) {
    return this.previous_(timestamp, this.currentPageview ? this.currentPageview.pageViewId : undefined);
  }

  /** @return {!Object} */
  doEvent() {
    return {'$pageview_id': this.currentPageview ? this.currentPageview.pageViewId : undefined};
  }

  /**
   * @param {!Date} timestamp
   * @param {string|undefined} pageviewId
   * @return {!Object}
   * @private
   */
  previous_(timestamp, pageviewId) {
    const prev = this.currentPageview;
    if (!prev) return {'$pageview_id': pageviewId};
    let props = {'$pageview_id': pageviewId, '$prev_pageview_id': prev.pageViewId};
    const ctx = this.scrollManager_.getContext();
    if (ctx && !this.getConfig_()['disable_scroll_properties']) {
      let maxScrollHeight = ctx.maxScrollHeight;
      let lastScrollY = ctx.lastScrollY;
      let maxScrollY = ctx.maxScrollY;
      let maxContentHeight = ctx.maxContentHeight;
      let lastContentY = ctx.lastContentY;
      let maxContentY = ctx.maxContentY;
      if (!isUndefined(maxScrollHeight) && !isUndefined(lastScrollY) && !isUndefined(maxScrollY) &&
          !isUndefined(maxContentHeight) && !isUndefined(lastContentY) && !isUndefined(maxContentY)) {
        maxScrollHeight = Math.ceil(/** @type {number} */ (maxScrollHeight));
        lastScrollY = Math.ceil(/** @type {number} */ (lastScrollY));
        maxScrollY = Math.ceil(/** @type {number} */ (maxScrollY));
        maxContentHeight = Math.ceil(/** @type {number} */ (maxContentHeight));
        lastContentY = Math.ceil(/** @type {number} */ (lastContentY));
        maxContentY = Math.ceil(/** @type {number} */ (maxContentY));
        props = /** @type {!Object} */ (extend(props, {
          '$prev_pageview_last_scroll': lastScrollY,
          '$prev_pageview_last_scroll_percentage': maxScrollHeight <= 1 ? 1 : clampToRange(lastScrollY / maxScrollHeight, 0, 1),
          '$prev_pageview_max_scroll': maxScrollY,
          '$prev_pageview_max_scroll_percentage': maxScrollHeight <= 1 ? 1 : clampToRange(maxScrollY / maxScrollHeight, 0, 1),
          '$prev_pageview_last_content': lastContentY,
          '$prev_pageview_last_content_percentage': maxContentHeight <= 1 ? 1 : clampToRange(lastContentY / maxContentHeight, 0, 1),
          '$prev_pageview_max_content': maxContentY,
          '$prev_pageview_max_content_percentage': maxContentHeight <= 1 ? 1 : clampToRange(maxContentY / maxContentHeight, 0, 1),
        }));
      }
    }
    if (prev.pathname) props['$prev_pageview_pathname'] = prev.pathname;
    if (prev.timestamp) props['$prev_pageview_duration'] = (timestamp.getTime() - prev.timestamp.getTime()) / 1000;
    return props;
  }
}
