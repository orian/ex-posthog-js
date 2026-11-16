/**
 * @fileoverview Autocapture (optional module). Port of upstream
 * browser-common/src/autocapture.ts with browser/src/browser-autocapture.ts's
 * config source: `$autocapture` for clicks/changes/submits, `$rageclick`,
 * `$copy_autocapture` (`autocapture.capture_copied_text`), `$input_value` for
 * allowlisted inputs, `$element_selectors`, and the server-side opt-out
 * persisted as `$autocapture_disabled_server_side`.
 */
import {PostHog} from '../core/posthog.js';
import {Extension} from '../core/extensions.js';
import {RageClick} from '../core/rageclick.js';
import {logger as baseLogger} from '../core/logger.js';
import {addEventListener, doc, includes, isArray, isBoolean, isFunction, isNull, isObject, win} from '../core/utils.js';
import {
  DEFAULT_AUTOCAPTURE_IGNORE_LIST, DomAutocaptureConfig, MAX_DOM_ANCESTOR_DEPTH, autocapturePropertiesForElement,
  elementMatchesCSSSelector, getClassNames, getEventTarget, isElementNode, isSensitiveElement, isShadowRoot, isTag,
  isTextNode, makeSafeText, shouldCaptureDomEvent, shouldCaptureElement, shouldCaptureRageclick,
} from '../dom/autocapture-utils.js';

const logger = baseLogger.createLogger('[AutoCapture]');

/** @const {string} */
export const AUTOCAPTURE_DISABLED_SERVER_SIDE = '$autocapture_disabled_server_side';
const COPY_AUTOCAPTURE_EVENT = '$copy_autocapture';
const EXCLUDED_INPUT_TYPES = ['password', 'hidden', 'file', 'checkbox', 'button', 'submit', 'reset', 'image'];
const DEFAULT_INPUT_TEXT_ALLOWLIST = ['[data-ph-capture-value]'];
const POINTER_EVENTS = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'];

/**
 * Upstream AutocaptureConfig, refreshed from `posthog.config` on every read
 * (BrowserAutocaptureConfigSource).
 * @implements {DomAutocaptureConfig}
 */
class AutocaptureConfig {
  constructor() {
    /** @type {boolean} */
    this.enabled = false;
    /** @type {*} */
    this.rageclick = false;
    /** @type {boolean} */
    this.maskAllElementAttributes = false;
    /** @type {boolean} */
    this.maskAllText = false;
    /** @type {boolean} */
    this.disableCaptureUrlHashes = false;
    /** @type {boolean} */
    this.remoteRequestsDisabled = false;
    /** @type {?} */
    this.getCurrentUrl = undefined;
    /** @type {?} */
    this.urlAllowlist = undefined;
    /** @type {?} */
    this.urlIgnorelist = undefined;
    /** @type {?} */
    this.domEventAllowlist = undefined;
    /** @type {?} */
    this.elementAllowlist = undefined;
    /** @type {?} */
    this.cssSelectorAllowlist = undefined;
    /** @type {?} */
    this.cssSelectorIgnorelist = undefined;
    /** @type {?} */
    this.elementAttributeIgnorelist = undefined;
    /** @type {?} */
    this.captureCopiedText = undefined;
    /** @type {?} */
    this.captureValueAllowlist = undefined;
  }
}

/**
 * @param {!Element} element
 * @return {boolean}
 */
function isValueInputElement(element) {
  if (isTag(element, 'input')) return !includes(EXCLUDED_INPUT_TYPES, element['type']);
  return isTag(element, 'textarea') || (isTag(element, 'select') && !element['multiple']);
}

/**
 * Value privacy checks cross shadow hosts and fail closed.
 * @param {!Element} target
 * @param {!AutocaptureConfig} config
 * @return {boolean}
 */
function isInputValueEligible(target, config) {
  if (!shouldCaptureElement(target)) return false;
  const ignorelist = config.cssSelectorIgnorelist != null ? config.cssSelectorIgnorelist :
      DEFAULT_AUTOCAPTURE_IGNORE_LIST;
  const seen = [];
  let element = /** @type {?Element} */ (target);
  if (isTag(target, 'select')) {
    const select = /** @type {!HTMLSelectElement} */ (target);
    element = select.options[select.selectedIndex] || target;
  }
  while (element) {
    const current = element;
    const classes = getClassNames(current);
    if (seen.length >= MAX_DOM_ANCESTOR_DEPTH || seen.indexOf(element) !== -1 || includes(classes, 'ph-sensitive') ||
        includes(classes, 'ph-no-capture') || ignorelist.some(function(s) {
          return elementMatchesCSSSelector(current, s);
        })) {
      return false;
    }
    seen.push(element);
    const parent = element['assignedSlot'] || element.parentNode;
    element = isShadowRoot(parent) ? parent['host'] : parent && isElementNode(parent) ? parent : null;
  }
  return true;
}

/**
 * @typedef {{target: !Element, excluded: boolean, id: number, x: number, y: number, released: boolean,
 *     distinctId: (string|undefined)}}
 */
let PointerDown;

/**
 * @implements {Extension}
 * @unrestricted public aliases (rageclicks)
 */
export class Autocapture {
  /** @param {!PostHog} instance */
  constructor(instance) {
    /** @type {!PostHog} */
    this.instance = instance;
    /** @type {boolean} */
    this.initialized = false;
    /** @type {?boolean} */
    this.isDisabledServerSide = null;
    /** @type {boolean} */
    this.hasReceivedConfigResponse = false;
    /** @type {?Array<string>} */
    this.elementSelectors = null;
    /** @private {!Array<{owner: *, selectors: !Array<string>}>} */
    this.elementSelectorsByOwner_ = [];
    /** @type {boolean} */
    this.elementsChainAsString = false;
    /** @private @const {!AutocaptureConfig} */
    this.config_ = new AutocaptureConfig();
    /** @private {?function(!Event)} */
    this.domEventHandler_ = null;
    /** @private {?function(!Event)} */
    this.copiedTextHandler_ = null;
    /** @private {?Window} */
    this.listenerWindow_ = null;
    /** @private {?Document} */
    this.listenerDocument_ = null;
    /** @private {boolean} */
    this.disposed_ = false;
    /** @private {boolean} */
    this.setUp_ = false;
    /** @private {?PointerDown} */
    this.pointerDown_ = null;
    /** @private {number|undefined} */
    this.pointerExpiry_ = undefined;
    this.refreshConfig_();
    /** @type {!RageClick} */
    this.rageclicks = new RageClick(this.config_.rageclick);
    this['rageclicks'] = this.rageclicks; // public, like upstream
  }

  /** @private @return {!AutocaptureConfig} */
  refreshConfig_() {
    const config = this.instance.config;
    const ac = isObject(config['autocapture']) ? config['autocapture'] : undefined;
    const t = this.config_;
    t.enabled = !!config['autocapture'];
    t.rageclick = config['rageclick'];
    t.maskAllElementAttributes = config['mask_all_element_attributes'];
    t.maskAllText = config['mask_all_text'];
    t.disableCaptureUrlHashes = config['disable_capture_url_hashes'];
    t.getCurrentUrl = config['get_current_url'];
    t.remoteRequestsDisabled = this.instance.shouldDisableFlags();
    t.urlAllowlist = ac ? ac['url_allowlist'] : undefined;
    t.urlIgnorelist = ac ? ac['url_ignorelist'] : undefined;
    t.domEventAllowlist = ac ? ac['dom_event_allowlist'] : undefined;
    t.elementAllowlist = ac ? ac['element_allowlist'] : undefined;
    t.cssSelectorAllowlist = ac ? ac['css_selector_allowlist'] : undefined;
    t.cssSelectorIgnorelist = ac ? ac['css_selector_ignorelist'] : undefined;
    t.elementAttributeIgnorelist = ac ? ac['element_attribute_ignorelist'] : undefined;
    t.captureCopiedText = ac ? ac['capture_copied_text'] : undefined;
    const valueAllowlist = ac ? ac['capture_value_css_selector_allowlist'] : undefined;
    t.captureValueAllowlist = valueAllowlist != null ? valueAllowlist : DEFAULT_INPUT_TEXT_ALLOWLIST;
    return t;
  }

  /** @private @return {!AutocaptureConfig} */
  compileUrlPatterns_() {
    const t = this.refreshConfig_();
    /** @param {?} list @return {?} */
    const compile = function(list) {
      return list ? list.map(function(url) {
        return new RegExp(url);
      }) : list;
    };
    t.urlAllowlist = compile(t.urlAllowlist);
    t.urlIgnorelist = compile(t.urlIgnorelist);
    return t;
  }

  /** Upstream setup(client). */
  onInit() {
    this.compileUrlPatterns_();
    this.setUp_ = true;
    this.startIfEnabled();
  }

  /** @private */
  clearPointer_() {
    this.pointerDown_ = null;
    clearTimeout(this.pointerExpiry_);
    this.pointerExpiry_ = undefined;
  }

  /**
   * @param {!Element} target
   * @return {boolean}
   * @private
   */
  isExcludedPointerTarget_(target) {
    if (!shouldCaptureElement(target)) return true;
    const c = this.refreshConfig_();
    const ignorelist = c.cssSelectorIgnorelist != null ? c.cssSelectorIgnorelist : DEFAULT_AUTOCAPTURE_IGNORE_LIST;
    const seen = [];
    let el = /** @type {?Element} */ (target);
    while (el) {
      if (seen.length >= MAX_DOM_ANCESTOR_DEPTH || seen.indexOf(el) !== -1) return true;
      seen.push(el);
      const current = el;
      const classes = getClassNames(current);
      if (includes(classes, 'ph-no-capture') || includes(classes, 'ph-sensitive') || isSensitiveElement(current) ||
          ignorelist.some(function(s) {
            return elementMatchesCSSSelector(current, s);
          })) {
        return true;
      }
      const parent = el.parentNode;
      el = isShadowRoot(parent) ? parent['host'] : parent && isElementNode(parent) ? /** @type {!Element} */ (parent) :
          null;
    }
    return false;
  }

  /**
   * @param {!Event} event
   * @private
   */
  trackPointer_(event) {
    const e = /** @type {!PointerEvent} */ (event);
    if (!this.checkEnabled() || e.type === 'pointercancel') {
      this.clearPointer_();
      return;
    }
    if (e.type === 'pointerdown') {
      this.clearPointer_();
      const target = getEventTarget(e);
      if (e.isPrimary && e.button === 0 && !e.ctrlKey && target && isElementNode(target)) {
        this.pointerDown_ = {
          target: target,
          excluded: this.isExcludedPointerTarget_(target),
          id: e.pointerId,
          x: e.clientX,
          y: e.clientY,
          released: false,
          distinctId: this.instance.get_distinct_id(),
        };
      }
      return;
    }
    const down = this.pointerDown_;
    if (!down) return;
    if (e.pointerId !== down.id || Math.abs(e.clientX - down.x) > 5 || Math.abs(e.clientY - down.y) > 5) {
      this.clearPointer_();
    } else if (e.type === 'pointerup') {
      down.released = true;
      const self = this;
      this.pointerExpiry_ = setTimeout(function() {
        self.clearPointer_();
      }, 0);
    }
  }

  /**
   * A click whose target is html/body after the DOM changed under the pointer:
   * attribute it to the pointerdown target.
   * @param {!Event} event
   * @return {?Element|undefined} null = drop, undefined = no override
   * @private
   */
  recoverClickTarget_(event) {
    const e = /** @type {!PointerEvent} */ (event);
    const down = this.pointerDown_;
    this.clearPointer_();
    const target = getEventTarget(e);
    if (down && down.released && down.target.isConnected && down.distinctId === this.instance.get_distinct_id() &&
        e.pointerId === down.id && (e.detail > 0 || e.pointerType === 'touch' || e.pointerType === 'pen') &&
        e.button === 0 && Math.abs(e.clientX - down.x) <= 5 && Math.abs(e.clientY - down.y) <= 5 && target &&
        (isTag(target, 'html') || isTag(target, 'body'))) {
      if (down.excluded) return null;
      const c = this.refreshConfig_();
      const ignorelist = c.cssSelectorIgnorelist != null ? c.cssSelectorIgnorelist : DEFAULT_AUTOCAPTURE_IGNORE_LIST;
      const roots = [target, doc ? doc.documentElement : null, doc ? doc.body : null];
      const excludedRoot = roots.some(function(root) {
        if (!root) return false;
        const classes = getClassNames(root);
        return includes(classes, 'ph-no-capture') || includes(classes, 'ph-sensitive') || !shouldCaptureElement(root) ||
            isSensitiveElement(root) || ignorelist.some(function(s) {
              return elementMatchesCSSSelector(root, s);
            });
      });
      if (excludedRoot) return null;
      return down.target;
    }
    return undefined;
  }

  /** @private */
  addDomEventHandlers_() {
    if (!this.isBrowserSupported()) {
      logger.info('Disabling Automatic Event Collection because this browser is not supported');
      return;
    }
    if (!win || !doc) return;
    this.listenerWindow_ = win;
    this.listenerDocument_ = doc;
    const self = this;
    const handler = this.domEventHandler_ = function(ev) {
      const e = ev || win.event;
      try {
        if (e.type === 'blur') {
          self.clearPointer_();
          return;
        }
        if (e.type.indexOf('pointer') === 0) {
          self.trackPointer_(e);
          return;
        }
        const target = e.type === 'click' ? self.recoverClickTarget_(e) : undefined;
        if (isNull(target)) return;
        self.captureEvent_(e, '$autocapture', target || undefined);
      } catch (error) {
        logger.error('Failed to capture event', error);
      }
    };
    addEventListener(win, 'blur', handler);
    addEventListener(doc, 'submit', handler, {capture: true, passive: undefined});
    addEventListener(doc, 'change', handler, {capture: true, passive: undefined});
    addEventListener(doc, 'click', handler, {capture: true, passive: undefined});
    POINTER_EVENTS.forEach(function(type) {
      addEventListener(doc, type, handler, {capture: true, passive: undefined});
    });
    if (this.refreshConfig_().captureCopiedText) {
      const copied = this.copiedTextHandler_ = function(ev) {
        const e = ev || win.event;
        try {
          self.captureEvent_(e, COPY_AUTOCAPTURE_EVENT, undefined);
        } catch (error) {
          logger.error('Failed to capture clipboard event', error);
        }
      };
      addEventListener(doc, 'copy', copied, {capture: true, passive: undefined});
      addEventListener(doc, 'cut', copied, {capture: true, passive: undefined});
      addEventListener(doc, 'paste', copied, {capture: true, passive: undefined});
    }
  }

  /** @private */
  removeDomEventHandlers_() {
    const w = this.listenerWindow_;
    const d = this.listenerDocument_;
    this.clearPointer_();
    const handler = this.domEventHandler_;
    if (handler) {
      if (w) w.removeEventListener('blur', handler);
      if (d) {
        POINTER_EVENTS.forEach(function(type) {
          d.removeEventListener(type, handler, true);
        });
        d.removeEventListener('submit', handler, true);
        d.removeEventListener('change', handler, true);
        d.removeEventListener('click', handler, true);
      }
      this.domEventHandler_ = null;
    }
    const copied = this.copiedTextHandler_;
    if (copied) {
      if (d) {
        d.removeEventListener('copy', copied, true);
        d.removeEventListener('cut', copied, true);
        d.removeEventListener('paste', copied, true);
      }
      this.copiedTextHandler_ = null;
    }
    this.listenerWindow_ = null;
    this.listenerDocument_ = null;
    this.initialized = false;
  }

  startIfEnabled() {
    const enabled = this.checkEnabled();
    if (!enabled) this.clearPointer_();
    if (!this.disposed_ && this.setUp_ && enabled && !this.initialized) {
      this.addDomEventHandlers_();
      this.initialized = true;
    }
  }

  /** Re-checks enablement after `set_config` (upstream calls startIfEnabled there). */
  onConfigChange() {
    this.startIfEnabled();
  }

  /** Removes the DOM listeners for good. */
  dispose() {
    if (this.disposed_) return;
    this.disposed_ = true;
    this.elementSelectorsByOwner_ = [];
    this.elementSelectors = null;
    this.removeDomEventHandlers_();
  }

  /** @param {?Object} response remote config, null when loading failed */
  onRemoteConfig(response) {
    if (this.disposed_) return;
    this.hasReceivedConfigResponse = true;
    if (!response) {
      // Unknown opt-out: keep the last known persisted value, no persistence write.
      this.startIfEnabled();
      return;
    }
    if (response['elementsChainAsString']) this.elementsChainAsString = response['elementsChainAsString'];
    const optOut = response['autocapture_opt_out'];
    if (isBoolean(optOut)) {
      if (this.instance.persistence) this.instance.persistence.register({[AUTOCAPTURE_DISABLED_SERVER_SIDE]: optOut});
      this.isDisabledServerSide = /** @type {boolean} */ (optOut);
    }
    this.startIfEnabled();
  }

  /**
   * Selectors (from surveys/product tours actions) reported in
   * `$element_selectors` when they match the clicked element.
   * @param {*} selectors a Set or array of selectors
   * @param {*=} owner
   */
  setElementSelectors(selectors, owner) {
    if (this.disposed_) return;
    const key = arguments.length > 1 && owner !== undefined ? owner : this;
    const list = [];
    if (selectors && isFunction(selectors['forEach'])) {
      selectors['forEach'](function(s) {
        if (list.indexOf(s) === -1) list.push(s);
      });
    }
    this.elementSelectorsByOwner_ = this.elementSelectorsByOwner_.filter(function(c) {
      return c.owner !== key;
    });
    if (list.length) this.elementSelectorsByOwner_.push({owner: key, selectors: list});
    const combined = [];
    this.elementSelectorsByOwner_.forEach(function(c) {
      c.selectors.forEach(function(s) {
        if (combined.indexOf(s) === -1) combined.push(s);
      });
    });
    this.elementSelectors = combined;
  }

  /**
   * @param {?Element} element
   * @param {?Element=} additionalElement
   * @return {!Array<string>}
   */
  getElementSelectors(element, additionalElement) {
    const out = [];
    (this.elementSelectors || []).forEach(function(selector) {
      const matched = doc ? doc.querySelectorAll(selector) : null;
      if (!matched) return;
      for (let i = 0; i < matched.length; i++) {
        const m = matched[i];
        if ((element === m || additionalElement === m) && out.indexOf(selector) === -1) out.push(selector);
      }
    });
    return out;
  }

  /** @return {boolean} */
  checkEnabled() {
    if (this.disposed_) return false;
    const persisted = this.instance.persistence ?
        this.instance.persistence.get_property(AUTOCAPTURE_DISABLED_SERVER_SIDE) : undefined;
    const memoryDisabled = this.isDisabledServerSide;
    const config = this.refreshConfig_();
    if (!config.remoteRequestsDisabled && !this.hasReceivedConfigResponse) return false;
    const clientConfigOnly = config.remoteRequestsDisabled && !this.hasReceivedConfigResponse;
    if (isNull(memoryDisabled) && !isBoolean(persisted) && !clientConfigOnly) return false;
    const disabledServer = !isNull(memoryDisabled) ? memoryDisabled : !!persisted;
    return !!config.enabled && !disabledServer;
  }

  /**
   * @param {!Event} e
   * @param {string} eventName
   * @param {!Element|undefined} targetOverride
   * @return {boolean|undefined}
   * @private
   */
  captureEvent_(e, eventName, targetOverride) {
    if (!this.checkEnabled()) {
      this.clearPointer_();
      return undefined;
    }
    let target = /** @type {?} */ (targetOverride || getEventTarget(e));
    if (isTextNode(target)) target = target.parentNode || null;
    const config = this.compileUrlPatterns_();
    if (eventName === '$autocapture' && e.type === 'click' && e instanceof MouseEvent) {
      const me = /** @type {!MouseEvent} */ (e);
      if (!!config.rageclick && this.rageclicks.isRageClick(me.clientX, me.clientY, me.timeStamp || new Date().getTime())) {
        if (shouldCaptureRageclick(target, config.rageclick)) this.captureEvent_(e, '$rageclick', targetOverride);
      }
    }
    const isClipboard = eventName === COPY_AUTOCAPTURE_EVENT;
    let eventConfig = config;
    if (isClipboard) {
      // Clipboard events ignore dom_event_allowlist.
      eventConfig = /** @type {!AutocaptureConfig} */ (Object.create(config));
      eventConfig.domEventAllowlist = undefined;
    }
    if (target && shouldCaptureDomEvent(target, e, eventConfig, isClipboard,
        isClipboard ? ['copy', 'cut', 'paste'] : undefined)) {
      const r = autocapturePropertiesForElement(target, {
        e: e,
        maskAllElementAttributes: config.maskAllElementAttributes,
        maskAllText: config.maskAllText,
        elementAttributeIgnoreList: config.elementAttributeIgnorelist,
        elementsChainAsString: this.elementsChainAsString,
        disableCaptureUrlHashes: config.disableCaptureUrlHashes,
      });
      if (r.explicitNoCapture) return false;
      const props = r.props;
      const selectors = this.getElementSelectors(target, r.target);
      if (selectors && selectors.length > 0) props['$element_selectors'] = selectors;
      if (isClipboard) {
        const clipType = e.type || 'clipboard';
        if (clipType !== 'paste') {
          const selection = win && win.getSelection ? win.getSelection() : null;
          const selectedText = selection ? selection.toString() : undefined;
          const selectedContent = makeSafeText(selectedText);
          if (!selectedContent) return false;
          props['$selected_content'] = selectedContent;
          props['$clipboard_text_length'] = selectedText ? selectedText.length : 0;
        }
        props['$copy_type'] = clipType;
      }
      if (eventName === '$autocapture' && e.type === 'change' && config.captureValueAllowlist && !config.maskAllText &&
          isValueInputElement(target) && isInputValueEligible(target, config) &&
          !target.querySelector('.ph-no-capture, .ph-sensitive')) {
        const allowlist = config.captureValueAllowlist;
        let captureValue = false;
        try {
          captureValue = isFunction(allowlist) ? !!allowlist(target) :
              isArray(allowlist) && allowlist.some(function(s) {
                return elementMatchesCSSSelector(target, s);
              });
        } catch (error) {
          logger.error('capture_value_css_selector_allowlist threw', error);
        }
        if (captureValue) props['$input_value'] = target['value'];
      }
      this.instance.capture(eventName, props);
      return true;
    }
    return undefined;
  }

  /** @return {boolean} */
  isBrowserSupported() {
    return !!doc && isFunction(doc.querySelectorAll);
  }
}
