/**
 * @fileoverview Port of upstream replay/session-recording.ts: the always-loaded
 * wrapper that persists the remote config, decides whether to record, loads
 * rrweb (recorder.js) and drives the recorder (recorder.js in this folder,
 * upstream's lazy-loaded-session-recorder.ts).
 *
 * Difference from upstream: upstream lazy-loads `lazy-recorder.js` (rrweb +
 * the recorder logic); we compile the recorder logic in and only load
 * `recorder.js` (rrweb + its plugins). The `scriptConfig.script` remote
 * override (which picks another upstream bundle) is therefore ignored.
 */
import {PostHog} from '../core/posthog.js';
import {Extension} from '../core/extensions.js';
import {logger as baseLogger} from '../core/logger.js';
import {Config} from '../core/constants.js';
import {loadScript} from '../core/script-loader.js';
import {addEventListener, doc, isNullish, isNumber, isObject, isUndefined, win} from '../core/utils.js';
import {
  AWAITING_CONFIG, DISABLED, LAZY_LOADING, MISSING_CONFIG, RECORDING_REMOTE_CONFIG_TTL_MS,
  SDK_DEBUG_RECORDING_SCRIPT_NOT_LOADED, SDK_DEBUG_REPLAY_EVENT_TRIGGER_STATUS,
  SDK_DEBUG_REPLAY_LINKED_FLAG_TRIGGER_STATUS, SDK_DEBUG_REPLAY_MATCHED_RECORDING_TRIGGER_GROUPS,
  SDK_DEBUG_REPLAY_PENDING_TRIGGER_CONDITIONS, SDK_DEBUG_REPLAY_REMOTE_TRIGGER_MATCHING_CONFIG,
  SDK_DEBUG_REPLAY_STALE_CONFIG, SDK_DEBUG_REPLAY_TRIGGER_GROUPS_COUNT, SDK_DEBUG_REPLAY_URL_TRIGGER_STATUS,
  SESSION_RECORDING_IS_SAMPLED, SESSION_RECORDING_OVERRIDE_EVENT_TRIGGER, SESSION_RECORDING_OVERRIDE_LINKED_FLAG,
  SESSION_RECORDING_OVERRIDE_SAMPLING, SESSION_RECORDING_OVERRIDE_URL_TRIGGER, SESSION_RECORDING_REMOTE_CONFIG,
  SESSION_RECORDING_SAMPLE_RATE,
} from './constants.js';
import {LazyLoadedSessionRecording, getRRWebRecord} from './recorder.js';

const LOGGER_PREFIX = '[SessionRecording]';
const logger = baseLogger.createLogger(LOGGER_PREFIX);
const scriptLogger = baseLogger.createLogger('[ExternalScriptsLoader]');

/** The rrweb-only bundle published with every posthog-js release. */
const RECORDER_SCRIPT = 'recorder';

const SESSION_DEBUG_PROPERTY_KEYS = [
  SDK_DEBUG_RECORDING_SCRIPT_NOT_LOADED, SDK_DEBUG_REPLAY_STALE_CONFIG, SDK_DEBUG_REPLAY_EVENT_TRIGGER_STATUS,
  SDK_DEBUG_REPLAY_LINKED_FLAG_TRIGGER_STATUS, SDK_DEBUG_REPLAY_MATCHED_RECORDING_TRIGGER_GROUPS,
  SDK_DEBUG_REPLAY_PENDING_TRIGGER_CONDITIONS, SDK_DEBUG_REPLAY_REMOTE_TRIGGER_MATCHING_CONFIG,
  SDK_DEBUG_REPLAY_TRIGGER_GROUPS_COUNT, SDK_DEBUG_REPLAY_URL_TRIGGER_STATUS,
];

/** @return {boolean} */
function hasDocumentEverBeenVisible() {
  if (!doc || !doc.visibilityState || doc.visibilityState === 'visible') return true;
  const perf = win ? win.performance : null;
  const entries = perf && perf.getEntriesByType ? perf.getEntriesByType('visibility-state') : null;
  return !entries || !entries.length || Array.prototype.some.call(entries, function(e) {
    return e.name === 'visible';
  });
}

/** @const {!Object<string, string>} versioned url -> fallback url (upstream fallbackScripts) */
const fallbackScripts = {};

/**
 * @param {string} url
 * @return {?Element}
 */
function findScript(url) {
  const scripts = doc ? doc.querySelectorAll('script') : null;
  if (scripts) {
    for (let i = 0; i < scripts.length; i++) {
      const s = /** @type {!HTMLScriptElement} */ (scripts[i]);
      if (s.src === url || s.getAttribute('src') === url) return s;
    }
  }
  return null;
}

/**
 * Upstream `__PosthogExtensions__.loadExternalDependency` for a `/static/`
 * script: `?v=<version>`, or `/static/<version>/` under
 * `strict_script_versioning`, falling back to the unversioned path when that
 * fails and the setting is 'fallback'.
 * @param {!PostHog} instance
 * @param {string} kind
 * @param {function((string|!Event|undefined)=)} callback
 */
export function loadExternalDependency(instance, kind, callback) {
  const version = Config.LIB_VERSION;
  const legacyUrl = function() {
    return instance.requestRouter.endpointFor('assets', '/static/' + kind + '.js?v=' + version);
  };
  const scriptVersioning = instance.config['strict_script_versioning'];
  if (scriptVersioning) {
    const url = instance.requestRouter.endpointFor('assets', '/static/' + version + '/' + kind + '.js');
    const existingFallback = fallbackScripts[url];
    if (scriptVersioning === 'fallback' && existingFallback) {
      if (findScript(existingFallback)) {
        loadScript(instance.config, existingFallback, callback);
        return;
      }
      delete fallbackScripts[url];
    }
    loadScript(instance.config, url, scriptVersioning === 'fallback' ? function(error) {
      if (!error) {
        callback(undefined);
      } else if (typeof error === 'string') {
        callback(error);
      } else {
        const fallbackUrl = legacyUrl();
        fallbackScripts[url] = fallbackUrl;
        const failed = findScript(url);
        if (failed && failed.parentNode) failed.parentNode.removeChild(failed);
        loadScript(instance.config, fallbackUrl, callback);
      }
    } : callback);
    return;
  }
  loadScript(instance.config, legacyUrl(), callback);
}

/**
 * @param {*} rate
 * @return {boolean}
 */
function isValidSampleRate(rate) {
  return isNumber(rate) && /** @type {number} */ (rate) >= 0 && /** @type {number} */ (rate) <= 1;
}

/**
 * The core passes the remote config (or null when loading failed); upstream's
 * public `onRemoteConfig` takes a RemoteConfigResult `{ok, config}`. Accept
 * both: the hook and the public method share a name in uncompiled sources.
 * @param {*} arg
 * @return {?Object}
 */
function normalizeRemoteConfigArg(arg) {
  if (isObject(arg) && typeof arg['ok'] === 'boolean' && !('sessionRecording' in arg)) {
    return arg['ok'] && isObject(arg['config']) ? arg['config'] : null;
  }
  return isObject(arg) ? /** @type {!Object} */ (arg) : null;
}

/** @implements {Extension} */
export class SessionRecording {
  /** @param {!PostHog} instance */
  constructor(instance) {
    /** @private @const */
    this.instance_ = instance;
    if (!instance.sessionManager) {
      logger.error('started without valid sessionManager');
      throw new Error(LOGGER_PREFIX + ' started without valid sessionManager. This is a bug.');
    }
    if (instance.config['cookieless_mode'] === 'always') {
      throw new Error(LOGGER_PREFIX + ' cannot be used with cookieless_mode="always"');
    }
    /** @private {string} */
    this.recordingStatus_ = DISABLED;
    /** @private {(function()|undefined)} */
    this.persistFlagsOnSessionListener_ = undefined;
    /** @private {?LazyLoadedSessionRecording} */
    this.lazyLoadedSessionRecording_ = null;
    /** @private {boolean} */
    this.sessionRecordingDisposed_ = false;
    /** @private {boolean} */
    this.documentWasEverVisible_ = hasDocumentEverBeenVisible();
    /** @type {boolean} public as `_forceAllowLocalhostNetworkCapture`, like upstream */
    this.forceAllowLocalhostNetworkCapture = false;
    const self = this;
    /** @private @const */
    this.onVisibilityChange_ = function() {
      if (doc && doc.visibilityState === 'visible') {
        self.documentWasEverVisible_ = true;
        if (self.lazyLoadedSessionRecording_) self.lazyLoadedSessionRecording_.setDocumentWasEverVisible(true);
      }
    };
    if (doc && doc.addEventListener) addEventListener(doc, 'visibilitychange', this.onVisibilityChange_);
    /** @type {(function()|undefined)} */
    this.onInit = function() {
      self.initialize();
    };
    /** @type {(function(?Object): void)|undefined} */
    this.onRemoteConfig = function(config) {
      self.handleRemoteConfig(normalizeRemoteConfigArg(config));
    };
    /** @type {(function(string): ?Object)|undefined} */
    this.eventProperties = undefined;
    /** @type {(function(): void)|undefined} */
    this.onReset = undefined;
  }

  /** @return {boolean} */
  isStarted() {
    return !!this.lazyLoadedSessionRecording_ && this.lazyLoadedSessionRecording_.isStarted();
  }

  /** @return {string} */
  getStatus() {
    if (this.recordingStatus_ === AWAITING_CONFIG || this.recordingStatus_ === MISSING_CONFIG) {
      return this.recordingStatus_;
    }
    return this.lazyLoadedSessionRecording_ ? this.lazyLoadedSessionRecording_.status() : this.recordingStatus_;
  }

  initialize() {
    this.startIfEnabledOrStop();
  }

  /** @param {boolean=} discardBufferedEvents */
  disposeRecording(discardBufferedEvents) {
    this.sessionRecordingDisposed_ = true;
    if (doc && doc.removeEventListener) doc.removeEventListener('visibilitychange', this.onVisibilityChange_);
    if (discardBufferedEvents) this.discardRecording_(true);
    else this.stopRecording();
  }

  /**
   * @return {boolean}
   * @private
   */
  isRecordingEnabled_() {
    const rc = this.instance_.get_property(SESSION_RECORDING_REMOTE_CONFIG);
    const enabledServerSide = !!(rc && rc['enabled']);
    const enabledClientSide = !this.instance_.config['disable_session_recording'];
    const isDisabled = this.instance_.config['disable_session_recording'] || this.instance_.consent.isOptedOut();
    return !!win && enabledServerSide && enabledClientSide && !isDisabled;
  }

  /** @param {string=} startReason */
  startIfEnabledOrStop(startReason) {
    if (this.sessionRecordingDisposed_) return;
    if (this.isRecordingEnabled_() && this.isStarted()) return;
    const canRunReplay = !isUndefined(Object.assign) && !isUndefined(Array.from);
    if (this.isRecordingEnabled_() && canRunReplay) {
      this.lazyLoadAndStart_(startReason);
      logger.info('starting');
    } else {
      this.recordingStatus_ = DISABLED;
      this.stopRecording();
    }
  }

  /**
   * @param {string=} startReason
   * @private
   */
  lazyLoadAndStart_(startReason) {
    if (!this.isRecordingEnabled_()) return;
    if (this.recordingStatus_ !== AWAITING_CONFIG && this.recordingStatus_ !== MISSING_CONFIG) {
      this.recordingStatus_ = LAZY_LOADING;
    }
    // Only rrweb is loaded at runtime; the recorder logic is compiled in.
    if (!getRRWebRecord()) {
      const sessionManager = this.instance_.sessionManager;
      const self = this;
      loadExternalDependency(this.instance_, RECORDER_SCRIPT, function(err) {
        if (self.sessionRecordingDisposed_ || !self.isRecordingEnabled_() ||
            self.instance_.sessionManager !== sessionManager) {
          self.recordingStatus_ = DISABLED;
          return;
        }
        if (err) {
          self.instance_.register_for_session({[SDK_DEBUG_RECORDING_SCRIPT_NOT_LOADED]: true});
          logger.error('could not load recorder', err);
          return;
        }
        self.onScriptLoaded_(startReason);
      });
    } else {
      this.onScriptLoaded_(startReason);
    }
  }

  stopRecording() {
    if (this.persistFlagsOnSessionListener_) this.persistFlagsOnSessionListener_();
    this.persistFlagsOnSessionListener_ = undefined;
    if (this.lazyLoadedSessionRecording_) this.lazyLoadedSessionRecording_.stop();
  }

  /**
   * @param {boolean=} discardProducerEvents
   * @private
   */
  discardRecording_(discardProducerEvents) {
    if (this.persistFlagsOnSessionListener_) this.persistFlagsOnSessionListener_();
    this.persistFlagsOnSessionListener_ = undefined;
    if (this.lazyLoadedSessionRecording_) this.lazyLoadedSessionRecording_.discard(!!discardProducerEvents);
  }

  /** @private */
  resetSampling_() {
    const p = this.instance_.persistence;
    if (p) {
      p.unregister(SESSION_RECORDING_IS_SAMPLED);
      p.unregister(SESSION_RECORDING_SAMPLE_RATE);
    }
  }

  /**
   * @param {*} rate
   * @param {string} source
   * @return {?number}
   * @private
   */
  validateSampleRate_(rate, source) {
    if (isNullish(rate)) return null;
    const parsed = isNumber(rate) ? /** @type {number} */ (rate) : parseFloat(/** @type {string} */ (rate));
    if (!isValidSampleRate(parsed)) {
      logger.warn(source + ' must be between 0 and 1. Ignoring invalid value:', rate);
      return null;
    }
    return parsed;
  }

  /**
   * @param {!Object} response the remote config
   * @private
   */
  persistRemoteConfig_(response) {
    const persistence = this.instance_.persistence;
    if (!persistence) return;
    const self = this;
    const persistResponse = function() {
      const sr = response['sessionRecording'] === false ? undefined : response['sessionRecording'];
      const get = function(k) {
        return sr ? sr[k] : undefined;
      };
      const clientSr = self.instance_.config['session_recording'];
      const localSampleRate = self.validateSampleRate_(clientSr ? clientSr['sampleRate'] : undefined,
          'session_recording.sampleRate');
      const remoteSampleRate = self.validateSampleRate_(get('sampleRate'), 'remote config sampleRate');
      const parsedSampleRate = isNullish(localSampleRate) ? remoteSampleRate : localSampleRate;
      if (isNullish(parsedSampleRate)) self.resetSampling_();
      const receivedMinimumDuration = get('minimumDurationMilliseconds');
      const config = {'cache_timestamp': Date.now(), 'enabled': !!sr};
      if (sr) for (const k in sr) config[k] = sr[k];
      const networkPayloadCapture = {'capturePerformance': response['capturePerformance']};
      const npc = get('networkPayloadCapture');
      if (npc) for (const k in npc) networkPayloadCapture[k] = npc[k];
      config['networkPayloadCapture'] = networkPayloadCapture;
      config['canvasRecording'] = {
        'enabled': get('recordCanvas'),
        'fps': get('canvasFps'),
        'quality': get('canvasQuality'),
      };
      config['sampleRate'] = parsedSampleRate;
      config['minimumDurationMilliseconds'] = isUndefined(receivedMinimumDuration) ? null : receivedMinimumDuration;
      config['endpoint'] = get('endpoint');
      config['triggerMatchType'] = get('triggerMatchType');
      config['masking'] = get('masking');
      config['urlTriggers'] = get('urlTriggers');
      config['version'] = get('version');
      config['triggerGroups'] = get('triggerGroups');
      persistence.register({[SESSION_RECORDING_REMOTE_CONFIG]: config});
    };
    persistResponse();
    if (this.persistFlagsOnSessionListener_) this.persistFlagsOnSessionListener_();
    this.persistFlagsOnSessionListener_ = this.instance_.sessionManager ?
        this.instance_.sessionManager.onSessionId(persistResponse) : undefined;
  }

  /**
   * Remote config result (null when loading failed).
   * @param {?Object} response
   */
  handleRemoteConfig(response) {
    if (!response || !('sessionRecording' in response)) {
      if (this.recordingStatus_ === AWAITING_CONFIG) {
        this.recordingStatus_ = MISSING_CONFIG;
        this.instance_.register_for_session({[SDK_DEBUG_REPLAY_STALE_CONFIG]: true});
        logger.warn('config refresh failed, recording will not start until page reload');
      }
      this.startIfEnabledOrStop();
      return;
    }
    if (response['sessionRecording'] === false) {
      this.persistRemoteConfig_(response);
      this.discardRecording_();
      return;
    }
    this.persistRemoteConfig_(response);
    this.startIfEnabledOrStop();
  }

  /**
   * @param {string} message
   * @param {string=} level
   */
  log(message, level) {
    if (this.lazyLoadedSessionRecording_) this.lazyLoadedSessionRecording_.log(message, level || 'log');
    else logger.warn('log called before recorder was ready');
  }

  /**
   * @return {boolean}
   * @private
   */
  isRemoteConfigFresh_() {
    const persisted = this.instance_.get_property(SESSION_RECORDING_REMOTE_CONFIG);
    if (!persisted) return false;
    let config;
    try {
      config = typeof persisted === 'object' ? persisted : JSON.parse(/** @type {string} */ (persisted));
    } catch (e) {
      logger.warn('persisted remote config for session recording is invalid and will be ignored', e);
      return false;
    }
    if (isNullish(config['cache_timestamp'])) return false;
    return Date.now() - config['cache_timestamp'] <= RECORDING_REMOTE_CONFIG_TTL_MS;
  }

  /**
   * @param {string=} startReason
   * @private
   */
  onScriptLoaded_(startReason) {
    if (this.sessionRecordingDisposed_ || !this.isRecordingEnabled_() || !this.instance_.sessionManager) {
      this.recordingStatus_ = DISABLED;
      return;
    }
    if (!getRRWebRecord()) {
      logger.warn('Called on script loaded before session recording is available. This can be caused by adblockers.');
      this.instance_.register_for_session({[SDK_DEBUG_RECORDING_SCRIPT_NOT_LOADED]: true});
      return;
    }
    if (!this.lazyLoadedSessionRecording_) {
      this.lazyLoadedSessionRecording_ = new LazyLoadedSessionRecording(this.instance_, this.documentWasEverVisible_);
      this.lazyLoadedSessionRecording_.forceAllowLocalhostNetworkCapture =
          !!this.forceAllowLocalhostNetworkCapture;
    }
    if (!this.isRemoteConfigFresh_()) {
      if (this.recordingStatus_ === MISSING_CONFIG || this.recordingStatus_ === AWAITING_CONFIG) return;
      this.recordingStatus_ = AWAITING_CONFIG;
      logger.info('persisted remote config is stale, requesting fresh config before starting');
      if (this.instance_.remoteConfigLoader) this.instance_.remoteConfigLoader.load();
      return;
    }
    this.recordingStatus_ = LAZY_LOADING;
    this.lazyLoadedSessionRecording_.setDocumentWasEverVisible(this.documentWasEverVisible_);
    this.lazyLoadedSessionRecording_.start(startReason);
  }

  /**
   * Kept on the public API like upstream (deprecated there).
   * @param {*} rawEvent
   */
  onRRwebEmit(rawEvent) {
    if (this.lazyLoadedSessionRecording_) this.lazyLoadedSessionRecording_.onRRwebEmit(rawEvent);
  }

  overrideLinkedFlag() {
    if (!this.lazyLoadedSessionRecording_ && this.instance_.persistence) {
      this.instance_.persistence.register({[SESSION_RECORDING_OVERRIDE_LINKED_FLAG]: true});
    }
    if (this.lazyLoadedSessionRecording_) this.lazyLoadedSessionRecording_.overrideLinkedFlag();
  }

  overrideSampling() {
    if (!this.lazyLoadedSessionRecording_ && this.instance_.persistence) {
      this.instance_.persistence.register({[SESSION_RECORDING_OVERRIDE_SAMPLING]: true});
    }
    if (this.lazyLoadedSessionRecording_) this.lazyLoadedSessionRecording_.overrideSampling();
  }

  /** @param {string} triggerType 'url' | 'event' */
  overrideTrigger(triggerType) {
    if (!this.lazyLoadedSessionRecording_ && this.instance_.persistence) {
      this.instance_.persistence.register({
        [triggerType === 'url' ? SESSION_RECORDING_OVERRIDE_URL_TRIGGER : SESSION_RECORDING_OVERRIDE_EVENT_TRIGGER]:
            true,
      });
    }
    if (this.lazyLoadedSessionRecording_) this.lazyLoadedSessionRecording_.overrideTrigger(triggerType);
  }

  /**
   * Debug properties added to events (upstream `sdkDebugProperties`).
   * @return {!Object}
   */
  getSdkDebugProperties() {
    const properties = {};
    const sp = this.instance_.sessionPersistence;
    SESSION_DEBUG_PROPERTY_KEYS.forEach(function(key) {
      const value = sp ? sp.get_property(key) : undefined;
      if (!isUndefined(value)) properties[key] = value;
    });
    const recorder = this.lazyLoadedSessionRecording_ ? this.lazyLoadedSessionRecording_.sdkDebugProperties() :
        {'$recording_status': this.getStatus()};
    for (const k in recorder) properties[k] = recorder[k];
    return properties;
  }

  /**
   * @param {string} tag
   * @param {*} payload
   * @return {boolean}
   */
  tryAddCustomEvent(tag, payload) {
    return !!this.lazyLoadedSessionRecording_ && this.lazyLoadedSessionRecording_.tryAddCustomEvent(tag, payload);
  }

  flushBeforeIdentityReset() {
    if (this.lazyLoadedSessionRecording_) this.lazyLoadedSessionRecording_.flushBeforeIdentityReset();
  }
}

/** Exposes upstream's public names on `posthog.sessionRecording`. */
export function exportSessionRecordingApi() {
  const p = SessionRecording.prototype;
  p['initialize'] = p.initialize;
  p['startIfEnabledOrStop'] = p.startIfEnabledOrStop;
  p['stopRecording'] = p.stopRecording;
  p['dispose'] = /** @this {!SessionRecording} */ function(options) {
    this.disposeRecording(!!(options && options['discardBufferedEvents']));
  };
  p['onRemoteConfig'] = /** @this {!SessionRecording} */ function(result) {
    this.handleRemoteConfig(normalizeRemoteConfigArg(result));
  };
  p['log'] = p.log;
  p['onRRwebEmit'] = p.onRRwebEmit;
  p['overrideLinkedFlag'] = p.overrideLinkedFlag;
  p['overrideSampling'] = p.overrideSampling;
  p['overrideTrigger'] = p.overrideTrigger;
  p['tryAddCustomEvent'] = p.tryAddCustomEvent;
  p['flushBeforeIdentityReset'] = p.flushBeforeIdentityReset;
  Object.defineProperty(p, '_forceAllowLocalhostNetworkCapture', {
    get: /** @this {!SessionRecording} */ function() {
      return this.forceAllowLocalhostNetworkCapture;
    },
    set: /** @this {!SessionRecording} */ function(v) {
      this.forceAllowLocalhostNetworkCapture = !!v;
    },
  });
  Object.defineProperty(p, 'started', {get: /** @this {!SessionRecording} */ function() {
    return this.isStarted();
  }});
  Object.defineProperty(p, 'status', {get: /** @this {!SessionRecording} */ function() {
    return this.getStatus();
  }});
  Object.defineProperty(p, 'sdkDebugProperties', {get: /** @this {!SessionRecording} */ function() {
    return this.getSdkDebugProperties();
  }});
}
