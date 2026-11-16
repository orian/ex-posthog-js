/**
 * @fileoverview Dead clicks (optional module). Port of upstream
 * browser/src/extensions/dead-clicks-autocapture.ts (the extension, enabled by
 * `capture_dead_clicks` or the remote `captureDeadClicks`, persisted as
 * `$dead_clicks_enabled_server_side`) and of the lazily loaded detector in
 * browser/src/entrypoints/dead-clicks-autocapture.ts. Upstream loads the
 * detector from /static; here it is compiled in, so it starts synchronously.
 * Heatmaps reuse the detector to plot `deadclick` points.
 */
import {PostHog} from '../core/posthog.js';
import {Extension} from '../core/extensions.js';
import {logger as baseLogger} from '../core/logger.js';
import {addEventListener, doc, extend, isBoolean, isNull, isNumber, isObject, isUndefined, win} from '../core/utils.js';
import {
  autocapturePropertiesForElement, getEventTarget, isElementInToolbar, isElementNode, isTag, isTextSelectionTarget,
  shouldCaptureDeadClick, shouldSkipDeadClick,
} from '../dom/autocapture-utils.js';

const logger = baseLogger.createLogger('[Dead Clicks]');

/** @const {string} */
export const DEAD_CLICKS_ENABLED_SERVER_SIDE = '$dead_clicks_enabled_server_side';

const UNOBSERVABLE_SURFACE_SELECTOR = 'canvas,video,audio,embed,object';
const LIVENESS_SUPPRESSION_MS = 1000;

/** A queued click or swipe (upstream DeadClickCandidate). */
export class DeadClickCandidate {
  /**
   * @param {!Element} node
   * @param {!Event} originalEvent
   * @param {string} type 'click' | 'swipe'
   */
  constructor(node, originalEvent, type) {
    /** @type {!Element} */
    this.node = node;
    /** @type {!Event} */
    this.originalEvent = originalEvent;
    /** @type {number} */
    this.timestamp = Date.now();
    /** @type {string} */
    this.type = type;
    /** @type {string|undefined} */
    this.swipeDirection = undefined;
    /** @type {number|undefined} */
    this.swipeDistancePx = undefined;
    /** @type {number|undefined} */
    this.scrollDelayMs = undefined;
    /** @type {number|undefined} */
    this.mutationDelayMs = undefined;
    /** @type {number|undefined} */
    this.absoluteDelayMs = undefined;
    /** @type {number|undefined} */
    this.selectionChangedDelayMs = undefined;
    /** @type {number|undefined} */
    this.visibilityChangedDelayMs = undefined;
    /** @type {number|undefined} */
    this.focusChangedDelayMs = undefined;
    /** @type {boolean|undefined} */
    this.selectionChangedDuringGesture = undefined;
  }
}

/** @typedef {function(!DeadClickCandidate, !Object)} */
export let DeadClickCallback;

/**
 * @param {!Event} event
 * @param {string} type
 * @return {?DeadClickCandidate}
 */
function asCandidate(event, type) {
  const target = getEventTarget(event);
  return target ? new DeadClickCandidate(target, event, type) : null;
}

/**
 * @param {*} node
 * @return {boolean}
 */
function isInspectableElement(node) {
  try {
    return isElementNode(node);
  } catch (e) {
    return false;
  }
}

/**
 * @param {number} dx
 * @param {number} dy
 * @return {string}
 */
function swipeDirection(dx, dy) {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'down' : 'up';
}

/**
 * @param {!DeadClickCandidate} c
 * @return {string}
 */
function deadEventName(c) {
  return c.type === 'swipe' ? '$dead_swipe' : '$dead_click';
}

/**
 * @param {!Event} event
 * @return {boolean}
 */
function hasModifierKey(event) {
  return !!(event['ctrlKey'] || event['metaKey'] || event['altKey'] || event['shiftKey']);
}

/**
 * @param {number|undefined} value
 * @param {number} thresholdMs
 * @return {boolean}
 */
function checkTimeout(value, thresholdMs) {
  return isNumber(value) && /** @type {number} */ (value) >= thresholdMs;
}

/**
 * @param {number} delay
 * @param {number=} windowMs
 * @return {number|undefined}
 */
function livenessDelayInWindow(delay, windowMs) {
  const w = isUndefined(windowMs) ? LIVENESS_SUPPRESSION_MS : windowMs;
  return delay >= 0 && delay < w ? delay : undefined;
}

/**
 * @param {number} clickTimestamp
 * @param {number|undefined} lastSeenAt
 * @param {number=} windowMs
 * @return {number|undefined}
 */
function priorLivenessDelay(clickTimestamp, lastSeenAt, windowMs) {
  return isNumber(lastSeenAt) ? livenessDelayInWindow(clickTimestamp - /** @type {number} */ (lastSeenAt), windowMs) :
      undefined;
}

/** @type {?} */
let cachedMutationObserver = null;

/**
 * Upstream getNativeMutationObserverImplementation: the page's MutationObserver
 * unless it was patched (e.g. by Angular's zone.js), else one from a sandbox iframe.
 * @return {?}
 */
function getNativeMutationObserver() {
  if (cachedMutationObserver) return cachedMutationObserver;
  let impl = win ? win['MutationObserver'] : undefined;
  const isNative = typeof impl === 'function' && String(impl).indexOf('[native code]') !== -1;
  if (isNative && !(win && win['Zone'])) return cachedMutationObserver = impl.bind(win);
  if (doc && typeof doc.createElement === 'function') {
    let sandbox = null;
    let keep = false;
    try {
      sandbox = /** @type {!HTMLIFrameElement} */ (doc.createElement('iframe'));
      sandbox.hidden = true;
      doc.head.appendChild(sandbox);
      const cw = sandbox.contentWindow;
      if (cw && cw['MutationObserver']) {
        impl = cw['MutationObserver'];
        const ua = win && win.navigator ? win.navigator.userAgent || '' : '';
        if (ua.indexOf('AppleWebKit') !== -1 && ua.indexOf('Chrome') === -1) {
          sandbox.classList.add('rr-block', 'ph-no-capture');
          keep = true;
        }
      }
    } catch (e) {
      baseLogger.warn('Could not create sandbox iframe for MutationObserver check, bailing to ' +
          'assignableWindow.MutationObserver: ', e);
    } finally {
      if (!keep && sandbox && sandbox.parentNode) sandbox.parentNode.removeChild(sandbox);
    }
  }
  if (!impl || typeof impl !== 'function') return impl || null;
  return cachedMutationObserver = impl.bind(win);
}

/**
 * @typedef {{path: !Array<!EventTarget>, trusted: boolean, selectionChanged: boolean,
 *     selectionInitiallyRelated: boolean, clickTarget: (?EventTarget|undefined), clickDetail: (number|undefined)}}
 */
let MouseSelectionGesture;

/**
 * The dead click detector (upstream LazyLoadedDeadClicksAutocapture). A click
 * or swipe is queued, re-examined ~1s later, and reported only when no
 * liveness signal (mutation, scroll, selection, visibility, focus) fired in
 * its window and some timeout did.
 */
export class DeadClickDetector {
  /**
   * @param {!PostHog} instance
   * @param {!Object} config `capture_dead_clicks` options (quoted keys)
   * @param {?DeadClickCallback|undefined} onCapture
   */
  constructor(instance, config, onCapture) {
    /** @type {!PostHog} */
    this.instance = instance;
    const self = this;
    /** @param {string} k @param {*} d @return {?} */
    const opt = function(k, d) {
      const v = config[k];
      return v === null || v === undefined ? d : v;
    };
    /** @private @const */
    this.elementAttributeIgnorelist_ = opt('element_attribute_ignorelist', []);
    /** @private @const {number} */
    this.scrollThresholdMs_ = opt('scroll_threshold_ms', 100);
    /** @private @const {number} */
    this.selectionChangeThresholdMs_ = opt('selection_change_threshold_ms', 100);
    /** @private @const {number} */
    this.mutationThresholdMs_ = opt('mutation_threshold_ms', 2500);
    /** @private @const {boolean} */
    this.captureWithModifierKeys_ = opt('capture_clicks_with_modifier_keys', false);
    /** @private @const {boolean} */
    this.captureDeadSwipes_ = opt('capture_dead_swipes', true);
    /** @private @const {number} */
    this.swipeThresholdPx_ = opt('swipe_threshold_px', 30);
    /** @private @const {number} */
    this.maxDeadSwipes_ = opt('max_dead_swipes_per_page_load', 10);
    /** @private @const {*} */
    this.cssSelectorIgnorelist_ = config['css_selector_ignorelist'];
    /** @private @const {!DeadClickCallback} */
    this.onCapture_ = onCapture || function(click, props) {
      self.captureDeadClick_(click, props);
    };

    /** @private {?MutationObserver} */
    this.mutationObserver_ = null;
    /** @private {!Array<!Node>} */
    this.observedRoots_ = [];
    /** @private {number|undefined} */
    this.lastMutation_ = undefined;
    /** @private {number|undefined} */
    this.lastScroll_ = undefined;
    /** @private {number|undefined} */
    this.lastSelectionChanged_ = undefined;
    /** @private {boolean} */
    this.hadSelection_ = false;
    /** @private {number|undefined} */
    this.lastVisibilityChange_ = undefined;
    /** @private {number|undefined} */
    this.lastFocusChange_ = undefined;
    /** @private {!Array<!DeadClickCandidate>} */
    this.clicks_ = [];
    /** @private {number|undefined} */
    this.checkClickTimer_ = undefined;
    /** @private {?MouseSelectionGesture} */
    this.mouseSelection_ = null;
    /** @private {number|undefined} */
    this.mouseSelectionTimer_ = undefined;
    /** @private {?{x: number, y: number, timestamp: number}} */
    this.touchStart_ = null;
    /** @private {number} */
    this.deadSwipesCaptured_ = 0;
    /** @private {boolean|undefined} */
    this.hasUnobservableSurfaces_ = undefined;
    /** @private {number|undefined} */
    this.surfacesCheckedAt_ = undefined;

    // Bound listeners (upstream arrow-function properties).
    /** @private @const {function(?)} */
    this.clearMouseSelection_ = function() {
      clearTimeout(self.mouseSelectionTimer_);
      self.mouseSelectionTimer_ = undefined;
      self.mouseSelection_ = null;
    };
    /** @private @const {function(!Event)} */
    this.onMouseDown_ = function(e) {
      self.handleMouseDown_(e);
    };
    /** @private @const {function(!Event)} */
    this.onMouseOut_ = function(e) {
      if (isNull(e['relatedTarget'])) self.clearMouseSelection_(undefined);
    };
    /** @private @const {function(!Event)} */
    this.onMouseUp_ = function(e) {
      self.handleMouseUp_(e);
    };
    /** @private @const {function(!Event)} */
    this.onClick_ = function(e) {
      self.handleClick_(e);
    };
    /** @private @const {function(?)} */
    this.onScroll_ = function() {
      self.handleScroll_();
    };
    /** @private @const {function(!Event)} */
    this.onSelectionChange_ = function(e) {
      self.handleSelectionChange_(e);
    };
    /** @private @const {function(?)} */
    this.onVisibilityChange_ = function() {
      if (doc && doc.visibilityState === 'hidden') self.clearMouseSelection_(undefined);
      const firedAt = Date.now();
      self.lastVisibilityChange_ = firedAt;
      self.recordLivenessSignal_(true, firedAt);
    };
    /** @private @const {function(?)} */
    this.onFocusChange_ = function() {
      const firedAt = Date.now();
      self.lastFocusChange_ = firedAt;
      self.recordLivenessSignal_(false, firedAt);
    };
    /** @private @const {function(!Event)} */
    this.onTouchStart_ = function(e) {
      self.observeGesturePath_(e);
      const touches = e['touches'];
      const touch = touches && touches.length === 1 ? touches[0] : undefined;
      self.touchStart_ = touch ? {x: touch['clientX'], y: touch['clientY'], timestamp: Date.now()} : null;
    };
    /** @private @const {function(?)} */
    this.onTouchCancel_ = function() {
      self.touchStart_ = null;
    };
    /** @private @const {function(!Event)} */
    this.onTouchEnd_ = function(e) {
      self.handleTouchEnd_(e);
    };
  }

  /** @param {!Node} observerTarget */
  start(observerTarget) {
    const w = win;
    const capture = {capture: true, passive: undefined};
    addEventListener(w, 'click', this.onClick_, capture);
    addEventListener(w, 'mousedown', this.onMouseDown_, capture);
    addEventListener(w, 'mouseup', this.onMouseUp_, capture);
    addEventListener(w, 'mouseout', this.onMouseOut_, capture);
    addEventListener(w, 'dragstart', this.clearMouseSelection_, capture);
    addEventListener(w, 'pointercancel', this.clearMouseSelection_, capture);
    addEventListener(w, 'blur', this.clearMouseSelection_);
    addEventListener(w, 'scroll', this.onScroll_, capture);
    const sel = doc ? doc.getSelection() : null;
    this.hadSelection_ = !!sel && sel.type === 'Range';
    addEventListener(doc, 'selectionchange', this.onSelectionChange_);
    addEventListener(doc, 'visibilitychange', this.onVisibilityChange_);
    addEventListener(w, 'blur', this.onFocusChange_);
    addEventListener(w, 'focus', this.onFocusChange_);
    if (!this.mutationObserver_) {
      const MO = getNativeMutationObserver();
      const self = this;
      this.mutationObserver_ = new MO(function(mutations) {
        self.onMutation_(mutations);
      });
      this.observeRoot_(observerTarget);
    }
    if (this.captureDeadSwipes_) {
      const passive = {capture: true, passive: true};
      addEventListener(w, 'touchstart', this.onTouchStart_, passive);
      addEventListener(w, 'touchend', this.onTouchEnd_, passive);
      addEventListener(w, 'touchcancel', this.onTouchCancel_, passive);
    }
  }

  /**
   * @param {?Node|undefined} root
   * @private
   */
  observeRoot_(root) {
    if (!root || !this.mutationObserver_) return;
    if (this.observedRoots_.indexOf(root) !== -1) return;
    this.mutationObserver_.observe(root, {attributes: true, characterData: true, childList: true, subtree: true});
    this.observedRoots_.push(root);
    this.observeShadowRoots_(root, null);
  }

  /**
   * @param {!Node} node
   * @param {?Array<!Node>} scanned
   * @private
   */
  observeShadowRoots_(node, scanned) {
    if (isElementNode(node) && node['shadowRoot']) this.observeRoot_(node['shadowRoot']);
    const descendants = node['querySelectorAll'] ? node['querySelectorAll']('*') : [];
    for (let i = 0; i < descendants.length; i++) {
      if (scanned) scanned.push(descendants[i]);
      this.observeRoot_(descendants[i]['shadowRoot']);
    }
  }

  /**
   * @param {!Event} event
   * @private
   */
  observeGesturePath_(event) {
    const path = event.composedPath ? event.composedPath() : [];
    for (let i = 0; i < path.length; i++) {
      if (isInspectableElement(path[i])) this.observeRoot_(path[i]['shadowRoot']);
    }
  }

  stop() {
    if (this.mutationObserver_) this.mutationObserver_.disconnect();
    this.mutationObserver_ = null;
    this.observedRoots_ = [];
    const w = win;
    if (w) {
      const capture = /** @type {?} */ ({'capture': true});
      w.removeEventListener('click', this.onClick_, capture);
      w.removeEventListener('mousedown', this.onMouseDown_, capture);
      w.removeEventListener('mouseup', this.onMouseUp_, capture);
      w.removeEventListener('mouseout', this.onMouseOut_, capture);
      w.removeEventListener('dragstart', this.clearMouseSelection_, capture);
      w.removeEventListener('pointercancel', this.clearMouseSelection_, capture);
      w.removeEventListener('blur', this.clearMouseSelection_);
    }
    this.clearMouseSelection_(undefined);
    if (w) w.removeEventListener('scroll', this.onScroll_, /** @type {?} */ ({'capture': true}));
    if (doc) doc.removeEventListener('selectionchange', this.onSelectionChange_);
    if (w) {
      const capture = /** @type {?} */ ({'capture': true});
      w.removeEventListener('touchstart', this.onTouchStart_, capture);
      w.removeEventListener('touchend', this.onTouchEnd_, capture);
      w.removeEventListener('touchcancel', this.onTouchCancel_, capture);
    }
    if (doc) doc.removeEventListener('visibilitychange', this.onVisibilityChange_);
    if (w) {
      w.removeEventListener('blur', this.onFocusChange_);
      w.removeEventListener('focus', this.onFocusChange_);
    }
    this.touchStart_ = null;
  }

  /**
   * @param {!Array<!MutationRecord>} mutations
   * @private
   */
  onMutation_(mutations) {
    const scanned = [];
    for (let m = 0; m < mutations.length; m++) {
      const mutation = mutations[m];
      try {
        if (mutation.target && mutation.target['isConnected'] === false) continue;
        this.lastMutation_ = Date.now();
        const added = mutation.addedNodes;
        for (let i = 0; i < added.length; i++) {
          const node = added[i];
          if (isInspectableElement(node) && scanned.indexOf(node) === -1) this.observeShadowRoots_(node, scanned);
        }
      } catch (e) {}
    }
  }

  /**
   * @param {!Event} event
   * @private
   */
  handleMouseDown_(event) {
    this.observeGesturePath_(event);
    this.clearMouseSelection_(undefined);
    if (event['button'] === 0) {
      /** @type {!MouseSelectionGesture} */
      const gesture = {
        path: event.composedPath(),
        trusted: event.isTrusted,
        selectionChanged: false,
        selectionInitiallyRelated: false,
        clickTarget: undefined,
        clickDetail: undefined,
      };
      const selection = doc ? doc.getSelection() : null;
      gesture.selectionInitiallyRelated = !!selection && selection.type === 'Range' &&
          this.selectionTouchesGesture_(selection, gesture);
      this.mouseSelection_ = gesture;
    }
  }

  /**
   * @param {!Event} event
   * @private
   */
  handleMouseUp_(event) {
    const gesture = this.mouseSelection_;
    if (!gesture || event['button'] !== 0 || event.isTrusted !== gesture.trusted) return;
    const path = event.composedPath();
    for (let i = 0; i < gesture.path.length; i++) {
      const node = gesture.path[i];
      if (isInspectableElement(node) && path.indexOf(node) !== -1) {
        gesture.clickTarget = node;
        break;
      }
    }
    gesture.clickDetail = event['detail'];
    this.mouseSelectionTimer_ = setTimeout(this.clearMouseSelection_, 0);
  }

  /**
   * @param {!Event} event
   * @private
   */
  handleClick_(event) {
    this.observeGesturePath_(event);
    const click = asCandidate(event, 'click');
    const gesture = this.mouseSelection_;
    if (click && gesture && event['button'] === 0 && event['detail'] > 0 && event['detail'] === gesture.clickDetail &&
        event.isTrusted === gesture.trusted && click.node === gesture.clickTarget) {
      click.selectionChangedDuringGesture = gesture.selectionChanged && this.selectionChangeThresholdMs_ > 0;
      this.clearMouseSelection_(undefined);
    }
    if (!isNull(click) && !this.ignore_(click)) this.queueCandidate_(/** @type {!DeadClickCandidate} */ (click));
    this.scheduleCheck_();
  }

  /**
   * @param {!DeadClickCandidate} candidate
   * @private
   */
  queueCandidate_(candidate) {
    candidate.selectionChangedDelayMs = priorLivenessDelay(candidate.timestamp, this.lastSelectionChanged_,
        this.selectionChangeThresholdMs_);
    candidate.visibilityChangedDelayMs = priorLivenessDelay(candidate.timestamp, this.lastVisibilityChange_);
    candidate.focusChangedDelayMs = priorLivenessDelay(candidate.timestamp, this.lastFocusChange_);
    this.clicks_.push(candidate);
  }

  /** @private */
  scheduleCheck_() {
    if (this.clicks_.length && isUndefined(this.checkClickTimer_)) {
      const self = this;
      this.checkClickTimer_ = setTimeout(function() {
        self.checkClicks_();
      }, 1000);
    }
  }

  /** @private */
  handleScroll_() {
    const now = Date.now();
    this.lastScroll_ = now;
    if (now % 50 === 0) {
      this.clicks_.forEach(function(click) {
        if (isUndefined(click.scrollDelayMs)) click.scrollDelayMs = now - click.timestamp;
      });
    }
  }

  /**
   * @param {?Node|undefined} node
   * @param {!MouseSelectionGesture} gesture
   * @return {boolean}
   * @private
   */
  selectionIsInGesture_(node, gesture) {
    const target = /** @type {?} */ (gesture.path[0]);
    try {
      while (node) {
        if (gesture.path.indexOf(node) !== -1 || (isElementNode(target) && target.contains(node))) return true;
        node = node.getRootNode()['host'];
      }
    } catch (e) {}
    return false;
  }

  /**
   * @param {!Selection} selection
   * @param {!MouseSelectionGesture} gesture
   * @return {boolean}
   * @private
   */
  selectionTouchesGesture_(selection, gesture) {
    const target = /** @type {?} */ (gesture.path[0]);
    const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : undefined;
    let sameRoot = false;
    try {
      sameRoot = !!range && range.startContainer.getRootNode() === target.getRootNode();
    } catch (e) {
      sameRoot = false;
    }
    if (range && sameRoot && isElementNode(target)) {
      if (!range.collapsed) return !!range['intersectsNode'](target);
      const start = range.startContainer;
      const node = isElementNode(start) ? (start.childNodes[range.startOffset] || start) : start;
      return this.selectionIsInGesture_(node, gesture);
    }
    return this.selectionIsInGesture_(selection.focusNode, gesture) ||
        this.selectionIsInGesture_(selection.anchorNode, gesture);
  }

  /**
   * @param {!Event} event
   * @private
   */
  handleSelectionChange_(event) {
    const selection = doc ? doc.getSelection() : null;
    const hadSelection = this.hadSelection_;
    this.hadSelection_ = !!selection && selection.type === 'Range';
    const focusNode = selection ? selection.focusNode : null;
    const focusElement = focusNode && (isElementNode(focusNode) ? /** @type {!Element} */ (focusNode) :
        focusNode.parentElement);
    const documentActiveElement = doc ? doc.activeElement : null;
    let activeElement = documentActiveElement;
    while (activeElement && activeElement['shadowRoot'] && activeElement['shadowRoot']['activeElement']) {
      activeElement = activeElement['shadowRoot']['activeElement'];
    }
    const isEditing = isTextSelectionTarget(getEventTarget(event)) || isTextSelectionTarget(focusElement || null) ||
        isTextSelectionTarget(activeElement || null);
    const hasRetargetedCaret = !!selection && selection.type === 'Caret' && !!activeElement &&
        !activeElement['shadowRoot'] && !!focusNode && focusNode !== documentActiveElement &&
        focusNode.contains(documentActiveElement || null);
    if (!hadSelection && !this.hadSelection_ && !isEditing && !hasRetargetedCaret) return;
    const firedAt = Date.now();
    this.lastSelectionChanged_ = firedAt;
    const gesture = this.mouseSelection_;
    if (gesture && (hadSelection || this.hadSelection_ || isEditing)) {
      const eventTarget = getEventTarget(event);
      let editor = null;
      if (isTextSelectionTarget(eventTarget)) {
        editor = eventTarget;
      } else if (selection && selection.type === 'Caret') {
        if (isTextSelectionTarget(activeElement || null) || hasRetargetedCaret) {
          editor = activeElement;
        } else if (isEditing) {
          editor = focusElement;
        }
      }
      const related = editor ? this.selectionIsInGesture_(editor, gesture) :
          selection && (focusNode || selection.anchorNode) ? this.selectionTouchesGesture_(selection, gesture) :
          hadSelection && !this.hadSelection_ && gesture.selectionInitiallyRelated;
      gesture.selectionChanged = gesture.selectionChanged || !!related;
    }
    this.clicks_.forEach(function(c) {
      const delay = firedAt - c.timestamp;
      if (delay >= 0 && (isUndefined(c.selectionChangedDelayMs) || delay < c.selectionChangedDelayMs)) {
        c.selectionChangedDelayMs = delay;
      }
    });
  }

  /**
   * @param {boolean} visibility true: visibilityChangedDelayMs, false: focusChangedDelayMs
   * @param {number} firedAt
   * @private
   */
  recordLivenessSignal_(visibility, firedAt) {
    this.clicks_.forEach(function(c) {
      const delay = livenessDelayInWindow(firedAt - c.timestamp);
      if (!isNumber(delay)) return;
      if (visibility) {
        if (isUndefined(c.visibilityChangedDelayMs) || delay < c.visibilityChangedDelayMs) {
          c.visibilityChangedDelayMs = delay;
        }
      } else if (isUndefined(c.focusChangedDelayMs) || delay < c.focusChangedDelayMs) {
        c.focusChangedDelayMs = delay;
      }
    });
  }

  /**
   * @param {!Event} event
   * @private
   */
  handleTouchEnd_(event) {
    const start = this.touchStart_;
    this.touchStart_ = null;
    if (!start || this.deadSwipesCaptured_ >= this.maxDeadSwipes_) return;
    const changed = event['changedTouches'];
    const touch = changed ? changed[0] : undefined;
    if (!touch) return;
    const dx = touch['clientX'] - start.x;
    const dy = touch['clientY'] - start.y;
    const distanceSq = dx * dx + dy * dy;
    const threshold = this.swipeThresholdPx_;
    if (distanceSq < threshold * threshold) return;
    const gestureCausedActivity = [this.lastScroll_, this.lastMutation_, this.lastSelectionChanged_].some(function(t) {
      return isNumber(t) && t >= start.timestamp;
    });
    if (gestureCausedActivity) return;
    if (this.pageHasUnobservableSurfaces_()) {
      const stack = doc && doc['elementsFromPoint'] ? doc['elementsFromPoint'](start.x, start.y) || [] : [];
      if (stack.some(function(el) {
        return el.matches && el.matches(UNOBSERVABLE_SURFACE_SELECTOR);
      })) {
        return;
      }
    }
    const swipe = asCandidate(event, 'swipe');
    if (swipe) {
      swipe.swipeDirection = swipeDirection(dx, dy);
      swipe.swipeDistancePx = Math.round(Math.sqrt(distanceSq));
    }
    if (!isNull(swipe) && !this.ignore_(swipe)) this.queueCandidate_(/** @type {!DeadClickCandidate} */ (swipe));
    this.scheduleCheck_();
  }

  /**
   * @return {boolean}
   * @private
   */
  pageHasUnobservableSurfaces_() {
    const changed = isUndefined(this.surfacesCheckedAt_) ||
        (isNumber(this.lastMutation_) && this.lastMutation_ > this.surfacesCheckedAt_);
    if (isUndefined(this.hasUnobservableSurfaces_) || changed) {
      this.surfacesCheckedAt_ = Date.now();
      this.hasUnobservableSurfaces_ = !!doc && !!doc.querySelector(UNOBSERVABLE_SURFACE_SELECTOR);
    }
    return !!this.hasUnobservableSurfaces_;
  }

  /**
   * @param {?DeadClickCandidate} candidate
   * @return {boolean}
   * @private
   */
  ignore_(candidate) {
    if (!candidate) return true;
    return candidate.type === 'swipe' ? this.ignoreCommon_(candidate) : this.ignoreClick_(candidate);
  }

  /**
   * @param {!DeadClickCandidate} candidate
   * @return {boolean}
   * @private
   */
  ignoreCommon_(candidate) {
    if (isElementInToolbar(candidate.node)) return true;
    const seen = this.clicks_.some(function(c) {
      return c.type === candidate.type && c.node === candidate.node &&
          Math.abs(c.timestamp - candidate.timestamp) < 1000;
    });
    if (seen) return true;
    if (isTag(candidate.node, 'html') || !isElementNode(candidate.node)) return true;
    return !shouldCaptureDeadClick(candidate.node, {'css_selector_ignorelist': this.cssSelectorIgnorelist_});
  }

  /**
   * @param {!DeadClickCandidate} candidate
   * @return {boolean}
   * @private
   */
  ignoreClick_(candidate) {
    if (!this.captureWithModifierKeys_ && hasModifierKey(candidate.originalEvent)) return true;
    if (this.ignoreCommon_(candidate)) return true;
    return shouldSkipDeadClick(candidate.node);
  }

  /** @private */
  checkClicks_() {
    if (!this.clicks_.length) return;
    clearTimeout(this.checkClickTimer_);
    this.checkClickTimer_ = undefined;
    const toCheck = this.clicks_;
    this.clicks_ = [];
    for (let i = 0; i < toCheck.length; i++) {
      const click = toCheck[i];
      if (isUndefined(click.mutationDelayMs) || isNull(click.mutationDelayMs)) {
        click.mutationDelayMs = this.lastMutation_ && click.timestamp <= this.lastMutation_ ?
            this.lastMutation_ - click.timestamp : undefined;
      }
      click.absoluteDelayMs = Date.now() - click.timestamp;
      const scrollTimeout = checkTimeout(click.scrollDelayMs, this.scrollThresholdMs_);
      const selectionChangedTimeout = checkTimeout(click.selectionChangedDelayMs, this.selectionChangeThresholdMs_);
      const mutationTimeout = checkTimeout(click.mutationDelayMs, this.mutationThresholdMs_);
      const absoluteTimeout = checkTimeout(click.absoluteDelayMs, this.mutationThresholdMs_ * 1.1);
      const hadScroll = isNumber(click.scrollDelayMs) && click.scrollDelayMs < this.scrollThresholdMs_;
      const hadMutation = isNumber(click.mutationDelayMs) && click.mutationDelayMs < this.mutationThresholdMs_;
      const hadSelectionChange = click.selectionChangedDuringGesture ||
          (isNumber(click.selectionChangedDelayMs) && click.selectionChangedDelayMs < this.selectionChangeThresholdMs_);
      const hadVisibilityChange = isNumber(click.visibilityChangedDelayMs);
      const hadFocusChange = isNumber(click.focusChangedDelayMs);
      if (hadScroll || hadMutation || hadSelectionChange || hadVisibilityChange || hadFocusChange) continue;
      if (scrollTimeout || mutationTimeout || absoluteTimeout || selectionChangedTimeout) {
        const prefix = deadEventName(click);
        if (prefix === '$dead_swipe') {
          if (this.deadSwipesCaptured_ >= this.maxDeadSwipes_) continue;
          this.deadSwipesCaptured_++;
        }
        const props = {};
        props[prefix + '_last_mutation_timestamp'] = this.lastMutation_;
        props[prefix + '_event_timestamp'] = click.timestamp;
        props[prefix + '_scroll_timeout'] = scrollTimeout;
        props[prefix + '_mutation_timeout'] = mutationTimeout;
        props[prefix + '_absolute_timeout'] = absoluteTimeout;
        props[prefix + '_selection_changed_timeout'] = selectionChangedTimeout;
        props[prefix + '_visibility_changed_timeout'] = false;
        this.onCapture_(click, props);
      } else if (click.absoluteDelayMs < this.mutationThresholdMs_) {
        this.clicks_.push(click);
      }
    }
    this.scheduleCheck_();
  }

  /**
   * @param {!DeadClickCandidate} click
   * @param {!Object} properties
   * @private
   */
  captureDeadClick_(click, properties) {
    const prefix = deadEventName(click);
    const config = this.instance.config;
    const props = extend({}, properties, autocapturePropertiesForElement(click.node, {
      e: click.originalEvent,
      maskAllElementAttributes: config['mask_all_element_attributes'],
      maskAllText: config['mask_all_text'],
      elementAttributeIgnoreList: this.elementAttributeIgnorelist_,
      // Upstream: the UI still depends on $elements here.
      elementsChainAsString: false,
      disableCaptureUrlHashes: config['disable_capture_url_hashes'],
    }).props);
    props[prefix + '_scroll_delay_ms'] = click.scrollDelayMs;
    props[prefix + '_mutation_delay_ms'] = click.mutationDelayMs;
    props[prefix + '_absolute_delay_ms'] = click.absoluteDelayMs;
    props[prefix + '_selection_changed_delay_ms'] = click.selectionChangedDelayMs;
    props[prefix + '_visibility_changed_delay_ms'] = click.visibilityChangedDelayMs;
    props[prefix + '_focus_changed_delay_ms'] = click.focusChangedDelayMs;
    props['$dead_swipe_direction'] = click.swipeDirection;
    props['$dead_swipe_distance_px'] = click.swipeDistancePx;
    this.instance.capture(prefix, props, {'timestamp': new Date(click.timestamp)});
  }
}

/** Whether upstream would have loaded the lazy detector script by now. */
let detectorLoaded = false;

/** @return {boolean} heatmaps always run their own detector */
export function isDeadClicksEnabledForHeatmaps() {
  return true;
}

/**
 * @param {!DeadClicksAutocapture} dca
 * @return {boolean}
 */
export function isDeadClicksEnabledForAutocapture(dca) {
  const p = dca.instance.persistence;
  const isRemoteEnabled = !!(p && p.get_property(DEAD_CLICKS_ENABLED_SERVER_SIDE));
  const clientConfig = dca.instance.config['capture_dead_clicks'];
  if (isBoolean(clientConfig)) return /** @type {boolean} */ (clientConfig);
  if (isObject(clientConfig)) return true;
  return isRemoteEnabled;
}

/**
 * The dead clicks extension (upstream DeadClicksAutocapture).
 * @implements {Extension}
 */
export class DeadClicksAutocapture {
  /**
   * @param {!PostHog} instance
   * @param {function(!DeadClicksAutocapture): boolean} isEnabled
   * @param {?DeadClickCallback=} onCapture
   */
  constructor(instance, isEnabled, onCapture) {
    /** @type {!PostHog} */
    this.instance = instance;
    /** @private @const {function(!DeadClicksAutocapture): boolean} */
    this.isEnabled_ = isEnabled;
    /** @private @const {?DeadClickCallback|undefined} */
    this.onCapture_ = onCapture;
    /** @type {?DeadClickDetector} */
    this.detector = null;
    this.startIfEnabledOrStop();
  }

  /** @param {?Object} response remote config, null when loading failed */
  onRemoteConfig(response) {
    if (!response || !('captureDeadClicks' in response)) return;
    if (this.instance.persistence) {
      this.instance.persistence.register({[DEAD_CLICKS_ENABLED_SERVER_SIDE]: response['captureDeadClicks']});
    }
    this.startIfEnabledOrStop();
  }

  /** Re-checks `capture_dead_clicks` after `set_config`. */
  onConfigChange() {
    this.startIfEnabledOrStop();
  }

  startIfEnabledOrStop() {
    if (this.isEnabled_(this)) {
      // Upstream lazy-loads the detector script; with external dependency
      // loading disabled that load fails (until it has loaded once) and dead
      // clicks never start. The detector is compiled in here, so only the
      // refusal is mirrored.
      if (!detectorLoaded && this.instance.config['disable_external_dependency_loading']) {
        logger.error('failed to load script', 'Loading of external scripts is disabled');
        return;
      }
      detectorLoaded = true;
      this.start_();
    } else {
      this.stop();
    }
  }

  /** @private */
  start_() {
    if (!doc) {
      logger.error('`document` not found. Cannot start.');
      return;
    }
    if (!this.detector) {
      const userConfig = this.instance.config['capture_dead_clicks'];
      // Copied so the writes below can't leak into the user's config object.
      const config = isObject(userConfig) ? extend({}, userConfig) : {};
      if (this.onCapture_) config['capture_dead_swipes'] = false;
      this.detector = new DeadClickDetector(this.instance, config, this.onCapture_);
      this.detector.start(doc);
      logger.info('starting...');
    }
  }

  stop() {
    if (this.detector) {
      this.detector.stop();
      this.detector = null;
      logger.info('stopping...');
    }
  }
}
