/**
 * @fileoverview Key/value storage backends used by persistence.
 * All backends store JSON strings under a single key.
 */
import {doc, win, jsonParse, jsonStringify, isNullish, extend, includes, keys} from './utils.js';
import {logger} from './logger.js';
import {DISTINCT_ID, DEVICE_ID, SESSION_ID, USER_STATE, ENABLE_PERSON_PROCESSING, INITIAL_PERSON_INFO} from './constants.js';

/**
 * @record
 */
export class Store {
  constructor() {}
  /** @return {boolean} */ isSupported() {}
  /**
   * @param {string} name
   * @return {?Object}
   */
  parse(name) {}
  /**
   * @param {string} name
   * @param {!Object} value
   * @param {number=} days
   * @param {boolean=} crossSubdomain
   * @param {boolean=} secure
   */
  set(name, value, days, crossSubdomain, secure) {}
  /**
   * @param {string} name
   * @param {boolean=} crossSubdomain
   */
  remove(name, crossSubdomain) {}
}

/** @type {!Object<string, string>} */
const cookieDomainCache = {};

/**
 * Finds the widest domain a cookie can be written to (e.g. `.example.com` for
 * `app.example.com`), by probing from the shortest suffix up.
 * @param {string} hostname
 * @return {string}
 */
export function chooseCookieDomain(hostname) {
  if (cookieDomainCache[hostname] !== void 0) return cookieDomainCache[hostname];
  let result = '';
  if (doc && hostname && !/^(localhost|[\d.]+|\[[0-9a-f:]+\])$/i.test(hostname)) {
    const parts = hostname.split('.');
    const probe = 'dmn_chk_' + Math.random().toString(36).slice(2);
    for (let i = parts.length - 2; i >= 0; i--) {
      const candidate = '.' + parts.slice(i).join('.');
      doc.cookie = probe + '=1;domain=' + candidate + ';path=/';
      if (doc.cookie.indexOf(probe + '=1') !== -1) {
        doc.cookie = probe + '=;domain=' + candidate + ';path=/;expires=Thu, 01 Jan 1970 00:00:00 GMT';
        result = candidate;
        break;
      }
    }
  }
  cookieDomainCache[hostname] = result;
  return result;
}

/** @implements {Store} */
export class CookieStore {
  /** @override */
  isSupported() {
    return !!doc;
  }

  /**
   * @param {string} name
   * @return {?string}
   */
  get(name) {
    if (!doc) return null;
    const prefix = name + '=';
    const parts = doc.cookie.split(';');
    for (let i = 0; i < parts.length; i++) {
      const c = parts[i].replace(/^\s+/, '');
      if (c.indexOf(prefix) === 0) {
        try {
          return decodeURIComponent(c.substring(prefix.length));
        } catch (e) {
          return null;
        }
      }
    }
    return null;
  }

  /** @override */
  parse(name) {
    const v = jsonParse(this.get(name));
    return v && typeof v === 'object' ? /** @type {!Object} */ (v) : null;
  }

  /** @override */
  set(name, value, days, crossSubdomain, secure) {
    if (!doc) return;
    let expires = '';
    let domain = '';
    if (crossSubdomain && win) {
      const d = chooseCookieDomain(win.location.hostname);
      domain = d ? '; domain=' + d : '';
    }
    if (days) {
      const date = new Date();
      date.setTime(date.getTime() + days * 24 * 3600 * 1000);
      expires = '; expires=' + date.toUTCString();
    }
    const cookie = name + '=' + encodeURIComponent(jsonStringify(value)) + expires +
        '; SameSite=Lax; path=/' + domain + (secure ? '; secure' : '');
    if (cookie.length > 4096) {
      logger.warn('cookie too large (' + cookie.length + ' chars), it may be dropped by the browser');
    }
    doc.cookie = cookie;
  }

  /** @override */
  remove(name, crossSubdomain) {
    if (!doc) return;
    this.set(name, {}, -1, crossSubdomain);
  }
}

/** @implements {Store} */
export class WebStorageStore {
  /** @param {string} kind 'localStorage' or 'sessionStorage' */
  constructor(kind) {
    /** @private @const {string} */
    this.kind_ = kind;
    /** @private {?boolean} */
    this.supported_ = null;
  }

  /** @return {?Storage} */
  storage() {
    try {
      return win ? /** @type {?Storage} */ (win[this.kind_]) : null;
    } catch (e) {
      return null;
    }
  }

  /** @override */
  isSupported() {
    if (this.supported_ !== null) return this.supported_;
    let ok = false;
    try {
      const s = this.storage();
      if (s) {
        s.setItem('__ph_test', 'x');
        ok = s.getItem('__ph_test') === 'x';
        s.removeItem('__ph_test');
      }
    } catch (e) {
      ok = false;
    }
    this.supported_ = ok;
    return ok;
  }

  /** @override */
  parse(name) {
    if (!this.isSupported()) return null;
    const v = jsonParse(this.storage().getItem(name));
    return v && typeof v === 'object' ? /** @type {!Object} */ (v) : null;
  }

  /** @override */
  set(name, value) {
    if (!this.isSupported()) return;
    try {
      this.storage().setItem(name, jsonStringify(value));
    } catch (e) {
      logger.error('failed to write to ' + this.kind_, e);
    }
  }

  /** @override */
  remove(name) {
    if (!this.isSupported()) return;
    try {
      this.storage().removeItem(name);
    } catch (e) {}
  }
}

/** @implements {Store} */
export class MemoryStore {
  constructor() {
    /** @private @const {!Object<string, !Object>} */
    this.data_ = {};
  }
  /** @override */
  isSupported() {
    return true;
  }
  /** @override */
  parse(name) {
    return this.data_[name] || null;
  }
  /** @override */
  set(name, value) {
    this.data_[name] = value;
  }
  /** @override */
  remove(name) {
    delete this.data_[name];
  }
}

/** Properties mirrored into the cookie by `localStorage+cookie`. */
const COOKIE_PERSISTED_KEYS = [DISTINCT_ID, DEVICE_ID, SESSION_ID, USER_STATE, ENABLE_PERSON_PROCESSING, INITIAL_PERSON_INFO];

/**
 * Upstream's default: everything in localStorage, identity/session also in a
 * cookie so subdomains share them.
 * @implements {Store}
 */
export class LocalPlusCookieStore {
  constructor() {
    /** @private @const */
    this.local_ = new WebStorageStore('localStorage');
    /** @private @const */
    this.cookie_ = new CookieStore();
  }
  /** @override */
  isSupported() {
    return this.local_.isSupported();
  }
  /** @override */
  parse(name) {
    const local = this.local_.parse(name) || {};
    const cookie = this.cookie_.parse(name) || {};
    return /** @type {!Object} */ (extend({}, local, cookie));
  }
  /** @override */
  set(name, value, days, crossSubdomain, secure) {
    this.local_.set(name, value);
    const subset = {};
    keys(value).forEach(function(k) {
      if (includes(COOKIE_PERSISTED_KEYS, k) && !isNullish(value[k])) subset[k] = value[k];
    });
    this.cookie_.set(name, subset, days, crossSubdomain, secure);
  }
  /** @override */
  remove(name, crossSubdomain) {
    this.local_.remove(name);
    this.cookie_.remove(name, crossSubdomain);
  }
}

/**
 * @param {string} type persistence config value
 * @return {!Store}
 */
export function createStore(type) {
  const t = String(type || '').toLowerCase();
  /** @type {!Store} */
  let store;
  if (t === 'cookie') {
    store = new CookieStore();
  } else if (t === 'localstorage') {
    store = new WebStorageStore('localStorage');
  } else if (t === 'sessionstorage') {
    store = new WebStorageStore('sessionStorage');
  } else if (t === 'memory') {
    store = new MemoryStore();
  } else {
    store = new LocalPlusCookieStore();
  }
  if (!store.isSupported()) {
    logger.warn('persistence "' + t + '" unavailable, falling back');
    store = new CookieStore();
    if (!store.isSupported()) store = new MemoryStore();
  }
  return store;
}
