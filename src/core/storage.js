/**
 * @fileoverview Key/value storage backends (port of upstream storage.ts):
 * cookieStore, localStore, sessionStore, memoryStore and the
 * `localStorage+cookie` combination. Values are JSON-encoded.
 *
 * Not ported: the `cookieWinsOnConflict` reconciliation path of the
 * localStorage+cookie store (opt-in upstream, off by default).
 */
import {doc, win, extend, getCookieValue, isNull, isUndefined, isObject, keys} from './utils.js';
import {logger} from './logger.js';
import {uuidv7} from './uuid.js';
import {COOKIE_PERSISTED_PROPERTIES} from './constants.js';

/**
 * @record
 */
export class Store {
  constructor() {}
  /** @return {boolean} */
  isSupported() {}
  /**
   * @param {string} name
   * @return {*}
   */
  get(name) {}
  /**
   * @param {string} name
   * @return {*}
   */
  parse(name) {}
  /**
   * @param {string} name
   * @param {*} value
   * @param {number=} days
   * @param {boolean=} crossSubdomain
   * @param {boolean=} secure
   * @return {boolean}
   */
  set(name, value, days, crossSubdomain, secure) {}
  /**
   * @param {string} name
   * @param {boolean=} crossSubdomain
   */
  remove(name, crossSubdomain) {}
}

/** @type {string} */
let firstNonPublicSubDomain = '';

/**
 * @param {string} hostname
 * @return {string}
 */
function seekFirstNonPublicSubDomain(hostname) {
  if (firstNonPublicSubDomain) return firstNonPublicSubDomain;
  if (!doc) return '';
  if (['localhost', '127.0.0.1'].indexOf(hostname) !== -1) return '';
  const list = hostname.split('.');
  let len = Math.min(list.length, 8);
  const key = 'dmn_chk_' + uuidv7();
  while (!firstNonPublicSubDomain && len--) {
    const candidate = list.slice(len).join('.');
    const value = key + '=1;domain=.' + candidate + ';path=/';
    doc.cookie = value + ';max-age=3';
    if (doc.cookie.indexOf(key) !== -1) {
      doc.cookie = value + ';max-age=0';
      firstNonPublicSubDomain = candidate;
    }
  }
  return firstNonPublicSubDomain;
}

/**
 * @param {string} hostname
 * @param {boolean|undefined} crossSubdomain
 * @return {string}
 */
export function chooseCookieDomain(hostname, crossSubdomain) {
  if (crossSubdomain) {
    let matched = seekFirstNonPublicSubDomain(hostname);
    if (!matched) {
      const m = hostname.match(/[a-z0-9][a-z0-9-]+\.[a-z]{2,}$/i);
      matched = m ? m[0] : '';
    }
    return matched ? '; domain=.' + matched : '';
  }
  return '';
}

/** @type {?boolean} */
let cookieSupported = null;

/** @implements {Store} */
class CookieStore {
  /** @override */
  isSupported() {
    if (!isNull(cookieSupported)) return /** @type {boolean} */ (cookieSupported);
    cookieSupported = false;
    if (doc) {
      try {
        const key = '__ph_cookie_support_' + uuidv7();
        this.set(key, 'xyz');
        cookieSupported = getCookieValue(key) === '"xyz"';
        this.remove(key);
      } catch (e) {
        cookieSupported = false;
      }
    }
    return /** @type {boolean} */ (cookieSupported);
  }
  /** @override */
  get(name) {
    return getCookieValue(name);
  }
  /** @override */
  parse(name) {
    let cookie;
    try {
      cookie = JSON.parse(/** @type {string} */ (this.get(name))) || {};
    } catch (e) {}
    return cookie;
  }
  /** @override */
  set(name, value, days, crossSubdomain, secure) {
    if (!doc) return false;
    try {
      let expires = '';
      let sec = '';
      const cdomain = chooseCookieDomain(doc.location.hostname, crossSubdomain);
      if (days) {
        const date = new Date();
        date.setTime(date.getTime() + days * 24 * 60 * 60 * 1000);
        expires = '; expires=' + date.toUTCString();
      }
      if (secure) sec = '; secure';
      const cookie = name + '=' + encodeURIComponent(JSON.stringify(value)) + expires + '; SameSite=Lax; path=/' +
          cdomain + sec;
      if (cookie.length > 4096 * 0.9) logger.warn('cookieStore warning: large cookie, len=' + cookie.length);
      doc.cookie = cookie;
      return true;
    } catch (e) {
      return false;
    }
  }
  /** @override */
  remove(name, crossSubdomain) {
    if (!doc || !doc.cookie) return;
    if (crossSubdomain && isNull(getCookieValue(name))) return;
    try {
      this.set(name, '', -1, crossSubdomain);
    } catch (e) {}
  }
}

/** @implements {Store} */
class WebStore {
  /**
   * @param {string} kind 'localStorage' | 'sessionStorage'
   * @param {string} probeKey
   */
  constructor(kind, probeKey) {
    /** @private @const {string} */
    this.kind_ = kind;
    /** @private @const {string} */
    this.probeKey_ = probeKey;
    /** @private {?boolean} */
    this.supported_ = null;
  }
  /** @return {!Storage} @private */
  storage_() {
    return /** @type {!Storage} */ (win[this.kind_]);
  }
  /** @override */
  isSupported() {
    if (!isNull(this.supported_)) return /** @type {boolean} */ (this.supported_);
    let supported = true;
    if (win) {
      try {
        this.set(this.probeKey_, 'xyz');
        if (this.get(this.probeKey_) !== '"xyz"') supported = false;
        this.remove(this.probeKey_);
      } catch (e) {
        supported = false;
      }
    } else {
      supported = false;
    }
    if (!supported && this.kind_ === 'localStorage') logger.error('localStorage unsupported; falling back to cookie store');
    this.supported_ = supported;
    return supported;
  }
  /** @override */
  get(name) {
    try {
      return win ? this.storage_().getItem(name) : null;
    } catch (e) {
      logger.error(this.kind_ + ' error: ' + e);
    }
    return null;
  }
  /** @override */
  parse(name) {
    try {
      const v = JSON.parse(/** @type {string} */ (this.get(name)));
      return this.kind_ === 'localStorage' ? v || {} : v || null;
    } catch (e) {}
    return null;
  }
  /** @override */
  set(name, value) {
    try {
      if (win) this.storage_().setItem(name, JSON.stringify(value));
      return true;
    } catch (e) {
      logger.error(this.kind_ + ' error: ' + e);
    }
    return false;
  }
  /** @override */
  remove(name) {
    try {
      if (win) this.storage_().removeItem(name);
    } catch (e) {
      logger.error(this.kind_ + ' error: ' + e);
    }
  }
}

/** @const {!Object<string, *>} */
const memoryStorage = {};

/** @implements {Store} */
class MemoryStore {
  /** @override */
  isSupported() {
    return true;
  }
  /** @override */
  get(name) {
    return name in memoryStorage ? memoryStorage[name] : null;
  }
  /** @override */
  parse(name) {
    return name in memoryStorage ? memoryStorage[name] : null;
  }
  /** @override */
  set(name, value) {
    memoryStorage[name] = value;
    return true;
  }
  /** @override */
  remove(name) {
    delete memoryStorage[name];
  }
}

/** @const {!Store} */
export const cookieStore = new CookieStore();
/** @const {!Store} */
export const localStore = new WebStore('localStorage', '__mplssupport__');
/** @const {!Store} */
export const sessionStore = new WebStore('sessionStorage', '__support__');
/** @const {!Store} */
export const memoryStore = new MemoryStore();

/**
 * @param {!Object} value
 * @param {!Array<string>=} custom
 * @return {!Object}
 */
export function getCookiePersistedProperties(value, custom) {
  const out = {};
  COOKIE_PERSISTED_PROPERTIES.concat(custom || []).forEach(function(key) {
    const v = value[key];
    if (!isUndefined(v) && !isNull(v) && v !== '') out[key] = v;
  });
  return out;
}

/**
 * Upstream createLocalPlusCookieStore (default path: localStorage wins).
 * @implements {Store}
 */
class LocalPlusCookieStore {
  /**
   * @param {!Array<string>} custom extra cookie-persisted keys
   * @param {function(): boolean} isReadOnly
   */
  constructor(custom, isReadOnly) {
    /** @private @const */
    this.custom_ = custom;
    /** @private @const */
    this.isReadOnly_ = isReadOnly;
  }
  /** @override */
  isSupported() {
    return localStore.isSupported();
  }
  /** @override */
  get(name) {
    return localStore.get(name);
  }
  /** @override */
  parse(name) {
    try {
      let cookieProps = {};
      try {
        const cv = cookieStore.get(name);
        const parsed = /** @type {?} */ (cv ? JSON.parse(/** @type {string} */ (cv)) : {});
        cookieProps = {};
        if (isObject(parsed)) {
          keys(parsed).forEach(function(k) {
            if (['__proto__', 'constructor', 'prototype'].indexOf(k) === -1) cookieProps[k] = parsed[k];
          });
        }
      } catch (e) {}
      const local = JSON.parse(/** @type {string} */ (localStore.get(name)) || '{}');
      const value = extend(cookieProps, local);
      if (!this.isReadOnly_()) localStore.set(name, value);
      return value;
    } catch (e) {}
    return null;
  }
  /** @override */
  set(name, value, days, crossSubdomain, secure) {
    const stored = localStore.set(name, value);
    try {
      const cookieProps = getCookiePersistedProperties(/** @type {!Object} */ (value), this.custom_);
      if (keys(cookieProps).length) cookieStore.set(name, cookieProps, days, crossSubdomain, secure);
    } catch (e) {
      logger.error('localStorage error: ' + e);
    }
    return stored;
  }
  /** @override */
  remove(name, crossSubdomain) {
    try {
      if (win) win.localStorage.removeItem(name);
      cookieStore.remove(name, crossSubdomain);
      cookieStore.remove(name + '_cpm', crossSubdomain);
    } catch (e) {
      logger.error('localStorage error: ' + e);
    }
  }
}

/**
 * @param {!Array<string>} custom
 * @param {function(): boolean} isReadOnly
 * @return {!Store}
 */
export function createLocalPlusCookieStore(custom, isReadOnly) {
  return new LocalPlusCookieStore(custom, isReadOnly);
}
