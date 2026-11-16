/**
 * @fileoverview PostHog core: init, capture, identity, super properties,
 * consent, sessions and pageviews. Optional modules (feature flags, web
 * experiments) attach through extensions.js and are reached via
 * `this.extensions[name]`; the core never imports them.
 */
import {Persistence} from './persistence.js';
import {SessionManager} from './session.js';
import {RequestQueue, RetryQueue, captureBody} from './request-queue.js';
import {request, RequestOptions, HttpResponse} from './request.js';
import {getEventProperties, isLikelyBot, documentTitle} from './event-props.js';
import {uuidv7} from './uuid.js';
import {logger} from './logger.js';
import {createStore, Store} from './storage.js';
import {Extension, FeatureFlagsApi, attachAllExtensions} from './extensions.js';
import {
  addEventListener, doc, extend, hasOwn, isArray, isEmptyObject, isFunction, isNullish, isObject,
  isString, isUndefined, nav, now, truncateStrings, userAgent, win,
} from './utils.js';
import {
  ALIAS_ID_KEY, DEVICE_ID, DISTINCT_ID, ENABLE_PERSON_PROCESSING, GROUPS_KEY, LIB_VERSION,
  OPT_IN_CONSENT_PREFIX, PEOPLE_DISTINCT_ID_KEY, STORED_GROUP_PROPERTIES_KEY,
  STORED_PERSON_PROPERTIES_KEY, USER_STATE,
} from './constants.js';

/**
 * Default config. Keys are quoted: they are part of the public API.
 * @return {!Object}
 */
export function defaultConfig() {
  const isHttps = !!win && win.location.protocol === 'https:';
  const host = win ? win.location.hostname : '';
  return {
    'api_host': 'https://us.i.posthog.com',
    'ui_host': null,
    'token': '',
    'capture_pageview': true, // true | false | 'history_change'
    'capture_pageleave': 'if_capture_pageview',
    'persistence': 'localStorage+cookie',
    'persistence_name': '',
    'cookie_expiration': 365,
    'cross_subdomain_cookie': !/herokuapp\.com$|vercel\.app$|netlify\.app$/.test(host),
    'secure_cookie': isHttps,
    'disable_persistence': false,
    'opt_out_capturing_by_default': false,
    'opt_out_persistence_by_default': false,
    'opt_out_capturing_persistence_type': 'localStorage',
    'opt_out_capturing_cookie_prefix': null,
    'respect_dnt': false,
    'property_denylist': [],
    'request_headers': {},
    'request_batching': true,
    'request_queue_config': {'flush_interval_ms': 3000},
    'properties_string_max_length': 65535,
    'session_idle_timeout_seconds': 30 * 60,
    'person_profiles': 'identified_only', // 'always' | 'identified_only' | 'never'
    'before_send': null,
    'loaded': null,
    'debug': false,
    'save_referrer': true,
    'save_campaign_params': true,
    'custom_campaign_params': [],
    'mask_personal_data_properties': false,
    'custom_personal_data_properties': [],
    'disable_capture_url_hashes': false,
    'opt_out_useragent_filter': false,
    'custom_blocked_useragents': [],
    'bootstrap': {},
    // Read by the feature flags module when it is loaded:
    'advanced_disable_flags': false,
    'advanced_disable_feature_flags': false,
    'advanced_disable_feature_flags_on_first_load': false,
    'feature_flag_request_timeout_ms': 3000,
    // Read by the web experiments module when it is loaded:
    'disable_web_experiments': false,
  };
}

/**
 * Normalises well-known PostHog app hosts to ingestion hosts.
 * @param {string} host
 * @return {string}
 */
function normalizeApiHost(host) {
  let h = String(host || '').replace(/\/+$/, '');
  h = h.replace(/^https:\/\/(us|app)\.posthog\.com$/i, 'https://us.i.posthog.com');
  h = h.replace(/^https:\/\/eu\.posthog\.com$/i, 'https://eu.i.posthog.com');
  return h;
}

/** Events that create/merge persons and bypass person_profiles gating. */
const PERSON_EVENTS = ['$identify', '$create_alias', '$groupidentify', '$set'];

/** @unrestricted Named instances and snippet replay use dynamic keys. */
export class PostHog {
  constructor() {
    /** @type {!Object} Public config, quoted keys. */
    this.config = defaultConfig();
    /** @type {boolean} */
    this.loaded = false;
    /** @type {?Persistence} */
    this.persistence = null;
    /** @type {?Persistence} Per-tab persistence for session-scoped super props. */
    this.sessionPersistence = null;
    /** @type {?SessionManager} */
    this.sessionManager = null;
    /** @type {?RequestQueue} */
    this.requestQueue = null;
    /** @type {!RetryQueue|null} */
    this.retryQueue = null;
    /** Attached optional modules, keyed by registration name. @type {!Object<string, !Extension>} */
    this.extensions = {};
    /** @type {string} */
    this.name = 'posthog';
    /** @private {!Object<string, !Array<function(...?)>>} */
    this.listeners_ = {};
    /** @private {?Store} */
    this.consentStore_ = null;
    /** @private {boolean} */
    this.initialPersonInfoSent_ = false;
    /** @private {?{id: string, pathname: string, ts: number}} */
    this.pageview_ = null;
    /** @private {string} */
    this.lastPathname_ = '';
    /** @private {boolean} */
    this.botWarned_ = false;
  }

  // ---------------------------------------------------------------------------
  // Init & config

  /**
   * @param {string} token Project API key.
   * @param {!Object=} config
   * @param {string=} name Creates a secondary named instance when given.
   * @return {!PostHog|undefined}
   */
  init(token, config, name) {
    if (name && name !== this.name) {
      const instance = new PostHog();
      instance.name = name;
      instance.init(token, config);
      this[name] = instance;
      return instance;
    }
    if (!token || !isString(token)) {
      logger.critical('PostHog was initialized without a token. This likely indicates a misconfiguration.');
      return undefined;
    }
    if (this.loaded) {
      logger.warn('You have already initialized PostHog! Re-initializing is a no-op');
      return this;
    }
    this.config = /** @type {!Object} */ (extend(defaultConfig(), config || {}, {'token': token}));
    this.config['api_host'] = normalizeApiHost(this.config['api_host']);
    logger.enabled = !!this.config['debug'];

    this.persistence = new Persistence(this.config);
    this.sessionPersistence = new Persistence(this.config, true);
    this.consentStore_ = createStore(this.config['opt_out_capturing_persistence_type'] === 'cookie' ? 'cookie' : 'localStorage');
    if (this.config['disable_persistence'] ||
        (this.config['opt_out_persistence_by_default'] && this.has_opted_out_capturing())) {
      this.persistence.setDisabled(true);
      this.sessionPersistence.setDisabled(true);
    }

    this.sessionManager = new SessionManager(this.config, this.persistence);
    this.retryQueue = new RetryQueue();
    const retry = this.retryQueue;
    const flushMs = (this.config['request_queue_config'] || {})['flush_interval_ms'];
    this.requestQueue = new RequestQueue(function(opts) {
      retry.send(opts);
    }, Number(flushMs) || 3000);

    this.bootstrapIdentity_();

    this.loaded = true;
    attachAllExtensions(this);

    const self = this;
    // Flush on unload. pagehide also fires on bfcache navigation.
    addEventListener(win, 'pagehide', function() {
      self.handleUnload_();
    });

    if (this.is_capturing()) this.requestQueue.start();
    this.setupPageviews_();

    const loaded = this.config['loaded'];
    if (isFunction(loaded)) {
      try {
        loaded(this);
      } catch (e) {
        logger.critical('`loaded` function failed', e);
      }
    }
    return this;
  }

  /** @private */
  bootstrapIdentity_() {
    const p = /** @type {!Persistence} */ (this.persistence);
    const bootstrap = this.config['bootstrap'] || {};
    const bootId = bootstrap['distinctID'];
    if (bootId) {
      const isIdentified = !!bootstrap['isIdentifiedID'];
      const current = p.get(DISTINCT_ID);
      if (!current || (isIdentified && p.get(USER_STATE) !== 'identified')) {
        p.register({
          [DISTINCT_ID]: bootId,
          [DEVICE_ID]: p.get(DEVICE_ID) || (isIdentified ? uuidv7() : bootId),
          [USER_STATE]: isIdentified ? 'identified' : 'anonymous',
        });
      }
    }
    if (!p.get(DISTINCT_ID)) {
      const id = uuidv7();
      p.register({[DISTINCT_ID]: id, [DEVICE_ID]: id, [USER_STATE]: 'anonymous'});
    }
  }

  /**
   * Called by the extension registry for each module (at init, or when a
   * module chunk is loaded later).
   * @param {string} name
   * @param {function(?): !Extension} factory
   */
  attachExtension(name, factory) {
    if (this.extensions[name]) return;
    try {
      const ext = factory(this);
      this.extensions[name] = ext;
      if (ext.onInit) ext.onInit();
    } catch (e) {
      logger.critical('failed to initialise extension ' + name, e);
    }
  }

  /** @param {!Object} config */
  set_config(config) {
    const oldPersistence = this.config['persistence'];
    extend(this.config, config);
    if ('api_host' in config) this.config['api_host'] = normalizeApiHost(this.config['api_host']);
    if ('debug' in config) logger.enabled = !!this.config['debug'];
    if (this.persistence && this.sessionPersistence) {
      if (config['persistence'] && config['persistence'] !== oldPersistence) {
        this.persistence.configure(this.config);
        this.sessionPersistence.configure(this.config);
      }
      if ('disable_persistence' in config) {
        this.persistence.setDisabled(!!this.config['disable_persistence']);
        this.sessionPersistence.setDisabled(!!this.config['disable_persistence']);
      }
    }
  }

  /** @param {boolean=} enabled */
  debug(enabled) {
    const on = enabled !== false;
    this.set_config({'debug': on});
    try {
      if (on) win.localStorage.setItem('ph_debug', 'true');
      else win.localStorage.removeItem('ph_debug');
    } catch (e) {}
  }

  /**
   * @param {string} path e.g. '/e/'
   * @return {string}
   */
  apiUrl(path) {
    return this.config['api_host'] + path;
  }

  // ---------------------------------------------------------------------------
  // Events

  /**
   * @param {string} name 'eventCaptured'
   * @param {function(...?)} cb
   * @return {function()} unsubscribe
   */
  on(name, cb) {
    const list = this.listeners_[name] || (this.listeners_[name] = []);
    list.push(cb);
    return function() {
      const i = list.indexOf(cb);
      if (i !== -1) list.splice(i, 1);
    };
  }

  /**
   * @param {string} name
   * @param {...*} args
   */
  emit(name, args) {
    const list = (this.listeners_[name] || []).slice();
    const rest = Array.prototype.slice.call(arguments, 1);
    list.forEach(function(cb) {
      try {
        cb.apply(null, rest);
      } catch (e) {
        logger.error('listener for ' + name + ' threw', e);
      }
    });
  }

  /**
   * @param {string} eventName
   * @param {?Object=} properties
   * @param {?Object=} options {'$set', '$set_once', 'timestamp', 'uuid', 'send_instantly', 'transport'}
   * @return {!Object|undefined} the captured event
   */
  capture(eventName, properties, options) {
    if (!this.loaded || !this.persistence) {
      logger.warn('posthog.capture called before init');
      return undefined;
    }
    if (!this.is_capturing()) return undefined;
    if (!isString(eventName) || !eventName) {
      logger.error('No event name provided to posthog.capture');
      return undefined;
    }
    if (!this.config['opt_out_useragent_filter'] && this.isBot_()) {
      if (!this.botWarned_) {
        this.botWarned_ = true;
        logger.critical('Events are dropped because the user agent looks like a bot. ' +
            'Set `opt_out_useragent_filter: true` to capture them.');
      }
      return undefined;
    }
    const opts = options || {};

    if (this.config['save_campaign_params']) this.sessionPersistence.updateCampaignParams();
    if (this.config['save_referrer']) this.sessionPersistence.updateReferrerInfo();
    if (this.config['save_campaign_params'] || this.config['save_referrer']) this.persistence.setInitialPersonInfo();

    const timestamp = opts['timestamp'] instanceof Date ? opts['timestamp'] : new Date();
    const uuid = isString(opts['uuid']) ? opts['uuid'] : uuidv7();
    /** @type {!Object} */
    let data = {
      'uuid': uuid,
      'event': eventName,
      'properties': this.calculateEventProperties(eventName, properties || {}, timestamp, uuid),
    };
    if (opts['$set']) data['$set'] = opts['$set'];
    if (opts['$unset']) data['$unset'] = opts['$unset'];
    const setOnce = this.calculateSetOnce_(opts['$set_once'], eventName);
    if (setOnce) data['$set_once'] = setOnce;

    data = /** @type {!Object} */ (truncateStrings(data, this.config['properties_string_max_length']));
    data['timestamp'] = timestamp;
    if (opts['timestamp']) data['properties']['$event_time_override_provided'] = true;

    const finalSet = extend({}, data['properties']['$set'], data['$set']);
    if (!isEmptyObject(finalSet)) this.setPersonPropertiesForFlags(finalSet, false);

    const before = this.config['before_send'];
    if (before) {
      const fns = isArray(before) ? before : [before];
      for (let i = 0; i < fns.length; i++) {
        if (!isFunction(fns[i])) continue;
        const res = fns[i](data);
        if (!res) {
          logger.info('Event "' + eventName + '" was dropped by before_send');
          return undefined;
        }
        data = res;
      }
    }

    this.emit('eventCaptured', data);

    const url = this.apiUrl('/e/');
    if (this.config['request_batching'] && !opts['send_instantly'] && !opts['transport']) {
      this.requestQueue.enqueue({url: url, data: data, batchKey: undefined, transport: undefined});
    } else {
      this.retryQueue.send(/** @type {!RequestOptions} */ ({
        url: url,
        method: 'POST',
        data: captureBody([data]),
        compression: 'gzip-js',
        transport: opts['transport'],
        headers: this.config['request_headers'],
      }));
    }
    return data;
  }

  /**
   * Builds the full property set for an event.
   * @param {string} eventName
   * @param {!Object} eventProperties
   * @param {!Date=} timestamp
   * @param {string=} uuid
   * @return {!Object}
   */
  calculateEventProperties(eventName, eventProperties, timestamp, uuid) {
    const ts = timestamp || new Date();
    const p = /** @type {!Persistence} */ (this.persistence);
    const sp = /** @type {!Persistence} */ (this.sessionPersistence);

    let props = /** @type {!Object} */ (extend({}, eventProperties));
    props['token'] = this.config['token'];

    const startTs = p.removeEventTimer(eventName);
    if (!isUndefined(startTs)) {
      props['$duration'] = parseFloat(((ts.getTime() - /** @type {number} */ (startTs)) / 1000).toFixed(3));
    }

    const s = /** @type {!SessionManager} */ (this.sessionManager).checkAndGetSessionAndWindowId(false, ts.getTime());
    props['$session_id'] = s.sessionId;
    props['$window_id'] = s.windowId;

    extend(props, this.pageviewProperties_(eventName, ts, uuid));
    if (eventName === '$pageview') props['title'] = documentTitle();

    // Extension-provided properties ($feature/<key>, $active_feature_flags, ...)
    const extProps = {};
    for (const key in this.extensions) {
      const ext = this.extensions[key];
      if (ext.eventProperties) {
        try {
          extend(extProps, ext.eventProperties(eventName));
        } catch (e) {
          logger.error('extension ' + key + ' failed to produce properties', e);
        }
      }
    }

    // Registered super properties win over session ones for referrer keys.
    const persisted = p.properties();
    const session = sp.properties();
    ['$referrer', '$referring_domain'].forEach(function(k) {
      if (k in persisted) delete session[k];
    });

    props = /** @type {!Object} */ (extend({}, getEventProperties(this.config), persisted, session, extProps, props));
    props['$is_identified'] = this.isIdentified_();
    if (this.config['api_host'].indexOf('.posthog.com') === -1) props['$lib_custom_api_host'] = this.config['api_host'];

    const denylist = this.config['property_denylist'];
    if (isArray(denylist)) {
      denylist.forEach(function(k) {
        delete props[k];
      });
    }

    const processPerson = this.hasPersonProcessing_() || PERSON_EVENTS.indexOf(eventName) !== -1;
    props['$process_person_profile'] = processPerson;
    if (processPerson) this.requirePersonProcessing_();
    return props;
  }

  /**
   * @param {?Object|undefined} setOnce
   * @param {string} eventName
   * @return {?Object}
   * @private
   */
  calculateSetOnce_(setOnce, eventName) {
    if (!this.hasPersonProcessing_() && eventName !== '$identify') return setOnce || null;
    let out = setOnce || null;
    if (!this.initialPersonInfoSent_ || eventName === '$identify') {
      const initial = /** @type {!Persistence} */ (this.persistence).getInitialProps();
      if (!isEmptyObject(initial)) {
        out = /** @type {!Object} */ (extend({}, initial, setOnce || {}));
        // $groupidentify doesn't apply $set_once on the server; keep sending.
        if (eventName !== '$groupidentify') this.initialPersonInfoSent_ = true;
      }
    }
    return out;
  }

  /**
   * Starts a timer; the next capture of `eventName` gets `$duration`.
   * @param {string} eventName
   */
  time_event(eventName) {
    if (this.persistence) this.persistence.startEventTimer(eventName);
  }

  // ---------------------------------------------------------------------------
  // Super properties

  /** @param {!Object} props */
  register(props) {
    if (this.persistence) this.persistence.register(props);
  }

  /**
   * @param {!Object} props
   * @param {*=} defaultValue
   */
  register_once(props, defaultValue) {
    if (this.persistence) this.persistence.registerOnce(props, defaultValue);
  }

  /** @param {!Object} props */
  register_for_session(props) {
    if (this.sessionPersistence) this.sessionPersistence.register(props);
  }

  /** @param {string} key */
  unregister(key) {
    if (this.persistence) this.persistence.unregister(key);
  }

  /** @param {string} key */
  unregister_for_session(key) {
    if (this.sessionPersistence) this.sessionPersistence.unregister(key);
  }

  /**
   * @param {string} key
   * @return {*}
   */
  get_property(key) {
    return this.persistence ? this.persistence.get(key) : undefined;
  }

  /**
   * @param {string} key
   * @return {*}
   */
  getSessionProperty(key) {
    return this.sessionPersistence ? this.sessionPersistence.get(key) : undefined;
  }

  // ---------------------------------------------------------------------------
  // Identity

  /** @return {string} */
  get_distinct_id() {
    return String(this.get_property(DISTINCT_ID) || '');
  }

  /** @return {string} */
  get_session_id() {
    return this.sessionManager ? this.sessionManager.checkAndGetSessionAndWindowId(true).sessionId : '';
  }

  /**
   * @param {function(string, string, ?Object)} cb
   * @return {function()}
   */
  onSessionId(cb) {
    return this.sessionManager ? this.sessionManager.onSessionId(cb) : function() {};
  }

  /**
   * @param {string} newDistinctId
   * @param {?Object=} setProps
   * @param {?Object=} setOnceProps
   */
  identify(newDistinctId, setProps, setOnceProps) {
    if (!this.loaded || !this.persistence) {
      logger.warn('posthog.identify called before init');
      return;
    }
    if (isNullish(newDistinctId) || newDistinctId === '') {
      logger.error('Unique user id has not been set in posthog.identify');
      return;
    }
    newDistinctId = String(newDistinctId);
    if (['undefined', 'null', '0', 'anonymous', 'guest', 'distinct_id', '[object object]', 'none', 'nan', 'true', 'false']
            .indexOf(newDistinctId.toLowerCase()) !== -1) {
      logger.critical('The string "' + newDistinctId + '" was set in posthog.identify which indicates an error. ' +
          'This ID should be unique to the user and not a hardcoded string.');
      return;
    }
    if (this.config['person_profiles'] === 'never') {
      logger.error('identify was called, but person_profiles is "never"');
      return;
    }
    this.requirePersonProcessing_();

    const previousId = this.get_distinct_id();
    const p = this.persistence;
    this.register({[PEOPLE_DISTINCT_ID_KEY]: newDistinctId});
    if (!this.get_property(DEVICE_ID)) {
      // Older persisted data may lack a device id; anchor it to the anonymous id.
      p.registerOnce({[DEVICE_ID]: previousId, [USER_STATE]: 'anonymous'});
    }

    if (newDistinctId !== previousId && newDistinctId !== this.get_property(ALIAS_ID_KEY)) {
      p.unregister(ALIAS_ID_KEY);
      p.register({[DISTINCT_ID]: newDistinctId});
    }

    const wasAnonymous = p.get(USER_STATE) === 'anonymous';
    if (newDistinctId !== previousId && wasAnonymous) {
      p.register({[USER_STATE]: 'identified'});
      this.capture('$identify', {'distinct_id': newDistinctId, '$anon_distinct_id': previousId},
          {'$set': setProps || {}, '$set_once': setOnceProps || {}});
      this.notifyIdentity_('identify');
    } else {
      if (setProps || setOnceProps) this.setPersonProperties(setProps, setOnceProps);
      if (newDistinctId !== previousId) {
        p.register({[USER_STATE]: 'identified'});
        this.notifyIdentity_('identify');
      }
    }
  }

  /**
   * @param {string} alias
   * @param {string=} original
   * @return {!Object|undefined}
   */
  alias(alias, original) {
    if (alias === this.get_property(PEOPLE_DISTINCT_ID_KEY)) {
      logger.critical('Attempting to create alias for existing People user - aborting.');
      return undefined;
    }
    const orig = original || this.get_distinct_id();
    if (alias === orig) {
      this.identify(alias);
      return undefined;
    }
    this.register({[ALIAS_ID_KEY]: alias});
    return this.capture('$create_alias', {'alias': alias, 'distinct_id': orig});
  }

  /**
   * @param {?Object=} setProps
   * @param {?Object=} setOnceProps
   */
  setPersonProperties(setProps, setOnceProps) {
    if (!setProps && !setOnceProps) return;
    if (this.config['person_profiles'] === 'never') return;
    this.requirePersonProcessing_();
    this.capture('$set', {'$set': setProps || {}, '$set_once': setOnceProps || {}});
  }

  /**
   * @param {string} groupType
   * @param {string} groupKey
   * @param {?Object=} groupProps
   */
  group(groupType, groupKey, groupProps) {
    if (!groupType || !groupKey) {
      logger.error('posthog.group requires a group type and group key');
      return;
    }
    if (this.config['person_profiles'] === 'never') return;
    this.requirePersonProcessing_();
    const existing = this.getGroups();
    const changed = existing[groupType] !== groupKey;
    if (changed) this.resetGroupPropertiesForFlags(groupType);
    this.register({[GROUPS_KEY]: extend({}, existing, {[groupType]: groupKey})});
    if (groupProps) {
      this.capture('$groupidentify', {'$group_type': groupType, '$group_key': groupKey, '$group_set': groupProps});
      this.setGroupPropertiesForFlags({[groupType]: groupProps}, false);
    }
    if (changed || groupProps) this.notifyIdentity_('group');
  }

  /** @return {!Object<string, string>} */
  getGroups() {
    return /** @type {!Object<string, string>} */ (this.get_property(GROUPS_KEY) || {});
  }

  resetGroups() {
    this.register({[GROUPS_KEY]: {}});
    this.resetGroupPropertiesForFlags();
    this.notifyIdentity_('group');
  }

  /**
   * Person properties used when evaluating flags (until the server knows them).
   * @param {!Object} props
   * @param {boolean=} reload default true
   */
  setPersonPropertiesForFlags(props, reload) {
    const current = this.get_property(STORED_PERSON_PROPERTIES_KEY) || {};
    this.register({[STORED_PERSON_PROPERTIES_KEY]: extend({}, current, props)});
    if (reload !== false) this.notifyIdentity_('person_properties');
  }

  /** @param {boolean=} reload */
  resetPersonPropertiesForFlags(reload) {
    this.unregister(STORED_PERSON_PROPERTIES_KEY);
    if (reload) this.notifyIdentity_('person_properties');
  }

  /**
   * @param {!Object<string, !Object>} props keyed by group type
   * @param {boolean=} reload default true
   */
  setGroupPropertiesForFlags(props, reload) {
    const current = /** @type {!Object} */ (this.get_property(STORED_GROUP_PROPERTIES_KEY) || {});
    const next = extend({}, current);
    for (const type in props) {
      if (hasOwn(props, type)) next[type] = extend({}, current[type], props[type]);
    }
    this.register({[STORED_GROUP_PROPERTIES_KEY]: next});
    if (reload !== false) this.notifyIdentity_('group_properties');
  }

  /** @param {string=} groupType */
  resetGroupPropertiesForFlags(groupType) {
    if (groupType) {
      const current = /** @type {!Object} */ (extend({}, this.get_property(STORED_GROUP_PROPERTIES_KEY) || {}));
      delete current[groupType];
      this.register({[STORED_GROUP_PROPERTIES_KEY]: current});
    } else {
      this.unregister(STORED_GROUP_PROPERTIES_KEY);
    }
  }

  /** Marks this user for person processing (person_profiles: identified_only). */
  createPersonProfile() {
    if (this.hasPersonProcessing_()) return;
    if (this.config['person_profiles'] === 'never') return;
    this.setPersonProperties({}, {});
  }

  /**
   * Clears identity and super properties (call on logout).
   * @param {boolean=} resetDeviceId
   */
  reset(resetDeviceId) {
    if (!this.loaded || !this.persistence) return;
    const deviceId = this.get_property(DEVICE_ID);
    this.persistence.clear();
    this.sessionPersistence.clear();
    if (this.sessionManager) this.sessionManager.resetSessionId();
    const newId = uuidv7();
    this.persistence.register({
      [DISTINCT_ID]: newId,
      [DEVICE_ID]: resetDeviceId || !deviceId ? newId : deviceId,
      [USER_STATE]: 'anonymous',
    });
    this.initialPersonInfoSent_ = false;
    for (const key in this.extensions) {
      const ext = this.extensions[key];
      if (ext.onReset) ext.onReset();
    }
    this.notifyIdentity_('reset');
  }

  /**
   * @param {string} reason
   * @private
   */
  notifyIdentity_(reason) {
    for (const key in this.extensions) {
      const ext = this.extensions[key];
      if (ext.onIdentityChange) {
        try {
          ext.onIdentityChange(reason);
        } catch (e) {
          logger.error('extension ' + key + ' onIdentityChange failed', e);
        }
      }
    }
  }

  /** @return {boolean} @private */
  isIdentified_() {
    return this.get_property(USER_STATE) === 'identified';
  }

  /** @return {boolean} @private */
  hasPersonProcessing_() {
    const mode = this.config['person_profiles'];
    if (mode === 'never') return false;
    if (mode === 'identified_only') {
      return !!this.get_property(ENABLE_PERSON_PROCESSING) || this.isIdentified_() ||
          !isEmptyObject(this.getGroups());
    }
    return true;
  }

  /** @private */
  requirePersonProcessing_() {
    if (this.config['person_profiles'] === 'never') return;
    if (!this.get_property(ENABLE_PERSON_PROCESSING)) this.register({[ENABLE_PERSON_PROCESSING]: true});
  }

  /** @return {boolean} @private */
  isBot_() {
    return isLikelyBot(userAgent, this.config['custom_blocked_useragents']);
  }

  // ---------------------------------------------------------------------------
  // Consent

  /** @return {string} @private */
  consentKey_() {
    return (this.config['opt_out_capturing_cookie_prefix'] || OPT_IN_CONSENT_PREFIX) + this.config['token'];
  }

  /** @return {?boolean} stored consent: true=in, false=out, null=unset @private */
  consent_() {
    if (!this.consentStore_) return null;
    const v = this.consentStore_.parse(this.consentKey_());
    if (v && hasOwn(v, 'v')) return !!v['v'];
    return null;
  }

  /**
   * @param {?Object=} options {'captureEventName', 'captureProperties'}
   */
  opt_in_capturing(options) {
    if (this.consentStore_) this.consentStore_.set(this.consentKey_(), {'v': 1}, 365);
    if (this.config['opt_out_persistence_by_default'] && this.persistence) {
      this.persistence.setDisabled(!!this.config['disable_persistence']);
      this.sessionPersistence.setDisabled(!!this.config['disable_persistence']);
    }
    if (this.requestQueue) this.requestQueue.start();
    const opts = options || {};
    const evt = opts['captureEventName'];
    if (evt !== false && evt !== null) {
      this.capture(isString(evt) ? evt : '$opt_in', opts['captureProperties'] || {}, {'send_instantly': true});
    }
    if (this.config['capture_pageview'] && !this.pageview_) this.capturePageview_();
  }

  opt_out_capturing() {
    if (this.consentStore_) this.consentStore_.set(this.consentKey_(), {'v': 0}, 365);
    if (this.config['opt_out_persistence_by_default'] && this.persistence) {
      this.persistence.setDisabled(true);
      this.sessionPersistence.setDisabled(true);
    }
  }

  /** @return {boolean} */
  has_opted_in_capturing() {
    return this.consent_() === true;
  }

  /** @return {boolean} */
  has_opted_out_capturing() {
    const c = this.consent_();
    if (c !== null) return !c;
    if (this.config['respect_dnt'] && nav) {
      const dnt = nav['doNotTrack'] || (win ? win['doNotTrack'] : null);
      if (dnt === '1' || dnt === 'yes' || dnt === true) return true;
    }
    return !!this.config['opt_out_capturing_by_default'];
  }

  clear_opt_in_out_capturing() {
    if (this.consentStore_) this.consentStore_.remove(this.consentKey_());
  }

  /** @return {boolean} */
  is_capturing() {
    return !this.has_opted_out_capturing();
  }

  // ---------------------------------------------------------------------------
  // Pageviews & unload

  /** @private */
  setupPageviews_() {
    const mode = this.config['capture_pageview'];
    if (!mode || !win) return;
    this.capturePageview_();
    if (mode === 'history_change') {
      const self = this;
      const onChange = function() {
        if (win.location.pathname !== self.lastPathname_) self.capturePageview_();
      };
      ['pushState', 'replaceState'].forEach(function(method) {
        const original = win.history[method];
        if (!isFunction(original) || original['__ph_wrapped']) return;
        const wrapped = function() {
          const r = original.apply(this, arguments);
          onChange();
          return r;
        };
        wrapped['__ph_wrapped'] = true;
        win.history[method] = wrapped;
      });
      addEventListener(win, 'popstate', onChange);
    }
  }

  /** @private */
  capturePageview_() {
    if (!this.is_capturing()) return;
    this.lastPathname_ = win ? win.location.pathname : '';
    this.capture('$pageview', {}, {});
  }

  /**
   * Tracks pageview ids and previous-page metrics.
   * @param {string} eventName
   * @param {!Date} ts
   * @param {string=} uuid
   * @return {!Object}
   * @private
   */
  pageviewProperties_(eventName, ts, uuid) {
    const out = {};
    const prev = this.pageview_;
    if (eventName === '$pageview') {
      if (prev) {
        out['$prev_pageview_id'] = prev.id;
        out['$prev_pageview_pathname'] = prev.pathname;
        out['$prev_pageview_duration'] = (ts.getTime() - prev.ts) / 1000;
      }
      const id = uuid || uuidv7();
      this.pageview_ = {id: id, pathname: win ? win.location.pathname : '', ts: ts.getTime()};
      out['$pageview_id'] = id;
    } else if (prev) {
      out['$pageview_id'] = prev.id;
      if (eventName === '$pageleave') {
        out['$prev_pageview_id'] = prev.id;
        out['$prev_pageview_pathname'] = prev.pathname;
        out['$prev_pageview_duration'] = (ts.getTime() - prev.ts) / 1000;
      }
    }
    return out;
  }

  /** @private */
  handleUnload_() {
    const leave = this.config['capture_pageleave'];
    if (leave === true || (leave === 'if_capture_pageview' && this.config['capture_pageview'])) {
      if (this.pageview_) this.capture('$pageleave', {}, {'transport': 'sendBeacon'});
    }
    if (this.requestQueue) this.requestQueue.flush('sendBeacon');
    if (this.retryQueue) this.retryQueue.unload();
  }

  // ---------------------------------------------------------------------------
  // Feature-flag facade. Implemented by the optional `featureFlags` module;
  // without it these log a warning and return undefined.

  /**
   * @return {?FeatureFlagsApi}
   * @private
   */
  flags_() {
    const f = this.extensions['featureFlags'];
    if (!f) logger.warn('feature flags module is not loaded');
    return f ? /** @type {!FeatureFlagsApi} */ (f) : null;
  }

  /**
   * @param {string} key
   * @param {?Object=} options {'send_event': boolean}
   * @return {boolean|string|undefined}
   */
  getFeatureFlag(key, options) {
    const f = this.flags_();
    return f ? f.getFlag(key, options) : undefined;
  }

  /**
   * @param {string} key
   * @return {*}
   */
  getFeatureFlagPayload(key) {
    const f = this.flags_();
    return f ? f.getFlagPayload(key) : undefined;
  }

  /**
   * @param {string} key
   * @param {?Object=} options
   * @return {boolean|undefined}
   */
  isFeatureEnabled(key, options) {
    const f = this.flags_();
    return f ? f.isEnabled(key, options) : undefined;
  }

  reloadFeatureFlags() {
    const f = this.flags_();
    if (f) f.reload();
  }

  /**
   * @param {function(!Array<string>, !Object<string, (string|boolean)>, ?Object)} cb
   * @return {function()}
   */
  onFeatureFlags(cb) {
    const f = this.flags_();
    return f ? f.onFlags(cb) : function() {};
  }

  /**
   * @param {(boolean|!Array<string>|!Object<string, (string|boolean)>)} overrides false clears
   */
  overrideFeatureFlags(overrides) {
    const f = this.flags_();
    if (f) f.override(overrides);
  }

  /** @return {!Object<string, (string|boolean)>} */
  getFeatureFlags() {
    const f = this.flags_();
    return f ? f.getFlagVariants() : {};
  }

  /** @return {string} */
  toString() {
    return this.name;
  }
}

/** @const {string} */
PostHog.VERSION = LIB_VERSION;

/**
 * Exposes the public API under stable (quoted) names on the prototype.
 * Written out explicitly so Closure can see each mapping.
 */
export function exportPublicApi() {
  const p = PostHog.prototype;
  p['init'] = p.init;
  p['capture'] = p.capture;
  p['identify'] = p.identify;
  p['alias'] = p.alias;
  p['setPersonProperties'] = p.setPersonProperties;
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
  p['onSessionId'] = p.onSessionId;
  p['set_config'] = p.set_config;
  p['debug'] = p.debug;
  p['time_event'] = p.time_event;
  p['on'] = p.on;
  p['createPersonProfile'] = p.createPersonProfile;
  p['setPersonPropertiesForFlags'] = p.setPersonPropertiesForFlags;
  p['resetPersonPropertiesForFlags'] = p.resetPersonPropertiesForFlags;
  p['setGroupPropertiesForFlags'] = p.setGroupPropertiesForFlags;
  p['resetGroupPropertiesForFlags'] = p.resetGroupPropertiesForFlags;
  p['opt_in_capturing'] = p.opt_in_capturing;
  p['opt_out_capturing'] = p.opt_out_capturing;
  p['has_opted_in_capturing'] = p.has_opted_in_capturing;
  p['has_opted_out_capturing'] = p.has_opted_out_capturing;
  p['clear_opt_in_out_capturing'] = p.clear_opt_in_out_capturing;
  p['is_capturing'] = p.is_capturing;
  p['getFeatureFlag'] = p.getFeatureFlag;
  p['getFeatureFlagPayload'] = p.getFeatureFlagPayload;
  p['isFeatureEnabled'] = p.isFeatureEnabled;
  p['reloadFeatureFlags'] = p.reloadFeatureFlags;
  p['onFeatureFlags'] = p.onFeatureFlags;
  p['overrideFeatureFlags'] = p.overrideFeatureFlags;
  p['getFeatureFlags'] = p.getFeatureFlags;
  p['toString'] = p.toString;
  // Read-only-ish state commonly accessed from outside.
  Object.defineProperty(p, '__loaded', {get: /** @this {!PostHog} */ function() {
    return this.loaded;
  }});
  // `config` is an instance field; when ADVANCED renamed it, expose it under
  // its public name too (uncompiled, the field already has that name).
  if (!hasOwn(new PostHog(), 'config')) {
    Object.defineProperty(p, 'config', {get: /** @this {!PostHog} */ function() {
      return this.config;
    }});
  }
  Object.defineProperty(p, 'version', {get: function() {
    return LIB_VERSION;
  }});
}
