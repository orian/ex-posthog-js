/**
 * @fileoverview Feature flags module (optional). Port of upstream
 * browser-common/src/feature-flags.ts + browser/src/posthog-featureflags.ts:
 * `/flags/?v=2` requests (with retries and a status-0 circuit breaker),
 * persisted flag state under upstream's keys, `$feature/<key>`,
 * `$active_feature_flags` and `$feature_flag_payloads` on every event,
 * `$feature_flag_called` with upstream's dedup rules, overrides, bootstrap,
 * the 5-minute background refresh, and early access features.
 *
 * Not ported: cross-tab flag merging (needs split storage) and the opt-in
 * `/flags` request timing metrics.
 *
 * Load it by including this module in the build (see src/entry/full.js) or by
 * loading the `flags` Closure chunk after the core chunk.
 */
import {PostHog} from '../core/posthog.js';
import {FeatureFlagsApi} from '../core/extensions.js';
import {RequestOptions} from '../core/request.js';
import {logger as baseLogger} from '../core/logger.js';
import {getTimezone} from '../core/event-utils.js';
import {
  addEventListener, assign, doc, extend, isArray, isObject, isString, isUndefined, keys, microtask, win,
} from '../core/utils.js';
import {
  Config, DEVICE_ID, ENABLED_FEATURE_FLAGS, FLAG_CALL_REPORTED, FLAG_CALL_REPORTED_SESSION_ID,
  PERSISTENCE_ACTIVE_FEATURE_FLAGS, PERSISTENCE_EARLY_ACCESS_FEATURES, PERSISTENCE_FEATURE_FLAG_DETAILS,
  PERSISTENCE_FEATURE_FLAG_ERRORS, PERSISTENCE_FEATURE_FLAG_EVALUATED_AT, PERSISTENCE_FEATURE_FLAG_PAYLOADS,
  PERSISTENCE_FEATURE_FLAG_REQUEST_ID, PERSISTENCE_MINIMAL_FLAG_CALLED_EVENTS, PERSISTENCE_OVERRIDE_FEATURE_FLAGS,
  PERSISTENCE_OVERRIDE_FEATURE_FLAG_PAYLOADS, STORED_GROUP_PROPERTIES_KEY, STORED_PERSON_PROPERTIES_KEY,
} from '../core/constants.js';

const logger = baseLogger.createLogger('[FeatureFlags]');
const FLAG_TIMEOUT_MSG = '" failed. Feature flags didn\'t load in time.';
const MAX_CONSECUTIVE_FLAGS_STATUS_ZERO_FAILURES = 3;
const RETRYABLE_FLAGS_HTTP_STATUSES = [502, 504];
const FLAGS_RETRY_DELAY_MS = 500;
const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const MAX_IDLE_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const USER_INTERACTION_EVENTS = ['click', 'keydown', 'wheel', 'touchstart', 'pointerdown'];

/** Upstream FeatureFlagError. */
export const FeatureFlagError = {
  ERRORS_WHILE_COMPUTING: 'errors_while_computing_flags',
  FLAG_MISSING: 'flag_missing',
  EVALUATION_FAILED: 'evaluation_failed',
  QUOTA_LIMITED: 'quota_limited',
  TIMEOUT: 'timeout',
  CONNECTION_ERROR: 'connection_error',
  UNKNOWN_ERROR: 'unknown_error',
};

/**
 * @param {*} response
 * @return {*}
 */
function parsePayload(response) {
  if (typeof response !== 'string') return response;
  try {
    return JSON.parse(response);
  } catch (e) {
    return response;
  }
}

/**
 * @param {!PHResponse} response
 * @return {boolean}
 */
function isFlagsTimeout(response) {
  return response.statusCode === 0 && response.error instanceof Error && response.error.name === 'AbortError';
}

/**
 * @param {?} values
 * @param {?} details
 * @return {!Object}
 */
function filterFailedFlagValues(values, details) {
  const failed = keys(details || {}).filter(function(k) {
    return details[k] && details[k]['failed'];
  });
  if (!failed.length) return values || {};
  const filtered = assign(values);
  failed.forEach(function(k) {
    delete filtered[k];
  });
  return filtered;
}

/**
 * @param {!Object} details
 * @param {!Array<string>} evaluatedKeys
 * @return {!Object}
 */
function withoutFailedDetails(details, evaluatedKeys) {
  const remaining = assign(details);
  evaluatedKeys.forEach(function(k) {
    if (remaining[k] && remaining[k]['failed']) delete remaining[k];
  });
  return remaining;
}

/**
 * @param {!Object} response
 * @param {?Object=} options
 * @return {boolean}
 */
function mergesIntoCurrentState(response, options) {
  return !!(options && options['partialResponse']) || !!response['errorsWhileComputingFlags'];
}

/**
 * @param {!Array<string>} flags
 * @return {!Object<string, boolean>}
 */
function arrayToFlagsRecord(flags) {
  const out = {};
  for (let i = 0; i < flags.length; i++) out[flags[i]] = true;
  return out;
}

/**
 * @param {?Object|undefined} flags
 * @return {!Object}
 */
function filterActiveFeatureFlags(flags) {
  const active = {};
  keys(flags || {}).forEach(function(k) {
    if (flags[k]) active[k] = flags[k];
  });
  return active;
}

/**
 * @param {!Object} response
 * @return {!Object}
 */
function normalizeFlagsResponse(response) {
  const details = response['flags'];
  if (details) {
    const featureFlags = {};
    const featureFlagPayloads = {};
    keys(details).forEach(function(flag) {
      const d = details[flag];
      if (d['failed']) return;
      featureFlags[flag] = isUndefined(d['variant']) || d['variant'] === null ? d['enabled'] : d['variant'];
      const meta = d['metadata'];
      if (d['enabled'] && !isUndefined(meta ? meta['payload'] : undefined)) featureFlagPayloads[flag] = meta['payload'];
    });
    return extend({}, response, {'featureFlags': featureFlags, 'featureFlagPayloads': featureFlagPayloads});
  } else if (response['featureFlags']) {
    logger.warn('Using an older version of the feature flags endpoint. Please upgrade your PostHog server to the ' +
        'latest version');
  }
  return response;
}

/**
 * Upstream parseFlagsResponse: the persistence patch for a /flags response.
 * @param {!Object} response
 * @param {?} currentFlags
 * @param {?} currentPayloads
 * @param {?} currentDetails
 * @param {?Object=} options
 * @return {!Object|undefined}
 */
function parseFlagsResponse(response, currentFlags, currentPayloads, currentDetails, options) {
  const normalized = normalizeFlagsResponse(response);
  const flagDetails = normalized['flags'];
  const featureFlags = normalized['featureFlags'];
  const flagPayloads = normalized['featureFlagPayloads'];
  if (!featureFlags) return undefined;
  const requestId = response['requestId'];
  const evaluatedAt = response['evaluatedAt'];

  if (isArray(featureFlags)) {
    logger.warn('v1 of the feature flags endpoint is deprecated. Please use the latest version.');
    const enabled = {};
    featureFlags.forEach(function(f) {
      enabled[f] = true;
    });
    return {
      [PERSISTENCE_ACTIVE_FEATURE_FLAGS]: featureFlags,
      [ENABLED_FEATURE_FLAGS]: enabled,
      [PERSISTENCE_FEATURE_FLAG_DETAILS]: withoutFailedDetails(currentDetails, featureFlags),
      [PERSISTENCE_FEATURE_FLAG_PAYLOADS]: filterFailedFlagValues(currentPayloads, currentDetails),
      [PERSISTENCE_MINIMAL_FLAG_CALLED_EVENTS]: false,
    };
  }

  let newFlags = featureFlags;
  let newPayloads = flagPayloads;
  let newDetails = flagDetails;
  if (mergesIntoCurrentState(response, options)) {
    const hasOwnCached = function(key) {
      return Object.prototype.hasOwnProperty.call(currentFlags, key) && !isUndefined(currentFlags[key]);
    };
    const evaluatedKeys = keys(newFlags);
    const evaluatedPayloads = newPayloads || {};
    newFlags = extend({}, currentFlags, newFlags);
    newPayloads = extend({}, currentPayloads, evaluatedPayloads);
    if ((options && options['partialResponse']) || flagDetails) {
      evaluatedKeys.forEach(function(k) {
        if (!(k in evaluatedPayloads)) delete newPayloads[k];
      });
    }
    if (flagDetails) {
      const kept = {};
      keys(flagDetails).forEach(function(k) {
        if (!flagDetails[k]['failed'] || !hasOwnCached(k)) kept[k] = flagDetails[k];
      });
      newDetails = extend({}, currentDetails, kept);
    } else {
      newDetails = withoutFailedDetails(currentDetails, evaluatedKeys);
    }
  }
  const patch = {
    [PERSISTENCE_ACTIVE_FEATURE_FLAGS]: keys(filterActiveFeatureFlags(newFlags)),
    [ENABLED_FEATURE_FLAGS]: newFlags || {},
    [PERSISTENCE_FEATURE_FLAG_PAYLOADS]: newPayloads || {},
    [PERSISTENCE_FEATURE_FLAG_DETAILS]: newDetails || {},
    [PERSISTENCE_MINIMAL_FLAG_CALLED_EVENTS]: response['minimalFlagCalledEvents'] === true,
  };
  if (requestId) patch[PERSISTENCE_FEATURE_FLAG_REQUEST_ID] = requestId;
  if (evaluatedAt) patch[PERSISTENCE_FEATURE_FLAG_EVALUATED_AT] = evaluatedAt;
  return patch;
}

/**
 * @param {!Object} a
 * @param {!Object} b
 * @return {boolean}
 */
function haveSameGroups(a, b) {
  const k = keys(a);
  return k.length === keys(b).length && k.every(function(key) {
    return a[key] === b[key];
  });
}

/** @typedef {{distinctId: (string|undefined), groups: !Object, sessionId: (string|undefined)}} */
let FlagCallContext;

/** @implements {FeatureFlagsApi} */
export class FeatureFlags {
  /** @param {!PostHog} instance */
  constructor(instance) {
    /** @private @const {!PostHog} */
    this.ph_ = instance;
    /** @private {boolean} */
    this.overrideWarning_ = false;
    /** @private {!Array<function(!Array<string>, !Object, ?Object=)>} */
    this.handlers_ = [];
    /** @type {string|undefined} */
    this.anonDistinctId = undefined;
    /** @private {!Object} */
    this.baseEventProperties_ = {};
    /** @private {!Object} */
    this.eventPropertiesWithFlagValues_ = {};
    /** @private {?Object|undefined} */
    this.bootstrapState_ = undefined;
    /** @private {!Array<function()>} */
    this.reloadingHandlers_ = [];
    /** @private {boolean} */
    this.hasLoadedFlags_ = false;
    /** @private {boolean} */
    this.requestInFlight_ = false;
    /** @private {number} */
    this.requestGeneration_ = 0;
    /** @private {boolean} */
    this.reloadingDisabled_ = false;
    /** @private {boolean} */
    this.additionalReloadRequested_ = false;
    /** @private {number|undefined} */
    this.reloadDebouncer_ = undefined;
    /** @private {boolean} */
    this.firingCallbacks_ = false;
    /** @private {!Object<string, {value: string, context: !FlagCallContext}>} */
    this.flagCallsPendingCapture_ = {};
    /** @private {!Array<string>} insertion order of pending keys */
    this.pendingOrder_ = [];
    /** @private {boolean} */
    this.sendingPending_ = false;
    /** @private {boolean} */
    this.flagsLoadedFromRemote_ = false;
    /** @private {boolean} */
    this.staleCacheRefreshTriggered_ = false;
    /** @private {number} */
    this.consecutiveStatusZeroFailures_ = 0;
    /** @private {number|undefined} */
    this.refreshInterval_ = undefined;
    /** @private {number|undefined} */
    this.refreshIntervalMs_ = undefined;
    /** @private {number|undefined} */
    this.dueRefreshIntervalMs_ = undefined;
    /** @private {boolean} */
    this.hadUserInteraction_ = false;
    /** @private {number|undefined} */
    this.lastRefreshAt_ = undefined;
    /** @private {boolean} */
    this.setUp_ = false;
    /** @private {?} config snapshot (upstream MutableFeatureFlagsConfigSource) */
    this.snapshot_ = {};
    this.updateSnapshot_(instance.config, instance.shouldDisableFlags());

    const self = this;
    /** @private @const */
    this.onOnline_ = function() {
      const wasTripped = self.circuitBreakerTripped_();
      self.consecutiveStatusZeroFailures_ = 0;
      if (wasTripped) self.reloadFeatureFlags();
    };
    /** @private @const */
    this.refreshIfDue_ = function() {
      self.doRefreshIfDue_();
    };
    /** @private @const */
    this.onUserInteraction_ = function() {
      if (self.hadUserInteraction_ && self.dueRefreshIntervalMs_ === self.refreshIntervalMs_) return;
      self.resumeConfiguredInterval_();
    };
    /** @private @const */
    this.onVisibilityChange_ = function() {
      if (doc && doc.visibilityState === 'visible') self.resumeConfiguredInterval_();
    };
  }

  /**
   * @param {!Object} c
   * @param {boolean} remoteRequestsDisabled
   * @private
   */
  updateSnapshot_(c, remoteRequestsDisabled) {
    const bootstrap = c['bootstrap'] || {};
    const interval = c['remote_config_refresh_interval_ms'];
    this.snapshot_ = {
      bootstrapFlags: bootstrap['featureFlags'],
      bootstrapPayloads: bootstrap['featureFlagPayloads'],
      remoteRequestsDisabled: remoteRequestsDisabled,
      featureFlagsDisabled: !!c['advanced_disable_feature_flags'],
      onlyEvaluateSurveyFeatureFlags: !!c['advanced_only_evaluate_survey_feature_flags'],
      deduplicateCallsPerSession: !!c['advanced_feature_flags_dedup_per_session'],
      cacheTtlMs: c['feature_flag_cache_ttl_ms'],
      refreshIntervalMs: interval === undefined || interval === null ? DEFAULT_REFRESH_INTERVAL_MS : interval,
      idleRefreshBackoff: isUndefined(interval),
      requestTimeoutMs: c['feature_flag_request_timeout_ms'],
      requestMaxRetries: Math.max(0, isUndefined(c['feature_flag_request_max_retries']) ||
          c['feature_flag_request_max_retries'] === null ? 1 : c['feature_flag_request_max_retries']),
      compression: c['disable_compression'] ? undefined : 'best-available',
      evaluationContexts: c['evaluation_contexts'] || c['evaluation_environments'] || [],
      flagKeys: isArray(c['flag_keys']) ? c['flag_keys'] : undefined,
    };
  }

  /** @override */
  updateConfig(config, remoteRequestsDisabled) {
    this.updateSnapshot_(config, remoteRequestsDisabled);
    if (this.setUp_) this.syncAutomaticRefresh_();
  }

  // ---- setup ----------------------------------------------------------------

  /** @override */
  onInit() {
    this.setUp_ = true;
    if (win) addEventListener(win, 'online', this.onOnline_);
    this.syncAutomaticRefresh_();
    this.rebuildEventProperties_();
    this.initialize();
  }

  /** @override */
  eventProperties(eventName) {
    return this.isCacheStale_() ? this.baseEventProperties_ : this.eventPropertiesWithFlagValues_;
  }

  /** @private */
  doRefreshIfDue_() {
    const interval = this.refreshIntervalMs_;
    const due = isUndefined(this.dueRefreshIntervalMs_) ? interval : this.dueRefreshIntervalMs_;
    if (isUndefined(interval) || isUndefined(due) || this.snapshot_.remoteRequestsDisabled || !doc ||
        doc.visibilityState === 'hidden' || new Date().getTime() - (this.lastRefreshAt_ || 0) < due) {
      return;
    }
    this.dueRefreshIntervalMs_ = this.hadUserInteraction_ || !this.snapshot_.idleRefreshBackoff ? interval :
        Math.min(/** @type {number} */ (due) * 2, MAX_IDLE_REFRESH_INTERVAL_MS);
    this.hadUserInteraction_ = false;
    this.reloadFeatureFlags();
    this.scheduleNextRefresh_();
  }

  /** @private */
  resumeConfiguredInterval_() {
    this.hadUserInteraction_ = true;
    this.dueRefreshIntervalMs_ = this.refreshIntervalMs_;
    this.doRefreshIfDue_();
  }

  /** @private */
  syncAutomaticRefresh_() {
    const configured = this.snapshot_.refreshIntervalMs;
    const interval = !this.snapshot_.remoteRequestsDisabled && doc && !isUndefined(configured) && configured > 0 ?
        configured : undefined;
    if (!this.snapshot_.idleRefreshBackoff) this.dueRefreshIntervalMs_ = interval;
    if (interval === this.refreshIntervalMs_) return;
    this.stopAutomaticRefresh_();
    if (isUndefined(interval)) return;
    this.refreshIntervalMs_ = interval;
    this.dueRefreshIntervalMs_ = interval;
    this.scheduleNextRefresh_();
    if (doc && doc.addEventListener) {
      addEventListener(doc, 'visibilitychange', this.onVisibilityChange_);
      const self = this;
      USER_INTERACTION_EVENTS.forEach(function(e) {
        addEventListener(doc, e, self.onUserInteraction_, {capture: true, passive: undefined});
      });
    }
  }

  /** @private */
  scheduleNextRefresh_() {
    if (isUndefined(this.refreshIntervalMs_)) return;
    if (!isUndefined(this.refreshInterval_)) clearInterval(this.refreshInterval_);
    this.lastRefreshAt_ = new Date().getTime();
    this.refreshInterval_ = setInterval(this.refreshIfDue_, this.refreshIntervalMs_);
  }

  /** @private */
  stopAutomaticRefresh_() {
    if (!isUndefined(this.refreshInterval_)) {
      clearInterval(this.refreshInterval_);
      this.refreshInterval_ = undefined;
      if (doc) {
        doc.removeEventListener('visibilitychange', this.onVisibilityChange_);
        const self = this;
        USER_INTERACTION_EVENTS.forEach(function(e) {
          doc.removeEventListener(e, self.onUserInteraction_, true);
        });
      }
    }
    this.refreshIntervalMs_ = undefined;
    this.dueRefreshIntervalMs_ = undefined;
    this.hadUserInteraction_ = false;
    this.lastRefreshAt_ = undefined;
  }

  // ---- persistence helpers ---------------------------------------------------

  /**
   * @param {string} key
   * @return {?}
   * @private
   */
  prop_(key) {
    if (this.bootstrapState_ && key in this.bootstrapState_) return this.bootstrapState_[key];
    return this.ph_.get_property(key);
  }

  /** @return {boolean} @private */
  clearBootstrapState_() {
    if (!this.bootstrapState_) return false;
    this.bootstrapState_ = undefined;
    return true;
  }

  /** @return {boolean} @private */
  fallBackToPersistedFlags_() {
    if (isUndefined(this.ph_.get_property(ENABLED_FEATURE_FLAGS))) return false;
    return this.clearBootstrapState_();
  }

  /**
   * @param {!Object} properties
   * @private
   */
  set_(properties) {
    try {
      if (this.ph_.persistence) this.ph_.persistence.register(properties);
    } catch (e) {
      logger.error('Failed to update feature flag persistence', e);
    }
  }

  /**
   * @param {(string|!Array<string>)} k
   * @private
   */
  remove_(k) {
    try {
      if (this.ph_.persistence) this.ph_.persistence.unregister(k);
    } catch (e) {
      logger.error('Failed to update feature flag persistence', e);
    }
  }

  /** @private */
  rebuildEventProperties_() {
    const common = {};
    const details = this.prop_(PERSISTENCE_FEATURE_FLAG_DETAILS);
    const self = this;
    [PERSISTENCE_FEATURE_FLAG_REQUEST_ID, PERSISTENCE_OVERRIDE_FEATURE_FLAGS].forEach(function(k) {
      const v = self.prop_(k);
      if (!isUndefined(v)) common[k] = v;
    });
    const active = this.prop_(PERSISTENCE_ACTIVE_FEATURE_FLAGS);
    if (active) {
      common[PERSISTENCE_ACTIVE_FEATURE_FLAGS] = active.filter(function(k) {
        return !(details && details[k] && details[k]['failed']);
      });
    }
    const payloads = this.prop_(PERSISTENCE_FEATURE_FLAG_PAYLOADS);
    if (payloads) common[PERSISTENCE_FEATURE_FLAG_PAYLOADS] = filterFailedFlagValues(payloads, details);
    this.baseEventProperties_ = common;
    const withValues = assign(common);
    const flags = filterFailedFlagValues(this.prop_(ENABLED_FEATURE_FLAGS), details);
    keys(flags).forEach(function(k) {
      withValues['$feature/' + k] = flags[k];
    });
    this.eventPropertiesWithFlagValues_ = withValues;
  }

  /** @return {boolean} @private */
  isCacheStale_() {
    const ttl = this.snapshot_.cacheTtlMs;
    if (!ttl || ttl <= 0) return false;
    const evaluatedAt = this.prop_(PERSISTENCE_FEATURE_FLAG_EVALUATED_AT);
    return typeof evaluatedAt !== 'number' || new Date().getTime() - evaluatedAt > ttl;
  }

  /** @return {boolean} @private */
  checkAndTriggerStaleRefresh_() {
    if (!this.isCacheStale_()) return false;
    if (!this.staleCacheRefreshTriggered_ && !this.requestInFlight_) {
      this.staleCacheRefreshTriggered_ = true;
      logger.warn('Feature flag cache is stale, triggering refresh...');
      this.reloadFeatureFlags();
    }
    return true;
  }

  /** @return {!Array<string>} @private */
  validEvaluationContexts_() {
    const envs = this.snapshot_.evaluationContexts;
    if (!envs || !envs.length) return [];
    return envs.filter(function(env) {
      const ok = env && typeof env === 'string' && env.replace(/^\s+|\s+$/g, '').length > 0;
      if (!ok) logger.error('Invalid evaluation context found:', env, 'Expected non-empty string');
      return ok;
    });
  }

  /** @return {!Array<string>|undefined} @private */
  validFlagKeys_() {
    const flagKeys = this.snapshot_.flagKeys;
    if (isUndefined(flagKeys)) return undefined;
    return flagKeys.filter(function(k) {
      const ok = k && typeof k === 'string' && k.replace(/^\s+|\s+$/g, '').length > 0;
      if (!ok) logger.error('Invalid flag key found:', k, 'Expected non-empty string');
      return ok;
    });
  }

  /** @override */
  initialize() {
    const bootstrapFlags = this.snapshot_.bootstrapFlags || {};
    if (keys(bootstrapFlags).length) {
      const bootstrapPayloads = this.snapshot_.bootstrapPayloads || {};
      const featureFlags = {};
      keys(bootstrapFlags).forEach(function(k) {
        if (!isUndefined(bootstrapFlags[k])) featureFlags[k] = bootstrapFlags[k];
      });
      const featureFlagPayloads = {};
      keys(bootstrapPayloads).forEach(function(k) {
        if (featureFlags[k]) featureFlagPayloads[k] = bootstrapPayloads[k];
      });
      this.receivedFeatureFlags_({'featureFlags': featureFlags, 'featureFlagPayloads': featureFlagPayloads}, undefined,
          {'persist': false});
    }
  }

  /** @override */
  updateFlags(flags, payloads, options) {
    const merge = options && options['merge'];
    const existingFlags = merge ?
        filterFailedFlagValues(this.prop_(ENABLED_FEATURE_FLAGS), this.prop_(PERSISTENCE_FEATURE_FLAG_DETAILS)) : {};
    const existingPayloads = merge ?
        filterFailedFlagValues(this.prop_(PERSISTENCE_FEATURE_FLAG_PAYLOADS), this.prop_(PERSISTENCE_FEATURE_FLAG_DETAILS)) : {};
    const finalFlags = extend({}, existingFlags, flags);
    const finalPayloads = extend({}, existingPayloads, payloads);
    const details = {};
    keys(finalFlags).forEach(function(k) {
      const v = finalFlags[k];
      details[k] = {
        'key': k,
        'enabled': typeof v === 'string' ? true : v,
        'variant': typeof v === 'string' ? v : undefined,
        'reason': undefined,
        'metadata': !isUndefined(finalPayloads[k]) ?
            {'id': 0, 'version': undefined, 'description': undefined, 'payload': finalPayloads[k]} : undefined,
      };
    });
    this.receivedFeatureFlags_({'flags': details});
  }

  /** @override */
  hasLoadedFlags() {
    return this.hasLoadedFlags_;
  }

  /** @override */
  getFlags() {
    return keys(this.getFlagVariants());
  }

  /** @return {!Object} */
  getFlagsWithDetails() {
    const details = this.prop_(PERSISTENCE_FEATURE_FLAG_DETAILS);
    const overriddenFlags = this.prop_(PERSISTENCE_OVERRIDE_FEATURE_FLAGS);
    const overriddenPayloads = this.prop_(PERSISTENCE_OVERRIDE_FEATURE_FLAG_PAYLOADS);
    if (!overriddenPayloads && !overriddenFlags) return details || {};
    const final = extend({}, details || {});
    const overriddenKeys = [];
    keys(overriddenPayloads || {}).concat(keys(overriddenFlags || {})).forEach(function(k) {
      if (overriddenKeys.indexOf(k) === -1) overriddenKeys.push(k);
    });
    overriddenKeys.forEach(function(key) {
      const orig = final[key];
      const overrideValue = overriddenFlags ? overriddenFlags[key] : undefined;
      const finalEnabled = isUndefined(overrideValue) ? (orig && !isUndefined(orig['enabled']) ? orig['enabled'] : false) :
          !!overrideValue;
      const overrideVariant = isUndefined(overrideValue) ? (orig ? orig['variant'] : undefined) :
          typeof overrideValue === 'string' ? overrideValue : undefined;
      const overridePayload = overriddenPayloads ? overriddenPayloads[key] : undefined;
      const detail = extend({}, orig, {
        'enabled': finalEnabled,
        'variant': finalEnabled ? (isUndefined(overrideVariant) || overrideVariant === null ?
            (orig ? orig['variant'] : undefined) : overrideVariant) : undefined,
      });
      if (!finalEnabled) detail['variant'] = undefined;
      if (finalEnabled !== (orig ? orig['enabled'] : undefined)) detail['original_enabled'] = orig ? orig['enabled'] : undefined;
      if (overrideVariant !== (orig ? orig['variant'] : undefined)) detail['original_variant'] = orig ? orig['variant'] : undefined;
      if (overridePayload) {
        detail['metadata'] = extend({}, orig ? orig['metadata'] : undefined, {
          'payload': overridePayload,
          'original_payload': orig && orig['metadata'] ? orig['metadata']['payload'] : undefined,
        });
      }
      final[key] = detail;
    });
    if (!this.overrideWarning_) {
      logger.warn(' Overriding feature flag details!', {'flagDetails': details, 'overriddenPayloads': overriddenPayloads,
        'finalDetails': final});
      this.overrideWarning_ = true;
    }
    return final;
  }

  /** @override */
  getAllFeatureFlags() {
    const variants = this.getFlagVariants();
    const payloads = this.getFlagPayloads();
    return keys(variants).map(function(key) {
      const v = variants[key];
      return {
        'key': key,
        'enabled': typeof v === 'string' ? true : v,
        'variant': typeof v === 'string' ? v : undefined,
        'payload': parsePayload(payloads[key]),
      };
    });
  }

  /** @override */
  getFlagVariants() {
    const enabled = filterFailedFlagValues(this.prop_(ENABLED_FEATURE_FLAGS), this.prop_(PERSISTENCE_FEATURE_FLAG_DETAILS));
    const overridden = this.prop_(PERSISTENCE_OVERRIDE_FEATURE_FLAGS);
    if (!overridden) return /** @type {!Object<string, (string|boolean)>} */ (enabled || {});
    const final = extend({}, enabled || {});
    keys(overridden).forEach(function(k) {
      final[k] = overridden[k];
    });
    if (!this.overrideWarning_) {
      logger.warn(' Overriding feature flags!', {'enabledFlags': enabled, 'overriddenFlags': overridden, 'finalFlags': final});
      this.overrideWarning_ = true;
    }
    return /** @type {!Object<string, (string|boolean)>} */ (final);
  }

  /** @override */
  getFlagPayloads() {
    const payloads = filterFailedFlagValues(this.prop_(PERSISTENCE_FEATURE_FLAG_PAYLOADS),
        this.prop_(PERSISTENCE_FEATURE_FLAG_DETAILS));
    const overridden = this.prop_(PERSISTENCE_OVERRIDE_FEATURE_FLAG_PAYLOADS);
    if (!overridden) return payloads || {};
    const final = extend({}, payloads || {});
    keys(overridden).forEach(function(k) {
      final[k] = overridden[k];
    });
    if (!this.overrideWarning_) {
      logger.warn(' Overriding feature flag payloads!', {'flagPayloads': payloads, 'overriddenPayloads': overridden,
        'finalPayloads': final});
      this.overrideWarning_ = true;
    }
    return final;
  }

  // ---- loading ---------------------------------------------------------------

  /** @override */
  reloadFeatureFlags() {
    if (this.reloadingDisabled_ || this.snapshot_.featureFlagsDisabled) return;
    if (this.circuitBreakerTripped_()) return;
    if (this.firingCallbacks_) {
      logger.warn('reloadFeatureFlags() was called inside an onFeatureFlags callback. This callback also runs when ' +
          'flags change in other tabs, so this can cause a request loop.');
    }
    if (this.requestInFlight_) this.additionalReloadRequested_ = true;
    if (this.reloadDebouncer_) return;
    const self = this;
    this.reloadingHandlers_.slice().forEach(function(h) {
      try {
        h();
      } catch (e) {
        logger.error('Error while running feature flags reloading callback', e);
      }
    });
    this.reloadDebouncer_ = setTimeout(function() {
      self.callFlagsEndpoint_();
    }, 5);
  }

  /** @private */
  clearDebouncer_() {
    clearTimeout(this.reloadDebouncer_);
    this.reloadDebouncer_ = undefined;
  }

  /** @override */
  onReloading(handler) {
    this.reloadingHandlers_.push(handler);
    const self = this;
    return function() {
      self.reloadingHandlers_ = self.reloadingHandlers_.filter(function(h) {
        return h !== handler;
      });
    };
  }

  /** @override */
  ensureFlagsLoaded() {
    if (this.hasLoadedFlags_ || this.requestInFlight_ || this.reloadDebouncer_) return;
    this.reloadFeatureFlags();
  }

  /** @override */
  setAnonymousDistinctId(id) {
    this.anonDistinctId = id;
  }

  /** @param {boolean} isPaused */
  setReloadingPaused(isPaused) {
    this.reloadingDisabled_ = isPaused;
  }

  /** @override */
  resetFlagCallReported() {
    this.remove_(FLAG_CALL_REPORTED);
    this.flagCallsPendingCapture_ = {};
    this.pendingOrder_ = [];
  }

  /** @return {boolean} @private */
  canCapture_() {
    return this.ph_.is_capturing();
  }

  /** @return {boolean} @private */
  isRateLimited_() {
    return this.ph_.rateLimiter.isClientRateLimited();
  }

  /** @override */
  sendFlagCallsPendingCapture() {
    if (this.pendingOrder_.length === 0 || this.sendingPending_ || !this.canCapture_() || this.isRateLimited_()) return;
    this.sendingPending_ = true;
    try {
      const variants = this.getFlagVariants();
      const order = this.pendingOrder_.slice();
      for (let i = 0; i < order.length; i++) {
        const key = order[i];
        const pending = this.flagCallsPendingCapture_[key];
        if (!pending) continue;
        if (pending.value !== String(variants[key]) || !this.sameContext_(pending.context, this.flagCallContext_())) {
          this.deletePending_(key);
          continue;
        }
        this.getFeatureFlagResult(key);
        if (this.flagCallsPendingCapture_[key]) break;
      }
    } finally {
      this.sendingPending_ = false;
    }
  }

  /**
   * @param {string} key
   * @private
   */
  deletePending_(key) {
    delete this.flagCallsPendingCapture_[key];
    this.pendingOrder_ = this.pendingOrder_.filter(function(k) {
      return k !== key;
    });
  }

  /**
   * @param {!FlagCallContext} a
   * @param {!FlagCallContext} b
   * @return {boolean}
   * @private
   */
  sameContext_(a, b) {
    return a.distinctId === b.distinctId && a.sessionId === b.sessionId && haveSameGroups(a.groups, b.groups);
  }

  /** @private */
  callFlagsEndpoint_() {
    this.clearDebouncer_();
    if (!this.setUp_ || this.snapshot_.remoteRequestsDisabled || this.circuitBreakerTripped_()) return;
    if (this.requestInFlight_) {
      this.additionalReloadRequested_ = true;
      return;
    }
    const ph = this.ph_;
    const data = {
      'token': ph.config['token'],
      'distinct_id': ph.get_distinct_id(),
      'groups': ph.getGroups(),
      '$anon_distinct_id': this.anonDistinctId,
      'person_properties': extend({}, ph.persistence ? ph.persistence.get_initial_props() : {},
          this.prop_(STORED_PERSON_PROPERTIES_KEY) || {}, {'$lib': Config.LIB_NAME, '$lib_version': Config.LIB_VERSION}),
      'group_properties': this.prop_(STORED_GROUP_PROPERTIES_KEY),
      'timezone': getTimezone(),
    };
    const deviceId = ph.get_property(DEVICE_ID);
    if (typeof deviceId === 'string') data['$device_id'] = deviceId;
    if (this.snapshot_.featureFlagsDisabled) data['disable_flags'] = true;
    const contexts = this.validEvaluationContexts_();
    if (contexts.length) data['evaluation_contexts'] = contexts;
    const flagKeys = this.validFlagKeys_();
    if (!isUndefined(flagKeys)) data['flag_keys'] = flagKeys;

    const partial = this.snapshot_.onlyEvaluateSurveyFeatureFlags;
    const path = '/flags/?v=2' + (partial ? '&only_evaluate_survey_feature_flags=true' : '');
    const generation = this.requestGeneration_;
    this.requestInFlight_ = true;
    const self = this;

    const requestAdditionalReload = function() {
      if (self.additionalReloadRequested_) {
        self.additionalReloadRequested_ = false;
        self.callFlagsEndpoint_();
      }
    };
    /** @param {!PHResponse} response */
    const handleResponse = function(response) {
      const json = response.json || {};
      const errorsLoading = response.statusCode !== 200;
      self.requestInFlight_ = false;
      if (generation !== self.requestGeneration_) {
        requestAdditionalReload();
        return;
      }
      self.trackStatusZero_(response.statusCode);
      if (!errorsLoading && !self.additionalReloadRequested_) self.anonDistinctId = undefined;
      if (data['disable_flags'] && !self.additionalReloadRequested_) return;
      self.flagsLoadedFromRemote_ = !errorsLoading;
      const errors = [];
      if (response.error) {
        errors.push(response.error instanceof Error && response.error.name === 'AbortError' ? FeatureFlagError.TIMEOUT :
            response.error instanceof Error ? FeatureFlagError.CONNECTION_ERROR : FeatureFlagError.UNKNOWN_ERROR);
      } else if (response.statusCode !== 200) {
        errors.push('api_error_' + response.statusCode);
      }
      if (json['errorsWhileComputingFlags']) errors.push(FeatureFlagError.ERRORS_WHILE_COMPUTING);
      const quota = json['quotaLimited'];
      const isQuotaLimited = !!quota && quota.indexOf('feature_flags') !== -1;
      if (isQuotaLimited) errors.push(FeatureFlagError.QUOTA_LIMITED);
      self.set_({[PERSISTENCE_FEATURE_FLAG_ERRORS]: errors});
      if (isQuotaLimited) {
        logger.warn('You have hit your feature flags quota limit, and will not be able to load feature flags until ' +
            'the quota is reset.  Please visit https://posthog.com/docs/billing/limits-alerts to learn more.');
      } else if (!data['disable_flags']) {
        self.receivedFeatureFlags_(json, errorsLoading, {'partialResponse': partial});
      }
      requestAdditionalReload();
    };

    let attemptsLeft = isUndefined(this.snapshot_.requestMaxRetries) ? 1 : this.snapshot_.requestMaxRetries;
    const attempt = function() {
      if (generation !== self.requestGeneration_ || self.snapshot_.remoteRequestsDisabled) {
        self.requestInFlight_ = false;
        requestAdditionalReload();
        return;
      }
      const compression = self.snapshot_.compression;
      ph.sendRequest(/** @type {!RequestOptions} */ ({
        method: 'POST',
        url: ph.endpointFor('flags', path),
        data: data,
        timeout: self.snapshot_.requestTimeoutMs,
        fireCallbackOnDrop: true,
        compression: compression,
        compressionFallback: compression === 'best-available' ? 'base64' : undefined,
        timestampMode: 'body',
        callback: function(response) {
          microtask(function() {
            if ((RETRYABLE_FLAGS_HTTP_STATUSES.indexOf(response.statusCode) !== -1 || isFlagsTimeout(response)) &&
                attemptsLeft > 0 && generation === self.requestGeneration_) {
              attemptsLeft--;
              setTimeout(attempt, FLAGS_RETRY_DELAY_MS);
              return;
            }
            handleResponse(response);
          });
        },
      }));
    };
    try {
      attempt();
    } catch (error) {
      this.requestInFlight_ = false;
      this.set_({[PERSISTENCE_FEATURE_FLAG_ERRORS]: [FeatureFlagError.CONNECTION_ERROR]});
      logger.error('Feature flag request failed', error);
      if (this.fallBackToPersistedFlags_()) this.fireFeatureFlagsCallbacks_(true);
      requestAdditionalReload();
    }
  }

  /** @return {boolean} @private */
  circuitBreakerTripped_() {
    return this.consecutiveStatusZeroFailures_ >= MAX_CONSECUTIVE_FLAGS_STATUS_ZERO_FAILURES && this.isOnline_();
  }

  /** @return {boolean} @private */
  isOnline_() {
    try {
      return !!win && win.navigator.onLine !== false;
    } catch (e) {
      return false;
    }
  }

  /**
   * @param {number} statusCode
   * @private
   */
  trackStatusZero_(statusCode) {
    if (statusCode === 0) {
      if (this.isOnline_()) {
        this.consecutiveStatusZeroFailures_++;
        if (this.consecutiveStatusZeroFailures_ === MAX_CONSECUTIVE_FLAGS_STATUS_ZERO_FAILURES) {
          logger.warn('Feature flag requests are failing before receiving an HTTP response; this can happen due to ' +
              'network issues, CORS, browser blocking, or ad blockers. Stopped refreshing feature flags; will try ' +
              'again when connectivity changes.');
        }
      }
      return;
    }
    this.consecutiveStatusZeroFailures_ = 0;
  }

  // ---- reading ---------------------------------------------------------------

  /**
   * @param {string} key
   * @return {boolean}
   * @private
   */
  flagsNotLoaded_(key) {
    const d = this.getFeatureFlagDetails(key);
    return !this.hasLoadedFlags_ && !this.getFlags().length && !(d && d['failed']);
  }

  /** @override */
  getFeatureFlag(key, options) {
    const o = options || {};
    if (o['fresh'] && !this.flagsLoadedFromRemote_) return undefined;
    if (this.flagsNotLoaded_(key)) {
      logger.warn('getFeatureFlag for key "' + key + FLAG_TIMEOUT_MSG);
      return undefined;
    }
    if (this.checkAndTriggerStaleRefresh_()) return undefined;
    const result = this.getFeatureFlagResult(key, o);
    if (!result) return undefined;
    return isUndefined(result['variant']) || result['variant'] === null ? result['enabled'] : result['variant'];
  }

  /**
   * @param {string} key
   * @return {?Object|undefined}
   */
  getFeatureFlagDetails(key) {
    return this.getFlagsWithDetails()[key];
  }

  /** @override */
  getFeatureFlagPayload(key) {
    const result = this.getFeatureFlagResult(key, {'send_event': false});
    return result ? result['payload'] : undefined;
  }

  /** @override */
  getFeatureFlagResult(key, options) {
    const o = options || {};
    if (o['fresh'] && !this.flagsLoadedFromRemote_) return undefined;
    if (this.flagsNotLoaded_(key)) {
      logger.warn('getFeatureFlagResult for key "' + key + FLAG_TIMEOUT_MSG);
      return undefined;
    }
    if (this.checkAndTriggerStaleRefresh_()) return undefined;

    const storedDetails = this.prop_(PERSISTENCE_FEATURE_FLAG_DETAILS);
    const failed = storedDetails && storedDetails[key] ? storedDetails[key]['failed'] : undefined;
    const storedFlags = failed ? undefined : this.prop_(ENABLED_FEATURE_FLAGS);
    const storedPayloads = failed ? undefined : this.prop_(PERSISTENCE_FEATURE_FLAG_PAYLOADS);
    const overriddenFlags = this.prop_(PERSISTENCE_OVERRIDE_FEATURE_FLAGS);
    const hasOverride = !!overriddenFlags && Object.prototype.hasOwnProperty.call(overriddenFlags, key);
    const flagExists = hasOverride || (!!storedFlags && key in storedFlags);
    const flagValue = hasOverride ? overriddenFlags[key] : (storedFlags ? storedFlags[key] : undefined);
    const overriddenPayloads = this.prop_(PERSISTENCE_OVERRIDE_FEATURE_FLAG_PAYLOADS);
    const payload = overriddenPayloads && Object.prototype.hasOwnProperty.call(overriddenPayloads, key) ?
        overriddenPayloads[key] : (storedPayloads ? storedPayloads[key] : undefined);
    const reportValue = String(flagValue);
    const requestId = this.prop_(PERSISTENCE_FEATURE_FLAG_REQUEST_ID) || undefined;
    const evaluatedAt = this.prop_(PERSISTENCE_FEATURE_FLAG_EVALUATED_AT) || undefined;
    let reported = this.prop_(FLAG_CALL_REPORTED) || {};

    let sessionIdToPersist;
    if (this.snapshot_.deduplicateCallsPerSession) {
      const current = this.ph_.get_session_id();
      const storedSession = this.prop_(FLAG_CALL_REPORTED_SESSION_ID);
      if (current && current !== storedSession) {
        reported = {};
        sessionIdToPersist = current;
      }
    }

    if (o['send_event'] || !('send_event' in o)) {
      const captureOff = !this.canCapture_();
      const canCapture = !captureOff && !this.isRateLimited_();
      if (canCapture) {
        this.deletePending_(key);
      } else {
        if (captureOff && keys(reported).length > 0) {
          reported = {};
          this.set_({[FLAG_CALL_REPORTED]: reported});
        }
        if (!(reported[key] && reported[key].indexOf(reportValue) !== -1)) this.holdFlagCall_(key, reportValue);
      }
      if (canCapture && !(reported[key] && reported[key].indexOf(reportValue) !== -1)) {
        if (isArray(reported[key])) reported[key].push(reportValue);
        else reported[key] = [reportValue];
        const patch = {[FLAG_CALL_REPORTED]: reported};
        if (sessionIdToPersist) patch[FLAG_CALL_REPORTED_SESSION_ID] = sessionIdToPersist;
        this.set_(patch);

        const details = this.getFeatureFlagDetails(key);
        const errors = (this.prop_(PERSISTENCE_FEATURE_FLAG_ERRORS) || []).slice();
        if (isUndefined(flagValue)) {
          errors.push(details && details['failed'] ? FeatureFlagError.EVALUATION_FAILED : FeatureFlagError.FLAG_MISSING);
        }
        const bf = this.snapshot_.bootstrapFlags;
        const bp = this.snapshot_.bootstrapPayloads;
        const bfv = bf ? bf[key] : undefined;
        const bpv = bp ? bp[key] : undefined;
        const properties = {
          '$feature_flag': key,
          '$feature_flag_response': flagValue,
          '$feature_flag_payload': isUndefined(payload) || payload === null ? null : payload,
          '$feature_flag_request_id': requestId,
          '$feature_flag_evaluated_at': evaluatedAt,
          '$feature_flag_bootstrapped_response': isUndefined(bfv) || bfv === null ? null : bfv,
          '$feature_flag_bootstrapped_payload': isUndefined(bpv) || bpv === null ? null : bpv,
          '$used_bootstrap_value': !this.flagsLoadedFromRemote_,
        };
        const meta = details ? details['metadata'] : undefined;
        if (meta && !isUndefined(meta['has_experiment'])) properties['$feature_flag_has_experiment'] = meta['has_experiment'];
        if (meta && !isUndefined(meta['version'])) properties['$feature_flag_version'] = meta['version'];
        const reasonObj = details ? details['reason'] : undefined;
        const reason = reasonObj ? (isUndefined(reasonObj['description']) || reasonObj['description'] === null ?
            reasonObj['code'] : reasonObj['description']) : undefined;
        if (reason) properties['$feature_flag_reason'] = reason;
        if (meta && meta['id']) properties['$feature_flag_id'] = meta['id'];
        if (details && (!isUndefined(details['original_variant']) || !isUndefined(details['original_enabled']))) {
          properties['$feature_flag_original_response'] = !isUndefined(details['original_variant']) ?
              details['original_variant'] : details['original_enabled'];
        }
        if (meta && meta['original_payload']) properties['$feature_flag_original_payload'] = meta['original_payload'];
        if (errors.length) properties['$feature_flag_error'] = errors.join(',');

        if (!this.captureFeatureFlagCalled_(properties)) {
          this.unmarkFlagCallReported_(key, reportValue);
          this.holdFlagCall_(key, reportValue);
        }
      } else if (sessionIdToPersist) {
        this.set_({[FLAG_CALL_REPORTED]: reported, [FLAG_CALL_REPORTED_SESSION_ID]: sessionIdToPersist});
      }
    } else if (sessionIdToPersist) {
      this.set_({[FLAG_CALL_REPORTED]: reported, [FLAG_CALL_REPORTED_SESSION_ID]: sessionIdToPersist});
    }

    if (!flagExists) return undefined;
    return {
      'key': key,
      'enabled': !!flagValue,
      'variant': typeof flagValue === 'string' ? flagValue : undefined,
      'payload': parsePayload(payload),
    };
  }

  /**
   * @param {!Object} properties
   * @return {boolean} false when the client rate limit dropped the event
   * @private
   */
  captureFeatureFlagCalled_(properties) {
    try {
      const result = this.ph_.capture('$feature_flag_called', properties);
      return !isUndefined(result) || !this.ph_.rateLimiter.lastEventRateLimited;
    } catch (e) {
      logger.error('Failed to capture feature flag call', e);
      return true;
    }
  }

  /**
   * @param {string} key
   * @param {string} value
   * @private
   */
  holdFlagCall_(key, value) {
    if (!this.flagCallsPendingCapture_[key]) this.pendingOrder_.push(key);
    this.flagCallsPendingCapture_[key] = {value: value, context: this.flagCallContext_()};
  }

  /** @return {!FlagCallContext} @private */
  flagCallContext_() {
    return {
      distinctId: this.ph_.get_distinct_id(),
      groups: assign(this.ph_.getGroups()),
      sessionId: this.snapshot_.deduplicateCallsPerSession ? this.ph_.get_session_id() : undefined,
    };
  }

  /**
   * @param {string} key
   * @param {string} value
   * @private
   */
  unmarkFlagCallReported_(key, value) {
    const reported = this.prop_(FLAG_CALL_REPORTED) || {};
    const values = reported[key];
    if (!isArray(values) || values.indexOf(value) === -1) return;
    reported[key] = values.filter(function(v) {
      return v !== value;
    });
    this.set_({[FLAG_CALL_REPORTED]: reported});
  }

  /** @override */
  isFeatureEnabled(key, options) {
    const o = options || {};
    if (o['fresh'] && !this.flagsLoadedFromRemote_) return o['defaultValue'];
    if (this.flagsNotLoaded_(key)) {
      logger.warn('isFeatureEnabled for key "' + key + FLAG_TIMEOUT_MSG);
      return o['defaultValue'];
    }
    const v = this.getFeatureFlag(key, o);
    return isUndefined(v) ? o['defaultValue'] : !!v;
  }

  /**
   * @param {?} response
   * @param {boolean=} errorsLoading
   * @param {?Object=} options {'partialResponse', 'persist'}
   * @private
   */
  receivedFeatureFlags_(response, errorsLoading, options) {
    if (!this.setUp_) return;
    this.hasLoadedFlags_ = true;
    const currentFlags = this.getFlagVariants();
    const legacy = !response['flags'] && isArray(response['featureFlags']);
    const currentPayloads = legacy ? this.prop_(PERSISTENCE_FEATURE_FLAG_PAYLOADS) || {} : this.getFlagPayloads();
    const currentDetails = legacy ? this.prop_(PERSISTENCE_FEATURE_FLAG_DETAILS) || {} : this.getFlagsWithDetails();
    const patch = parseFlagsResponse(response, currentFlags, currentPayloads, currentDetails, options);
    if (patch) {
      if (options && options['persist'] === false) {
        const hasPersisted = !isUndefined(this.ph_.get_property(ENABLED_FEATURE_FLAGS));
        this.bootstrapState_ = patch;
        if (!hasPersisted) this.set_(patch);
      } else {
        this.clearBootstrapState_();
        this.set_(patch);
      }
    } else if (errorsLoading) {
      this.fallBackToPersistedFlags_();
    }
    if (!errorsLoading) this.staleCacheRefreshTriggered_ = false;
    this.fireFeatureFlagsCallbacks_(errorsLoading);
  }

  /** @override */
  overrideFeatureFlags(overrideOptions) {
    if (!this.setUp_) {
      logger.warn('posthog.featureFlags.overrideFeatureFlags called before feature flags were ready');
      return;
    }
    if (overrideOptions === false) {
      this.remove_([PERSISTENCE_OVERRIDE_FEATURE_FLAGS, PERSISTENCE_OVERRIDE_FEATURE_FLAG_PAYLOADS]);
      this.fireFeatureFlagsCallbacks_();
      return;
    }
    if (isArray(overrideOptions)) {
      this.set_({[PERSISTENCE_OVERRIDE_FEATURE_FLAGS]: arrayToFlagsRecord(/** @type {!Array<string>} */ (overrideOptions))});
      this.fireFeatureFlagsCallbacks_();
      return;
    }
    if (overrideOptions && typeof overrideOptions === 'object' &&
        ('flags' in overrideOptions || 'payloads' in overrideOptions)) {
      this.overrideWarning_ = Boolean(isUndefined(overrideOptions['suppressWarning']) ? false : overrideOptions['suppressWarning']);
      const patch = {};
      const flags = overrideOptions['flags'];
      const payloads = overrideOptions['payloads'];
      if (flags) patch[PERSISTENCE_OVERRIDE_FEATURE_FLAGS] = isArray(flags) ? arrayToFlagsRecord(flags) : flags;
      if (payloads) patch[PERSISTENCE_OVERRIDE_FEATURE_FLAG_PAYLOADS] = payloads;
      if (keys(patch).length) this.set_(patch);
      if (flags === false && payloads === false) {
        this.remove_([PERSISTENCE_OVERRIDE_FEATURE_FLAGS, PERSISTENCE_OVERRIDE_FEATURE_FLAG_PAYLOADS]);
      } else if (flags === false) {
        this.remove_(PERSISTENCE_OVERRIDE_FEATURE_FLAGS);
      } else if (payloads === false) {
        this.remove_(PERSISTENCE_OVERRIDE_FEATURE_FLAG_PAYLOADS);
      }
      this.fireFeatureFlagsCallbacks_();
      return;
    }
    if (overrideOptions && typeof overrideOptions === 'object') {
      this.set_({[PERSISTENCE_OVERRIDE_FEATURE_FLAGS]: overrideOptions});
      this.fireFeatureFlagsCallbacks_();
      return;
    }
    logger.warn('Invalid overrideOptions provided to overrideFeatureFlags', {'overrideOptions': overrideOptions});
  }

  /** @override */
  onFeatureFlags(callback) {
    this.handlers_.push(callback);
    if (this.hasLoadedFlags_) {
      const prepared = this.prepareForCallbacks_();
      try {
        callback(prepared.flags, prepared.flagVariants);
      } catch (e) {
        logger.error('Error while running feature flags callback', e);
      }
    }
    const self = this;
    return function() {
      self.handlers_ = self.handlers_.filter(function(h) {
        return h !== callback;
      });
    };
  }

  /** @override */
  updateEarlyAccessFeatureEnrollment(key, isEnrolled, stage) {
    const existing = this.prop_(PERSISTENCE_EARLY_ACCESS_FEATURES) || [];
    let feature;
    for (let i = 0; i < existing.length; i++) {
      if (existing[i]['flagKey'] === key) feature = existing[i];
    }
    const enrollmentProp = {['$feature_enrollment/' + key]: isEnrolled};
    const properties = {'$feature_flag': key, '$feature_enrollment': isEnrolled, '$set': enrollmentProp};
    if (feature) properties['$early_access_feature_name'] = feature['name'];
    if (stage) properties['$feature_enrollment_stage'] = stage;
    const newFlags = extend({}, this.getFlagVariants(), {[key]: isEnrolled});
    const details = extend({}, this.prop_(PERSISTENCE_FEATURE_FLAG_DETAILS));
    const replacesFailure = details[key] && details[key]['failed'];
    const payloads = extend({}, this.prop_(PERSISTENCE_FEATURE_FLAG_PAYLOADS));
    if (replacesFailure) {
      delete details[key];
      delete payloads[key];
    }
    const patch = {
      [PERSISTENCE_ACTIVE_FEATURE_FLAGS]: keys(filterActiveFeatureFlags(newFlags)),
      [ENABLED_FEATURE_FLAGS]: newFlags,
      [STORED_PERSON_PROPERTIES_KEY]: extend({}, this.prop_(STORED_PERSON_PROPERTIES_KEY) || {}, enrollmentProp),
    };
    if (replacesFailure) {
      patch[PERSISTENCE_FEATURE_FLAG_DETAILS] = details;
      patch[PERSISTENCE_FEATURE_FLAG_PAYLOADS] = payloads;
    }
    this.set_(patch);
    this.fireFeatureFlagsCallbacks_();
    try {
      this.ph_.capture('$feature_enrollment_update', properties);
    } catch (e) {
      logger.error('Failed to capture early access feature enrollment', e);
    }
  }

  /** @override */
  getEarlyAccessFeatures(callback, forceReload, stages) {
    const existing = this.prop_(PERSISTENCE_EARLY_ACCESS_FEATURES);
    if (existing && !forceReload) {
      callback(existing);
      return;
    }
    const ph = this.ph_;
    const stageParams = stages ? '&' + stages.map(function(s) {
      return 'stage=' + s;
    }).join('&') : '';
    const self = this;
    ph.sendRequest(/** @type {!RequestOptions} */ ({
      method: 'GET',
      url: ph.endpointFor('api', '/api/early_access_features/?token=' + ph.config['token'] + stageParams),
      fireCallbackOnDrop: true,
      timestampMode: 'query',
      callback: function(response) {
        microtask(function() {
          if (!response.json) return;
          const features = response.json['earlyAccessFeatures'];
          self.set_({[PERSISTENCE_EARLY_ACCESS_FEATURES]: features});
          try {
            callback(features);
          } catch (e) {
            logger.error('Early access feature callback failed', e);
          }
        });
      },
    }));
  }

  /**
   * @return {{flags: !Array<string>, flagVariants: !Object<string, (string|boolean)>}}
   * @private
   */
  prepareForCallbacks_() {
    const flags = this.getFlags();
    const variants = this.getFlagVariants();
    const truthyVariants = {};
    keys(variants).forEach(function(k) {
      if (variants[k]) truthyVariants[k] = variants[k];
    });
    return {
      flags: flags.filter(function(f) {
        return !!variants[f];
      }),
      flagVariants: truthyVariants,
    };
  }

  /**
   * @param {boolean=} errorsLoading
   * @private
   */
  fireFeatureFlagsCallbacks_(errorsLoading) {
    this.rebuildEventProperties_();
    const prepared = this.prepareForCallbacks_();
    const was = this.firingCallbacks_;
    this.firingCallbacks_ = true;
    this.handlers_.forEach(function(h) {
      try {
        h(prepared.flags, prepared.flagVariants, {'errorsLoading': errorsLoading});
      } catch (e) {
        logger.error('Error while running feature flags callback', e);
      }
    });
    this.firingCallbacks_ = was;
  }

  /** @override */
  setPersonPropertiesForFlags(properties, reload) {
    const existing = this.prop_(STORED_PERSON_PROPERTIES_KEY) || {};
    const toSet = properties['$set'] || (!properties['$set_once'] ? properties : {});
    const toSetOnce = properties['$set_once'];
    const setOnce = {};
    if (toSetOnce) {
      for (const k in toSetOnce) {
        if (Object.prototype.hasOwnProperty.call(toSetOnce, k) && !(k in existing)) setOnce[k] = toSetOnce[k];
      }
    }
    this.set_({[STORED_PERSON_PROPERTIES_KEY]: extend({}, existing, setOnce, toSet)});
    if (reload !== false) this.reloadFeatureFlags();
  }

  /** @override */
  unsetPersonPropertiesForFlags(names, reload) {
    const next = extend({}, this.prop_(STORED_PERSON_PROPERTIES_KEY) || {});
    names.forEach(function(n) {
      delete next[n];
    });
    this.set_({[STORED_PERSON_PROPERTIES_KEY]: next});
    if (reload !== false) this.reloadFeatureFlags();
  }

  /** @override */
  resetPersonPropertiesForFlags(reload) {
    this.remove_(STORED_PERSON_PROPERTIES_KEY);
    if (reload !== false) this.reloadFeatureFlags();
  }

  /** @override */
  setGroupPropertiesForFlags(properties, reload) {
    const existing = this.prop_(STORED_GROUP_PROPERTIES_KEY) || {};
    const next = extend({}, existing);
    keys(properties).forEach(function(t) {
      next[t] = extend({}, existing[t], properties[t]);
    });
    this.set_({[STORED_GROUP_PROPERTIES_KEY]: next});
    if (reload !== false) this.reloadFeatureFlags();
  }

  /** @override */
  resetGroupPropertiesForFlags(groupType) {
    if (groupType) {
      const existing = this.prop_(STORED_GROUP_PROPERTIES_KEY) || {};
      this.set_({[STORED_GROUP_PROPERTIES_KEY]: extend({}, existing, {[groupType]: {}})});
    } else {
      this.remove_(STORED_GROUP_PROPERTIES_KEY);
    }
  }

  /** @override */
  reset() {
    this.requestGeneration_++;
    this.additionalReloadRequested_ = false;
    this.baseEventProperties_ = {};
    this.eventPropertiesWithFlagValues_ = {};
    this.bootstrapState_ = undefined;
    this.hasLoadedFlags_ = false;
    this.reloadingDisabled_ = false;
    this.flagsLoadedFromRemote_ = false;
    this.anonDistinctId = undefined;
    this.clearDebouncer_();
    this.overrideWarning_ = false;
    this.consecutiveStatusZeroFailures_ = 0;
    this.flagCallsPendingCapture_ = {};
    this.pendingOrder_ = [];
  }
}
