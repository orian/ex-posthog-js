/**
 * @fileoverview Heatmaps (optional module). Port of upstream
 * browser/src/heatmaps.ts: buffers click, rageclick, deadclick and (debounced)
 * mousemove points per URL and sends them as `$$heatmap` every
 * `capture_heatmaps.flush_interval_milliseconds` (5s) while the page is
 * visible, and on beforeunload. Enabled by `capture_heatmaps` /
 * `enable_heatmaps` or the remote `heatmaps` switch, persisted as
 * `$heatmaps_enabled_server_side`.
 */
import {PostHog} from '../core/posthog.js';
import {Extension} from '../core/extensions.js';
import {RageClick} from '../core/rageclick.js';
import {logger as baseLogger} from '../core/logger.js';
import {MASKED, paramsToMask} from '../core/event-utils.js';
import {
  addEventListener, doc, includes, isEmptyObject, isNullish, isNumber, isObject, maskQueryParams, stripUrlHash, win,
} from '../core/utils.js';
import {
  getEventTarget, getParentElement, isElementInToolbar, isElementNode, isTag, shouldCaptureRageclick,
} from '../dom/autocapture-utils.js';
import {DeadClickCandidate, DeadClicksAutocapture, isDeadClicksEnabledForHeatmaps} from '../dead-clicks/dead-clicks.js';

const logger = baseLogger.createLogger('[Heatmaps]');

/** @const {string} */
export const HEATMAPS_ENABLED_SERVER_SIDE = '$heatmaps_enabled_server_side';
const DEFAULT_FLUSH_INTERVAL = 5000;

/**
 * @param {?Element} el
 * @param {!Array<string>} matches
 * @param {?Element=} breakOnElement
 * @return {boolean}
 */
function elementOrParentPositionMatches(el, matches, breakOnElement) {
  let curEl = el;
  while (curEl && isElementNode(curEl) && !isTag(curEl, 'body')) {
    if (curEl === breakOnElement) return false;
    let position;
    try {
      const view = curEl.ownerDocument && curEl.ownerDocument.defaultView ? curEl.ownerDocument.defaultView : win;
      position = view ? view.getComputedStyle(curEl).position : undefined;
    } catch (e) {
      return false;
    }
    if (includes(matches, position)) return true;
    curEl = getParentElement(curEl);
  }
  return false;
}

/**
 * @param {*} e
 * @return {boolean}
 */
function isValidMouseEvent(e) {
  return isObject(e) && 'clientX' in e && 'clientY' in e && isNumber(e['clientX']) && isNumber(e['clientY']);
}

/** @implements {Extension} */
export class Heatmaps {
  /** @param {!PostHog} instance */
  constructor(instance) {
    /** @type {!PostHog} */
    this.instance = instance;
    /** @type {boolean} */
    this.enabledServerSide = !!(instance.persistence && instance.persistence.props[HEATMAPS_ENABLED_SERVER_SIDE]);
    /** @type {!RageClick} */
    this.rageclicks = new RageClick(instance.config['rageclick']);
    /** @type {boolean} */
    this.initialized = false;
    /** @private {number|undefined} */
    this.mouseMoveTimeout_ = undefined;
    /** @private {?Object<string, !Array<!Object>>} */
    this.buffer_ = null;
    /** @private {?number} */
    this.flushInterval_ = null;
    /** @private {?DeadClicksAutocapture} */
    this.deadClicksCapture_ = null;
    /** @private {?function(!Event)} */
    this.onClickHandler_ = null;
    /** @private {?function(!Event)} */
    this.onMouseMoveHandler_ = null;
    /** @private {?function(?)} */
    this.flushHandler_ = null;
    /** @private {?function(?)} */
    this.onVisibilityChangeHandler_ = null;
  }

  /** Upstream initialize(). */
  onInit() {
    this.startIfEnabled();
  }

  /** @return {number} */
  flushIntervalMs() {
    const c = this.instance.config['capture_heatmaps'];
    return isObject(c) && c['flush_interval_milliseconds'] ? c['flush_interval_milliseconds'] : DEFAULT_FLUSH_INTERVAL;
  }

  /** @return {boolean} */
  checkEnabled() {
    const config = this.instance.config;
    if (!isNullish(config['capture_heatmaps'])) return config['capture_heatmaps'] !== false;
    if (!isNullish(config['enable_heatmaps'])) return config['enable_heatmaps'];
    return this.enabledServerSide;
  }

  startIfEnabled() {
    if (this.checkEnabled()) {
      if (this.initialized) return;
      logger.info('starting...');
      this.setupListeners_();
      this.onVisibilityChange_();
    } else {
      clearInterval(this.flushInterval_ === null ? undefined : this.flushInterval_);
      this.removeListeners_();
      this.getAndClearBuffer();
    }
  }

  /** Upstream calls startIfEnabled from set_config. */
  onConfigChange() {
    this.startIfEnabled();
  }

  /** @param {?Object} response remote config, null when loading failed */
  onRemoteConfig(response) {
    if (!response || !('heatmaps' in response)) return;
    const optIn = !!response['heatmaps'];
    if (this.instance.persistence) this.instance.persistence.register({[HEATMAPS_ENABLED_SERVER_SIDE]: optIn});
    this.enabledServerSide = optIn;
    this.startIfEnabled();
  }

  /** @return {?Object<string, !Array<!Object>>|undefined} */
  getAndClearBuffer() {
    const buffer = this.buffer_;
    this.buffer_ = null;
    return buffer || undefined;
  }

  /**
   * @param {!DeadClickCandidate} click
   * @private
   */
  onDeadClick_(click) {
    if (!isValidMouseEvent(click.originalEvent)) return;
    this.onClick_(/** @type {!MouseEvent} */ (click.originalEvent), 'deadclick');
  }

  /** @private */
  onVisibilityChange_() {
    if (this.flushInterval_) clearInterval(this.flushInterval_);
    const self = this;
    this.flushInterval_ = doc && doc.visibilityState === 'visible' ? setInterval(function() {
      self.flush_();
    }, this.flushIntervalMs()) : null;
  }

  /** @private */
  setupListeners_() {
    if (!win || !doc) return;
    const self = this;
    this.flushHandler_ = function() {
      self.flush_();
    };
    addEventListener(win, 'beforeunload', this.flushHandler_);
    this.onClickHandler_ = function(e) {
      self.onClick_(/** @type {!MouseEvent} */ (e || win.event), 'click');
    };
    addEventListener(doc, 'click', this.onClickHandler_, {capture: true, passive: undefined});
    this.onMouseMoveHandler_ = function(e) {
      self.onMouseMove_(/** @type {!Event} */ (e || win.event));
    };
    addEventListener(doc, 'mousemove', this.onMouseMoveHandler_, {capture: true, passive: undefined});
    this.deadClicksCapture_ = new DeadClicksAutocapture(this.instance, isDeadClicksEnabledForHeatmaps,
        function(click) {
          self.onDeadClick_(click);
        });
    this.deadClicksCapture_.startIfEnabledOrStop();
    this.onVisibilityChangeHandler_ = function() {
      self.onVisibilityChange_();
    };
    addEventListener(doc, 'visibilitychange', this.onVisibilityChangeHandler_);
    this.initialized = true;
  }

  /** @private */
  removeListeners_() {
    if (!win || !doc) return;
    if (this.flushHandler_) win.removeEventListener('beforeunload', this.flushHandler_);
    const capture = /** @type {?} */ ({'capture': true});
    if (this.onClickHandler_) doc.removeEventListener('click', this.onClickHandler_, capture);
    if (this.onMouseMoveHandler_) doc.removeEventListener('mousemove', this.onMouseMoveHandler_, capture);
    if (this.onVisibilityChangeHandler_) doc.removeEventListener('visibilitychange', this.onVisibilityChangeHandler_);
    clearTimeout(this.mouseMoveTimeout_);
    if (this.deadClicksCapture_) this.deadClicksCapture_.stop();
    this.initialized = false;
  }

  /**
   * @param {!MouseEvent} e
   * @param {string} type
   * @return {!Object}
   * @private
   */
  getProperties_(e, type) {
    const sm = this.instance.scrollManager;
    const scrollY = sm.scrollY();
    const scrollX = sm.scrollX();
    const scrollElement = sm.scrollElement();
    const fixed = elementOrParentPositionMatches(getEventTarget(e), ['fixed', 'sticky'], scrollElement);
    return {
      'x': e.clientX + (fixed ? 0 : scrollX),
      'y': e.clientY + (fixed ? 0 : scrollY),
      'target_fixed': fixed,
      'type': type,
    };
  }

  /**
   * @param {!MouseEvent} e
   * @param {string} type
   * @private
   */
  onClick_(e, type) {
    if (isElementInToolbar(e.target) || !isValidMouseEvent(e)) return;
    const properties = this.getProperties_(e, type);
    if (this.rageclicks.isRageClick(e.clientX, e.clientY, new Date().getTime()) &&
        shouldCaptureRageclick(getEventTarget(e), this.instance.config['rageclick'])) {
      const rage = {};
      for (const k in properties) rage[k] = properties[k];
      rage['type'] = 'rageclick';
      this.capture_(rage);
    }
    this.capture_(properties);
  }

  /**
   * @param {!Event} e
   * @private
   */
  onMouseMove_(e) {
    if (isElementInToolbar(e.target) || !isValidMouseEvent(e)) return;
    clearTimeout(this.mouseMoveTimeout_);
    const self = this;
    this.mouseMoveTimeout_ = setTimeout(function() {
      self.capture_(self.getProperties_(/** @type {!MouseEvent} */ (e), 'mousemove'));
    }, 500);
  }

  /**
   * @param {!Object} properties
   * @private
   */
  capture_(properties) {
    if (!win) return;
    const config = this.instance.config;
    const href = config['disable_capture_url_hashes'] ? stripUrlHash(win.location.href) : win.location.href;
    const url = maskQueryParams(href, paramsToMask(config['mask_personal_data_properties'],
        config['custom_personal_data_properties']), MASKED);
    this.buffer_ = this.buffer_ || {};
    if (!this.buffer_[url]) this.buffer_[url] = [];
    this.buffer_[url].push(properties);
  }

  /** @private */
  flush_() {
    if (!this.buffer_ || isEmptyObject(this.buffer_)) return;
    this.instance.capture('$$heatmap', {'$heatmap_data': this.getAndClearBuffer()});
  }
}
