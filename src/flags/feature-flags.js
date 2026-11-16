/**
 * @fileoverview Feature flags module (optional). Talks to `/flags/?v=2`,
 * persists results under upstream's keys and adds `$feature/<key>` and
 * `$active_feature_flags` to every event.
 *
 * Load it by including this module in the build (see src/entry/full.js) or by
 * loading the `flags` Closure chunk after the core chunk.
 */
import {PostHog} from '../core/posthog.js';
import {FeatureFlagsApi} from '../core/extensions.js';
import {request, HttpResponse} from '../core/request.js';
import {logger} from '../core/logger.js';
import {extend, hasOwn, isArray, isObject, isString, isUndefined, jsonParse, keys, win} from '../core/utils.js';
import {DEVICE_ID, STORED_GROUP_PROPERTIES_KEY, STORED_PERSON_PROPERTIES_KEY, LIB_VERSION, LIB_NAME} from '../core/constants.js';

/** @const {string} */ export const ENABLED_FLAGS_KEY = '$enabled_feature_flags';
/** @const {string} */ export const ACTIVE_FLAGS_KEY = '$active_feature_flags';
/** @const {string} */ export const FLAG_PAYLOADS_KEY = '$feature_flag_payloads';
/** @const {string} */ export const FLAG_DETAILS_KEY = '$feature_flag_details';
/** @const {string} */ export const OVERRIDE_FLAGS_KEY = '$override_feature_flags';
/** @const {string} */ export const FLAG_REQUEST_ID_KEY = '$feature_flag_request_id';

/** @typedef {function(!Array<string>, !Object<string, (string|boolean)>, ?Object)} */
let FlagsCallback;

/**
 * Parses a payload, which v2 sends as a JSON-encoded string.
 * @param {*} raw
 * @return {*}
 */
function parsePayload(raw) {
  if (!isString(raw)) return raw;
  const parsed = jsonParse(/** @type {string} */ (raw));
  return parsed === null && raw !== 'null' ? raw : parsed;
}

/** @implements {FeatureFlagsApi} */
export class FeatureFlags {
  /** @param {!PostHog} instance */
  constructor(instance) {
    /** @private @const {!PostHog} */
    this.ph_ = instance;
    /** @private {boolean} */
    this.loadedOnce_ = false;
    /** @private {boolean} */
    this.inFlight_ = false;
    /** @private {boolean} */
    this.reloadQueued_ = false;
    /** @private {number} */
    this.debounce_ = 0;
    /** @private {string|undefined} */
    this.anonDistinctId_ = undefined;
    /** @private @const {!Array<!FlagsCallback>} */
    this.callbacks_ = [];
    /** Flags already reported via $feature_flag_called: key -> [values]. @private @const {!Object<string, !Array<*>>} */
    this.reported_ = {};
  }

  /** @private @return {!Object} */
  config_() {
    return this.ph_.config;
  }

  /** @private @return {boolean} */
  remoteDisabled_() {
    const c = this.config_();
    return !!(c['advanced_disable_flags'] || c['advanced_disable_feature_flags']);
  }

  /** @override */
  onInit() {
    this.applyBootstrap_();
    if (this.remoteDisabled_() || this.config_()['advanced_disable_feature_flags_on_first_load']) {
      if (this.loadedOnce_) this.notify_(false);
      return;
    }
    this.reload();
  }

  /** @private */
  applyBootstrap_() {
    const b = this.config_()['bootstrap'] || {};
    const flags = b['featureFlags'];
    if (!isObject(flags) || !keys(flags).length) return;
    const payloads = b['featureFlagPayloads'] || {};
    const all = {};
    const pl = {};
    for (const k in flags) {
      if (!hasOwn(flags, k)) continue;
      all[k] = flags[k];
      if (!isUndefined(payloads[k])) pl[k] = parsePayload(payloads[k]);
    }
    this.store_(all, pl, {}, undefined);
    this.loadedOnce_ = true;
  }

  // ---- extension hooks ------------------------------------------------------

  /** @override */
  eventProperties(eventName) {
    if (eventName === '$snapshot') return null;
    const flags = this.getFlagVariants();
    const out = {};
    const active = [];
    for (const k in flags) {
      if (!hasOwn(flags, k)) continue;
      const v = flags[k];
      if (v) {
        out['$feature/' + k] = v;
        active.push(k);
      }
    }
    if (active.length) out[ACTIVE_FLAGS_KEY] = active;
    return out;
  }

  /** @override */
  onIdentityChange(reason) {
    if (reason === 'identify' && isUndefined(this.anonDistinctId_)) {
      // The server merges flags evaluated for the previous anonymous id.
      this.anonDistinctId_ = String(this.ph_.get_property(DEVICE_ID) || '');
    }
    this.reload();
  }

  /** @override */
  onReset() {
    this.reported_ = /** @type {!Object<string, !Array<*>>} */ ({});
    this.anonDistinctId_ = undefined;
  }

  // ---- public facade (called through PostHog) ------------------------------

  /** Debounced reload so bursts of identify/group calls make one request. */
  reload() {
    if (this.remoteDisabled_() || !win) return;
    if (this.debounce_) win.clearTimeout(this.debounce_);
    const self = this;
    this.debounce_ = win.setTimeout(function() {
      self.debounce_ = 0;
      self.request_();
    }, 5);
  }

  /** @private */
  request_() {
    if (this.inFlight_) {
      this.reloadQueued_ = true;
      return;
    }
    const ph = this.ph_;
    const c = this.config_();
    const body = {
      'token': c['token'],
      'distinct_id': ph.get_distinct_id(),
      'groups': ph.getGroups(),
      'person_properties': extend({}, ph.get_property(STORED_PERSON_PROPERTIES_KEY) || {},
          {'$lib': LIB_NAME, '$lib_version': LIB_VERSION}),
      'group_properties': ph.get_property(STORED_GROUP_PROPERTIES_KEY) || {},
    };
    const deviceId = ph.get_property(DEVICE_ID);
    if (deviceId) body['$device_id'] = deviceId;
    if (this.anonDistinctId_) body['$anon_distinct_id'] = this.anonDistinctId_;
    try {
      body['timezone'] = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch (e) {}

    this.inFlight_ = true;
    const self = this;
    request({
      url: ph.apiUrl('/flags/?v=2'),
      method: 'POST',
      data: body,
      headers: c['request_headers'],
      compression: 'base64',
      transport: undefined,
      timeout: c['feature_flag_request_timeout_ms'],
      callback: function(/** !HttpResponse */ res) {
        self.inFlight_ = false;
        self.handleResponse_(res);
        if (self.reloadQueued_) {
          self.reloadQueued_ = false;
          self.reload();
        }
      },
    });
  }

  /**
   * @param {!HttpResponse} res
   * @private
   */
  handleResponse_(res) {
    const json = res.json;
    const failed = res.statusCode !== 200 || !isObject(json);
    if (failed) {
      logger.error('feature flags request failed', res.statusCode);
      this.notify_(true);
      return;
    }
    this.anonDistinctId_ = undefined;
    const quota = json['quotaLimited'];
    if (isArray(quota) && quota.indexOf('feature_flags') !== -1) {
      logger.warn('feature flags quota limited; flags were not updated');
      this.notify_(true);
      return;
    }
    const partial = !!json['errorsWhileComputingFlags'];
    const all = partial ? extend({}, this.storedFlags_()) : {};
    const payloads = partial ? extend({}, this.ph_.get_property(FLAG_PAYLOADS_KEY) || {}) : {};
    const details = partial ? extend({}, this.ph_.get_property(FLAG_DETAILS_KEY) || {}) : {};

    if (isObject(json['flags'])) {
      // v2: {flags: {key: {key, enabled, variant, reason, metadata: {id, version, payload}}}}
      const flags = json['flags'];
      for (const k in flags) {
        if (!hasOwn(flags, k)) continue;
        const f = flags[k] || {};
        const value = f['enabled'] ? (f['variant'] || true) : false;
        all[k] = value;
        const meta = f['metadata'] || {};
        if (f['enabled'] && !isUndefined(meta['payload']) && meta['payload'] !== null) {
          payloads[k] = parsePayload(meta['payload']);
        } else {
          delete payloads[k];
        }
        details[k] = {
          'id': meta['id'],
          'version': meta['version'],
          'reason': f['reason'] ? f['reason']['description'] || f['reason']['code'] : undefined,
        };
      }
    } else if (isObject(json['featureFlags'])) {
      // v1 fallback
      extend(all, json['featureFlags']);
      const p = json['featureFlagPayloads'] || {};
      for (const k in p) {
        if (hasOwn(p, k)) payloads[k] = parsePayload(p[k]);
      }
    }
    this.store_(all, payloads, details, json['requestId']);
    this.loadedOnce_ = true;
    this.notify_(false);
  }

  /**
   * @param {!Object} all key -> value (false for disabled)
   * @param {!Object} payloads
   * @param {!Object} details
   * @param {*} requestId
   * @private
   */
  store_(all, payloads, details, requestId) {
    const active = keys(all).filter(function(k) {
      return !!all[k];
    });
    const props = {};
    props[ENABLED_FLAGS_KEY] = all;
    props[ACTIVE_FLAGS_KEY] = active;
    props[FLAG_PAYLOADS_KEY] = payloads;
    props[FLAG_DETAILS_KEY] = details;
    if (requestId) props[FLAG_REQUEST_ID_KEY] = requestId;
    this.ph_.register(props);
  }

  /** @private @return {!Object<string, (string|boolean)>} */
  storedFlags_() {
    const v = this.ph_.get_property(ENABLED_FLAGS_KEY);
    return /** @type {!Object<string, (string|boolean)>} */ (isObject(v) ? v : {});
  }

  /**
   * All flags (including disabled ones as false), with overrides applied.
   * @return {!Object<string, (string|boolean)>}
   */
  getFlagVariants() {
    const flags = /** @type {!Object<string, (string|boolean)>} */ (extend({}, this.storedFlags_()));
    const overrides = this.ph_.get_property(OVERRIDE_FLAGS_KEY);
    if (isObject(overrides)) extend(flags, overrides);
    return flags;
  }

  /**
   * @param {string} key
   * @param {?Object=} options {'send_event': boolean}
   * @return {boolean|string|undefined}
   */
  getFlag(key, options) {
    if (!this.loadedOnce_ && !this.hasOverrides_()) {
      logger.warn('getFeatureFlag for key "' + key + '" failed. Feature flags didn\'t load in time.');
      return undefined;
    }
    const flags = this.getFlagVariants();
    const value = flags[key];
    if (!options || options['send_event'] !== false) this.reportCall_(key, value);
    return value;
  }

  /**
   * @param {string} key
   * @param {?Object=} options
   * @return {boolean|undefined}
   */
  isEnabled(key, options) {
    const v = this.getFlag(key, options);
    return isUndefined(v) ? undefined : !!v;
  }

  /**
   * @param {string} key
   * @return {*}
   */
  getFlagPayload(key) {
    const payloads = this.ph_.get_property(FLAG_PAYLOADS_KEY);
    return isObject(payloads) ? payloads[key] : undefined;
  }

  /**
   * @param {!FlagsCallback} cb
   * @return {function()}
   */
  onFlags(cb) {
    this.callbacks_.push(cb);
    if (this.loadedOnce_) this.invoke_(cb, false);
    const list = this.callbacks_;
    return function() {
      const i = list.indexOf(cb);
      if (i !== -1) list.splice(i, 1);
    };
  }

  /**
   * @param {(boolean|!Array<string>|!Object<string, (string|boolean)>)} overrides
   */
  override(overrides) {
    if (overrides === false) {
      this.ph_.unregister(OVERRIDE_FLAGS_KEY);
    } else if (isArray(overrides)) {
      const map = {};
      /** @type {!Array<string>} */ (overrides).forEach(function(k) {
        map[k] = true;
      });
      this.ph_.register({[OVERRIDE_FLAGS_KEY]: map});
    } else if (isObject(overrides)) {
      this.ph_.register({[OVERRIDE_FLAGS_KEY]: overrides});
    }
    this.notify_(false);
  }

  /** @private @return {boolean} */
  hasOverrides_() {
    return isObject(this.ph_.get_property(OVERRIDE_FLAGS_KEY));
  }

  /**
   * @param {boolean} errorsLoading
   * @private
   */
  notify_(errorsLoading) {
    const self = this;
    this.callbacks_.slice().forEach(function(cb) {
      self.invoke_(cb, errorsLoading);
    });
  }

  /**
   * @param {!FlagsCallback} cb
   * @param {boolean} errorsLoading
   * @private
   */
  invoke_(cb, errorsLoading) {
    const variants = this.getFlagVariants();
    const active = keys(variants).filter(function(k) {
      return !!variants[k];
    });
    try {
      cb(active, variants, {'errorsLoading': errorsLoading});
    } catch (e) {
      logger.error('onFeatureFlags callback threw', e);
    }
  }

  /**
   * Emits $feature_flag_called once per (flag, value) per page load.
   * @param {string} key
   * @param {*} value
   * @private
   */
  reportCall_(key, value) {
    const seen = this.reported_[key] || (this.reported_[key] = []);
    if (seen.indexOf(value) !== -1) return;
    seen.push(value);
    const details = (this.ph_.get_property(FLAG_DETAILS_KEY) || {})[key] || {};
    const props = {
      '$feature_flag': key,
      '$feature_flag_response': isUndefined(value) ? null : value,
      '$feature_flag_payload': this.getFlagPayload(key),
      '$feature_flag_id': details['id'],
      '$feature_flag_version': details['version'],
      '$feature_flag_reason': details['reason'],
      '$feature_flag_request_id': this.ph_.get_property(FLAG_REQUEST_ID_KEY),
    };
    const bootstrap = (this.config_()['bootstrap'] || {})['featureFlags'];
    if (isObject(bootstrap) && hasOwn(/** @type {!Object} */ (bootstrap), key)) {
      props['$feature_flag_bootstrapped_response'] = bootstrap[key];
    }
    this.ph_.capture('$feature_flag_called', props);
  }
}
