/**
 * @fileoverview Consent state (port of upstream consent.ts). The stored value
 * lives under `consent_persistence_name`, or `<opt_out_capturing_cookie_prefix
 * or __ph_opt_in_out_><token>`, in localStorage or a cookie
 * (`opt_out_capturing_persistence_type`).
 */
import {cookieStore, localStore, memoryStore, Store} from './storage.js';
import {isNoLike, isYesLike, nav, win} from './utils.js';
import {OPT_IN_CONSENT_PREFIX} from './constants.js';

/** @enum {number} */
export const ConsentStatus = {PENDING: -1, DENIED: 0, GRANTED: 1};

export class ConsentManager {
  /** @param {function(): !Object} getConfig */
  constructor(getConfig) {
    /** @private @const */
    this.getConfig_ = getConfig;
    /** @private {?Store} */
    this.store_ = null;
  }

  /** @return {number} one of ConsentStatus */
  consent() {
    if (this.getDnt_()) return ConsentStatus.DENIED;
    return this.storedConsent_();
  }

  /** @return {boolean} */
  isOptedOut() {
    const c = this.getConfig_();
    if (c['cookieless_mode'] === 'always') return true;
    return this.isRejected() || (this.consent() === ConsentStatus.PENDING && c['cookieless_mode'] === 'on_reject');
  }

  /** @return {boolean} */
  isOptedIn() {
    return !this.isOptedOut();
  }

  /** @return {boolean} */
  isExplicitlyOptedOut() {
    return this.consent() === ConsentStatus.DENIED;
  }

  /** @return {boolean} */
  isRejected() {
    const consent = this.consent();
    return consent === ConsentStatus.DENIED ||
        (consent === ConsentStatus.PENDING && !!this.getConfig_()['opt_out_capturing_by_default']);
  }

  /** @param {boolean} isOptedIn */
  optInOut(isOptedIn) {
    const c = this.getConfig_();
    this.storage_().set(this.storageKey_(), isOptedIn ? 1 : 0, c['cookie_expiration'], c['cross_subdomain_cookie'],
        c['secure_cookie']);
  }

  reset() {
    this.storage_().remove(this.storageKey_(), this.getConfig_()['cross_subdomain_cookie']);
  }

  /** @return {string} @private */
  storageKey_() {
    const c = this.getConfig_();
    if (c['consent_persistence_name']) return c['consent_persistence_name'];
    if (c['opt_out_capturing_cookie_prefix']) return c['opt_out_capturing_cookie_prefix'] + c['token'];
    return OPT_IN_CONSENT_PREFIX + c['token'];
  }

  /** @return {number} @private */
  storedConsent_() {
    const value = this.storage_().get(this.storageKey_());
    return isYesLike(value) ? ConsentStatus.GRANTED : isNoLike(value) ? ConsentStatus.DENIED : ConsentStatus.PENDING;
  }

  /** @return {!Store} @private */
  storage_() {
    const c = this.getConfig_();
    const type = c['opt_out_capturing_persistence_type'];
    const preferred = type === 'localStorage' ? localStore : cookieStore;
    const expected = preferred.isSupported() ? preferred : memoryStore;
    if (!this.store_ || this.store_ !== expected) {
      this.store_ = expected;
      const other = type === 'localStorage' ? cookieStore : localStore;
      const key = this.storageKey_();
      if (other.get(key)) {
        if (!this.store_.get(key)) this.optInOut(isYesLike(other.get(key)));
        other.remove(key, c['cross_subdomain_cookie']);
      }
    }
    return /** @type {!Store} */ (this.store_);
  }

  /** @return {boolean} @private */
  getDnt_() {
    if (!this.getConfig_()['respect_dnt']) return false;
    return [
      nav ? nav['doNotTrack'] : undefined,
      nav ? nav['msDoNotTrack'] : undefined,
      win ? win['doNotTrack'] : undefined,
      nav ? nav['globalPrivacyControl'] : undefined,
    ].some(function(v) {
      return isYesLike(v);
    });
  }
}
