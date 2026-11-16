/**
 * @fileoverview Super-property & identity persistence. Data is a single JSON
 * object stored under `ph_<token>_posthog` (same key/format as upstream so an
 * existing visitor keeps their distinct_id when switching SDKs).
 */
import {createStore, MemoryStore, Store} from './storage.js';
import {
  extend, hasOwn, includes, isObject, isUndefined, keys, win, doc, getQueryParam, now,
} from './utils.js';
import {
  CAMPAIGN_PARAMS, EVENT_TIMERS_KEY, INITIAL_PERSON_INFO, PERSISTENCE_RESERVED_PROPERTIES,
} from './constants.js';

export class Persistence {
  /**
   * @param {!Object} config PostHog config (quoted keys).
   * @param {boolean=} sessionScoped true for the per-tab sessionStorage persistence.
   */
  constructor(config, sessionScoped) {
    /** @type {!Object} */
    this.props = {};
    /** @private @const {boolean} */
    this.sessionScoped_ = !!sessionScoped;
    /** @private {boolean} */
    this.disabled_ = false;
    /** @type {string} */
    this.name = '';
    /** @private {!Store} */
    this.store_ = new MemoryStore();
    /** @private {!Object} */
    this.config_ = config;
    this.configure(config);
  }

  /** @param {!Object} config */
  configure(config) {
    this.config_ = config;
    const token = String(config['token']);
    this.name = config['persistence_name'] ?
        'ph_' + config['persistence_name'] :
        'ph_' + token.replace(/\+/g, 'PL').replace(/\//g, 'SL').replace(/=/g, 'EQ') + '_posthog';
    if (this.sessionScoped_) {
      this.store_ = createStore(config['persistence'] === 'memory' ? 'memory' : 'sessionStorage');
    } else {
      this.store_ = createStore(String(config['persistence'] || 'localStorage+cookie'));
    }
    this.disabled_ = !!config['disable_persistence'];
    this.load();
  }

  /** @param {boolean} disabled */
  setDisabled(disabled) {
    this.disabled_ = disabled;
    if (disabled) this.removeFromStore();
    else this.save();
  }

  load() {
    if (this.disabled_) return;
    const stored = this.store_.parse(this.name);
    if (stored) this.props = /** @type {!Object} */ (extend({}, stored));
  }

  save() {
    if (this.disabled_) return;
    this.store_.set(
        this.name, this.props, this.expireDays_(), !!this.config_['cross_subdomain_cookie'],
        !!this.config_['secure_cookie']);
  }

  removeFromStore() {
    this.store_.remove(this.name, !!this.config_['cross_subdomain_cookie']);
  }

  clear() {
    this.removeFromStore();
    this.props = {};
  }

  /** @private @return {number} */
  expireDays_() {
    return this.config_['cookie_expiration'] || 365;
  }

  /**
   * Super properties to attach to events (internal keys stripped).
   * @return {!Object}
   */
  properties() {
    const out = {};
    for (const k in this.props) {
      if (!hasOwn(this.props, k)) continue;
      if (k === 'distinct_id' && this.config_['__omit_distinct_id']) continue;
      if (!includes(PERSISTENCE_RESERVED_PROPERTIES, k) && k.indexOf('$feature/') !== 0) {
        out[k] = this.props[k];
      }
    }
    return out;
  }

  /**
   * @param {!Object} props
   * @return {boolean} whether anything changed
   */
  register(props) {
    let changed = false;
    for (const k in props) {
      if (hasOwn(props, k) && this.props[k] !== props[k]) {
        this.props[k] = props[k];
        changed = true;
      }
    }
    if (changed) this.save();
    return changed;
  }

  /**
   * Sets only properties not already present (or equal to defaultValue).
   * @param {!Object} props
   * @param {*=} defaultValue
   * @return {boolean}
   */
  registerOnce(props, defaultValue) {
    let changed = false;
    for (const k in props) {
      if (!hasOwn(props, k)) continue;
      if (!hasOwn(this.props, k) || this.props[k] === defaultValue) {
        this.props[k] = props[k];
        changed = true;
      }
    }
    if (changed) this.save();
    return changed;
  }

  /** @param {string} key */
  unregister(key) {
    if (key in this.props) {
      delete this.props[key];
      this.save();
    }
  }

  /**
   * @param {string} key
   * @return {*}
   */
  get(key) {
    return this.props[key];
  }

  /**
   * @param {string} key
   * @param {*} value
   */
  set(key, value) {
    this.props[key] = value;
    this.save();
  }

  // ---- campaign / referrer -------------------------------------------------

  /** Stores current UTM/click-id params as super properties (session scope). */
  updateCampaignParams() {
    const params = getCampaignParams(this.config_['custom_campaign_params']);
    if (keys(params).length) this.register(params);
    return params;
  }

  updateReferrerInfo() {
    const ref = getReferrerInfo();
    this.register({'$referrer': ref['$referrer'], '$referring_domain': ref['$referring_domain']});
  }

  /** Stores the first-seen url/referrer so they can go out as $set_once. */
  setInitialPersonInfo() {
    if (this.props[INITIAL_PERSON_INFO]) return;
    const info = {
      'r': doc ? doc.referrer || '$direct' : '$direct',
      'u': win ? win.location.href : undefined,
    };
    extend(info, getCampaignParams(this.config_['custom_campaign_params']));
    this.registerOnce({[INITIAL_PERSON_INFO]: info});
  }

  /**
   * Converts the stored initial info into $initial_* person properties.
   * @return {!Object}
   */
  getInitialProps() {
    const info = this.props[INITIAL_PERSON_INFO];
    if (!isObject(info)) return {};
    const out = {};
    const referrer = info['r'];
    out['$initial_referrer'] = referrer;
    out['$initial_referring_domain'] = referrer === '$direct' ? '$direct' : hostnameOf(String(referrer));
    if (info['u']) {
      out['$initial_current_url'] = info['u'];
      const host = hostnameOf(String(info['u']));
      out['$initial_host'] = host;
      const m = /^[a-z]+:\/\/[^/]*(\/[^?#]*)/i.exec(String(info['u']));
      out['$initial_pathname'] = m ? m[1] : '/';
    }
    CAMPAIGN_PARAMS.forEach(function(p) {
      if (!isUndefined(info[p])) out['$initial_' + p] = info[p];
    });
    return out;
  }

  // ---- event timers ---------------------------------------------------------

  /** @param {string} eventName */
  startEventTimer(eventName) {
    const timers = this.props[EVENT_TIMERS_KEY] || {};
    timers[eventName] = now();
    this.set(EVENT_TIMERS_KEY, timers);
  }

  /**
   * @param {string} eventName
   * @return {number|undefined}
   */
  removeEventTimer(eventName) {
    const timers = this.props[EVENT_TIMERS_KEY] || {};
    const ts = timers[eventName];
    if (!isUndefined(ts)) {
      delete timers[eventName];
      this.set(EVENT_TIMERS_KEY, timers);
    }
    return ts;
  }
}

/**
 * @param {string} url
 * @return {string}
 */
export function hostnameOf(url) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i.exec(url);
  return m ? m[1] : '';
}

/**
 * @param {*=} custom array of extra campaign params from config
 * @return {!Object<string, string>}
 */
export function getCampaignParams(custom) {
  const out = {};
  if (!win) return out;
  const url = win.location.href;
  const names = CAMPAIGN_PARAMS.concat(Array.isArray(custom) ? /** @type {!Array<string>} */ (custom) : []);
  names.forEach(function(p) {
    const v = getQueryParam(url, p);
    if (v) out[p] = v;
  });
  return out;
}

/** @return {!Object<string, string>} */
export function getReferrerInfo() {
  const ref = doc && doc.referrer ? doc.referrer : '$direct';
  return {
    '$referrer': ref,
    '$referring_domain': ref === '$direct' ? '$direct' : hostnameOf(ref) || '$direct',
  };
}
