/**
 * @fileoverview Shared DOM helpers for autocapture, heatmaps and dead clicks.
 * Port of upstream browser-common/src/utils/autocapture-utils.ts,
 * element-utils.ts and the element-properties half of autocapture.ts
 * (`autocapturePropertiesForElement`, the `$elements_chain` builder).
 *
 * It is its own module (and Closure chunk, `dom`) because all three features
 * need it and each can be loaded without the others: autocapture uses the
 * whole file, heatmaps the rageclick/target helpers, and dead clicks the
 * element properties of `$dead_click`. Keeping it out of the core keeps the
 * core free of DOM-walking code.
 *
 * ES5 built-ins only: no Set/Map, no Array.prototype.includes/findIndex.
 */
import {logger as baseLogger} from '../core/logger.js';
import {DEFAULT_CONTENT_IGNORELIST, DEFAULT_CONTENT_IGNORELIST_WITH_STEPPERS} from '../core/rageclick.js';
import {
  doc, extend, includes, isArray, isBoolean, isFunction, isNullish, isString, isUndefined, stripUrlHash, win,
} from '../core/utils.js';

const logger = baseLogger.createLogger('[AutoCapture]');

/** Upstream MAX_DOM_ANCESTOR_DEPTH: bounds ancestor walks over patched/cyclic parent chains. */
export const MAX_DOM_ANCESTOR_DEPTH = 1000;

const NODE_TYPE_ELEMENT = 1;
const NODE_TYPE_TEXT = 3;
const NODE_TYPE_DOCUMENT_FRAGMENT = 11;
const TOOLBAR_ID = '__POSTHOG_TOOLBAR__';
const TOOLBAR_CONTAINER_CLASS = 'toolbar-global-fade-container';

/**
 * Autocapture settings that `shouldCaptureDomEvent` and friends read (the
 * DOM part of upstream's AutocaptureConfig). Values come from user config, so
 * they are loosely typed like upstream's runtime values.
 * @record
 */
export class DomAutocaptureConfig {
  constructor() {
    /** @type {?} */
    this.urlAllowlist;
    /** @type {?} */
    this.urlIgnorelist;
    /** @type {?} */
    this.domEventAllowlist;
    /** @type {?} */
    this.elementAllowlist;
    /** @type {?} */
    this.cssSelectorAllowlist;
    /** @type {?} */
    this.cssSelectorIgnorelist;
    /** @type {?} */
    this.getCurrentUrl;
  }
}

// ---------------------------------------------------------------------------
// element-utils.ts

/**
 * @param {*} el
 * @return {boolean}
 */
export function isElementNode(el) {
  return !!el && el['nodeType'] === NODE_TYPE_ELEMENT;
}

/**
 * @param {*} el
 * @param {string} tag
 * @return {boolean}
 */
export function isTag(el, tag) {
  return !!el && !!el['tagName'] && String(el['tagName']).toLowerCase() === tag.toLowerCase();
}

/**
 * @param {*} el
 * @return {boolean}
 */
export function isTextNode(el) {
  return !!el && el['nodeType'] === NODE_TYPE_TEXT;
}

/**
 * A DocumentFragment whose `host` is a real element.
 * @param {*} el
 * @return {boolean}
 */
export function isShadowRoot(el) {
  return !!el && el['nodeType'] === NODE_TYPE_DOCUMENT_FRAGMENT && isElementNode(el['host']);
}

/**
 * @param {*} el
 * @return {boolean}
 */
export function isElementInToolbar(el) {
  if (typeof Element !== 'undefined' && el instanceof Element) {
    const e = /** @type {!Element} */ (el);
    return e.id === TOOLBAR_ID || !!(e['closest'] && e['closest']('.' + TOOLBAR_CONTAINER_CLASS));
  }
  return false;
}

// ---------------------------------------------------------------------------
// autocapture-utils.ts

/**
 * @param {string} s
 * @return {!Array<string>}
 */
export function splitClassString(s) {
  return s ? s.trim().split(/\s+/) : [];
}

/**
 * Upstream getTargetingUrl: window.location.href through `get_current_url`.
 * @param {?} getCurrentUrl
 * @return {string|undefined}
 */
function getTargetingUrl(getCurrentUrl) {
  const defaultUrl = win && win.location ? win.location.href : undefined;
  if (isUndefined(defaultUrl)) return undefined;
  if (!isFunction(getCurrentUrl)) return defaultUrl;
  try {
    const result = getCurrentUrl(defaultUrl);
    return isString(result) && result ? result : defaultUrl;
  } catch (e) {
    baseLogger.error('Error in get_current_url, falling back to window.location.href', e);
    return defaultUrl;
  }
}

/**
 * @param {?} urlsList
 * @param {*} getCurrentUrl
 * @return {boolean}
 */
function checkForURLMatches(urlsList, getCurrentUrl) {
  const url = getTargetingUrl(getCurrentUrl);
  return !!(url && urlsList && urlsList.some(function(regex) {
    return url.match(regex);
  }));
}

/**
 * The element's classes; handles SVGAnimatedString className.
 * @param {!Element} el
 * @return {!Array<string>}
 */
export function getClassNames(el) {
  let className = '';
  const raw = /** @type {?} */ (el.className);
  switch (typeof raw) {
    case 'string':
      className = raw;
      break;
    case 'object':
      className = (raw && 'baseVal' in raw ? raw['baseVal'] : null) || el.getAttribute('class') || '';
      break;
    default:
      className = '';
  }
  return splitClassString(className);
}

/**
 * @param {?string|undefined} s
 * @return {?string}
 */
export function makeSafeText(s) {
  if (isNullish(s)) return null;
  return String(s).trim()
      .split(/(\s+)/)
      .filter(function(part) {
        return shouldCaptureValue(part);
      })
      .join('')
      .replace(/[\r\n]/g, ' ')
      .replace(/[ ]+/g, ' ')
      .substring(0, 255);
}

/**
 * Direct text of an element (its text-node children only), scrubbed.
 * @param {!Element} el
 * @return {string}
 */
export function getSafeText(el) {
  let elText = '';
  if (shouldCaptureElement(el) && !isSensitiveElement(el) && el.childNodes && el.childNodes.length) {
    const children = el.childNodes;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (isTextNode(child) && child.textContent) {
        const safe = makeSafeText(child.textContent);
        elText += isNullish(safe) ? '' : safe;
      }
    }
  }
  return elText.trim();
}

/**
 * @param {!Event} e
 * @return {?Element}
 */
export function getEventTarget(e) {
  const target = /** @type {?} */ (e.target);
  if (isUndefined(target)) return /** @type {?} */ (e['srcElement']) || null;
  if (target && target['shadowRoot']) return /** @type {?} */ (e.composedPath()[0]) || null;
  return target || null;
}

/** @const {!Array<string>} */
export const autocaptureCompatibleElements = ['a', 'button', 'form', 'input', 'select', 'textarea', 'label'];

/**
 * @param {!Array<!Element>} elements
 * @param {?DomAutocaptureConfig|undefined} config
 * @return {boolean}
 */
function checkIfElementTreePassesElementAllowList(elements, config) {
  const allowlist = config ? config.elementAllowlist : undefined;
  if (isUndefined(allowlist)) return true;
  for (let i = 0; i < elements.length; i++) {
    const tag = elements[i].tagName.toLowerCase();
    if (allowlist.some(function(t) {
      return tag === t;
    })) {
      return true;
    }
  }
  return false;
}

/**
 * @param {!Element} el
 * @param {string} selector
 * @return {boolean}
 */
export function elementMatchesCSSSelector(el, selector) {
  const e = /** @type {?} */ (el);
  const matches = e['matches'] || e['matchesSelector'] || e['msMatchesSelector'] || e['mozMatchesSelector'] ||
      e['webkitMatchesSelector'] || e['oMatchesSelector'];
  try {
    return matches ? !!matches.call(el, selector) : false;
  } catch (err) {
    return false;
  }
}

/**
 * undefined list: everything matches; otherwise any element matching any selector.
 * @param {!Array<!Element>} elements
 * @param {?} selectorList
 * @return {boolean}
 */
function checkIfElementsMatchCSSSelector(elements, selectorList) {
  if (isUndefined(selectorList)) return true;
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (selectorList.some(function(s) {
      return elementMatchesCSSSelector(el, s);
    })) {
      return true;
    }
  }
  return false;
}

/**
 * @param {!Element} curEl
 * @return {?Element} null for upstream's `false`
 */
export function getParentElement(curEl) {
  const parentNode = curEl.parentNode;
  if (!parentNode || !isElementNode(parentNode)) return null;
  return /** @type {!Element} */ (parentNode);
}

/** @const {!Array<string>} */
export const DEFAULT_AUTOCAPTURE_IGNORE_LIST = ['.ph-no-autocapture', '[data-ph-no-autocapture]'];

const MAX_CONTENT_IGNORELIST_ENTRIES = DEFAULT_CONTENT_IGNORELIST_WITH_STEPPERS.length + 10;
const INTERACTIVE_TAGS = ['button', 'a', 'input', 'select', 'textarea', 'label'];
const INTERACTIVE_ROLES = ['button', 'link', 'tab', 'menuitem', 'option'];

/**
 * Symbols match exactly; shipped word keywords match whole words; other user
 * words match as substrings.
 * @param {string} text
 * @param {string} keyword
 * @return {boolean}
 */
function matchesContentKeyword(text, keyword) {
  if (!/[a-z0-9]/i.test(keyword)) return text === keyword;
  return includes(DEFAULT_CONTENT_IGNORELIST_WITH_STEPPERS, keyword) ?
      new RegExp('\\b' + keyword + '\\b').test(text) : text.indexOf(keyword) !== -1;
}

/**
 * @param {*} contentIgnorelist
 * @param {{safeText: string, ariaLabel: string}} label
 * @return {boolean}
 */
function shouldIgnoreByContent(contentIgnorelist, label) {
  let keywords;
  if (contentIgnorelist === true) {
    keywords = DEFAULT_CONTENT_IGNORELIST;
  } else if (isArray(contentIgnorelist)) {
    const list = /** @type {!Array<string>} */ (contentIgnorelist);
    if (list.length > MAX_CONTENT_IGNORELIST_ENTRIES) {
      logger.error('[PostHog] content_ignorelist array cannot exceed ' + MAX_CONTENT_IGNORELIST_ENTRIES +
          ' items. Use css_selector_ignorelist for more complex matching.');
      return false;
    }
    keywords = list.map(function(k) {
      return k.toLowerCase();
    });
  } else {
    return false;
  }
  return keywords.some(function(keyword) {
    return matchesContentKeyword(label.safeText, keyword) || matchesContentKeyword(label.ariaLabel, keyword);
  });
}

/**
 * @param {!Element} el
 * @return {boolean}
 */
function isInteractiveElement(el) {
  return includes(INTERACTIVE_TAGS, el.tagName.toLowerCase()) ||
      includes(INTERACTIVE_ROLES, (el.getAttribute('role') || '').toLowerCase());
}

/**
 * Label of the nearest interactive ancestor (or the pointer-cursor run).
 * @param {!Element} el
 * @param {!Array<!Element>} targetElementList
 * @return {{safeText: string, ariaLabel: string}}
 */
function clickedControlText(el, targetElementList) {
  for (let i = 0; i < targetElementList.length; i++) {
    if (isInteractiveElement(targetElementList[i])) return controlLabelText(targetElementList[i]);
  }
  for (let i = 0; i < targetElementList.length; i++) {
    const candidate = targetElementList[i];
    try {
      if (win.getComputedStyle(candidate).getPropertyValue('cursor') !== 'pointer') break;
    } catch (e) {
      break;
    }
    const label = controlLabelText(candidate);
    if (label.safeText || label.ariaLabel) return label;
  }
  return controlLabelText(el);
}

/**
 * @param {!Element} control
 * @return {{safeText: string, ariaLabel: string}}
 */
function controlLabelText(control) {
  let text = '';
  let firstAriaLabel = '';
  /** @param {?} node */
  const collect = function(node) {
    if (isElementNode(node) && shouldCaptureElement(node) && !isSensitiveElement(node)) {
      text += ' ' + getSafeText(node);
      firstAriaLabel = firstAriaLabel || node.getAttribute('aria-label') || '';
      const children = node.childNodes;
      for (let i = 0; i < children.length; i++) collect(children[i]);
    }
  };
  collect(control);
  text = text.replace(/\s+/g, ' ').trim();
  const safeText = (shouldCaptureValue(text) ? text : '').toLowerCase();
  const ariaLabel = control.getAttribute('aria-label') || (safeText ? '' : firstAriaLabel);
  return {safeText: safeText, ariaLabel: ariaLabel.trim().toLowerCase()};
}

const DEFAULT_DEAD_CLICK_IGNORE_LIST = ['.ph-no-deadclick', '.ph-no-capture'];

/**
 * @param {?Element} el
 * @param {*} config `capture_dead_clicks`-like: boolean or {css_selector_ignorelist}
 * @return {boolean}
 */
export function shouldCaptureDeadClick(el, config) {
  if (!win || cannotCheckForAutocapture(el)) return false;
  const ignorelist = isBoolean(config) ? DEFAULT_DEAD_CLICK_IGNORE_LIST :
      (config && !isNullish(config['css_selector_ignorelist']) ? config['css_selector_ignorelist'] :
          DEFAULT_DEAD_CLICK_IGNORE_LIST);
  const list = getElementAndParentsForElement(/** @type {!Element} */ (el), false).targetElementList;
  return !checkIfElementsMatchCSSSelector(list, ignorelist);
}

const DEFAULT_RAGE_CLICK_IGNORE_LIST = ['.ph-no-rageclick', '.ph-no-capture'];
const TEXT_SELECTION_INPUT_TYPES = ['', 'text', 'search', 'email', 'password', 'url', 'tel', 'number'];

/**
 * @param {!Element} el
 * @return {boolean}
 */
function isContentEditableTarget(el) {
  if (el['isContentEditable']) return true;
  const ce = el.getAttribute ? el.getAttribute('contenteditable') : undefined;
  return ce === 'true' || ce === '';
}

/**
 * Text-editing surfaces: repeated fast clicks there are text selection, not rage.
 * @param {?Element|undefined} el
 * @return {boolean}
 */
export function isTextSelectionTarget(el) {
  if (!el || !isElementNode(el)) return false;
  if (isTag(el, 'textarea')) return true;
  if (isTag(el, 'input')) return includes(TEXT_SELECTION_INPUT_TYPES, (el.getAttribute('type') || '').toLowerCase());
  return isContentEditableTarget(el);
}

/**
 * @param {?Element} el
 * @param {*} config the `rageclick` config
 * @return {boolean}
 */
export function shouldCaptureRageclick(el, config) {
  if (!win || cannotCheckForAutocapture(el)) return false;
  const element = /** @type {!Element} */ (el);
  let selectorIgnoreList;
  let contentIgnorelist;
  let ignoreTextSelection;
  if (isBoolean(config)) {
    selectorIgnoreList = config ? DEFAULT_RAGE_CLICK_IGNORE_LIST : false;
    contentIgnorelist = undefined;
    ignoreTextSelection = false;
  } else {
    const c = config || {};
    selectorIgnoreList = isNullish(c['css_selector_ignorelist']) ? DEFAULT_RAGE_CLICK_IGNORE_LIST :
        c['css_selector_ignorelist'];
    contentIgnorelist = c['content_ignorelist'];
    ignoreTextSelection = isNullish(c['ignore_text_selection']) ? false : c['ignore_text_selection'];
  }
  if (selectorIgnoreList === false) return false;
  if (ignoreTextSelection && isTextSelectionTarget(element)) return false;
  const list = getElementAndParentsForElement(element, false).targetElementList;
  if (contentIgnorelist && shouldIgnoreByContent(contentIgnorelist, clickedControlText(element, list))) return false;
  return !checkIfElementsMatchCSSSelector(list, selectorIgnoreList);
}

/**
 * @param {?Element|undefined} el
 * @return {boolean}
 */
function cannotCheckForAutocapture(el) {
  return !el || isTag(el, 'html') || !isElementNode(el);
}

/**
 * @param {!Element} el
 * @param {boolean|undefined} captureOnAnyElement
 * @return {{parentIsUsefulElement: boolean, targetElementList: !Array<!Element>}}
 */
function getElementAndParentsForElement(el, captureOnAnyElement) {
  if (!win || cannotCheckForAutocapture(el)) return {parentIsUsefulElement: false, targetElementList: []};
  let parentIsUsefulElement = false;
  const targetElementList = [el];
  let curEl = el;
  while (curEl.parentNode && !isTag(curEl, 'body')) {
    if (isShadowRoot(curEl.parentNode)) {
      const host = /** @type {!Element} */ (curEl.parentNode['host']);
      targetElementList.push(host);
      curEl = host;
      continue;
    }
    const parentNode = getParentElement(curEl);
    if (!parentNode) break;
    if (captureOnAnyElement || autocaptureCompatibleElements.indexOf(parentNode.tagName.toLowerCase()) > -1) {
      parentIsUsefulElement = true;
    } else {
      try {
        const compStyles = win.getComputedStyle(parentNode);
        if (compStyles && compStyles.getPropertyValue('cursor') === 'pointer') parentIsUsefulElement = true;
      } catch (e) {}
    }
    targetElementList.push(parentNode);
    curEl = parentNode;
  }
  return {parentIsUsefulElement: parentIsUsefulElement, targetElementList: targetElementList};
}

/**
 * Dead clicks skip clicks on (or inside) an anchor.
 * @param {?Element} el
 * @return {boolean}
 */
export function shouldSkipDeadClick(el) {
  if (!win || cannotCheckForAutocapture(el)) return false;
  return getElementAndParentsForElement(/** @type {!Element} */ (el), false).targetElementList.some(function(node) {
    return isTag(node, 'a');
  });
}

/**
 * Whether a DOM event should be captured.
 * @param {!Element} el
 * @param {!Event} event
 * @param {?DomAutocaptureConfig=} config
 * @param {boolean=} captureOnAnyElement
 * @param {!Array<string>=} allowedEventTypes
 * @return {boolean}
 */
export function shouldCaptureDomEvent(el, event, config, captureOnAnyElement, allowedEventTypes) {
  if (!win || cannotCheckForAutocapture(el)) return false;
  const getCurrentUrl = config ? config.getCurrentUrl : undefined;
  if (config && config.urlAllowlist) {
    if (!checkForURLMatches(config.urlAllowlist, getCurrentUrl)) return false;
  }
  if (config && config.urlIgnorelist) {
    if (checkForURLMatches(config.urlIgnorelist, getCurrentUrl)) return false;
  }
  if (config && config.domEventAllowlist) {
    const allowlist = config.domEventAllowlist;
    if (allowlist && !allowlist.some(function(t) {
      return event.type === t;
    })) {
      return false;
    }
  }
  const r = getElementAndParentsForElement(el, captureOnAnyElement);
  const targetElementList = r.targetElementList;
  if (!checkIfElementTreePassesElementAllowList(targetElementList, config)) return false;
  if (!checkIfElementsMatchCSSSelector(targetElementList, config ? config.cssSelectorAllowlist : undefined)) {
    return false;
  }
  const ignore = config && !isNullish(config.cssSelectorIgnorelist) ? config.cssSelectorIgnorelist :
      DEFAULT_AUTOCAPTURE_IGNORE_LIST;
  if (checkIfElementsMatchCSSSelector(targetElementList, ignore)) return false;
  try {
    const compStyles = win.getComputedStyle(el);
    if (compStyles && compStyles.getPropertyValue('cursor') === 'pointer' && event.type === 'click') return true;
  } catch (e) {}
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case 'html':
      return false;
    case 'form':
      return (allowedEventTypes || ['submit']).indexOf(event.type) >= 0;
    case 'input':
    case 'select':
    case 'textarea':
      return (allowedEventTypes || ['change', 'click']).indexOf(event.type) >= 0;
    default:
      if (r.parentIsUsefulElement) return (allowedEventTypes || ['click']).indexOf(event.type) >= 0;
      return (allowedEventTypes || ['click']).indexOf(event.type) >= 0 &&
          (autocaptureCompatibleElements.indexOf(tag) > -1 || el.getAttribute('contenteditable') === 'true');
  }
}

/**
 * Whether an element may be captured at all (ph-sensitive/ph-no-capture
 * ancestors, hidden/password inputs, sensitive-looking names).
 * @param {!Element} el
 * @return {boolean}
 */
export function shouldCaptureElement(el) {
  const seen = [];
  let depth = 0;
  for (let curEl = el; curEl.parentNode && !isTag(curEl, 'body');
    curEl = /** @type {!Element} */ (curEl.parentNode)) {
    if (depth++ >= MAX_DOM_ANCESTOR_DEPTH || seen.indexOf(curEl) !== -1) return false;
    seen.push(curEl);
    const classes = getClassNames(curEl);
    if (includes(classes, 'ph-sensitive') || includes(classes, 'ph-no-capture')) return false;
  }
  if (includes(getClassNames(el), 'ph-include')) return true;
  const type = el['type'] || '';
  if (isString(type)) {
    switch (type.toLowerCase()) {
      case 'hidden':
        return false;
      case 'password':
        return false;
    }
  }
  const name = el['name'] || el.id || '';
  if (isString(name)) {
    const sensitiveNameRegex =
        /^cc|cardnum|ccnum|creditcard|csc|cvc|cvv|exp|pass|pwd|routing|seccode|securitycode|securitynum|socialsec|socsec|ssn/i;
    if (sensitiveNameRegex.test(name.replace(/[^a-zA-Z0-9]/g, ''))) return false;
  }
  return true;
}

/**
 * Inputs and similar elements: only safe attributes are captured.
 * @param {!Element} el
 * @return {boolean}
 */
export function isSensitiveElement(el) {
  const allowedInputTypes = ['button', 'checkbox', 'submit', 'reset'];
  return (isTag(el, 'input') && allowedInputTypes.indexOf(el['type']) === -1) || isTag(el, 'select') ||
      isTag(el, 'textarea') || el.getAttribute('contenteditable') === 'true';
}

const coreCCPattern = '(4[0-9]{12}(?:[0-9]{3})?)|(5[1-5][0-9]{14})|(6(?:011|5[0-9]{2})[0-9]{12})|(3[47][0-9]{13})|' +
    '(3(?:0[0-5]|[68][0-9])[0-9]{11})|((?:2131|1800|35[0-9]{3})[0-9]{11})';
const anchoredCCRegex = new RegExp('^(?:' + coreCCPattern + ')$');
const networkCCCandidateRegex = /(^|[^0-9A-Za-z_])([0-9][0-9 -]*[0-9])(?=$|[^0-9A-Za-z_])/g;
const networkCCLengths = [16, 15, 14, 13];
const coreSSNPattern = '\\d{3}-?\\d{2}-?\\d{4}';
const anchoredSSNRegex = new RegExp('^(' + coreSSNPattern + ')$');
const networkSSNPattern = '(?!000|666)[0-9]{3}-?(?!00)[0-9]{2}-?(?!0000)[0-9]{4}';
const networkSSNCandidateRegex = new RegExp('(^|[^0-9])(' + networkSSNPattern + ')(?=$|([^0-9]))', 'g');
const identifierCharacterRegex = /[0-9A-Za-z_]/;

/**
 * @param {string} value
 * @return {boolean}
 */
function passesLuhnCheck(value) {
  let sum = 0;
  let shouldDouble = false;
  for (let i = value.length - 1; i >= 0; i--) {
    let digit = value.charCodeAt(i) - 48;
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

/**
 * @param {string} value
 * @return {boolean}
 */
function containsCreditCardNumber(value) {
  networkCCCandidateRegex.lastIndex = 0;
  let match;
  while ((match = networkCCCandidateRegex.exec(value))) {
    const matched = match[2];
    if (!matched) continue;
    const candidate = matched.replace(/[- ]/g, '');
    for (let start = 0; start < candidate.length; start++) {
      for (let j = 0; j < networkCCLengths.length; j++) {
        const end = start + networkCCLengths[j];
        if (end <= candidate.length) {
          const possible = candidate.slice(start, end);
          if (anchoredCCRegex.test(possible) && passesLuhnCheck(possible)) return true;
        }
      }
    }
  }
  return false;
}

/**
 * @param {string} value
 * @return {boolean}
 */
function containsSSN(value) {
  networkSSNCandidateRegex.lastIndex = 0;
  let match;
  while ((match = networkSSNCandidateRegex.exec(value))) {
    const before = match[1];
    const after = match[3];
    if (before && after && identifierCharacterRegex.test(before) && identifierCharacterRegex.test(after)) continue;
    return true;
  }
  return false;
}

/**
 * Whether a value may be captured (not a credit card or SSN lookalike).
 * @param {*} value
 * @param {boolean=} anchorRegexes default true
 * @return {boolean}
 */
export function shouldCaptureValue(value, anchorRegexes) {
  if (isNullish(value)) return false;
  if (isString(value)) {
    const v = /** @type {string} */ (value).trim();
    const anchored = anchorRegexes !== false;
    const cc = anchored ? anchoredCCRegex.test((v || '').replace(/[- ]/g, '')) : containsCreditCardNumber(v);
    if (cc) return false;
    const ssn = anchored ? anchoredSSNRegex.test(v) : containsSSN(v);
    if (ssn) return false;
  }
  return true;
}

/**
 * Angular `_ngcontent` / `_nghost` attributes change per build.
 * @param {*} attributeName
 * @return {boolean}
 */
export function isAngularStyleAttr(attributeName) {
  if (isString(attributeName)) {
    const n = /** @type {string} */ (attributeName);
    return n.substring(0, 10) === '_ngcontent' || n.substring(0, 7) === '_nghost';
  }
  return false;
}

/**
 * Direct text plus the text of nested spans.
 * @param {!Element} target
 * @return {string}
 */
export function getDirectAndNestedSpanText(target) {
  let text = getSafeText(target);
  text = (text + ' ' + getNestedSpanText(target)).trim();
  return shouldCaptureValue(text) ? text : '';
}

/**
 * @param {!Element} target
 * @return {string}
 */
export function getNestedSpanText(target) {
  let text = '';
  if (target && target.childNodes && target.childNodes.length) {
    const children = target.childNodes;
    for (let i = 0; i < children.length; i++) {
      const child = /** @type {?} */ (children[i]);
      if (child && child['tagName'] && String(child['tagName']).toLowerCase() === 'span') {
        try {
          const spanText = getSafeText(child);
          text = (text + ' ' + spanText).trim();
          if (child.childNodes && child.childNodes.length) text = (text + ' ' + getNestedSpanText(child)).trim();
        } catch (e) {
          logger.error('[AutoCapture]', e);
        }
      }
    }
  }
  return text;
}

// ---------------------------------------------------------------------------
// $elements_chain

/**
 * @param {string} input
 * @return {string}
 */
function escapeQuotes(input) {
  return input.replace(/"|\\"/g, '\\"');
}

/**
 * Builds `$elements_chain` from element property objects (upstream
 * getElementsChainString + extractElements + elementsToString).
 * @param {*} elements
 * @return {string}
 */
export function getElementsChainString(elements) {
  if (!isArray(elements)) return '';
  return /** @type {!Array<!Object>} */ (elements).map(function(el) {
    const text = el['$el_text'];
    const href = el['attr__href'];
    const tagName = el['tag_name'];
    const attrId = el['attr__id'];
    const rawClass = el['attr__class'];
    const attrClass = !rawClass ? undefined : isArray(rawClass) ? rawClass : splitClassString(rawClass);
    let out = '';
    if (tagName) out += tagName;
    if (attrClass) {
      attrClass.sort();
      for (let i = 0; i < attrClass.length; i++) out += '.' + attrClass[i].replace(/"/g, '');
    }
    const t = isNullish(text) ? undefined : text.slice(0, 400);
    const h = isNullish(href) ? undefined : href.slice(0, 2048);
    const attributes = {};
    if (t) attributes['text'] = t;
    attributes['nth-child'] = isNullish(el['nth_child']) ? 0 : el['nth_child'];
    attributes['nth-of-type'] = isNullish(el['nth_of_type']) ? 0 : el['nth_of_type'];
    if (h) attributes['href'] = h;
    if (attrId) attributes['attr_id'] = attrId;
    for (const k in el) {
      if (Object.prototype.hasOwnProperty.call(el, k) && k.indexOf('attr__') === 0) attributes[k] = el[k];
    }
    const names = [];
    for (const k in attributes) names.push(k);
    names.sort(function(a, b) {
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const sorted = {};
    for (let i = 0; i < names.length; i++) {
      sorted[escapeQuotes(String(names[i]))] = escapeQuotes(String(attributes[names[i]]));
    }
    out += ':';
    for (const k in sorted) out += k + '="' + sorted[k] + '"';
    return out;
  }).join(';');
}

// ---------------------------------------------------------------------------
// autocapture.ts element properties

/**
 * @param {string} text
 * @return {string}
 */
function limitText(text) {
  return text.length > 1024 ? text.slice(0, 1024) + '...' : text;
}

/**
 * `data-ph-capture-attribute-*` attributes as properties.
 * @param {!Element} elem
 * @return {!Object}
 */
export function getAugmentPropertiesFromElement(elem) {
  if (!shouldCaptureElement(elem)) return {};
  const props = {};
  const attrs = elem.attributes;
  for (let i = 0; i < attrs.length; i++) {
    const attr = attrs[i];
    if (attr.name && attr.name.indexOf('data-ph-capture-attribute') === 0) {
      const key = attr.name.replace('data-ph-capture-attribute-', '');
      const value = attr.value;
      if (key && value && shouldCaptureValue(value)) props[key] = value;
    }
  }
  return props;
}

/**
 * @param {!Element} el
 * @return {?Element}
 */
export function previousElementSibling(el) {
  if (el.previousElementSibling) return el.previousElementSibling;
  let e = /** @type {?Node} */ (el);
  do {
    e = e.previousSibling;
  } while (e && !isElementNode(e));
  return /** @type {?Element} */ (e);
}

/**
 * @param {string} eventType
 * @return {!Object}
 */
export function getDefaultProperties(eventType) {
  return {'$event_type': eventType, '$ce_version': 1};
}

/**
 * @param {?} list
 * @param {string} name
 * @return {boolean}
 */
function listIncludes(list, name) {
  return !!list && list.indexOf(name) !== -1;
}

/**
 * One element of `$elements`.
 * @param {!Element} elem
 * @param {boolean} maskAllAttributes
 * @param {boolean} maskText
 * @param {?} elementAttributeIgnorelist
 * @param {boolean=} disableCaptureUrlHashes
 * @return {!Object}
 */
export function getPropertiesFromElement(elem, maskAllAttributes, maskText, elementAttributeIgnorelist,
    disableCaptureUrlHashes) {
  const tagName = elem.tagName.toLowerCase();
  const props = {'tag_name': tagName};
  if (autocaptureCompatibleElements.indexOf(tagName) > -1 && !maskText) {
    if (tagName === 'a' || tagName === 'button') {
      props['$el_text'] = limitText(getDirectAndNestedSpanText(elem));
    } else {
      props['$el_text'] = limitText(getSafeText(elem));
    }
  }
  const classes = getClassNames(elem);
  if (!maskAllAttributes && !listIncludes(elementAttributeIgnorelist, 'class') && classes.length > 0) {
    props['classes'] = classes.filter(function(c) {
      return c !== '';
    });
  }
  const sensitive = isSensitiveElement(elem);
  const attrs = elem.attributes;
  for (let i = 0; i < attrs.length; i++) {
    const attr = attrs[i];
    if (sensitive && ['name', 'id', 'class', 'aria-label'].indexOf(attr.name) === -1) continue;
    if (listIncludes(elementAttributeIgnorelist, attr.name)) continue;
    if (!maskAllAttributes && shouldCaptureValue(attr.value) && !isAngularStyleAttr(attr.name)) {
      let value = attr.value;
      if (attr.name === 'class') value = splitClassString(value).join(' ');
      props['attr__' + attr.name] = limitText(attr.name === 'href' && disableCaptureUrlHashes ?
          /** @type {string} */ (stripUrlHash(value)) : value);
    }
  }
  let nthChild = 1;
  let nthOfType = 1;
  let cur = /** @type {?Element} */ (elem);
  while ((cur = previousElementSibling(/** @type {!Element} */ (cur)))) {
    nthChild++;
    if (cur.tagName === elem.tagName) nthOfType++;
  }
  props['nth_child'] = nthChild;
  props['nth_of_type'] = nthOfType;
  return props;
}

/**
 * @typedef {{
 *   e: !Event,
 *   maskAllElementAttributes: boolean,
 *   maskAllText: boolean,
 *   elementAttributeIgnoreList: ?,
 *   elementsChainAsString: boolean,
 *   disableCaptureUrlHashes: boolean,
 * }}
 */
export let ElementPropertiesOptions;

/**
 * Autocapture properties of a target and its ancestors (`$elements_chain`,
 * `$el_text`, `$external_click_url`, data-ph-capture-attribute-*).
 * @param {!Element} target
 * @param {!ElementPropertiesOptions} o
 * @return {{props: !Object, explicitNoCapture: boolean, target: (!Element|undefined)}}
 */
export function autocapturePropertiesForElement(target, o) {
  if (!isElementNode(target)) return {props: {}, explicitNoCapture: false, target: undefined};
  let maskAllText = o.maskAllText;
  const e = o.e;
  const targetElementList = [target];
  const seen = [target];
  let curEl = target;
  while (curEl.parentNode && !isTag(curEl, 'body')) {
    if (targetElementList.length >= MAX_DOM_ANCESTOR_DEPTH) break;
    const parent = curEl.parentNode;
    if (isShadowRoot(parent)) {
      const host = /** @type {!Element} */ (parent['host']);
      if (seen.indexOf(host) !== -1) break;
      seen.push(host);
      targetElementList.push(host);
      curEl = host;
      continue;
    }
    if (!isElementNode(parent)) break;
    if (seen.indexOf(parent) !== -1) break;
    seen.push(parent);
    targetElementList.push(/** @type {!Element} */ (parent));
    curEl = /** @type {!Element} */ (parent);
  }

  // Attribute icon clicks to their enclosing control rather than the SVG.
  let controlIndex = -1;
  if (e.type === 'click' && target.namespaceURI === 'http://www.w3.org/2000/svg') {
    for (let i = 0; i < targetElementList.length; i++) {
      if (isTag(targetElementList[i], 'button') || isTag(targetElementList[i], 'a')) {
        controlIndex = i;
        break;
      }
    }
  }
  if (controlIndex > 0) {
    maskAllText = maskAllText || targetElementList.slice(0, controlIndex + 1).some(function(el) {
      return !shouldCaptureElement(el) || isSensitiveElement(el);
    });
  }

  const elementsJson = [];
  const augment = {};
  let href = /** @type {string|boolean} */ (false);
  let explicitNoCapture = false;
  const ignoreList = o.elementAttributeIgnoreList;
  for (let i = 0; i < targetElementList.length; i++) {
    const el = targetElementList[i];
    const shouldCaptureEl = shouldCaptureElement(el);
    if (isTag(el, 'a') && !o.maskAllElementAttributes && !listIncludes(ignoreList, 'href')) {
      const hrefAttr = el.getAttribute('href');
      href = shouldCaptureEl && !!hrefAttr && shouldCaptureValue(hrefAttr) ?
          (o.disableCaptureUrlHashes ? stripUrlHash(hrefAttr) : hrefAttr) : false;
    }
    if (includes(getClassNames(el), 'ph-no-capture')) explicitNoCapture = true;
    elementsJson.push(getPropertiesFromElement(el, o.maskAllElementAttributes, maskAllText, ignoreList,
        o.disableCaptureUrlHashes));
    const augmentProps = getAugmentPropertiesFromElement(el);
    for (const k in augmentProps) {
      if (!Object.prototype.hasOwnProperty.call(augment, k)) augment[k] = augmentProps[k];
    }
  }

  if (explicitNoCapture) return {props: {}, explicitNoCapture: true, target: undefined};

  let attributed = target;
  if (controlIndex > 0) {
    attributed = targetElementList[controlIndex];
    elementsJson.splice(0, controlIndex);
  }
  if (!maskAllText) {
    if (isTag(attributed, 'a') || isTag(attributed, 'button')) {
      elementsJson[0]['$el_text'] = getDirectAndNestedSpanText(attributed);
    } else {
      elementsJson[0]['$el_text'] = getSafeText(attributed);
    }
  }
  let externalHref;
  if (href) {
    elementsJson[0]['attr__href'] = href;
    // Upstream convertToURL: an anchor element resolves the href.
    const a = doc ? /** @type {!HTMLAnchorElement} */ (doc.createElement('a')) : null;
    if (a) a.href = /** @type {string} */ (href);
    const hrefHost = a ? a.host : undefined;
    const locationHost = win && win.location ? win.location.host : undefined;
    if (hrefHost && locationHost && hrefHost !== locationHost) externalHref = href;
  }
  const first = elementsJson[0];
  const props = extend(
      getDefaultProperties(e.type),
      !o.elementsChainAsString ? {'$elements': elementsJson} : {},
      {'$elements_chain': getElementsChainString(elementsJson)},
      first && first['$el_text'] ? {'$el_text': first['$el_text']} : {},
      externalHref && e.type === 'click' ? {'$external_click_url': externalHref} : {},
      augment);
  return {props: props, explicitNoCapture: false, target: attributed};
}
