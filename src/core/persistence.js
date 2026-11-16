/**
 * @fileoverview Super-property & identity persistence. Port of upstream
 * posthog-persistence.ts. Data is one JSON object stored under
 * `ph_<token>_posthog` (same key/format as upstream, so a visitor keeps their
 * distinct_id when a site switches SDKs).
 *
 * Not ported (all opt-in upstream, off with the default `defaults: 'unset'`):
 * `split_storage` group entries, `cookieWinsOnConflict` cross-subdomain
 * reconciliation and cross-tab feature-flag merging. `persistence_save_debounce_ms`
 * is supported.
 */
import {
  cookieStore, createLocalPlusCookieStore, localStore, memoryStore, sessionStore, Store,
} from './storage.js';
import {
  addEventListener, each, extend, isArray, isNumber, isObject, isUndefined, isNull, doc, win,
} from './utils.js';
import {logger} from './logger.js';
import {
  EVENT_TIMERS_KEY, INITIAL_CAMPAIGN_PARAMS, INITIAL_PERSON_INFO, INITIAL_REFERRER_INFO, isHiddenPersistenceKey,
} from './constants.js';
import {
  getCampaignParams, getInitialPersonPropsFromInfo, getPersonInfo, getReferrerInfo, getSearchInfo,
} from './event-utils.js';
import {stripEmptyProperties, isEmptyObject, stripLeadingDollar} from './utils.js';

const PERSISTENCE_TYPES = ['cookie', 'localstorage', 'localstorage+cookie', 'sessionstorage', 'memory'];
const MAX_COOKIE_PERSON_INFO_FIELD_SIZE = 1000;

/**
 * @param {string} value
 * @return {string}
 */
function truncateForCookie(value) {
  let result = '';
  let encodedLength = 0;
  for (let i = 0; i < value.length; i++) {
    let ch = value.charAt(i);
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      ch += value.charAt(i + 1);
      i++;
    }
    const len = encodeURIComponent(JSON.stringify(ch).slice(1, -1)).length;
    if (encodedLength + len > MAX_COOKIE_PERSON_INFO_FIELD_SIZE) break;
    result += ch;
    encodedLength += len;
  }
  return result;
}

/**
 * @param {!Object} config
 * @return {string}
 */
function parseName(config) {
  let token = '';
  if (config['token']) {
    token = String(config['token']).replace(/\+/g, 'PL').replace(/\//g, 'SL').replace(/=/g, 'EQ');
  }
  return config['persistence_name'] ? 'ph_' + config['persistence_name'] : 'ph_' + token + '_posthog';
}

export class Persistence {
  /**
   * @param {!Object} config PostHog config (quoted keys).
   * @param {boolean=} isDisabled
   * @param {boolean=} allowDisabledRead restore stored state while disabled
   */
  constructor(config, isDisabled, allowDisabledRead) {
    /** @private {!Object} */
    this.config_ = config;
    /** @type {!Object} */
    this.props = {};
    /** @private {string|undefined} */
    this.campaignParamsUrl_ = undefined;
    /** @const {string} */
    this.name = parseName(config);
    /** @type {boolean} */
    this.disabled = !!config['disable_persistence'] || !!isDisabled;
    /** @private {boolean|undefined} */
    this.secure_ = undefined;
    /** @private {number|undefined} */
    this.expireDays_ = undefined;
    /** @private {number|undefined} */
    this.defaultExpiry_ = undefined;
    /** @private {boolean|undefined} */
    this.crossSubdomain_ = undefined;
    /** @private {boolean} */
    this.storesIdentityInCookie_ = false;
    /** @private {string|undefined} */
    this.fingerprint_ = undefined;
    /** @private {number|undefined} */
    this.pendingSaveTimer_ = undefined;
    /** @private {!Store} */
    this.storage_ = this.buildStorage_(config);
    this.load(isUndefined(allowDisabledRead) ? !config['cookieless_mode'] : allowDisabledRead);
    if (config['debug']) logger.info('Persistence loaded', config['persistence'], extend({}, this.props));
    this.update_config(config, config, isDisabled);
    this.save();
    if (win) {
      const self = this;
      const flush = function() {
        self.flush();
      };
      addEventListener(win, 'beforeunload', flush, {capture: false, passive: undefined});
      addEventListener(win, 'pagehide', flush, {capture: false, passive: undefined});
    }
  }

  /**
   * @param {!Object} config
   * @return {!Store}
   * @private
   */
  buildStorage_(config) {
    if (PERSISTENCE_TYPES.indexOf(String(config['persistence']).toLowerCase()) === -1) {
      logger.critical('Unknown persistence type ' + config['persistence'] + '; falling back to localStorage+cookie');
      config['persistence'] = 'localStorage+cookie';
    }
    const self = this;
    const localPlusCookie = createLocalPlusCookieStore(config['cookie_persisted_properties'] || [], function() {
      return self.disabled;
    });
    const type = String(config['persistence']).toLowerCase();
    let store;
    let inCookie = false;
    if (type === 'localstorage' && localStore.isSupported()) {
      store = localStore;
    } else if (type === 'localstorage+cookie' && localPlusCookie.isSupported()) {
      store = localPlusCookie;
      inCookie = true;
    } else if (type === 'sessionstorage' && sessionStore.isSupported()) {
      store = sessionStore;
    } else if (type === 'memory') {
      store = memoryStore;
    } else if (type === 'cookie' && cookieStore.isSupported()) {
      store = cookieStore;
      inCookie = true;
    } else if (localPlusCookie.isSupported()) {
      store = localPlusCookie;
      inCookie = true;
    } else if (cookieStore.isSupported()) {
      store = cookieStore;
      inCookie = true;
    } else {
      store = memoryStore;
    }
    this.storesIdentityInCookie_ = inCookie;
    return store;
  }

  /**
   * Super properties exposed on events (hidden policy keys removed).
   * @return {!Object}
   */
  properties() {
    const p = {};
    each(this.props, function(v, k) {
      if (isHiddenPersistenceKey(k)) return;
      if (k === '$replay_sample_rate' && isNull(v)) return;
      p[k] = v;
    });
    return p;
  }

  /** @param {boolean=} allowDisabled */
  load(allowDisabled) {
    if (this.disabled && !allowDisabled) return;
    const entry = this.storage_.parse(this.name);
    if (entry) this.props = extend({}, entry);
  }

  save() {
    if (this.disabled) return;
    const v = this.config_['persistence_save_debounce_ms'];
    const debounce = isNumber(v) && v > 0 ? /** @type {number} */ (v) : 0;
    if (debounce <= 0) {
      this.writeNow_();
      return;
    }
    if (!isUndefined(this.pendingSaveTimer_)) return;
    const self = this;
    this.pendingSaveTimer_ = setTimeout(function() {
      self.pendingSaveTimer_ = undefined;
      self.writeNow_();
    }, debounce);
  }

  flush() {
    if (isUndefined(this.pendingSaveTimer_)) return;
    clearTimeout(this.pendingSaveTimer_);
    this.pendingSaveTimer_ = undefined;
    this.writeNow_();
  }

  /** @private */
  writeNow_() {
    if (this.disabled) return;
    let fingerprint;
    let serialized;
    try {
      serialized = JSON.stringify(this.props);
      fingerprint = serialized + '|' + this.expireDays_ + '|' + this.crossSubdomain_ + '|' + this.secure_;
      if (fingerprint === this.fingerprint_) return;
    } catch (e) {
      fingerprint = serialized = undefined;
    }
    // The store writes `serialized` (the same JSON.stringify(this.props)) instead of stringifying again.
    if (this.storage_.set(this.name, this.props, this.expireDays_, this.crossSubdomain_, this.secure_, serialized)) {
      this.fingerprint_ = fingerprint;
    }
  }

  remove() {
    if (!isUndefined(this.pendingSaveTimer_)) {
      clearTimeout(this.pendingSaveTimer_);
      this.pendingSaveTimer_ = undefined;
    }
    this.storage_.remove(this.name, false);
    this.storage_.remove(this.name, true);
    this.fingerprint_ = undefined;
  }

  clear() {
    this.remove();
    this.props = {};
  }

  /**
   * @param {!Object} props
   * @param {*=} defaultValue
   * @param {number=} days
   * @return {boolean}
   */
  register_once(props, defaultValue, days) {
    if (isObject(props)) {
      if (isUndefined(defaultValue)) defaultValue = 'None';
      this.expireDays_ = isUndefined(days) ? this.defaultExpiry_ : days;
      let changed = false;
      const self = this;
      each(props, function(val, prop) {
        if (!self.props.hasOwnProperty(prop) || self.props[prop] === defaultValue) {
          self.props[prop] = val;
          changed = true;
        }
      });
      if (changed) {
        this.save();
        return true;
      }
    }
    return false;
  }

  /**
   * @param {!Object} props
   * @param {number=} days
   * @return {boolean}
   */
  register(props, days) {
    if (isObject(props)) {
      this.expireDays_ = isUndefined(days) ? this.defaultExpiry_ : days;
      let changed = false;
      const self = this;
      each(props, function(val, prop) {
        if (self.props[prop] !== val || isObject(val) || isArray(val)) {
          self.props[prop] = val;
          changed = true;
        }
      });
      if (changed) {
        this.save();
        return true;
      }
    }
    return false;
  }

  /** @param {(string|!Array<string>)} propOrProps */
  unregister(propOrProps) {
    const list = isArray(propOrProps) ? /** @type {!Array<string>} */ (propOrProps) : [/** @type {string} */ (propOrProps)];
    let changed = false;
    for (let i = 0; i < list.length; i++) {
      if (list[i] in this.props) {
        delete this.props[list[i]];
        changed = true;
      }
    }
    if (changed) this.save();
  }

  /** @return {!Object|undefined} the campaign params registered, if any */
  update_campaign_params() {
    const currentUrl = doc ? doc.URL : undefined;
    if (currentUrl === this.campaignParamsUrl_) return undefined;
    const c = this.config_;
    const params = getCampaignParams(c['custom_campaign_params'], c['mask_personal_data_properties'],
        c['custom_personal_data_properties']);
    const has = !isEmptyObject(stripEmptyProperties(params));
    if (has) this.register(params);
    this.campaignParamsUrl_ = currentUrl;
    return has ? params : undefined;
  }

  update_search_keyword() {
    this.register(getSearchInfo());
  }

  update_referrer_info() {
    this.register_once(getReferrerInfo(), undefined);
  }

  set_initial_person_info() {
    if (this.props[INITIAL_CAMPAIGN_PARAMS] || this.props[INITIAL_REFERRER_INFO]) return;
    const c = this.config_;
    const info = getPersonInfo(c['mask_personal_data_properties'], c['custom_personal_data_properties'],
        c['disable_capture_url_hashes']);
    this.register_once({
      [INITIAL_PERSON_INFO]: this.storesIdentityInCookie_ ?
          {'r': truncateForCookie(info['r']), 'u': info['u'] ? truncateForCookie(info['u']) : undefined} :
          info,
    }, undefined);
  }

  /** @return {!Object} */
  get_initial_props() {
    const p = {};
    const self = this;
    [INITIAL_REFERRER_INFO, INITIAL_CAMPAIGN_PARAMS].forEach(function(key) {
      const info = self.props[key];
      if (info) {
        each(info, function(v, k) {
          p['$initial_' + stripLeadingDollar(k)] = v;
        });
      }
    });
    const personInfo = this.props[INITIAL_PERSON_INFO];
    if (personInfo) extend(p, getInitialPersonPropsFromInfo(personInfo, this.config_['disable_capture_url_hashes']));
    return p;
  }

  /**
   * @param {!Object} config
   * @param {!Object} oldConfig
   * @param {boolean=} isDisabled
   */
  update_config(config, oldConfig, isDisabled) {
    const persistenceChanged = config['persistence'] !== oldConfig['persistence'] ||
        JSON.stringify(config['cookie_persisted_properties'] || []) !==
        JSON.stringify(oldConfig['cookie_persisted_properties'] || []);
    const disabled = !!config['disable_persistence'] || !!isDisabled;
    this.config_ = config;
    const newStore = persistenceChanged ? this.buildStorage_(config) : this.storage_;
    this.truncateExistingPersonInfoForCookie_();
    this.defaultExpiry_ = this.expireDays_ = config['cookie_expiration'];
    this.set_disabled(disabled);
    this.set_cross_subdomain(config['cross_subdomain_cookie']);
    this.set_secure(config['secure_cookie']);
    if (persistenceChanged) {
      const props = this.props;
      this.clear();
      this.storage_ = newStore;
      this.props = props;
      this.save();
    }
  }

  /** @private */
  truncateExistingPersonInfoForCookie_() {
    const info = this.props[INITIAL_PERSON_INFO];
    if (!this.storesIdentityInCookie_ || !isObject(info) || typeof info['r'] !== 'string') return;
    const r = truncateForCookie(info['r']);
    const u = typeof info['u'] === 'string' ? truncateForCookie(info['u']) : info['u'];
    if (r !== info['r'] || u !== info['u']) this.props[INITIAL_PERSON_INFO] = extend({}, info, {'r': r, 'u': u});
  }

  /** @param {boolean} disabled */
  set_disabled(disabled) {
    this.disabled = disabled;
    if (this.disabled) this.remove();
    else this.save();
  }

  /** @param {boolean} cross */
  set_cross_subdomain(cross) {
    if (cross !== this.crossSubdomain_) {
      this.crossSubdomain_ = cross;
      this.remove();
      this.save();
    }
  }

  /** @param {boolean} secure */
  set_secure(secure) {
    if (secure !== this.secure_) {
      this.secure_ = secure;
      this.remove();
      this.save();
    }
  }

  /**
   * @param {string} eventName
   * @param {number} timestamp
   */
  set_event_timer(eventName, timestamp) {
    const timers = this.props[EVENT_TIMERS_KEY] || {};
    timers[eventName] = timestamp;
    this.props[EVENT_TIMERS_KEY] = timers;
    this.save();
  }

  /**
   * @param {string} eventName
   * @return {number|undefined}
   */
  remove_event_timer(eventName) {
    const timers = this.props[EVENT_TIMERS_KEY] || {};
    const ts = timers[eventName];
    if (!isUndefined(ts)) {
      delete timers[eventName];
      this.props[EVENT_TIMERS_KEY] = timers;
      this.save();
    }
    return ts;
  }

  /**
   * @param {string} prop
   * @return {*}
   */
  get_property(prop) {
    return this.props[prop];
  }

  /**
   * @param {string} prop
   * @param {*} to
   */
  set_property(prop, to) {
    this.props[prop] = to;
    this.save();
  }
}
