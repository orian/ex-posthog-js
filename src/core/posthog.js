/**
 * @fileoverview PostHog core: a port of upstream posthog-core.ts (init,
 * capture, identity, super properties, consent, sessions, pageviews, remote
 * config). Optional modules (feature flags, web experiments) attach through
 * extensions.js and are reached via `this.extensions[name]`; the core never
 * imports them.
 */
import {Persistence} from './persistence.js';
import {SessionManager} from './session.js';
import {SessionPropsManager} from './session-props.js';
import {ScrollManager} from './scroll-manager.js';
import {PageViewManager} from './page-view.js';
import {RateLimiter, RateLimiterHost} from './rate-limiter.js';
import {RequestRouter, RequestRouterRegion} from './request-router.js';
import {ConsentManager, ConsentStatus} from './consent.js';
import {RemoteConfigLoader, RemoteConfigHost, shouldLoadFlagsAfterRemoteConfig} from './remote-config.js';
import {HistoryAutocapture} from './history-autocapture.js';
import {DEFAULT_CONTENT_IGNORELIST_WITH_STEPPERS} from './rageclick.js';
import {DEFAULT_FLUSH_INTERVAL_MS, RequestQueue, RetryQueue} from './request-queue.js';
import {COMPRESSION_BASE64, COMPRESSION_GZIP_JS, RequestOptions, SUPPORTS_REQUEST, TransportCallback, request} from './request.js';
import {getEventProperties} from './event-utils.js';
import {isLikelyBot} from './user-agent.js';
import {uuidv7} from './uuid.js';
import {logger} from './logger.js';
import {localStore, sessionStore} from './storage.js';
import {
  ExceptionsApi, Extension, FeatureFlagsApi, SessionRecordingApi, UPSTREAM_CREATE_ORDER, UPSTREAM_INIT_ORDER,
  UPSTREAM_REMOTE_CONFIG_ORDER, attachAllExtensions, findExtensionFactory, inUpstreamOrder,
} from './extensions.js';
import {LogsApi, MetricsApi, ToolbarApi} from './extensions.js';
import {
  addEventListener, assign, copyAndTruncateStrings, doc, each, extend, getCookieValue, getPersonPropertiesHash,
  hasOwn, isArray, isBoolean, isEmptyObject, isEmptyString, isFunction, isNullish, isNumber, isObject, isString,
  isUndefined, isValidUUID, keys, loc, nav, userAgent, win,
} from './utils.js';
import {
  ALIAS_ID_KEY, COOKIELESS_SENTINEL_VALUE, CONFIG_DEFAULTS_DATES, Config, DEVICE_ID, DEVICE_MODEL, DISTINCT_ID,
  ENABLE_PERSON_PROCESSING, EVENT_GROUPIDENTIFY, EVENT_IDENTIFY, EVENT_PAGELEAVE, EVENT_PAGEVIEW, FACEBOOK_BROWSER_ID,
  FACEBOOK_CLICK_ID, FLAG_CALL_REPORTED, KNOWN_UNSAFE_EDITABLE_EVENTS, LIB_VERSION, MINIMAL_FLAG_CALLED_EVENT_PROPERTIES,
  PEOPLE_DISTINCT_ID_KEY, PERSISTENCE_FACEBOOK_BROWSER_ID, PERSISTENCE_FACEBOOK_CLICK_ID,
  PERSISTENCE_MINIMAL_FLAG_CALLED_EVENTS, PERSON_PROFILES_IDENTIFIED_ONLY, SDK_DEBUG_EXTENSIONS_INIT_METHOD,
  SDK_DEBUG_EXTENSIONS_INIT_TIME_MS, SESSION_RECORDING_REMOTE_CONFIG, USER_STATE, USER_STATE_ANONYMOUS,
  USER_STATE_IDENTIFIED,
} from './constants.js';

/** @const {!Object<string, !PostHog>} */
const instances = {};

let executeArrayDepth = 0;

const NOOP = function() {};
const PRIMARY_INSTANCE_NAME = 'posthog';
const CONSENT_COOKIELESS_WARN = 'Consent opt in/out is not valid with cookieless_mode="always" and will be ignored';
const RESET_CONSENT_WARN =
    'reset() cleared the stored consent, and capturing is now off because of `opt_out_capturing_by_default`. ' +
    'Call opt_in_capturing() again, and prefer calling reset() before opting in rather than after.';
const SANITIZE_DEPRECATED = 'sanitize_properties is deprecated. Use before_send instead';
const DENYLIST_INVALID = 'Invalid value for property_denylist config: ';
const FLAG_CALLED_TRANSPORT_PROPERTY_KEYS = ['token', 'distinct_id', '$cookieless_mode'];
const FBCLID_PATTERN = /^[A-Za-z0-9_-]{1,400}$/;
const FBC_PATTERN = /^fb\.[0-9]+\.[0-9]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/;
const FBP_PATTERN = /^fb\.[0-9]+\.[0-9]+\.[0-9]+$/;
const LATEST_DEFAULTS_DATE = CONFIG_DEFAULTS_DATES.slice().sort()[CONFIG_DEFAULTS_DATES.length - 1];

// Session replay (upstream posthog-core.ts): recording buttons and capture
// diagnostics read these from individual events; the other replay debug
// properties are sent at most once per 30s, on `$` events.
const REQUIRED_REPLAY_PROPERTIES = [
  '$recording_status', '$sdk_debug_recording_script_not_loaded', '$sdk_debug_replay_url_trigger_status',
  '$sdk_debug_replay_event_trigger_status', '$sdk_debug_replay_linked_flag_trigger_status',
  '$sdk_debug_replay_rrweb_error', '$sdk_debug_replay_internal_buffer_length', '$sdk_debug_replay_flushed_size',
];
const EVENTS_WITHOUT_REPLAY_DEBUG_PROPERTIES = ['$feature_flag_called', '$$heatmap', '$snapshot'];
const REPLAY_DEBUG_PROPERTIES_INTERVAL_MS = 30000;
/**
 * @param {string} eventName
 * @return {boolean}
 */
function isReplayDebugEvent(eventName) {
  return eventName.charAt(0) === '$' && EVENTS_WITHOUT_REPLAY_DEBUG_PROPERTIES.indexOf(eventName) === -1;
}

/** Requests are queued until the DOM is loaded when no transport exists (upstream ENQUEUE_REQUESTS). */
let enqueueRequests = !SUPPORTS_REQUEST && userAgent.indexOf('MSIE') === -1 && userAgent.indexOf('Mozilla') === -1;

/**
 * @param {string|undefined} defaults
 * @return {!Object}
 */
function getSessionRecordingDefaults(defaults) {
  const sr = {};
  if (!defaults || defaults === 'unset') return sr;
  if (defaults >= '2025-11-30') sr['strictMinimumDuration'] = true;
  if (defaults >= '2026-05-30') sr['canvasCapture'] = {'resolutionScale': 0.6};
  if (defaults >= '2026-06-25') sr['streamNetworkBody'] = true;
  if (defaults >= '2026-08-30') sr['captureJsonLd'] = true;
  return sr;
}

/**
 * Upstream defaultsThatVaryByConfig: config defaults gated by `defaults`.
 * @param {string|undefined} defaults
 * @return {!Object}
 */
export function defaultsThatVaryByConfig(defaults) {
  const d = defaults || '';
  return {
    'rageclick': d && d >= '2026-05-30' ?
        {'content_ignorelist': DEFAULT_CONTENT_IGNORELIST_WITH_STEPPERS, 'ignore_text_selection': true} :
        d && d >= '2025-11-30' ? {'content_ignorelist': true} : true,
    'capture_pageview': d && d >= '2025-05-24' ? 'history_change' : true,
    'session_recording': getSessionRecordingDefaults(defaults),
    'external_scripts_inject_target': d && d >= '2026-01-30' ? 'head' : 'body',
    'internal_or_test_user_hostname': d && d >= '2026-01-30' ? /^(localhost|127\.0\.0\.1)$/ : undefined,
    'persistence_save_debounce_ms': d && d >= '2026-05-30' ? 250 : 0,
    'split_storage': !!(d && d >= '2026-05-30'),
    'detect_google_search_app': !!(d && d >= '2026-05-30'),
    'disable_capture_url_hashes': !!(d && d >= '2026-06-25'),
    'cookieWinsOnConflict': !!(d && d !== 'unset' && d >= '2026-08-29'),
  };
}

/**
 * @param {?Location|undefined} location
 * @return {boolean}
 */
function isCrossDomainCookie(location) {
  const hostname = location ? location.hostname : undefined;
  if (!isString(hostname)) return false;
  const lastTwo = hostname.split('.').slice(-2).join('.');
  return ['herokuapp.com', 'vercel.app', 'netlify.app'].indexOf(lastTwo) === -1;
}

/**
 * Default config (upstream defaultConfig). Keys are quoted: public API.
 * @param {string=} defaults
 * @return {!Object}
 */
export function defaultConfig(defaults) {
  return /** @type {!Object} */ (extend({
    'api_host': 'https://us.i.posthog.com',
    'flags_api_host': null,
    'ui_host': null,
    'asset_host': null,
    'token': '',
    'autocapture': true,
    'cross_subdomain_cookie': isCrossDomainCookie(doc ? doc.location : undefined),
    'persistence': 'localStorage+cookie',
    'persistence_name': '',
    'cookie_persisted_properties': [],
    'loaded': NOOP,
    'save_campaign_params': true,
    'custom_campaign_params': [],
    'custom_blocked_useragents': [],
    'save_referrer': true,
    'capture_pageleave': 'if_capture_pageview',
    'defaults': isNullish(defaults) ? 'unset' : defaults,
    '__preview_deferred_init_extensions': false,
    '__preview_replay_sync_fetch': true,
    '__preview_external_dependency_versioned_paths': false,
    '__preview_cookie_wins_on_conflict': false,
    'debug': (loc && isString(loc.search) && loc.search.indexOf('__posthog_debug=true') !== -1) || false,
    'cookie_expiration': 365,
    'upgrade': false,
    'disable_session_recording': false,
    'disable_persistence': false,
    'disable_web_experiments': true,
    'disable_surveys': false,
    'disable_surveys_automatic_display': false,
    'disable_conversations': false,
    'disable_product_tours': false,
    'disableDeviceModel': false,
    'reuseAnonymousId': false,
    'disable_external_dependency_loading': false,
    'strict_script_versioning': 'fallback',
    'enable_recording_console_log': undefined,
    'secure_cookie': !!win && !!win.location && win.location.protocol === 'https:',
    'ip': false,
    'opt_out_capturing_by_default': false,
    'opt_out_persistence_by_default': false,
    'opt_out_useragent_filter': false,
    'opt_out_capturing_persistence_type': 'localStorage',
    'consent_persistence_name': null,
    'opt_out_capturing_cookie_prefix': null,
    'opt_in_site_apps': false,
    'property_denylist': [],
    'respect_dnt': false,
    'sanitize_properties': null,
    'request_headers': {},
    'request_batching': true,
    'properties_string_max_length': 65535,
    'mask_all_element_attributes': false,
    'mask_all_text': false,
    'mask_personal_data_properties': false,
    'custom_personal_data_properties': [],
    'advanced_disable_flags': false,
    'advanced_disable_decide': false,
    'advanced_disable_feature_flags': false,
    'advanced_disable_feature_flags_on_first_load': false,
    'advanced_only_evaluate_survey_feature_flags': false,
    'advanced_feature_flags_dedup_per_session': false,
    'advanced_enable_surveys': false,
    'advanced_disable_toolbar_metrics': false,
    'feature_flag_request_timeout_ms': 3000,
    'feature_flag_request_max_retries': 1,
    'surveys_request_timeout_ms': 10000,
    'on_request_error': function(res) {
      logger.error('Bad HTTP status: ' + res.statusCode + ' ' + res.text);
    },
    'get_device_id': function(uuid) {
      return uuid;
    },
    'capture_performance': undefined,
    'name': 'posthog',
    'bootstrap': {},
    'disable_compression': false,
    'session_idle_timeout_seconds': 30 * 60,
    'person_profiles': PERSON_PROFILES_IDENTIFIED_ONLY,
    'before_send': undefined,
    'get_current_url': undefined,
    'request_queue_config': {'flush_interval_ms': DEFAULT_FLUSH_INTERVAL_MS},
    'error_tracking': {},
    '_onCapture': NOOP,
  }, defaultsThatVaryByConfig(defaults)));
}

/** @const {!Array<!Array<string>>} */
const CONFIG_RENAMES = [
  ['process_person', 'person_profiles'],
  ['xhr_headers', 'request_headers'],
  ['cookie_name', 'persistence_name'],
  ['disable_cookie', 'disable_persistence'],
  ['__preview_disable_beacon', 'disable_beacon'],
  ['store_google', 'save_campaign_params'],
  ['verbose', 'debug'],
  ['__preview_cookie_wins_on_conflict', 'cookieWinsOnConflict'],
];

/**
 * Upstream configRenames: maps legacy config names to current ones.
 * @param {!Object} orig
 * @return {!Object}
 */
export function configRenames(orig) {
  const renames = {};
  CONFIG_RENAMES.forEach(function(pair) {
    if (!isUndefined(orig[pair[0]])) renames[pair[1]] = orig[pair[0]];
  });
  const out = /** @type {!Object} */ (extend({}, renames, orig));
  const previewPaths = orig['__preview_external_dependency_versioned_paths'];
  if (!isUndefined(previewPaths)) {
    if (isUndefined(orig['strict_script_versioning'])) out['strict_script_versioning'] = !!previewPaths;
    if (isString(previewPaths) && isUndefined(orig['asset_host'])) out['asset_host'] = previewPaths;
  }
  if (isArray(orig['property_blacklist'])) {
    if (isUndefined(orig['property_denylist'])) {
      out['property_denylist'] = orig['property_blacklist'];
    } else if (isArray(orig['property_denylist'])) {
      out['property_denylist'] = orig['property_blacklist'].concat(orig['property_denylist']);
    } else {
      logger.error(DENYLIST_INVALID + orig['property_denylist']);
    }
  }
  return out;
}

/**
 * Simple event emitter (upstream SimpleEventEmitter).
 */
class Emitter {
  constructor() {
    /** @private {!Object<string, !Array<function(...?)>>} */
    this.events_ = {};
  }
  /**
   * @param {string} event
   * @param {function(...?)} listener
   * @return {function()}
   */
  on(event, listener) {
    if (!this.events_[event]) this.events_[event] = [];
    this.events_[event].push(listener);
    const self = this;
    return function() {
      self.events_[event] = self.events_[event].filter(function(x) {
        return x !== listener;
      });
    };
  }
  /**
   * @param {string} event
   * @param {*} payload
   */
  emit(event, payload) {
    (this.events_[event] || []).forEach(function(l) {
      l(payload);
    });
    (this.events_['*'] || []).forEach(function(l) {
      l(event, payload);
    });
  }
}

/** @unrestricted Named instances and snippet replay use dynamic keys. */
export class PostHog {
  constructor() {
    /** @type {!Object} Public config, quoted keys. */
    this.config = defaultConfig();
    /** @type {boolean} */
    this.loaded = false;
    /** @type {?Object|undefined} */
    this.originalUserConfig_ = undefined;
    /** @private {boolean} */
    this.botFilterWarned_ = false;
    /** @type {?Persistence} */
    this.persistence = null;
    /** @type {?Persistence} */
    this.sessionPersistence = null;
    /** @type {?SessionManager} */
    this.sessionManager = null;
    /** @type {?SessionPropsManager} */
    this.sessionPropsManager = null;
    /** @type {?RequestQueue} */
    this.requestQueue = null;
    /** @type {?RetryQueue} */
    this.retryQueue = null;
    /** @type {boolean} */
    this.isPageUnloading = false;
    /** @private {boolean} */
    this.isShutdown_ = false;
    /** @private {boolean} */
    this.initialPageviewCaptured_ = false;
    /** @private {?function()} */
    this.visibilityStateListener_ = null;
    /** @private {boolean} */
    this.personProcessingSetOncePropertiesSent_ = false;
    /** @type {string|undefined} 'gzip-js' | 'base64' | undefined */
    this.compression = undefined;
    /** @type {!Array<!RequestOptions>} */
    this.requestQueueBeforeDomLoaded = [];
    /** @private {{config: ?Object}|undefined} last remote config (config null = failed) */
    this.lastRemoteConfig_ = undefined;
    /** @type {string} capture endpoint path; remote config `analytics.endpoint` overrides it */
    this.analyticsDefaultEndpoint = '/e/';
    /** @private {?string} */
    this.initialPersonProfilesConfig_ = null;
    /** @private {!Array<string>} keys registered via register_for_session */
    this.sessionRegisteredPropKeys_ = [];
    /** @private {string} */
    this.sessionRegisteredPropertiesStorageKey_ = '';
    /** @private {?string} */
    this.cachedPersonProperties_ = null;
    /** @private @const {!Emitter} */
    this.emitter_ = new Emitter();
    /** @private {boolean} */
    this.hasStableInitialDistinctId_ = false;
    /** @private {boolean} */
    this.hasWarnedAboutVolatileIdentity_ = false;
    /** @private {boolean} */
    this.isConsentTransition_ = false;
    /** @private {function()|undefined} */
    this.featureFlagsReloadingUnsubscribe_ = undefined;
    /** Attached optional modules, keyed by registration name. @type {!Object<string, !Extension>} */
    this.extensions = {};
    /** @private {!Array<string>} attach order */
    this.extensionOrder_ = [];
    /** @private {boolean} true once init reached the point where extensions are initialised */
    this.extensionsReady_ = false;
    /** @type {?HistoryAutocapture} */
    this.historyAutocapture = null;
    /** @type {?RemoteConfigLoader} */
    this.remoteConfigLoader = null;
    /** @private {boolean} session replay debug properties throttle */
    this.replayDebugPropertiesPaused_ = false;

    const self = this;
    const getConfig = function() {
      return self.config;
    };
    /** @type {!ScrollManager} */
    this.scrollManager = new ScrollManager(getConfig);
    this['scrollManager'] = this.scrollManager; // public: posthog.scrollManager.scrollY() etc.
    /** @type {!PageViewManager} */
    this.pageViewManager = new PageViewManager(getConfig, this.scrollManager, null);
    /** @type {!RateLimiter} */
    this.rateLimiter = new RateLimiter(/** @type {!RateLimiterHost} */ ({
      getConfig: getConfig,
      getProp: function(k) {
        return self.persistence ? self.persistence.get_property(k) : undefined;
      },
      setProp: function(k, v) {
        if (self.persistence) self.persistence.set_property(k, v);
      },
      sessionId: function() {
        return self.get_session_id();
      },
      capture: function(e, p, o) {
        return self.capture(e, p, o);
      },
    }));
    /** @type {!RequestRouter} */
    this.requestRouter = new RequestRouter(getConfig);
    /** @type {!ConsentManager} */
    this.consent = new ConsentManager(getConfig);

    /** Deprecated `posthog.people` (upstream keeps it for existing usage). */
    this.people = {
      'set': function(prop, to, callback) {
        const props = isString(prop) ? {[prop]: to} : prop;
        self.setPersonProperties(props);
        if (callback) callback({});
      },
      'set_once': function(prop, to, callback) {
        const props = isString(prop) ? {[prop]: to} : prop;
        self.setPersonProperties(undefined, props);
        if (callback) callback({});
      },
    };

    this.on('eventCaptured', function(data) {
      logger.info('send "' + (data ? data['event'] : undefined) + '"', data);
    });
  }

  // ---------------------------------------------------------------------------
  // Init

  /** @return {boolean} @private */
  inCookielessMode_() {
    return this.config['cookieless_mode'] === 'always' ||
        (this.config['cookieless_mode'] === 'on_reject' && this.consent.isRejected());
  }

  /** @private */
  warnIfVolatileIdentityWithoutStableId_() {
    if (this.hasWarnedAboutVolatileIdentity_ || this.config['reuseAnonymousId'] || this.config['segment'] ||
        this.inCookielessMode_()) {
      return;
    }
    const p = this.config['persistence'];
    const volatile = p === 'memory' || p === 'sessionStorage';
    if (!volatile && !this.config['disable_persistence']) return;
    if (this.hasStableInitialDistinctId_) return;
    let cause;
    let lifetime;
    let fix;
    if (volatile) {
      cause = "persistence is set to '" + p + "'";
      lifetime = p === 'memory' ? 'on every page load' : 'for every new browser tab or window';
      fix = "Either set persistence to 'localStorage+cookie', keep this persistence and pass a stable ID through " +
          'bootstrap.distinctID, or enable reuseAnonymousId.';
    } else {
      cause = 'persistence is disabled (disable_persistence is true)';
      lifetime = 'on every page load';
      fix = 'Either set disable_persistence to false, keep persistence disabled and pass a stable ID through ' +
          'bootstrap.distinctID, or enable reuseAnonymousId.';
    }
    this.hasWarnedAboutVolatileIdentity_ = true;
    if (win && win.console) {
      win.console.warn('[PostHog.js]', cause + ' but no bootstrap.distinctID was provided. PostHog will mint a new ' +
          'distinct ID ' + lifetime + ', so calling identify() merges a new ID onto the person each time. A person ' +
          'can then pass the distinct-ID limit and its events stop appearing on person pages and the session tab. ' +
          fix);
    }
  }

  /** @private */
  syncCookielessIdentity_() {
    const persistence = this.persistence;
    if (!persistence || this.isConsentTransition_) return;
    if (this.inCookielessMode_()) {
      if (this.config['cookieless_mode'] === 'on_reject' && this.get_distinct_id() !== COOKIELESS_SENTINEL_VALUE) {
        this.syncOptOutWithPersistence_();
        this.enterCookielessMode_();
      }
      return;
    }
    if (this.get_distinct_id() !== COOKIELESS_SENTINEL_VALUE) return;
    if (!this.isPersistenceDisabled_()) persistence.load(true);
    const current = this.get_distinct_id();
    if (!current || current === COOKIELESS_SENTINEL_VALUE) {
      const uuid = this.config['get_device_id'](uuidv7());
      this.register({[DISTINCT_ID]: uuid, [DEVICE_ID]: uuid});
      persistence.set_property(USER_STATE, USER_STATE_ANONYMOUS);
    }
    this.syncOptOutWithPersistence_();
  }

  /**
   * @param {string} token Project API key.
   * @param {!Object=} config
   * @param {string=} name Creates a secondary named instance when given.
   * @return {!PostHog}
   */
  init(token, config, name) {
    if (!name || name === PRIMARY_INSTANCE_NAME) return this.init_(token, config, name);
    const named = instances[name] || new PostHog();
    named.init_(token, config, name);
    instances[name] = named;
    if (instances[PRIMARY_INSTANCE_NAME]) instances[PRIMARY_INSTANCE_NAME][name] = named;
    else this[name] = named;
    return named;
  }

  /**
   * @param {string} token
   * @param {!Object=} cfg
   * @param {string=} name
   * @return {!PostHog}
   * @private
   */
  init_(token, cfg, name) {
    const config = cfg || {};
    const normalizedToken = isString(token) ? token.replace(/^\s+|\s+$/g, '') : '';
    if (!normalizedToken) {
      logger.critical('PostHog was initialized without a token. This likely indicates a misconfiguration. ' +
          'Please check the first argument passed to posthog.init()');
      return this;
    }
    if (this.loaded) {
      if (win && win.console) {
        if (normalizedToken !== this.config['token']) {
          win.console.warn('[PostHog.js]', 'You have already initialized PostHog with a different project token! ' +
              'Re-initializing is a no-op, so events will keep going to the project this instance was initialized ' +
              "with. To capture into a second project, load PostHog once, then initialize a named instance after the " +
              "SDK has loaded, e.g. posthog.init('" + normalizedToken + "', { ... }, 'project2')");
        } else {
          win.console.warn('[PostHog.js]', 'You have already initialized PostHog! Re-initializing is a no-op');
        }
      }
      return this;
    }
    this.loaded = true;
    this.config = defaultConfig(config['defaults']);
    config['debug'] = this.checkLocalStorageForDebug_(config['debug']);
    this.originalUserConfig_ = config;

    if (config['person_profiles']) this.initialPersonProfilesConfig_ = config['person_profiles'];
    else if (config['process_person']) this.initialPersonProfilesConfig_ = config['process_person'];

    const baseConfig = defaultConfig(config['defaults']);
    const userConfig = configRenames(config);
    const merged = /** @type {!Object} */ (extend({}, baseConfig, userConfig, {'name': name, 'token': normalizedToken}));
    if (isObject(baseConfig['rageclick']) && isObject(userConfig['rageclick'])) {
      merged['rageclick'] = extend({}, baseConfig['rageclick'], userConfig['rageclick']);
    }
    if (isObject(baseConfig['session_recording']) && isObject(userConfig['session_recording'])) {
      merged['session_recording'] = extend({}, baseConfig['session_recording'], userConfig['session_recording']);
    }
    this.set_config(merged);

    if (this.config['on_xhr_error']) logger.error('on_xhr_error is deprecated. Use on_request_error instead');

    this.compression = config['disable_compression'] ? undefined : COMPRESSION_GZIP_JS;

    const persistenceDisabled = this.isPersistenceDisabled_();
    const allowDisabledRead = !this.inCookielessMode_();
    this.persistence = new Persistence(this.config, persistenceDisabled, allowDisabledRead);
    this.sessionPersistence = this.config['persistence'] === 'sessionStorage' || this.config['persistence'] === 'memory' ?
        this.persistence :
        new Persistence(/** @type {!Object} */ (extend({}, this.config, {'persistence': 'sessionStorage'})),
            persistenceDisabled, allowDisabledRead);

    const persistenceName = this.config['persistence_name'] || this.config['token'];
    this.sessionRegisteredPropertiesStorageKey_ = 'ph_' + persistenceName + '_session_registered_properties';
    if (this.config['persistence'] !== 'memory' && !persistenceDisabled && sessionStore.isSupported()) {
      const stored = /** @type {?} */ (sessionStore.parse(this.sessionRegisteredPropertiesStorageKey_));
      if (isArray(stored)) {
        const self = this;
        stored.forEach(function(key) {
          if (isString(key) && self.sessionRegisteredPropKeys_.indexOf(key) === -1) {
            self.sessionRegisteredPropKeys_.push(key);
          }
        });
      }
    } else {
      sessionStore.remove(this.sessionRegisteredPropertiesStorageKey_);
    }

    const initialPersistenceProps = assign(this.persistence.props);
    const initialSessionProps = assign(this.sessionPersistence.props);

    this.register({'$initialization_time': new Date().toISOString()});

    const self = this;
    this.requestQueue = new RequestQueue(function(req, transportOverride) {
      self.sendRetriableRequest_(req, transportOverride);
    }, this.config['request_queue_config']);
    this.retryQueue = new RetryQueue(function(opts, onResponse) {
      self.sendRequest_(opts, onResponse);
    }, function(opts) {
      self.sendRequest_(opts);
    });
    this.requestQueueBeforeDomLoaded = [];

    const startInCookielessMode = this.inCookielessMode_();
    if (!startInCookielessMode) {
      this.sessionManager = new SessionManager(this.config, this.persistence);
      this.sessionPropsManager = new SessionPropsManager(this.config, this.sessionManager, this.persistence);
      this.sessionManager.onSessionId(function(_s, _w, reason) {
        if (reason && (reason['activityTimeout'] || reason['sessionPastMaximumLength'] || reason['crossTabAdoption'])) {
          self.clearSessionRegisteredProps_();
        }
      });
    }

    this.enrollFeatureFlags_();

    if (this.config['__preview_deferred_init_extensions']) {
      logger.info('Deferring extension initialization to improve startup performance');
      setTimeout(function() {
        self.initExtensions_(startInCookielessMode);
      }, 0);
    } else {
      logger.info('Initializing extensions synchronously');
      this.initExtensions_(startInCookielessMode);
    }

    Config.DEBUG = Config.DEBUG || !!this.config['debug'];
    if (Config.DEBUG) {
      logger.info('Starting in debug mode', {'this': this, 'config': config, 'thisC': assign(this.config),
        'p': initialPersistenceProps, 's': initialSessionProps});
    }

    if (this.config['identity_distinct_id'] && !(config['bootstrap'] && config['bootstrap']['distinctID'])) {
      config['bootstrap'] = extend({}, config['bootstrap'],
          {'distinctID': this.config['identity_distinct_id'], 'isIdentifiedID': true});
    }

    const bootstrap = config['bootstrap'];
    const initialDistinctId = bootstrap ? bootstrap['distinctID'] : undefined;
    this.hasStableInitialDistinctId_ = !!initialDistinctId && !isEmptyString(initialDistinctId);

    if (bootstrap && bootstrap['distinctID']) {
      const bootstrapDistinctId = bootstrap['distinctID'];
      const existingDistinctId = this.get_distinct_id();
      const existingUserState = this.persistence.get_property(USER_STATE);
      if (bootstrap['isIdentifiedID'] && existingDistinctId != null && existingDistinctId !== bootstrapDistinctId &&
          existingUserState === USER_STATE_ANONYMOUS) {
        this.identify(bootstrapDistinctId);
      } else if (bootstrap['isIdentifiedID'] && existingDistinctId != null &&
          existingDistinctId !== bootstrapDistinctId && existingUserState === USER_STATE_IDENTIFIED) {
        logger.warn('Bootstrap distinctID differs from an already-identified user. The existing identity is ' +
            'preserved. Call reset() before reinitializing if you intend to switch users.');
      } else {
        const uuid = this.config['get_device_id'](uuidv7());
        const deviceId = bootstrap['isIdentifiedID'] ? uuid : bootstrapDistinctId;
        this.persistence.set_property(USER_STATE, bootstrap['isIdentifiedID'] ? USER_STATE_IDENTIFIED : USER_STATE_ANONYMOUS);
        this.register({[DISTINCT_ID]: bootstrapDistinctId, [DEVICE_ID]: deviceId});
      }
    }

    if (startInCookielessMode) {
      this.register_once({[DISTINCT_ID]: COOKIELESS_SENTINEL_VALUE, [DEVICE_ID]: null}, '');
    } else if (!this.get_distinct_id()) {
      const uuid = this.config['get_device_id'](uuidv7());
      this.register_once({[DISTINCT_ID]: uuid, [DEVICE_ID]: uuid}, '');
      this.persistence.set_property(USER_STATE, USER_STATE_ANONYMOUS);
    }

    addEventListener(win, win && 'onpagehide' in win ? 'pagehide' : 'unload', function() {
      self.handleUnload_();
    }, {capture: undefined, passive: false});
    addEventListener(win, 'pageshow', function(event) {
      self.isPageUnloading = false;
      if (!self.isShutdown_) {
        if (event && event['persisted'] && self.persistence) {
          const prevId = self.persistence.get_property(DISTINCT_ID);
          const prevState = self.persistence.get_property(USER_STATE);
          self.persistence.load();
          if (prevId !== self.persistence.get_property(DISTINCT_ID) ||
              prevState !== self.persistence.get_property(USER_STATE)) {
            self.processIdentityChange_();
          }
        }
        if (self.retryQueue) self.retryQueue.resume();
      }
    });

    this.loaded_();

    if (isFunction(this.config['_onCapture']) && this.config['_onCapture'] !== NOOP) {
      logger.warn('onCapture is deprecated. Please use `before_send` instead');
      this.on('eventCaptured', function(data) {
        self.config['_onCapture'](data['event'], data);
      });
    }
    if (this.config['ip']) {
      logger.warn('The `ip` config option has NO EFFECT AT ALL and has been deprecated. Use a custom transformation ' +
          'or "Discard IP data" project setting instead. See https://posthog.com/tutorials/web-redact-properties#hiding-customer-ip-address for more information.');
    }

    if (!this.config['disableDeviceModel']) {
      const uaData = nav ? nav['userAgentData'] : undefined;
      if (uaData && uaData['getHighEntropyValues']) {
        try {
          uaData['getHighEntropyValues'](['model'])['then'](function(hints) {
            const model = hints ? hints['model'] : undefined;
            if (isString(model) && model.length > 0) self.register({[DEVICE_MODEL]: model});
          }, NOOP);
        } catch (e) {}
      }
    }
    return this;
  }

  /** @private */
  enrollFeatureFlags_() {
    const factory = findExtensionFactory('featureFlags');
    if (factory) this.attachExtension('featureFlags', factory);
  }

  /**
   * @param {boolean} startInCookielessMode
   * @private
   */
  initExtensions_(startInCookielessMode) {
    const perf = win ? win.performance : null;
    const t0 = perf && perf.now ? perf.now() : new Date().getTime();
    const self = this;
    this.historyAutocapture = new HistoryAutocapture(function() {
      return self.config;
    }, function(event, props) {
      self.capture(event, props);
    });
    const tasks = [];
    if (!this.config['disable_scroll_properties']) {
      tasks.push(function() {
        self.scrollManager.startMeasuringScrollPosition();
      });
    }
    tasks.push(function() {
      if (self.historyAutocapture) self.historyAutocapture.initialize();
    });
    tasks.push(function() {
      self.extensionsReady_ = true;
      attachAllExtensions(self);
    });
    tasks.forEach(function(task) {
      try {
        task();
      } catch (e) {
        logger.error('Error initializing extension:', e);
      }
    });
    const t1 = perf && perf.now ? perf.now() : new Date().getTime();
    this.register_for_session({
      [SDK_DEBUG_EXTENSIONS_INIT_METHOD]: this.config['__preview_deferred_init_extensions'] ? 'deferred' : 'synchronous',
      [SDK_DEBUG_EXTENSIONS_INIT_TIME_MS]: Math.round(t1 - t0),
    });
  }

  /**
   * Called by the extension registry for each module (during init, or when a
   * module chunk is loaded later).
   * @param {string} name
   * @param {function(?): !Extension} factory
   */
  attachExtension(name, factory) {
    if (this.createExtension_(name, factory)) this.initExtension_(name);
  }

  /**
   * Attaches the modules registered before init, like upstream's
   * `_initExtensions`: all are created first, then initialised, each phase in
   * upstream's order (see UPSTREAM_CREATE_ORDER), so features start, and
   * request their lazily loaded parts, in the same order as upstream's.
   * @param {!Array<{name: string, factory: function(?): !Extension}>} list in registration order
   */
  attachExtensions(list) {
    const factories = {};
    list.forEach(function(f) {
      factories[f.name] = f.factory;
    });
    const self = this;
    const created = inUpstreamOrder(list.map(function(f) {
      return f.name;
    }), UPSTREAM_CREATE_ORDER).filter(function(name) {
      return self.createExtension_(name, factories[name]);
    });
    inUpstreamOrder(created, UPSTREAM_INIT_ORDER).forEach(function(name) {
      self.initExtension_(name);
    });
  }

  /**
   * @param {string} name
   * @param {function(?): !Extension} factory
   * @return {boolean} whether it was created
   * @private
   */
  createExtension_(name, factory) {
    if (this.extensions[name]) return false;
    // Like upstream, session replay is not created in cookieless mode (it is
    // created when opting in from cookieless `on_reject` mode).
    if (name === 'sessionRecording' && !this.sessionManager) return false;
    let ext;
    try {
      ext = factory(this);
      this.extensions[name] = ext;
      this.extensionOrder_.push(name);
      // Public handle, like upstream's posthog.featureFlags / posthog.experiments.
      this[name] = ext;
    } catch (e) {
      logger.critical('failed to initialise extension ' + name, e);
      return false;
    }
    const self = this;
    if (name === 'featureFlags') {
      const flags = /** @type {!FeatureFlagsApi} */ (ext);
      this.featureFlagsReloadingUnsubscribe_ = flags.onReloading(function() {
        self.emitter_.emit('featureFlagsReloading', true);
      });
    }
    return true;
  }

  /**
   * onInit, then the last remote config for a module attached after it arrived.
   * @param {string} name
   * @private
   */
  initExtension_(name) {
    const ext = this.extensions[name];
    if (!ext) return;
    try {
      if (ext.onInit) ext.onInit();
    } catch (e) {
      logger.error('Error initializing extension:', e);
    }
    const last = this.lastRemoteConfig_;
    if (last) {
      try {
        if (ext.onRemoteConfig) ext.onRemoteConfig(last.config);
        // Flags loaded after the remote config arrived: load them the way the
        // remote config loader would have.
        if (name === 'featureFlags' && shouldLoadFlagsAfterRemoteConfig(last.config, this.config)) {
          /** @type {!FeatureFlagsApi} */ (ext).ensureFlagsLoaded();
        }
      } catch (e) {
        logger.error('Error applying remote config to extension ' + name, e);
      }
    }
  }

  /**
   * @return {?SessionRecordingApi}
   * @private
   */
  sessionRecording_() {
    const r = this.extensions['sessionRecording'];
    return r ? /** @type {!SessionRecordingApi} */ (r) : null;
  }

  /**
   * Detaches an extension (upstream `_removeExtension`).
   * @param {string} name
   * @private
   */
  detachExtension_(name) {
    if (!this.extensions[name]) return;
    delete this.extensions[name];
    this.extensionOrder_ = this.extensionOrder_.filter(function(n) {
      return n !== name;
    });
    this[name] = undefined;
  }

  /**
   * @return {?FeatureFlagsApi}
   * @private
   */
  flags_() {
    const f = this.extensions['featureFlags'];
    return f ? /** @type {!FeatureFlagsApi} */ (f) : null;
  }

  /**
   * Applies a remote config result (upstream `_onRemoteConfig`).
   * @param {?Object} config null when loading failed
   */
  onRemoteConfig_(config) {
    if (!(doc && doc.body)) {
      logger.info('document not ready yet, trying again in 500 milliseconds...');
      const self = this;
      setTimeout(function() {
        self.onRemoteConfig_(config);
      }, 500);
      return;
    }
    this.lastRemoteConfig_ = {config: config};
    this.compression = undefined;
    if (config) {
      const supported = config['supportedCompression'];
      if (supported && !this.config['disable_compression']) {
        this.compression = supported.indexOf(COMPRESSION_GZIP_JS) !== -1 ? COMPRESSION_GZIP_JS :
            supported.indexOf(COMPRESSION_BASE64) !== -1 ? COMPRESSION_BASE64 : undefined;
      }
      const analytics = config['analytics'];
      if (analytics && analytics['endpoint']) this.analyticsDefaultEndpoint = analytics['endpoint'];
    }
    this.set_config({
      'person_profiles': this.initialPersonProfilesConfig_ ? this.initialPersonProfilesConfig_ :
          PERSON_PROFILES_IDENTIFIED_ONLY,
    });
    this.emitter_.emit('extensionsRemoteConfig', config);
    const self = this;
    inUpstreamOrder(this.extensionOrder_, UPSTREAM_REMOTE_CONFIG_ORDER).forEach(function(name) {
      const ext = self.extensions[name];
      if (ext && ext.onRemoteConfig) {
        try {
          ext.onRemoteConfig(config);
        } catch (e) {
          logger.error('Error applying remote config to extension ' + name, e);
        }
      }
    });
  }

  /** @private */
  loaded_() {
    try {
      this.config['loaded'](this);
    } catch (err) {
      logger.critical('`loaded` function failed', err);
    }
    this.startQueueIfOptedIn_();

    const pattern = this.config['internal_or_test_user_hostname'];
    if (pattern && loc && loc.hostname) {
      const matches = typeof pattern === 'string' ? loc.hostname === pattern : pattern.test(loc.hostname);
      if (matches) this.setInternalOrTestUser();
    }

    const self = this;
    if (this.config['capture_pageview']) {
      setTimeout(function() {
        if (self.consent.isOptedIn() || self.inCookielessMode_()) self.captureInitialPageview_();
      }, 1);
    }

    this.remoteConfigLoader = new RemoteConfigLoader(/** @type {!RemoteConfigHost} */ ({
      getConfig: function() {
        return self.config;
      },
      shouldDisableFlags: function() {
        return self.shouldDisableFlags_();
      },
      endpointFor: function(target, path) {
        return self.requestRouter.endpointFor(target, path);
      },
      getJSON: function(url, callback) {
        self.sendRequest_(/** @type {!RequestOptions} */ ({method: 'GET', url: url, callback: callback}));
      },
      applyRemoteConfig: function(config) {
        self.onRemoteConfig_(config);
      },
      ensureFlagsLoaded: function() {
        const f = self.flags_();
        if (f) f.ensureFlagsLoaded();
      },
    }));
    this.remoteConfigLoader.load();
  }

  /** @private */
  startQueueIfOptedIn_() {
    if (this.is_capturing() && this.config['request_batching'] && this.requestQueue) this.requestQueue.enable();
  }

  /** Called once the DOM is loaded (upstream `_dom_loaded`). */
  domLoaded() {
    if (this.is_capturing()) {
      const self = this;
      this.requestQueueBeforeDomLoaded.forEach(function(item) {
        self.sendRetriableRequest_(item);
      });
    }
    this.requestQueueBeforeDomLoaded = [];
    this.startQueueIfOptedIn_();
  }

  /** @private */
  handleUnload_() {
    this.isPageUnloading = true;
    // Metrics are pre-aggregated and do not ride the request queue (upstream order).
    const metrics = /** @type {?MetricsApi} */ (this.extensions['metrics'] || null);
    if (metrics) metrics.flush('sendBeacon');
    if (!this.config['request_batching']) {
      if (this.shouldCapturePageleave_()) this.capture(EVENT_PAGELEAVE, null, {'transport': 'sendBeacon'});
      return;
    }
    if (this.shouldCapturePageleave_()) this.capture(EVENT_PAGELEAVE);
    const logs = /** @type {?LogsApi} */ (this.extensions['logs'] || null);
    if (logs) logs.flushLogs('sendBeacon');
    if (this.requestQueue) this.requestQueue.unload();
    if (this.retryQueue) this.retryQueue.unload();
  }

  /**
   * Upstream request-dispatch `sendRequest`: applies headers, compression,
   * server rate limits and `on_request_error`.
   * @param {!RequestOptions} opts
   * @param {!TransportCallback=} onResponse
   */
  sendRequest_(opts, onResponse) {
    let options = opts;
    if (onResponse) {
      options = /** @type {!RequestOptions} */ (assign(opts));
      options.callback = function(response) {
        onResponse(response, undefined);
      };
    }
    if (!this.loaded) {
      if (options.fireCallbackOnDrop && options.callback) options.callback(/** @type {!PHResponse} */ ({statusCode: 0}));
      return;
    }
    if (enqueueRequests) {
      this.requestQueueBeforeDomLoaded.push(options);
      return;
    }
    if (this.rateLimiter.isServerRateLimited(options.batchKey)) {
      if (options.fireCallbackOnDrop && options.callback) options.callback(/** @type {!PHResponse} */ ({statusCode: 429}));
      return;
    }
    options.transport = options.transport || this.config['api_transport'];
    options.headers = /** @type {!Object<string, string>} */ (extend({}, this.config['request_headers'], options.headers));
    options.compression = options.compression === 'best-available' ?
        (isNullish(this.compression) ? options.compressionFallback : this.compression) : options.compression;
    const disableBeacon = isUndefined(this.config['disable_beacon']) ? this.config['__preview_disable_beacon'] :
        this.config['disable_beacon'];
    if (disableBeacon) options.disableTransport = ['sendBeacon'];
    options.fetchOptions = options.fetchOptions || this.config['fetch_options'];
    if (options.onDispatch) options.onDispatch();
    const self = this;
    const finalOptions = options;
    request(options, function(response, retryAfterMs) {
      self.rateLimiter.checkForLimiting(response);
      if (response.statusCode >= 400 && isFunction(self.config['on_request_error'])) {
        self.config['on_request_error'](response);
      }
      if (onResponse) onResponse(response, retryAfterMs);
      else if (finalOptions.callback) finalOptions.callback(response);
    });
  }

  /**
   * @param {!RequestOptions} options
   * @param {string=} transportOverride
   * @private
   */
  sendRetriableRequest_(options, transportOverride) {
    if (this.retryQueue) {
      this.retryQueue.retriableRequest(options, transportOverride);
    } else {
      let o = options;
      if (transportOverride) {
        o = /** @type {!RequestOptions} */ (assign(options));
        o.transport = transportOverride;
      }
      this.sendRequest_(o);
    }
  }

  /**
   * Replays calls queued by the snippet (upstream `_execute_array`).
   * @param {!Array} array
   */
  executeArray(array) {
    executeArrayDepth++;
    try {
      const aliasCalls = [];
      const otherCalls = [];
      const capturingCalls = [];
      const self = this;
      (array || []).forEach(function(item) {
        if (!item) return;
        const fnName = item[0];
        if (isArray(fnName)) {
          capturingCalls.push(item);
        } else if (isFunction(item)) {
          try {
            item.call(self);
          } catch (e) {
            logger.error('Error executing queued PostHog call', item, e);
          }
        } else if (isArray(item) && fnName === 'alias') {
          aliasCalls.push(item);
        } else if (isArray(item) && String(fnName).indexOf('capture') !== -1 && isFunction(self[fnName])) {
          capturingCalls.push(item);
        } else {
          otherCalls.push(item);
        }
      });
      const execute = function(calls, thisArg) {
        calls.forEach(function(item) {
          try {
            if (isArray(item[0])) {
              let caller = thisArg;
              each(item, function(call) {
                caller = caller[call[0]].apply(caller, call.slice(1));
              });
            } else {
              thisArg[item[0]].apply(thisArg, item.slice(1));
            }
          } catch (e) {
            logger.error('Error executing queued PostHog call', item, e);
          }
        });
      };
      execute(aliasCalls, this);
      execute(otherCalls, this);
      execute(capturingCalls, this);
    } finally {
      executeArrayDepth--;
    }
  }

  /** @param {!Array} item a `[method, ...args]` call */
  push(item) {
    if (executeArrayDepth > 0 && isArray(item) && isString(item[0])) {
      const fn = PostHog.prototype[item[0]];
      if (isFunction(fn)) fn.apply(this, item.slice(1));
      return;
    }
    this.executeArray([item]);
  }

  // ---------------------------------------------------------------------------
  // Meta ($fbc / $fbp) identifiers

  /**
   * @param {string} which 'fbc' | 'fbp'
   * @return {{property: string, persistenceKey: string, cookieName: string, pattern: !RegExp}}
   * @private
   */
  metaChannel_(which) {
    return which === 'fbc' ?
        {property: FACEBOOK_CLICK_ID, persistenceKey: PERSISTENCE_FACEBOOK_CLICK_ID, cookieName: '_fbc', pattern: FBC_PATTERN} :
        {property: FACEBOOK_BROWSER_ID, persistenceKey: PERSISTENCE_FACEBOOK_BROWSER_ID, cookieName: '_fbp', pattern: FBP_PATTERN};
  }

  /**
   * @param {{persistenceKey: string, pattern: !RegExp}} channel
   * @return {{value: string, delivered: boolean}|undefined}
   * @private
   */
  getPersistedMeta_(channel) {
    const stored = /** @type {?} */ (this.persistence ? this.persistence.get_property(channel.persistenceKey) : undefined);
    if (isString(stored) && channel.pattern.test(stored)) return {value: /** @type {string} */ (stored), delivered: false};
    if (isObject(stored) && isString(stored['value']) && channel.pattern.test(stored['value'])) {
      return {value: stored['value'], delivered: stored['delivered'] === true};
    }
    return undefined;
  }

  /**
   * @param {{persistenceKey: string}} channel
   * @param {string} value
   * @param {boolean} delivered
   * @private
   */
  registerMeta_(channel, value, delivered) {
    if (this.persistence) this.persistence.register({[channel.persistenceKey]: {'value': value, 'delivered': delivered}});
  }

  /**
   * @param {{persistenceKey: string}} channel
   * @param {string} value
   * @param {{value: string, delivered: boolean}|undefined} stored
   * @return {{value: string, pending: boolean}}
   * @private
   */
  storeMeta_(channel, value, stored) {
    if (stored && value === stored.value) return {value: value, pending: !stored.delivered};
    this.registerMeta_(channel, value, false);
    return {value: value, pending: true};
  }

  /**
   * @param {{cookieName: string, pattern: !RegExp}} channel
   * @return {string|undefined}
   * @private
   */
  readMetaCookie_(channel) {
    if (!this.config['save_campaign_params'] || this.inCookielessMode_()) return undefined;
    const v = getCookieValue(channel.cookieName);
    return isString(v) && channel.pattern.test(/** @type {string} */ (v)) ? /** @type {string} */ (v) : undefined;
  }

  /**
   * @param {*} fbclid
   * @param {*} provided
   * @param {boolean} hasProvided
   * @param {boolean} unset
   * @return {{value: string, pending: boolean}|undefined}
   * @private
   */
  updateFacebookClickId_(fbclid, provided, hasProvided, unset) {
    if (!this.persistence) return undefined;
    const channel = this.metaChannel_('fbc');
    const stored = this.getPersistedMeta_(channel);
    if (unset) {
      this.persistence.unregister(channel.persistenceKey);
      return undefined;
    }
    if (hasProvided) {
      if (!isString(provided) || !FBC_PATTERN.test(provided)) {
        this.persistence.unregister(channel.persistenceKey);
        return undefined;
      }
      return this.storeMeta_(channel, /** @type {string} */ (provided), stored);
    }
    const urlClick = isString(fbclid) && FBCLID_PATTERN.test(fbclid) ? /** @type {string} */ (fbclid) : undefined;
    const cookieFbc = this.readMetaCookie_(channel);
    if (cookieFbc) {
      const cookie = cookieFbc.split('.');
      let wins;
      if (urlClick) {
        wins = cookie[3] === urlClick;
      } else if (!stored) {
        wins = true;
      } else {
        const known = stored.value.split('.');
        wins = cookie[3] === known[3] || Number(cookie[2]) > Number(known[2]);
      }
      if (wins) return this.storeMeta_(channel, cookieFbc, stored);
    }
    if (urlClick) {
      if (stored && stored.value.split('.')[3] === urlClick) return {value: stored.value, pending: !stored.delivered};
      return this.storeMeta_(channel, 'fb.1.' + new Date().getTime() + '.' + urlClick, stored);
    }
    return stored ? {value: stored.value, pending: !stored.delivered} : undefined;
  }

  /**
   * @param {*} provided
   * @param {boolean} hasProvided
   * @param {boolean} unset
   * @return {{value: string, pending: boolean}|undefined}
   * @private
   */
  updateFacebookBrowserId_(provided, hasProvided, unset) {
    if (!this.persistence) return undefined;
    const channel = this.metaChannel_('fbp');
    const stored = this.getPersistedMeta_(channel);
    if (unset) {
      this.persistence.unregister(channel.persistenceKey);
      return undefined;
    }
    if (hasProvided) {
      if (!isString(provided) || !FBP_PATTERN.test(provided)) {
        this.persistence.unregister(channel.persistenceKey);
        return undefined;
      }
      return this.storeMeta_(channel, /** @type {string} */ (provided), stored);
    }
    const cookieFbp = this.readMetaCookie_(channel);
    if (cookieFbp) return this.storeMeta_(channel, cookieFbp, stored);
    return stored ? {value: stored.value, pending: !stored.delivered} : undefined;
  }

  // ---------------------------------------------------------------------------
  // Capture

  /**
   * Captures an event. `options` (all optional, quoted keys):
   *  - '$set' / '$set_once' / '$unset': person properties sent with the event
   *  - 'timestamp' (Date): event time override; 'uuid': event uuid override
   *  - 'send_instantly': bypass the batch queue (sync gzip)
   *  - 'transport': 'XHR' | 'fetch' | 'sendBeacon'
   *  - '_batchKey': batch with other events of this key (also batches when
   *    other options are present); '_url': endpoint override
   *  - '_noTruncate': skip `properties_string_max_length` truncation
   *  - 'skip_client_rate_limiting': bypass the client token bucket
   *  - '_originatedFromCaptureException': marks `$exception` from captureException
   * Note: like upstream, passing any options object without `_batchKey`
   * sends the event unbatched.
   * @param {string} eventName
   * @param {?Object=} properties
   * @param {?Object=} options
   * @return {!Object|undefined} the captured event
   */
  capture(eventName, properties, options) {
    if (!this.loaded || !this.persistence || !this.sessionPersistence || !this.requestQueue) {
      logger.uninitializedWarning('posthog.capture');
      return undefined;
    }
    if (!this.is_capturing()) {
      logger.info('Event "' + eventName + '" was not captured because capturing is disabled (opted out or consent pending).');
      return undefined;
    }
    if (isUndefined(eventName) || !isString(eventName)) {
      logger.error('No event name provided to posthog.capture');
      return undefined;
    }
    this.syncCookielessIdentity_();
    if (eventName === '$snapshot' && this.inCookielessMode_()) return undefined;

    const isBot = !this.config['opt_out_useragent_filter'] && this.isBot_();
    if (isBot && !this.config['__preview_capture_bot_pageviews']) {
      if (!this.botFilterWarned_) {
        this.botFilterWarned_ = true;
        if (win && win.console) {
          win.console.warn('[PostHog.js] Events are being dropped because the user agent looks like a bot (first ' +
              'dropped event: "' + eventName + '"). Set `opt_out_useragent_filter: true` to capture them, e.g. in ' +
              'end-to-end tests. Note that logs from `captureLog` are not subject to this filter.');
        }
      }
      logger.info('Event "' + eventName + '" was not captured because the user agent looks like a bot. Set ' +
          '`opt_out_useragent_filter: true` to capture it.');
      return undefined;
    }

    const opts = options || {};
    const rateLimitContext = !opts['skip_client_rate_limiting'] ? this.rateLimiter.clientRateLimitContext() : undefined;
    if (rateLimitContext && rateLimitContext.isRateLimited) {
      logger.critical('This capture call is ignored due to client rate limiting.');
      return undefined;
    }
    if (properties && properties['$current_url'] && !isString(properties['$current_url'])) {
      logger.error('Invalid `$current_url` property provided to `posthog.capture`. Input must be a string. Ignoring ' +
          'provided value.');
      delete properties['$current_url'];
    }
    if (eventName === '$exception' && !opts['_originatedFromCaptureException']) {
      logger.warn("Using `posthog.capture('$exception')` is unreliable because it does not attach required metadata. " +
          'Use `posthog.captureException(error)` instead, which attaches required metadata automatically.');
    }

    this.sessionPersistence.update_search_keyword();
    let campaignParams;
    if (this.config['save_campaign_params']) campaignParams = this.sessionPersistence.update_campaign_params();
    if (this.config['save_referrer']) this.sessionPersistence.update_referrer_info();
    if (this.config['save_campaign_params'] || this.config['save_referrer']) this.persistence.set_initial_person_info();

    const systemTime = new Date();
    const timestamp = opts['timestamp'] || systemTime;
    const uuid = isValidUUID(opts['uuid']) ? /** @type {string} */ (opts['uuid']) : uuidv7();
    /** @type {!Object} */
    let data = {
      'uuid': uuid,
      'event': eventName,
      'properties': this.calculateEventProperties(eventName, properties || {}, timestamp, uuid),
    };

    if (eventName === EVENT_PAGEVIEW && this.config['__preview_capture_bot_pageviews'] && isBot) {
      data['event'] = '$bot_pageview';
      data['properties']['$browser_type'] = 'bot';
    }
    if (rateLimitContext) data['properties']['$lib_rate_limit_remaining_tokens'] = rateLimitContext.remainingTokens;

    const minimal = eventName === '$feature_flag_called' &&
        data['properties']['$feature_flag_has_experiment'] === false &&
        this.get_property(PERSISTENCE_MINIMAL_FLAG_CALLED_EVENTS) === true;

    if (opts['$set'] && !minimal) data['$set'] = opts['$set'];

    const propertySet = properties && isObject(properties['$set']) ? properties['$set'] : undefined;
    const propertyUnset = properties && isArray(properties['$unset']) ? properties['$unset'] : [];
    const optionUnset = opts['$unset'] || [];
    const callerValueFor = function(property) {
      const hasOption = !!opts['$set'] && property in opts['$set'];
      const hasProperty = !!propertySet && property in propertySet;
      return {
        hasProvided: hasOption || hasProperty,
        provided: hasOption ? opts['$set'][property] : (propertySet ? propertySet[property] : undefined),
        unset: propertyUnset.indexOf(property) !== -1 || optionUnset.indexOf(property) !== -1,
      };
    };
    const fbc = callerValueFor(FACEBOOK_CLICK_ID);
    const fbp = callerValueFor(FACEBOOK_BROWSER_ID);
    const metaIdentifiers = [
      {channel: this.metaChannel_('fbc'), hasProvided: fbc.hasProvided,
        update: this.updateFacebookClickId_(campaignParams ? campaignParams['fbclid'] : undefined, fbc.provided,
            fbc.hasProvided, fbc.unset)},
      {channel: this.metaChannel_('fbp'), hasProvided: fbp.hasProvided,
        update: this.updateFacebookBrowserId_(fbp.provided, fbp.hasProvided, fbp.unset)},
    ];
    metaIdentifiers.forEach(function(m) {
      if (m.update && data['properties']['$process_person_profile'] === true && m.update.pending && !m.hasProvided &&
          !minimal) {
        data['$set'] = extend({[m.channel.property]: m.update.value}, data['$set']);
      }
    });
    if (opts['$unset']) data['$unset'] = opts['$unset'];

    const setOnce = minimal ? undefined :
        this.calculateSetOnceProperties_(opts['$set_once'], eventName !== EVENT_GROUPIDENTIFY, eventName === EVENT_IDENTIFY);
    if (setOnce) data['$set_once'] = setOnce;

    if (!opts['_noTruncate']) data = copyAndTruncateStrings(data, this.config['properties_string_max_length']);
    data['timestamp'] = timestamp;
    if (!isUndefined(opts['timestamp'])) {
      data['properties']['$event_time_override_provided'] = true;
      data['properties']['$event_time_override_system_time'] = systemTime;
    }

    if (minimal) {
      const p = data['properties'];
      const out = {};
      MINIMAL_FLAG_CALLED_EVENT_PROPERTIES.concat(FLAG_CALLED_TRANSPORT_PROPERTY_KEYS).forEach(function(k) {
        if (p[k] !== undefined) out[k] = p[k];
      });
      data['properties'] = out;
    }

    if (eventName === 'survey dismissed' || eventName === 'survey sent') {
      const surveyId = properties ? properties['$survey_id'] : undefined;
      const iteration = properties ? properties['$survey_iteration'] : undefined;
      const key = '$survey_' + (eventName === 'survey sent' ? 'responded' : 'dismissed') + '/' + surveyId +
          (iteration && iteration > 0 ? '/' + iteration : '');
      try {
        localStore.set('seenSurvey_' + surveyId + (iteration && iteration > 0 ? '_' + iteration : ''), true);
      } catch (e) {}
      data['$set'] = extend({}, data['$set'], {[key]: true});
    } else if (eventName === 'survey shown') {
      data['$set'] = extend({}, data['$set'], {'$survey_last_seen_date': new Date().toISOString()});
    }
    if (eventName === 'product tour shown') {
      const tourType = properties ? properties['$product_tour_type'] : undefined;
      if (tourType) {
        data['$set'] = extend({}, data['$set'],
            {['$product_tour_last_seen_date/' + tourType]: new Date().toISOString()});
      }
    }

    const finalSet = extend({}, data['properties']['$set'], data['$set']);
    if (!isEmptyObject(finalSet)) this.setPersonPropertiesForFlags(finalSet);

    if (!isNullish(this.config['before_send'])) {
      const result = this.runBeforeSend_(data);
      if (!result) return undefined;
      data = result;
      data['uuid'] = isValidUUID(data['uuid']) ? data['uuid'] : uuidv7();
    }

    if (this.sessionRecording_() && !this.replayDebugPropertiesPaused_ && isReplayDebugEvent(eventName)) {
      this.replayDebugPropertiesPaused_ = true;
      const instance = this;
      setTimeout(function() {
        instance.replayDebugPropertiesPaused_ = false;
      }, REPLAY_DEBUG_PROPERTIES_INTERVAL_MS);
    }

    const toConfirm = [];
    metaIdentifiers.forEach(function(m) {
      const setVal = data['$set'] ? data['$set'][m.channel.property] : undefined;
      const finalValue = !isNullish(setVal) ? setVal :
          (data['properties'] && isObject(data['properties']['$set']) ? data['properties']['$set'][m.channel.property] : undefined);
      if (m.update && m.update.pending && finalValue === m.update.value) toConfirm.push({channel: m.channel, value: m.update.value});
    });

    this.emitter_.emit('eventCaptured', data);

    const url = !isNullish(opts['_url']) ? opts['_url'] : this.requestRouter.endpointFor('api', this.analyticsDefaultEndpoint);
    const isSessionRecording = opts['_batchKey'] === 'recordings' || /\/s\/(?:\?|$)/.test(url);
    const self = this;
    const requestOptions = /** @type {!RequestOptions} */ ({
      method: 'POST',
      url: url,
      data: data,
      compression: 'best-available',
      preferSyncCompression: opts['send_instantly'],
      timestampMode: isSessionRecording ? 'body' : 'capture-body',
      batchKey: opts['_batchKey'],
    });
    if (isSessionRecording && data['properties'] && data['properties']['$session_id']) {
      requestOptions.batchGroup = data['properties']['$session_id'] +
          (data['properties']['$window_id'] ? '-' + data['properties']['$window_id'] : '');
    }
    if (opts['transport']) requestOptions.transport = opts['transport'];
    if (toConfirm.length) {
      requestOptions.fireCallbackOnDrop = true;
      requestOptions.callback = function(response) {
        if (response.statusCode >= 200 && response.statusCode < 300) self.markMetaDelivered_(toConfirm);
      };
    }

    if (this.config['request_batching'] && (!options || opts['_batchKey']) && !opts['send_instantly']) {
      this.requestQueue.enqueue(requestOptions);
    } else {
      let transportOverride;
      if (!requestOptions.transport && !requestOptions.callback && isEmptyObject(this.config['request_headers'] || {}) &&
          this.isPageUnloading) {
        transportOverride = 'sendBeacon';
      }
      this.sendRetriableRequest_(requestOptions, transportOverride);
    }

    const flags = this.flags_();
    if (flags) flags.sendFlagCallsPendingCapture();
    return data;
  }

  /**
   * @param {!Array<{channel: {persistenceKey: string, pattern: !RegExp}, value: string}>} sent
   * @private
   */
  markMetaDelivered_(sent) {
    const self = this;
    sent.forEach(function(s) {
      const stored = self.getPersistedMeta_(s.channel);
      if (stored && stored.value === s.value && !stored.delivered) self.registerMeta_(s.channel, s.value, true);
    });
  }

  /**
   * @param {string} event
   * @param {function(...?)} cb
   * @return {function()}
   */
  on(event, cb) {
    return this.emitter_.on(event, cb);
  }

  /**
   * Builds the full property set for an event (upstream calculateEventProperties).
   * @param {string} eventName
   * @param {!Object} eventProperties
   * @param {!Date=} timestamp
   * @param {string=} uuid
   * @param {boolean=} readOnly
   * @return {!Object}
   */
  calculateEventProperties(eventName, eventProperties, timestamp, uuid, readOnly) {
    const ts = timestamp || new Date();
    if (!this.persistence || !this.sessionPersistence) return eventProperties;
    this.syncCookielessIdentity_();

    const startTimestamp = readOnly ? undefined : this.persistence.remove_event_timer(eventName);
    let properties = assign(eventProperties);
    properties['token'] = this.config['token'];
    properties['$config_defaults'] = this.config['defaults'] === 'latest' ? LATEST_DEFAULTS_DATE : this.config['defaults'];
    if (this.inCookielessMode_()) properties['$cookieless_mode'] = true;

    if (eventName === '$snapshot') {
      const pp = extend({}, this.persistence.properties(), this.sessionPersistence.properties());
      properties['distinct_id'] = pp['distinct_id'];
      if (!(isString(properties['distinct_id']) || isNumber(properties['distinct_id'])) ||
          isEmptyString(properties['distinct_id'])) {
        logger.error('Invalid distinct_id for replay event. This indicates a bug in your implementation');
      }
      return properties;
    }

    const infoProperties = getEventProperties(this.config['mask_personal_data_properties'],
        this.config['custom_personal_data_properties'], this.config['detect_google_search_app'],
        this.config['disable_capture_url_hashes']);

    if (this.sessionManager) {
      const s = this.sessionManager.checkAndGetSessionAndWindowId(readOnly, ts.getTime(), true);
      properties['$session_id'] = s.sessionId;
      properties['$window_id'] = s.windowId;
    }
    if (this.sessionPropsManager) extend(properties, this.sessionPropsManager.getSessionProps());

    try {
      const recording = this.sessionRecording_();
      if (recording) {
        const replayProperties = recording.getSdkDebugProperties();
        const includeDebugProperties = !this.replayDebugPropertiesPaused_ && isReplayDebugEvent(eventName);
        for (const key in replayProperties) {
          if (includeDebugProperties || REQUIRED_REPLAY_PROPERTIES.indexOf(key) !== -1) {
            properties[key] = replayProperties[key];
          }
        }
      }
      properties['$sdk_debug_retry_queue_size'] = this.retryQueue ? this.retryQueue.length : undefined;
    } catch (e) {
      properties['$sdk_debug_error_capturing_properties'] = String(e);
    }

    if (this.requestRouter.region() === RequestRouterRegion.CUSTOM) {
      properties['$lib_custom_api_host'] = this.config['api_host'];
    }

    let pageviewProperties;
    if (eventName === EVENT_PAGEVIEW && !readOnly) pageviewProperties = this.pageViewManager.doPageView(ts, uuid);
    else if (eventName === EVENT_PAGELEAVE && !readOnly) pageviewProperties = this.pageViewManager.doPageLeave(ts);
    else pageviewProperties = this.pageViewManager.doEvent();
    properties = /** @type {!Object} */ (extend(properties, pageviewProperties));

    if (eventName === EVENT_PAGEVIEW && doc) properties['title'] = doc.title;

    if (!isUndefined(startTimestamp)) {
      properties['$duration'] = parseFloat(((ts.getTime() - /** @type {number} */ (startTimestamp)) / 1000).toFixed(3));
    }

    if (userAgent && this.config['opt_out_useragent_filter']) properties['$browser_type'] = this.isBot_() ? 'bot' : 'browser';

    const persistenceProperties = this.persistence.properties();
    const sessionPersistenceProperties = this.sessionPersistence.properties();
    const eventGroups = properties['$groups'];
    const persistenceGroups = persistenceProperties['$groups'];
    if (isObject(eventGroups) && !isEmptyObject(eventGroups)) {
      properties['$groups'] = extend({}, isObject(persistenceGroups) ? persistenceGroups : {}, eventGroups);
    }
    ['$referrer', '$referring_domain'].forEach(function(k) {
      if (k in persistenceProperties) delete sessionPersistenceProperties[k];
    });

    const dynamicProperties = {};
    const self = this;
    this.extensionOrder_.slice().forEach(function(name) {
      const ext = self.extensions[name];
      if (ext && ext.eventProperties) {
        try {
          extend(dynamicProperties, ext.eventProperties(eventName));
        } catch (e) {
          logger.error('Failed to produce browser extension event properties', e);
        }
      }
    });

    properties = /** @type {!Object} */ (extend({}, infoProperties, persistenceProperties, sessionPersistenceProperties,
        extend({}, dynamicProperties, properties)));

    properties['$is_identified'] = this.isIdentified_();

    const denylist = this.config['property_denylist'];
    if (isArray(denylist)) {
      denylist.forEach(function(k) {
        delete properties[k];
      });
    } else {
      logger.error(DENYLIST_INVALID + denylist + ' or property_blacklist config: ' + this.config['property_blacklist']);
    }

    const sanitize = this.config['sanitize_properties'];
    if (sanitize) {
      logger.error(SANITIZE_DEPRECATED);
      properties = sanitize(properties, eventName);
    }

    const hasPersonProcessing = this.hasPersonProcessing_();
    properties['$process_person_profile'] = hasPersonProcessing;
    if (hasPersonProcessing && !readOnly) this.requirePersonProcessing_('_calculate_event_properties');
    return properties;
  }

  /**
   * Upstream _calculate_set_once_properties.
   * @param {?Object|undefined} dataSetOnce
   * @param {boolean=} markAsSent default true
   * @param {boolean=} forceIncludeInitialProps
   * @return {?Object|undefined}
   * @private
   */
  calculateSetOnceProperties_(dataSetOnce, markAsSent, forceIncludeInitialProps) {
    if (!this.persistence || !this.hasPersonProcessing_()) return dataSetOnce;
    if (this.personProcessingSetOncePropertiesSent_ && !forceIncludeInitialProps) return dataSetOnce;
    const initialProps = this.persistence.get_initial_props();
    const sessionProps = this.sessionPropsManager ? this.sessionPropsManager.getSetOnceProps() : undefined;
    let setOnce = extend({}, initialProps, sessionProps || {}, dataSetOnce || {});
    const sanitize = this.config['sanitize_properties'];
    if (sanitize) {
      logger.error(SANITIZE_DEPRECATED);
      setOnce = sanitize(setOnce, '$set_once');
    }
    if (markAsSent !== false) this.personProcessingSetOncePropertiesSent_ = true;
    if (isEmptyObject(setOnce)) return undefined;
    return setOnce;
  }

  // ---------------------------------------------------------------------------
  // Super properties

  /**
   * @param {!Object} properties
   * @param {number=} days
   */
  register(properties, days) {
    if (this.persistence) this.persistence.register(properties, days);
  }

  /**
   * @param {!Object} properties
   * @param {*=} defaultValue
   * @param {number=} days
   */
  register_once(properties, defaultValue, days) {
    if (this.persistence) this.persistence.register_once(properties, defaultValue, days);
  }

  /** @param {!Object} properties */
  register_for_session(properties) {
    if (this.sessionPersistence) this.sessionPersistence.register(properties);
    const self = this;
    keys(properties).forEach(function(k) {
      if (self.sessionRegisteredPropKeys_.indexOf(k) === -1) self.sessionRegisteredPropKeys_.push(k);
    });
    this.persistSessionRegisteredPropKeys_();
  }

  /** @param {string} property */
  unregister(property) {
    if (this.persistence) this.persistence.unregister(property);
  }

  /** @param {string} property */
  unregister_for_session(property) {
    if (this.sessionPersistence) this.sessionPersistence.unregister(property);
    this.sessionRegisteredPropKeys_ = this.sessionRegisteredPropKeys_.filter(function(k) {
      return k !== property;
    });
    this.persistSessionRegisteredPropKeys_();
  }

  /** @private */
  clearSessionRegisteredProps_() {
    const self = this;
    this.sessionRegisteredPropKeys_.forEach(function(k) {
      if (self.sessionPersistence) self.sessionPersistence.unregister(k);
    });
    this.sessionRegisteredPropKeys_ = [];
    this.persistSessionRegisteredPropKeys_();
  }

  /** @private */
  persistSessionRegisteredPropKeys_() {
    if (!this.sessionRegisteredPropertiesStorageKey_) return;
    if (this.config['persistence'] === 'memory' || (this.sessionPersistence && this.sessionPersistence.disabled) ||
        !sessionStore.isSupported()) {
      sessionStore.remove(this.sessionRegisteredPropertiesStorageKey_);
      return;
    }
    if (this.sessionRegisteredPropKeys_.length > 0) {
      sessionStore.set(this.sessionRegisteredPropertiesStorageKey_, this.sessionRegisteredPropKeys_.slice());
    } else {
      sessionStore.remove(this.sessionRegisteredPropertiesStorageKey_);
    }
  }

  /**
   * @param {string} property
   * @return {*}
   */
  get_property(property) {
    return this.persistence ? this.persistence.props[property] : undefined;
  }

  /**
   * @param {string} property
   * @return {*}
   */
  getSessionProperty(property) {
    return this.sessionPersistence ? this.sessionPersistence.props[property] : undefined;
  }

  // ---------------------------------------------------------------------------
  // Feature-flag facade (implemented by the optional `featureFlags` module)

  /**
   * @param {string} key
   * @param {?Object=} options {'send_event', 'fresh'}
   * @return {boolean|string|undefined}
   */
  getFeatureFlag(key, options) {
    const f = this.flags_();
    return f ? f.getFeatureFlag(key, options) : undefined;
  }

  /**
   * @param {string} key
   * @return {*}
   */
  getFeatureFlagPayload(key) {
    const f = this.flags_();
    return f ? f.getFeatureFlagPayload(key) : undefined;
  }

  /**
   * @param {string} key
   * @param {?Object=} options
   * @return {?Object|undefined}
   */
  getFeatureFlagResult(key, options) {
    const f = this.flags_();
    return f ? f.getFeatureFlagResult(key, options) : undefined;
  }

  /** @return {!Array<!Object>} */
  getAllFeatureFlags() {
    const f = this.flags_();
    return f ? f.getAllFeatureFlags() : [];
  }

  /**
   * @param {string} key
   * @param {?Object=} options {'send_event', 'fresh', 'defaultValue'}
   * @return {boolean|undefined}
   */
  isFeatureEnabled(key, options) {
    const f = this.flags_();
    const v = f ? f.isFeatureEnabled(key, options) : undefined;
    return isNullish(v) ? (options ? options['defaultValue'] : undefined) : v;
  }

  reloadFeatureFlags() {
    const f = this.flags_();
    if (f) f.reloadFeatureFlags();
  }

  /**
   * @param {!Object} flags
   * @param {?Object=} payloads
   * @param {?Object=} options
   */
  updateFlags(flags, payloads, options) {
    const f = this.flags_();
    if (f) f.updateFlags(flags, payloads, options);
  }

  /**
   * @param {string} key
   * @param {boolean} isEnrolled
   * @param {string=} stage
   */
  updateEarlyAccessFeatureEnrollment(key, isEnrolled, stage) {
    const f = this.flags_();
    if (f) f.updateEarlyAccessFeatureEnrollment(key, isEnrolled, stage);
  }

  /**
   * @param {function(!Array<!Object>)} callback
   * @param {boolean=} forceReload
   * @param {!Array<string>=} stages
   */
  getEarlyAccessFeatures(callback, forceReload, stages) {
    const f = this.flags_();
    if (f) f.getEarlyAccessFeatures(callback, forceReload, stages);
  }

  /**
   * @param {function(!Array<string>, !Object<string, (string|boolean)>, ?Object=)} callback
   * @return {function()}
   */
  onFeatureFlags(callback) {
    const f = this.flags_();
    if (!f) {
      callback([], {}, {'errorsLoading': true});
      return function() {};
    }
    return f.onFeatureFlags(callback);
  }

  /** @return {boolean} */
  flagsEndpointWasHit() {
    const f = this.flags_();
    return f ? f.checkHasLoadedFlags() : false;
  }

  /**
   * @param {function(string, string, (!Object|undefined))} callback
   * @return {function()}
   */
  onSessionId(callback) {
    return this.sessionManager ? this.sessionManager.onSessionId(callback) : function() {};
  }

  // ---------------------------------------------------------------------------
  // Identity

  /**
   * @param {*} id
   * @return {boolean}
   * @private
   */
  validateIdentifyId_(id) {
    if (!id || isEmptyString(id)) {
      logger.critical('Unique user id has not been set in posthog.identify');
      return false;
    }
    if (id === COOKIELESS_SENTINEL_VALUE) {
      logger.critical('The string "' + id + '" was set in posthog.identify which indicates an error. This ID is ' +
          'only used as a sentinel value.');
      return false;
    }
    const lower = String(id).toLowerCase();
    if (['distinct_id', 'distinctid', 'undefined', 'null'].indexOf(lower) !== -1) {
      logger.critical('The string "' + id + '" was set in posthog.identify which indicates an error. This ID should ' +
          'be unique to the user and not a hardcoded string.');
      return false;
    }
    return true;
  }

  /**
   * @param {string} newDistinctId
   * @param {?Object=} userPropertiesToSet
   * @param {?Object=} userPropertiesToSetOnce
   */
  identify(newDistinctId, userPropertiesToSet, userPropertiesToSetOnce) {
    try {
      this.identify_(newDistinctId, userPropertiesToSet, userPropertiesToSetOnce);
    } catch (e) {
      logger.critical('Implementation error. Please turn on debug mode and open a ticket on ' +
          'https://app.posthog.com/home#panel=support%3Asupport%3A.');
      logger.critical(e);
    }
  }

  /**
   * @param {*} newDistinctId
   * @param {?Object=} toSet
   * @param {?Object=} toSetOnce
   * @private
   */
  identify_(newDistinctId, toSet, toSetOnce) {
    if (!this.loaded || !this.persistence) {
      logger.uninitializedWarning('posthog.identify');
      return;
    }
    if (isNumber(newDistinctId)) {
      newDistinctId = String(newDistinctId);
      logger.warn('The first argument to posthog.identify was a number, but it should be a string. It has been ' +
          'converted to a string.');
    }
    if (!this.validateIdentifyId_(newDistinctId)) return;
    if (!this.requirePersonProcessing_('posthog.identify')) return;
    this.syncCookielessIdentity_();
    const id = /** @type {string} */ (newDistinctId);

    const previousId = this.get_distinct_id();
    this.register({'$user_id': id});
    if (!this.get_property(DEVICE_ID)) {
      this.register_once({'$had_persisted_distinct_id': true, [DEVICE_ID]: previousId}, '');
    }
    if (id !== previousId && id !== this.get_property(ALIAS_ID_KEY)) {
      this.unregister(ALIAS_ID_KEY);
      this.register({[DISTINCT_ID]: id});
    }
    const isKnownAnonymous = (this.persistence.get_property(USER_STATE) || USER_STATE_ANONYMOUS) === USER_STATE_ANONYMOUS;
    const identityDidChange = id !== previousId;
    const shouldTransition = !identityDidChange && isKnownAnonymous;
    const flags = this.flags_();

    if (identityDidChange && isKnownAnonymous) {
      const identifyProperties = this.config['reuseAnonymousId'] ? {'distinct_id': id} :
          {'distinct_id': id, '$anon_distinct_id': previousId};
      this.persistence.set_property(USER_STATE, USER_STATE_IDENTIFIED);
      this.setPersonPropertiesForFlags({'$set': toSet || {}, '$set_once': toSetOnce || {}}, false);
      if (this.capture(EVENT_IDENTIFY, identifyProperties, {'$set': toSet || {}, '$set_once': toSetOnce || {}})) {
        this.cachedPersonProperties_ = getPersonPropertiesHash(id, toSet, toSetOnce);
      }
      if (flags) flags.setAnonymousDistinctId(this.config['reuseAnonymousId'] ? undefined : previousId);
    } else if (shouldTransition) {
      this.persistence.set_property(USER_STATE, USER_STATE_IDENTIFIED);
      const s = toSet || {};
      const so = toSetOnce || {};
      this.setPersonPropertiesForFlags({'$set': s, '$set_once': so}, false);
      if (this.capture('$set', {'$set': s, '$set_once': so})) {
        this.cachedPersonProperties_ = getPersonPropertiesHash(id, toSet, toSetOnce);
      }
    } else if (toSet || toSetOnce) {
      this.setPersonProperties(toSet, toSetOnce);
    }

    if (identityDidChange) {
      this.reloadFeatureFlags();
      if (flags) flags.resetFlagCallReported();
      else this.unregister(FLAG_CALL_REPORTED);
    } else if (shouldTransition && (toSet || toSetOnce)) {
      this.reloadFeatureFlags();
    }
  }

  /**
   * @param {?Object=} toSet
   * @param {?Object=} toSetOnce
   */
  setPersonProperties(toSet, toSetOnce) {
    if (!toSet && !toSetOnce) return;
    if (!this.requirePersonProcessing_('posthog.setPersonProperties')) return;
    const hash = getPersonPropertiesHash(this.get_distinct_id(), toSet, toSetOnce);
    if (this.cachedPersonProperties_ === hash) {
      logger.info('A duplicate setPersonProperties call was made with the same properties. It has been ignored.');
      return;
    }
    this.setPersonPropertiesForFlags({'$set': toSet || {}, '$set_once': toSetOnce || {}}, true);
    if (this.capture('$set', {'$set': toSet || {}, '$set_once': toSetOnce || {}})) this.cachedPersonProperties_ = hash;
  }

  /** @param {(string|!Array<string>)} propertyNames */
  unsetPersonProperties(propertyNames) {
    const names = (isArray(propertyNames) ? /** @type {!Array<string>} */ (propertyNames) : [propertyNames])
        .filter(function(n) {
          return isString(n) && n.length > 0;
        });
    if (names.length === 0) return;
    if (!this.requirePersonProcessing_('posthog.unsetPersonProperties')) return;
    const f = this.flags_();
    if (f) f.unsetPersonPropertiesForFlags(names, true);
    this.capture('$set', {'$unset': names});
    this.cachedPersonProperties_ = null;
  }

  /**
   * @param {string} groupType
   * @param {string} groupKey
   * @param {?Object=} groupPropertiesToSet
   */
  group(groupType, groupKey, groupPropertiesToSet) {
    if (!groupType || !groupKey) {
      logger.error('posthog.group requires a group type and group key');
      return;
    }
    const existing = this.getGroups();
    const isNewGroup = existing[groupType] !== groupKey;
    if (isNewGroup) this.resetGroupPropertiesForFlags(groupType);
    this.register({'$groups': extend({}, existing, {[groupType]: groupKey})});
    if ((isNewGroup || groupPropertiesToSet) && this.hasPersonProcessing_()) {
      const props = {'$group_type': groupType, '$group_key': groupKey};
      if (groupPropertiesToSet) props['$group_set'] = groupPropertiesToSet;
      this.capture(EVENT_GROUPIDENTIFY, props);
    }
    if (groupPropertiesToSet) this.setGroupPropertiesForFlags({[groupType]: groupPropertiesToSet});
    if (isNewGroup && !groupPropertiesToSet) this.reloadFeatureFlags();
  }

  resetGroups() {
    this.register({'$groups': {}});
    this.resetGroupPropertiesForFlags();
    this.reloadFeatureFlags();
  }

  /**
   * @param {!Object} properties
   * @param {boolean=} reloadFeatureFlags default true
   */
  setPersonPropertiesForFlags(properties, reloadFeatureFlags) {
    const f = this.flags_();
    if (f) f.setPersonPropertiesForFlags(properties, reloadFeatureFlags !== false);
  }

  /** @param {boolean=} reloadFeatureFlags default true */
  resetPersonPropertiesForFlags(reloadFeatureFlags) {
    const f = this.flags_();
    if (f) f.resetPersonPropertiesForFlags(reloadFeatureFlags !== false);
  }

  /**
   * @param {!Object} properties keyed by group type
   * @param {boolean=} reloadFeatureFlags default true
   */
  setGroupPropertiesForFlags(properties, reloadFeatureFlags) {
    if (!this.requirePersonProcessing_('posthog.setGroupPropertiesForFlags')) return;
    const f = this.flags_();
    if (f) f.setGroupPropertiesForFlags(properties, reloadFeatureFlags !== false);
  }

  /** @param {string=} groupType */
  resetGroupPropertiesForFlags(groupType) {
    const f = this.flags_();
    if (f) f.resetGroupPropertiesForFlags(groupType);
  }

  /**
   * Clears identity and super properties (call on logout).
   * @param {(boolean|?Object)=} options resetDeviceID boolean, or {'resetDeviceID', 'bootstrap'}
   */
  reset(options) {
    const resetDeviceId = isBoolean(options) ? /** @type {boolean} */ (options) :
        (options ? options['resetDeviceID'] : undefined);
    const bootstrap = isBoolean(options) ? undefined : (options ? options['bootstrap'] : undefined);
    this.reset_(resetDeviceId, false, bootstrap);
  }

  /**
   * @param {boolean|undefined} resetDeviceId
   * @param {boolean} isConsentTransition
   * @param {?Object|undefined} bootstrap
   * @private
   */
  reset_(resetDeviceId, isConsentTransition, bootstrap) {
    logger.info('reset');
    if (!this.loaded) {
      logger.uninitializedWarning('posthog.reset');
      return;
    }
    const bootstrapSessionID = bootstrap ? bootstrap['sessionID'] : undefined;
    this.config['bootstrap'] = bootstrap || (this.originalUserConfig_ ? this.originalUserConfig_['bootstrap'] : undefined) || {};
    const flags = this.flags_();
    if (flags) flags.updateConfig(this.config, this.shouldDisableFlags_());

    const deviceId = this.get_property(DEVICE_ID);
    const deviceModel = this.get_property(DEVICE_MODEL);
    const recordingRemoteConfig = this.get_property(SESSION_RECORDING_REMOTE_CONFIG);
    // must run while the pre-reset distinct_id and consent state still apply
    const recording = this.sessionRecording_();
    if (recording) recording.flushBeforeIdentityReset();
    const wasCapturing = this.is_capturing();
    if (!isConsentTransition) this.consent.reset();
    if (!isConsentTransition && wasCapturing && !this.is_capturing() && win && win.console) {
      win.console.warn('[PostHog.js]', RESET_CONSENT_WARN);
    }

    const wasConsentTransition = this.isConsentTransition_;
    this.isConsentTransition_ = wasConsentTransition || isConsentTransition;
    const self = this;
    try {
      if (this.persistence) this.persistence.clear();
      if (this.sessionPersistence) this.sessionPersistence.clear();
      this.sessionRegisteredPropKeys_ = [];
      this.persistSessionRegisteredPropKeys_();
      if (!isUndefined(recordingRemoteConfig) && this.persistence) {
        this.persistence.register({[SESSION_RECORDING_REMOTE_CONFIG]: recordingRemoteConfig});
      }
      if (flags) flags.reset();
      this.extensionOrder_.forEach(function(name) {
        const ext = self.extensions[name];
        if (name !== 'featureFlags' && ext && ext.onReset) {
          try {
            ext.onReset();
          } catch (e) {
            logger.error('extension ' + name + ' onReset failed', e);
          }
        }
      });
      if (this.persistence) this.persistence.set_property(USER_STATE, USER_STATE_ANONYMOUS);
      if (this.sessionManager) this.sessionManager.resetSessionId();
      this.cachedPersonProperties_ = null;
      if (this.config['cookieless_mode'] === 'always') {
        this.register_once({[DISTINCT_ID]: COOKIELESS_SENTINEL_VALUE, [DEVICE_ID]: null}, '');
      } else {
        const uuid = this.config['get_device_id'](uuidv7());
        this.register_once({[DISTINCT_ID]: uuid, [DEVICE_ID]: resetDeviceId ? uuid : deviceId}, '');
        if (!resetDeviceId && !isUndefined(deviceModel)) this.register({[DEVICE_MODEL]: deviceModel});
      }
      this.register({'$last_posthog_reset': new Date().toISOString()}, 1);
      if (bootstrap) {
        if (bootstrap['distinctID'] && !this.inCookielessMode_()) {
          if (this.persistence) {
            this.persistence.set_property(USER_STATE, bootstrap['isIdentifiedID'] ? USER_STATE_IDENTIFIED : USER_STATE_ANONYMOUS);
          }
          this.register({[DISTINCT_ID]: bootstrap['distinctID']});
        }
        if (flags) flags.initialize();
        if (!isNullish(bootstrapSessionID) &&
            !(this.sessionManager && this.sessionManager.setBootstrapSessionId(bootstrapSessionID, true))) {
          const copy = assign(bootstrap);
          delete copy['sessionID'];
          this.config['bootstrap'] = copy;
        }
      }
      delete this.config['identity_distinct_id'];
      delete this.config['identity_hash'];
      delete this.config['identity_claims'];
    } finally {
      this.isConsentTransition_ = wasConsentTransition;
    }
    this.reloadFeatureFlags();
  }

  /** @return {string} */
  get_distinct_id() {
    return /** @type {string} */ (this.get_property('distinct_id'));
  }

  /** @return {!Object<string, string>} */
  getGroups() {
    return /** @type {!Object<string, string>} */ (this.get_property('$groups') || {});
  }

  /** @return {string} */
  get_session_id() {
    return this.sessionManager ? this.sessionManager.checkAndGetSessionAndWindowId(true).sessionId : '';
  }

  /**
   * Turns session recording on (sets `disable_session_recording: false`).
   * `override` (true, or {'sampling', 'linked_flag', 'url_trigger',
   * 'event_trigger'}) skips those conditions for the next recording.
   * @param {(boolean|?Object)=} override
   */
  startSessionRecording(override) {
    const overrideAll = override === true;
    const o = isObject(override) ? override : {};
    const sampling = overrideAll || !!o['sampling'];
    const linkedFlag = overrideAll || !!o['linked_flag'];
    const urlTrigger = overrideAll || !!o['url_trigger'];
    const eventTrigger = overrideAll || !!o['event_trigger'];
    if (sampling || linkedFlag || urlTrigger || eventTrigger) {
      if (this.sessionManager) this.sessionManager.checkAndGetSessionAndWindowId();
      if (sampling) {
        const r = this.sessionRecording_();
        if (r) r.overrideSampling();
      }
      if (linkedFlag) {
        const r = this.sessionRecording_();
        if (r) r.overrideLinkedFlag();
      }
      if (urlTrigger) {
        const r = this.sessionRecording_();
        if (r) r.overrideTrigger('url');
      }
      if (eventTrigger) {
        const r = this.sessionRecording_();
        if (r) r.overrideTrigger('event');
      }
    }
    this.set_config({'disable_session_recording': false});
  }

  /** Turns session recording off (sets `disable_session_recording: true`). */
  stopSessionRecording() {
    this.set_config({'disable_session_recording': true});
  }

  /** @return {boolean} whether session recording is currently running */
  sessionRecordingStarted() {
    const r = this.sessionRecording_();
    return !!r && r.isStarted();
  }

  /**
   * @param {?Object=} options {'withTimestamp', 'timestampLookBack'}
   * @return {string}
   */
  get_session_replay_url(options) {
    if (!this.sessionManager) return '';
    const s = this.sessionManager.checkAndGetSessionAndWindowId(true);
    let url = this.requestRouter.endpointFor('ui', '/project/' + this.config['token'] + '/replay/' + s.sessionId);
    if (options && options['withTimestamp'] && s.sessionStartTimestamp) {
      const lookBack = isNullish(options['timestampLookBack']) ? 10 : options['timestampLookBack'];
      url += '?t=' + Math.max(Math.floor((new Date().getTime() - s.sessionStartTimestamp) / 1000) - lookBack, 0);
    }
    return url;
  }

  /**
   * @param {string} alias
   * @param {string=} original
   * @return {?}
   */
  alias(alias, original) {
    if (alias === this.get_property(PEOPLE_DISTINCT_ID_KEY)) {
      logger.critical('Attempting to create alias for existing People user - aborting.');
      return -2;
    }
    if (!this.requirePersonProcessing_('posthog.alias')) return undefined;
    const orig = isUndefined(original) ? this.get_distinct_id() : original;
    if (alias !== orig) {
      this.register({[ALIAS_ID_KEY]: alias});
      return this.capture('$create_alias', {'alias': alias, 'distinct_id': orig});
    }
    logger.warn('alias matches current distinct_id - skipping api call.');
    this.identify(alias);
    return -1;
  }

  /**
   * @param {string} distinctId
   * @param {string} hash
   */
  setIdentity(distinctId, hash) {
    delete this.config['identity_claims'];
    this.config['identity_distinct_id'] = distinctId;
    this.config['identity_hash'] = hash;
    this.alias(distinctId);
  }

  clearIdentity() {
    delete this.config['identity_distinct_id'];
    delete this.config['identity_hash'];
    delete this.config['identity_claims'];
  }

  /** @param {!Object} config */
  set_config(config) {
    const oldConfig = assign(this.config);
    if (!isObject(config)) return;
    extend(this.config, configRenames(config));
    const disabled = this.isPersistenceDisabled_();
    if (this.persistence) {
      const shares = this.config['persistence'] === 'sessionStorage' || this.config['persistence'] === 'memory';
      if (shares && this.sessionPersistence !== this.persistence && this.sessionPersistence) {
        this.sessionPersistence.remove();
      }
      this.persistence.update_config(this.config, oldConfig, disabled);
      if (shares) {
        this.sessionPersistence = this.persistence;
      } else if (this.sessionPersistence === this.persistence) {
        this.sessionPersistence = new Persistence(
            /** @type {!Object} */ (extend({}, this.config, {'persistence': 'sessionStorage'})), disabled);
      } else if (this.sessionPersistence) {
        this.sessionPersistence.update_config(
            /** @type {!Object} */ (extend({}, this.config, {'persistence': 'sessionStorage'})),
            /** @type {!Object} */ (extend({}, oldConfig, {'persistence': 'sessionStorage'})), disabled);
      }
    }
    const fromStorage = this.checkLocalStorageForDebug_(this.config['debug']);
    if (isBoolean(fromStorage)) this.config['debug'] = fromStorage;
    if (isBoolean(this.config['debug'])) {
      if (this.config['debug']) {
        Config.DEBUG = true;
        if (localStore.isSupported()) localStore.set('ph_debug', true);
        logger.info('set_config', {'config': config, 'oldConfig': oldConfig, 'newConfig': assign(this.config)});
      } else {
        Config.DEBUG = false;
        if (localStore.isSupported()) localStore.remove('ph_debug');
      }
    }
    const flags = this.flags_();
    if (flags) flags.updateConfig(this.config, this.shouldDisableFlags_());
    const self = this;
    this.extensionOrder_.forEach(function(name) {
      const ext = self.extensions[name];
      if (ext && ext.onConfigChange) {
        try {
          ext.onConfigChange(config);
        } catch (e) {
          logger.error('extension ' + name + ' onConfigChange failed', e);
        }
      }
    });
    // Upstream calls sessionRecording.startIfEnabledOrStop() between the
    // exceptions and autocapture/heatmaps config hooks; none of these emit
    // traffic synchronously, so calling it after the extension loop is equivalent.
    const recording = this.sessionRecording_();
    if (recording) recording.startIfEnabledOrStop();
    if (this.historyAutocapture && ('capture_pageview' in config || 'disable_capture_url_hashes' in config)) {
      this.historyAutocapture.startIfEnabledOrStop();
    }
    this.syncOptOutWithPersistence_();
  }

  // ---------------------------------------------------------------------------
  // Person processing

  /** @return {string} */
  toString() {
    let name = isNullish(this.config['name']) ? PRIMARY_INSTANCE_NAME : this.config['name'];
    if (name !== PRIMARY_INSTANCE_NAME) name = PRIMARY_INSTANCE_NAME + '.' + name;
    return name;
  }

  /** @return {boolean} @private */
  isIdentified_() {
    return (this.persistence ? this.persistence.get_property(USER_STATE) : undefined) === USER_STATE_IDENTIFIED ||
        (this.sessionPersistence ? this.sessionPersistence.get_property(USER_STATE) : undefined) === USER_STATE_IDENTIFIED;
  }

  /** @return {boolean} @private */
  hasPersonProcessing_() {
    const props = this.persistence ? this.persistence.props : {};
    return !(this.config['person_profiles'] === 'never' ||
        (this.config['person_profiles'] === PERSON_PROFILES_IDENTIFIED_ONLY && !this.isIdentified_() &&
         isEmptyObject(this.getGroups()) && !props[ALIAS_ID_KEY] && !props[ENABLE_PERSON_PROCESSING]));
  }

  /** @return {boolean} @private */
  shouldCapturePageleave_() {
    return this.config['capture_pageleave'] === true ||
        (this.config['capture_pageleave'] === 'if_capture_pageview' && !!this.config['capture_pageview']);
  }

  createPersonProfile() {
    if (this.hasPersonProcessing_()) return;
    if (!this.requirePersonProcessing_('posthog.createPersonProfile')) return;
    this.setPersonProperties({}, {});
  }

  setInternalOrTestUser() {
    if (!this.requirePersonProcessing_('posthog.setInternalOrTestUser')) return;
    this.setPersonProperties({'$internal_or_test_user': true});
  }

  /**
   * @param {string} functionName
   * @return {boolean}
   * @private
   */
  requirePersonProcessing_(functionName) {
    if (this.config['person_profiles'] === 'never') {
      logger.error(functionName + ' was called, but process_person is set to "never". This call will be ignored.');
      return false;
    }
    this.warnIfVolatileIdentityWithoutStableId_();
    this.register({[ENABLE_PERSON_PROCESSING]: true});
    return true;
  }

  // ---------------------------------------------------------------------------
  // Consent

  /** @return {boolean} @private */
  isPersistenceDisabled_() {
    if (this.config['cookieless_mode'] === 'always') return true;
    const optedOut = this.consent.isOptedOut();
    const defaultDisabled = this.config['opt_out_persistence_by_default'] || this.config['cookieless_mode'] === 'on_reject';
    return !!this.config['disable_persistence'] || (optedOut && !!defaultDisabled);
  }

  /** @return {boolean} @private */
  syncOptOutWithPersistence_() {
    const disabled = this.isPersistenceDisabled_();
    // Release what console log capture holds as soon as capturing is off.
    const logs = /** @type {?LogsApi} */ (this.extensions['logs'] || null);
    if (logs && !this.is_capturing()) logs.onOptOut();
    if (this.persistence && this.persistence.disabled !== disabled) this.persistence.set_disabled(disabled);
    if (this.sessionPersistence && this.sessionPersistence.disabled !== disabled) this.sessionPersistence.set_disabled(disabled);
    this.persistSessionRegisteredPropKeys_();
    return disabled;
  }

  /**
   * @param {?Object=} options {'captureEventName', 'captureProperties'}
   */
  opt_in_capturing(options) {
    if (this.config['cookieless_mode'] === 'always') {
      logger.warn(CONSENT_COOKIELESS_WARN);
      return;
    }
    if (this.inCookielessMode_()) {
      const oldRecording = this.sessionRecording_();
      if (oldRecording) oldRecording.disposeRecording(true);
      this.reset_(true, true, undefined);
      if (this.sessionManager) this.sessionManager.destroy();
      this.pageViewManager.destroy();
      if (this.persistence) {
        this.sessionManager = new SessionManager(this.config, this.persistence);
        this.sessionPropsManager = new SessionPropsManager(this.config, this.sessionManager, this.persistence);
      }
      const self = this;
      this.pageViewManager = new PageViewManager(function() {
        return self.config;
      }, this.scrollManager, this.sessionManager);
      const recordingFactory = findExtensionFactory('sessionRecording');
      if (recordingFactory && this.extensionsReady_) {
        this.detachExtension_('sessionRecording');
        this.attachExtension('sessionRecording', recordingFactory);
      }
    }
    const wasAlreadyGranted = this.consent.consent() === ConsentStatus.GRANTED;
    if (wasAlreadyGranted) this.syncCookielessIdentity_();
    this.consent.optInOut(true);
    this.syncOptOutWithPersistence_();
    this.startQueueIfOptedIn_();
    const recording = this.sessionRecording_();
    if (recording) recording.startIfEnabledOrStop();

    const name = options ? options['captureEventName'] : undefined;
    if (!wasAlreadyGranted && (isUndefined(name) || name)) {
      this.capture(isNullish(name) ? '$opt_in' : name, options ? options['captureProperties'] : undefined,
          {'send_instantly': true});
    }
    const flags = this.flags_();
    if (flags) flags.sendFlagCallsPendingCapture();
    if (this.config['capture_pageview']) this.captureInitialPageview_();
  }

  opt_out_capturing() {
    if (this.config['cookieless_mode'] === 'always') {
      logger.warn(CONSENT_COOKIELESS_WARN);
      return;
    }
    this.consent.optInOut(false);
    this.syncOptOutWithPersistence_();
    if (this.config['cookieless_mode'] === 'on_reject') this.enterCookielessMode_();
  }

  /** @private */
  enterCookielessMode_() {
    const recording = this.sessionRecording_();
    if (recording) recording.disposeRecording(true);
    if (this.get_distinct_id() !== COOKIELESS_SENTINEL_VALUE) this.reset_(true, true, undefined);
    this.register({[DISTINCT_ID]: COOKIELESS_SENTINEL_VALUE, [DEVICE_ID]: null});
    this.detachExtension_('sessionRecording');
    if (this.sessionManager) this.sessionManager.destroy();
    this.pageViewManager.destroy();
    this.sessionManager = null;
    this.sessionPropsManager = null;
    if (this.config['capture_pageview']) this.captureInitialPageview_();
    this.startQueueIfOptedIn_();
  }

  /** @return {boolean} */
  has_opted_in_capturing() {
    return this.consent.isOptedIn();
  }

  /** @return {boolean} */
  has_opted_out_capturing() {
    return this.consent.isOptedOut();
  }

  /** @return {string} 'granted' | 'denied' | 'pending' */
  get_explicit_consent_status() {
    const c = this.consent.consent();
    return c === ConsentStatus.GRANTED ? 'granted' : c === ConsentStatus.DENIED ? 'denied' : 'pending';
  }

  /** @return {boolean} */
  is_capturing() {
    if (this.isConsentTransition_) return false;
    if (this.config['cookieless_mode'] === 'always') return true;
    if (this.config['cookieless_mode'] === 'on_reject') return this.consent.isRejected() || this.consent.isOptedIn();
    return !this.has_opted_out_capturing();
  }

  clear_opt_in_out_capturing() {
    this.consent.reset();
    this.syncOptOutWithPersistence_();
  }

  /** @return {boolean} @private */
  isBot_() {
    return nav ? isLikelyBot(nav, this.config['custom_blocked_useragents']) : false;
  }

  /** @private */
  captureInitialPageview_() {
    if (!doc) return;
    if (doc.visibilityState !== 'visible') {
      if (!this.visibilityStateListener_) {
        const self = this;
        this.visibilityStateListener_ = function() {
          self.captureInitialPageview_();
        };
        addEventListener(doc, 'visibilitychange', this.visibilityStateListener_);
      }
      return;
    }
    if (!this.initialPageviewCaptured_) {
      this.initialPageviewCaptured_ = true;
      this.capture(EVENT_PAGEVIEW, {'title': doc.title}, {'send_instantly': true});
      if (this.visibilityStateListener_) {
        doc.removeEventListener('visibilitychange', this.visibilityStateListener_);
        this.visibilityStateListener_ = null;
      }
    }
  }

  /** @param {boolean=} debug */
  debug(debug) {
    if (debug === false) {
      if (win) win.console.log("You've disabled debug mode.");
      this.set_config({'debug': false});
    } else {
      if (win) {
        win.console.log("You're now in debug mode. All calls to PostHog will be logged in your console.\nYou can " +
            'disable this with `posthog.debug(false)`.');
      }
      this.set_config({'debug': true});
    }
  }

  /** @return {boolean} @private */
  shouldDisableFlags_() {
    const orig = this.originalUserConfig_ || {};
    if ('advanced_disable_flags' in orig) return !!orig['advanced_disable_flags'];
    if (this.config['advanced_disable_flags'] !== false) return !!this.config['advanced_disable_flags'];
    if (this.config['advanced_disable_decide'] === true) {
      logger.warn("Config field 'advanced_disable_decide' is deprecated. Please use 'advanced_disable_flags' instead. " +
          'The old field will be removed in a future major version.');
      return true;
    }
    if ('advanced_disable_flags' in orig && !isNullish(orig['advanced_disable_flags'])) return orig['advanced_disable_flags'];
    if ('advanced_disable_decide' in orig && !isNullish(orig['advanced_disable_decide'])) {
      logger.warn("Config field 'advanced_disable_decide' is deprecated. Please use 'advanced_disable_flags' instead. " +
          'The old field will be removed in a future major version.');
      return !!orig['advanced_disable_decide'];
    }
    return false;
  }

  /** @return {boolean} whether remote flag requests are disabled (advanced_disable_flags/decide) */
  shouldDisableFlags() {
    return this.shouldDisableFlags_();
  }

  /**
   * @param {!Object} data
   * @return {?Object}
   * @private
   */
  runBeforeSend_(data) {
    const beforeSend = this.config['before_send'];
    if (isNullish(beforeSend)) return data;
    const required = keys(data['properties'] || {}).filter(function(k) {
      return k === 'token';
    });
    const fns = isArray(beforeSend) ? beforeSend : [beforeSend];
    let result = data;
    for (let i = 0; i < fns.length; i++) {
      try {
        result = fns[i](result);
        if (isNullish(result)) {
          const msg = "Event '" + data['event'] + "' was rejected in beforeSend function";
          if (KNOWN_UNSAFE_EDITABLE_EVENTS.indexOf(data['event']) !== -1) logger.warn(msg + '. This can cause unexpected behavior.');
          else logger.info(msg);
          return null;
        }
        if (!result['properties'] || isEmptyObject(result['properties'])) {
          logger.warn("Event '" + data['event'] + "' has no properties after beforeSend function, this is likely an error.");
        }
      } catch (e) {
        logger.error("Error in beforeSend function for event '" + data['event'] + "':", e);
        return null;
      }
    }
    for (let i = 0; i < required.length; i++) {
      if (result['properties'] && isNullish(result['properties'][required[i]])) {
        logger.warn("Event '" + data['event'] + "' had its '" + required[i] + "' property removed in a beforeSend " +
            'function. This property is required for ingestion, so the event will be dropped.');
        return null;
      }
    }
    return result;
  }

  /** @return {string|undefined} */
  getPageViewId() {
    return this.pageViewManager.currentPageview ? this.pageViewManager.currentPageview.pageViewId : undefined;
  }

  /**
   * @param {(string|number)} traceId
   * @param {string} userFeedback
   */
  captureTraceFeedback(traceId, userFeedback) {
    this.capture('$ai_feedback', {'$ai_trace_id': String(traceId), '$ai_feedback_text': userFeedback});
  }

  /**
   * @param {(string|number)} traceId
   * @param {string} metricName
   * @param {(string|number|boolean)} metricValue
   */
  captureTraceMetric(traceId, metricName, metricValue) {
    this.capture('$ai_metric', {'$ai_trace_id': String(traceId), '$ai_metric_name': metricName,
      '$ai_metric_value': String(metricValue)});
  }

  // ---------------------------------------------------------------------------
  // Exceptions (upstream captureException / addExceptionStep / *ExceptionAutocapture).
  // The work lives in the optional exceptions module (src/exceptions); without
  // it these behave like upstream with the extension unavailable.

  /**
   * The exceptions module, attached on first use when it is registered but
   * this instance is not initialised yet: upstream constructs it in the
   * PostHog constructor, so steps added before init are kept.
   * @return {?ExceptionsApi}
   * @private
   */
  exceptions_() {
    if (!this.extensions['exceptions']) {
      const factory = findExtensionFactory('exceptions');
      if (factory) this.attachExtension('exceptions', factory);
    }
    const ext = this.extensions['exceptions'];
    return ext ? /** @type {!ExceptionsApi} */ (ext) : null;
  }

  /**
   * Captures an exception as a `$exception` event.
   * @param {*} error
   * @param {?Object=} additionalProperties
   * @return {!Object|undefined}
   */
  captureException(error, additionalProperties) {
    try {
      const exceptions = this.exceptions_();
      if (!exceptions) return undefined;
      const built = exceptions.buildProperties(error, {
        handled: true,
        syntheticException: new Error('PostHog syntheticException'),
      });
      const props = {};
      [built, additionalProperties].forEach(function(src) {
        if (src == null) return;
        for (const k in src) {
          if (hasOwn(src, k)) props[k] = src[k];
        }
      });
      return /** @type {!Object|undefined} */ (exceptions.sendExceptionEvent(props) || undefined);
    } catch (e) {
      // Never throw into customer code; don't log (console.error may be instrumented).
      return undefined;
    }
  }

  /**
   * Adds a breadcrumb attached to the next captured exception.
   * @param {*} message
   * @param {*=} properties
   */
  addExceptionStep(message, properties) {
    const exceptions = this.exceptions_();
    if (exceptions) exceptions.addExceptionStep(message, properties);
  }

  /** @param {*=} config `capture_exceptions` value (default true) */
  startExceptionAutocapture(config) {
    this.set_config({'capture_exceptions': config == null ? true : config});
  }

  stopExceptionAutocapture() {
    this.set_config({'capture_exceptions': false});
  }

  /**
   * @param {*} debugConfig
   * @return {*}
   * @private
   */
  checkLocalStorageForDebug_(debugConfig) {
    const explicitlyFalse = isBoolean(debugConfig) && !debugConfig;
    const trueInStorage = localStore.isSupported() && localStore.get('ph_debug') === 'true';
    return explicitlyFalse ? false : trueInStorage ? true : debugConfig;
  }

  /** @private */
  processIdentityChange_() {
    this.cachedPersonProperties_ = null;
    if (this.persistence && this.persistence.get_property(USER_STATE) === USER_STATE_ANONYMOUS) {
      if (this.sessionPersistence) this.sessionPersistence.clear();
      this.sessionRegisteredPropKeys_ = [];
      this.persistSessionRegisteredPropKeys_();
    }
    const flags = this.flags_();
    if (flags) flags.reset();
    this.reloadFeatureFlags();
  }

  /**
   * Endpoint URL for 'api' | 'assets' | 'ui' | 'flags' (see request-router.js).
   * @param {string} target
   * @param {string=} path
   * @return {string}
   */
  endpointFor(target, path) {
    return this.requestRouter.endpointFor(target, path);
  }

  /**
   * Sends a request through the SDK's transport stack (headers, compression,
   * quota limits). For extensions; `options` uses RequestOptions fields.
   * @param {!RequestOptions} options
   */
  sendRequest(options) {
    this.sendRequest_(options);
  }

  // ---- logs and toolbar (delegated to the optional `logs` / `toolbar` modules) ----

  /**
   * Sends a log record to the logs endpoint (upstream `captureLog`); a no-op
   * without the logs module.
   * @param {!Object} options {'body', 'level', 'attributes', 'trace_id', 'span_id', 'trace_flags'}
   */
  captureLog(options) {
    const logs = /** @type {?LogsApi} */ (this.extensions['logs'] || null);
    if (logs) logs.captureLog(options);
  }

  /**
   * `posthog.logger`: trace/debug/info/warn/error/fatal(body, attributes).
   * @return {!Object}
   */
  getLogger() {
    const logs = /** @type {?LogsApi} */ (this.extensions['logs'] || null);
    if (logs) return logs.getLogger();
    const noop = function() {};
    return {'trace': noop, 'debug': noop, 'info': noop, 'warn': noop, 'error': noop, 'fatal': noop};
  }

  /**
   * Loads the toolbar (upstream `loadToolbar`); false without the toolbar module.
   * @param {*} params
   * @return {boolean}
   */
  loadToolbar(params) {
    const toolbar = /** @type {?ToolbarApi} */ (this.extensions['toolbar'] || null);
    return toolbar ? toolbar.loadToolbar(params) : false;
  }
}

/** @const {string} */
PostHog.VERSION = LIB_VERSION;

/**
 * Upstream add_dom_loaded_handler.
 */
function addDomLoadedHandler() {
  let done = false;
  const handler = function() {
    if (done) return;
    done = true;
    enqueueRequests = false;
    for (const name in instances) instances[name].domLoaded();
  };
  if (doc && doc.addEventListener) {
    if (doc.readyState === 'complete') handler();
    else addEventListener(doc, 'DOMContentLoaded', handler, {capture: false, passive: undefined});
    return;
  }
  if (win) logger.error("Browser doesn't support `document.addEventListener` so PostHog couldn't be initialized");
}

/**
 * Upstream init_from_snippet: creates the global instance, replays the
 * snippet's queued init and method calls.
 * @return {!PostHog}
 */
export function initFromSnippet() {
  Config.SDK_DIST_CHANNEL = 'cdn';
  const snippet = win ? win['posthog'] : undefined;
  if (snippet && !isArray(snippet['_i']) && isFunction(snippet['init'])) return /** @type {!PostHog} */ (snippet);
  const main = instances[PRIMARY_INSTANCE_NAME] = new PostHog();
  if (snippet) {
    const processed = [];
    each(snippet['_i'], function(item) {
      if (item && isArray(item)) {
        const instance = main.init(item[0], item[1], item[2]);
        const instanceSnippet = snippet[item[2]] || snippet;
        if (instance.loaded && processed.indexOf(instanceSnippet) === -1) {
          processed.push(instanceSnippet);
          instance.executeArray.call(instance['people'], instanceSnippet['people']);
          instance.executeArray(instanceSnippet);
        }
      }
    });
    const peopleQueue = snippet['people'];
    if (!main.loaded && isArray(snippet)) {
      const init = main.init;
      let pending = true;
      main['init'] = main.init = function(token, config, name) {
        const instance = init.call(main, token, config, name);
        if (pending && instance === main && instance.loaded) {
          pending = false;
          main['init'] = main.init = init;
          instance.executeArray.call(instance['people'], peopleQueue);
          instance.executeArray(snippet);
        }
        return instance;
      };
    }
  }
  main['__SV'] = 1;
  if (win) win['posthog'] = main;
  addDomLoadedHandler();
  return main;
}

/**
 * Exposes the public API under stable (quoted) names on the prototype.
 * Written out explicitly so Closure can see each mapping.
 */
export function exportPublicApi() {
  const p = PostHog.prototype;
  p['init'] = p.init;
  p['capture'] = p.capture;
  p['calculateEventProperties'] = p.calculateEventProperties;
  p['identify'] = p.identify;
  p['alias'] = p.alias;
  p['setPersonProperties'] = p.setPersonProperties;
  p['unsetPersonProperties'] = p.unsetPersonProperties;
  p['group'] = p.group;
  p['getGroups'] = p.getGroups;
  p['resetGroups'] = p.resetGroups;
  p['reset'] = p.reset;
  p['register'] = p.register;
  p['register_once'] = p.register_once;
  p['register_for_session'] = p.register_for_session;
  p['unregister'] = p.unregister;
  p['unregister_for_session'] = p.unregister_for_session;
  p['get_property'] = p.get_property;
  p['getSessionProperty'] = p.getSessionProperty;
  p['get_distinct_id'] = p.get_distinct_id;
  p['get_session_id'] = p.get_session_id;
  p['get_session_replay_url'] = p.get_session_replay_url;
  p['startSessionRecording'] = p.startSessionRecording;
  p['stopSessionRecording'] = p.stopSessionRecording;
  p['sessionRecordingStarted'] = p.sessionRecordingStarted;
  p['onSessionId'] = p.onSessionId;
  p['set_config'] = p.set_config;
  p['debug'] = p.debug;
  p['on'] = p.on;
  p['push'] = p.push;
  p['createPersonProfile'] = p.createPersonProfile;
  p['setInternalOrTestUser'] = p.setInternalOrTestUser;
  p['setPersonPropertiesForFlags'] = p.setPersonPropertiesForFlags;
  p['resetPersonPropertiesForFlags'] = p.resetPersonPropertiesForFlags;
  p['setGroupPropertiesForFlags'] = p.setGroupPropertiesForFlags;
  p['resetGroupPropertiesForFlags'] = p.resetGroupPropertiesForFlags;
  p['setIdentity'] = p.setIdentity;
  p['clearIdentity'] = p.clearIdentity;
  p['opt_in_capturing'] = p.opt_in_capturing;
  p['opt_out_capturing'] = p.opt_out_capturing;
  p['has_opted_in_capturing'] = p.has_opted_in_capturing;
  p['has_opted_out_capturing'] = p.has_opted_out_capturing;
  p['get_explicit_consent_status'] = p.get_explicit_consent_status;
  p['clear_opt_in_out_capturing'] = p.clear_opt_in_out_capturing;
  p['is_capturing'] = p.is_capturing;
  p['getFeatureFlag'] = p.getFeatureFlag;
  p['getFeatureFlagPayload'] = p.getFeatureFlagPayload;
  p['getFeatureFlagResult'] = p.getFeatureFlagResult;
  p['getAllFeatureFlags'] = p.getAllFeatureFlags;
  p['isFeatureEnabled'] = p.isFeatureEnabled;
  p['reloadFeatureFlags'] = p.reloadFeatureFlags;
  p['updateFlags'] = p.updateFlags;
  p['onFeatureFlags'] = p.onFeatureFlags;
  p['getEarlyAccessFeatures'] = p.getEarlyAccessFeatures;
  p['updateEarlyAccessFeatureEnrollment'] = p.updateEarlyAccessFeatureEnrollment;
  p['getPageViewId'] = p.getPageViewId;
  p['captureTraceFeedback'] = p.captureTraceFeedback;
  p['captureTraceMetric'] = p.captureTraceMetric;
  p['captureException'] = p.captureException;
  p['addExceptionStep'] = p.addExceptionStep;
  p['startExceptionAutocapture'] = p.startExceptionAutocapture;
  p['stopExceptionAutocapture'] = p.stopExceptionAutocapture;
  p['endpointFor'] = p.endpointFor;
  p['toString'] = p.toString;
  Object.defineProperty(p, '__loaded', {get: /** @this {!PostHog} */ function() {
    return this.loaded;
  }});
  Object.defineProperty(p, 'flagsEndpointWasHit', {get: /** @this {!PostHog} */ function() {
    return this.flagsEndpointWasHit();
  }});
  Object.defineProperty(p, 'decideEndpointWasHit', {get: /** @this {!PostHog} */ function() {
    return this.flagsEndpointWasHit();
  }});
  const sm = ScrollManager.prototype;
  sm['scrollX'] = sm.scrollX;
  sm['scrollY'] = sm.scrollY;
  sm['scrollElement'] = sm.scrollElement;
  sm['getContext'] = sm.getContext;
  if (!hasOwn(new PostHog(), 'config')) {
    Object.defineProperty(p, 'config', {get: /** @this {!PostHog} */ function() {
      return this.config;
    }});
  }
  if (!hasOwn(new PostHog(), 'people')) {
    Object.defineProperty(p, 'people', {get: /** @this {!PostHog} */ function() {
      return this.people;
    }});
  }
  Object.defineProperty(p, 'version', {get: function() {
    return LIB_VERSION;
  }});
  p['captureLog'] = p.captureLog;
  p['loadToolbar'] = p.loadToolbar;
  Object.defineProperty(p, 'logger', {get: /** @this {!PostHog} */ function() {
    return this.getLogger();
  }});
}
