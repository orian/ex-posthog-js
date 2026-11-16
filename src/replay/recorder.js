/**
 * @fileoverview Port of upstream replay/external/lazy-loaded-session-recorder.ts
 * (the PostHog logic upstream ships in lazy-recorder.js). rrweb itself comes
 * from the recorder.js script (`window.__PosthogExtensions__.rrweb.record`
 * and `.rrwebPlugins`), always accessed with quoted names. rrweb events,
 * custom-event payloads, the buffer and persisted values use quoted keys.
 */
import {PostHog} from '../core/posthog.js';
import {logger as baseLogger} from '../core/logger.js';
import {Config} from '../core/constants.js';
import {sessionStore} from '../core/storage.js';
import {
  addEventListener, clampToRange, doc, isArray, isBoolean, isFunction, isNull, isNullish, isNumber, isObject,
  isUndefined, maskQueryParams, stripUrlHash, win,
} from '../core/utils.js';
import {PERSONAL_DATA_CAMPAIGN_PARAMS} from '../core/constants.js';
import {
  ACTIVE, BUFFERING, DISABLED, PAUSED, RECORDING_REMOTE_CONFIG_TTL_MS, SAMPLED,
  SDK_DEBUG_REPLAY_PENDING_TRIGGER_CONDITIONS, SDK_DEBUG_REPLAY_RRWEB_ATTACHED, SDK_DEBUG_REPLAY_RRWEB_START_ATTEMPTED,
  SESSION_RECORDING_EVENT_TRIGGER_ACTIVATED_SESSION, SESSION_RECORDING_FIRST_FULL_SNAPSHOT_TIMESTAMP,
  SESSION_RECORDING_IS_SAMPLED, SESSION_RECORDING_OVERRIDE_EVENT_TRIGGER, SESSION_RECORDING_OVERRIDE_LINKED_FLAG,
  SESSION_RECORDING_OVERRIDE_SAMPLING, SESSION_RECORDING_OVERRIDE_URL_TRIGGER,
  SESSION_RECORDING_PAST_MINIMUM_DURATION, SESSION_RECORDING_REMOTE_CONFIG, SESSION_RECORDING_SAMPLE_RATE,
  SESSION_RECORDING_START_REASON, SESSION_RECORDING_URL_TRIGGER_ACTIVATED_SESSION,
} from './constants.js';
import {EventTriggerMatching, LinkedFlagMatching, URLTriggerMatching} from './trigger-matching.js';
import {
  RecordingStrategy, RecordingStrategyContext, V1RecordingStrategy, V2TriggerGroupStrategy, decodeSamplingDecision,
} from './recording-strategies.js';
import {
  CANVAS_MUTATION_SOURCE_TYPE, CUSTOM_EVENT_TYPE, FULL_SNAPSHOT_EVENT_TYPE, FlushedSizeTracker,
  INCREMENTAL_SNAPSHOT_EVENT_TYPE, META_EVENT_TYPE, MUTATION_SOURCE_TYPE, MutationThrottler,
  STYLE_SHEET_RULE_SOURCE_TYPE, UNSTRINGIFIABLE_EVENT_SIZE, buildNetworkRequestOptions, circularReferenceReplacer,
  estimateCompressedEventSize, estimateSize, splitBuffer, truncateLargeConsoleLogs,
} from './utils.js';
import {
  gzipField, gzipFieldAsync, gzipToString, gzipToStringAsync, isGzipSupported, isNativeAsyncGzipError,
} from './gzip-field.js';
import {JSON_LD_EVENT_TAG, startJsonLdCapture} from './json-ld.js';

const BASE_ENDPOINT = '/s/';
const DEFAULT_CANVAS_QUALITY = 0.4;
const DEFAULT_CANVAS_FPS = 4;
const MAX_CANVAS_FPS = 12;
const MAX_CANVAS_QUALITY = 1;
const MIN_CANVAS_SCALE = 0.1;
const TWO_SECONDS = 2000;
const ONE_KB = 1024;
const ONE_MINUTE = 1000 * 60;
const FIVE_MINUTES = ONE_MINUTE * 5;
const ONE_HOUR = ONE_MINUTE * 60;
const MIN_TRIGGER_PENDING_BUFFER_INTERVAL_MILLIS = 1000;
const MAX_TRIGGER_PENDING_BUFFER_INTERVAL_MILLIS = ONE_HOUR;
const SLOW_FULL_SNAPSHOT_THRESHOLD_MS = 500;
const MASKED = '<masked>';
const LOCAL_DOMAINS = ['localhost', '127.0.0.1'];

/** @const {number} */ export const RECORDING_IDLE_THRESHOLD_MS = FIVE_MINUTES;
/** @const {number} */ export const RECORDING_MAX_EVENT_SIZE = ONE_KB * ONE_KB * 0.9;
/** @const {number} */ export const RECORDING_BUFFER_TIMEOUT = 2000;
/** @const {string} */ export const SESSION_RECORDING_BATCH_KEY = 'recordings';
/** @const {string} */ export const PENDING_BUFFER_STORAGE_SUFFIX = '_replay_pending_buffer';

const LOGGER_PREFIX = '[SessionRecording]';
const logger = baseLogger.createLogger(LOGGER_PREFIX);

// IncrementalSource values that count as user activity.
const ACTIVE_SOURCES = [
  1, // MouseMove
  2, // MouseInteraction
  3, // Scroll
  4, // ViewportResize
  5, // Input
  6, // TouchMove
  7, // MediaInteraction
  12, // Drag
];

/** @typedef {{rrwebMethod: function(), attempt: number, enqueuedAt: number}} */
let QueuedRRWebEvent;

/**
 * @typedef {{event: !Object, compressionEnabled: boolean, targetSessionId: string, targetWindowId: string,
 *     generation: number, processed: boolean, counted: boolean}}
 */
let QueuedCompressionEvent;

/** @typedef {{event: !Object, size: number}} */
let CompressedEventResult;

/**
 * @param {function()} rrwebMethod
 * @return {!QueuedRRWebEvent}
 */
function newQueuedEvent(rrwebMethod) {
  return {rrwebMethod: rrwebMethod, enqueuedAt: Date.now(), attempt: 1};
}

/** @return {?} `__PosthogExtensions__.rrweb` from recorder.js */
export function getRRWeb() {
  const ext = win ? win['__PosthogExtensions__'] : undefined;
  return ext ? ext['rrweb'] : undefined;
}

/** @return {?} the rrweb `record` function */
export function getRRWebRecord() {
  const rrweb = getRRWeb();
  return rrweb ? rrweb['record'] : undefined;
}

/** @return {?} `__PosthogExtensions__.rrwebPlugins` */
function getRRWebPlugins() {
  const ext = win ? win['__PosthogExtensions__'] : undefined;
  return ext ? ext['rrwebPlugins'] : undefined;
}

const nativeAsyncGzipSupported = isGzipSupported();
let nativeAsyncGzipDisabled = false;

/**
 * @param {!Object} event
 * @return {boolean}
 */
function shouldCompressEvent(event) {
  return event['type'] === FULL_SNAPSHOT_EVENT_TYPE ||
      (event['type'] === INCREMENTAL_SNAPSHOT_EVENT_TYPE &&
       (event['data']['source'] === MUTATION_SOURCE_TYPE || event['data']['source'] === STYLE_SHEET_RULE_SOURCE_TYPE));
}

/**
 * @param {!Object} event
 * @return {boolean}
 */
function shouldUseNativeAsyncGzip(event) {
  return nativeAsyncGzipSupported && !nativeAsyncGzipDisabled && shouldCompressEvent(event);
}

/**
 * @param {!Object} event
 * @return {!CompressedEventResult}
 */
function compressedResult(event) {
  return {event: event, size: estimateCompressedEventSize(event)};
}

/**
 * @param {!Object} event
 * @param {string} data
 * @return {!Object}
 */
function buildCompressedFullSnapshotEvent(event, data) {
  const out = {};
  for (const k in event) out[k] = event[k];
  out['data'] = data;
  out['cv'] = '2024-10';
  return out;
}

/**
 * @param {!Object} event
 * @param {!Object} fields
 * @return {!Object}
 */
function buildCompressedIncrementalEvent(event, fields) {
  const out = {};
  for (const k in event) out[k] = event[k];
  out['cv'] = '2024-10';
  const data = {};
  for (const k in event['data']) data[k] = event['data'][k];
  for (const k in fields) data[k] = fields[k];
  out['data'] = data;
  return out;
}

/**
 * @param {!Object} event
 * @return {!CompressedEventResult}
 */
function compressEventSync(event) {
  try {
    if (event['type'] === FULL_SNAPSHOT_EVENT_TYPE) {
      return compressedResult(buildCompressedFullSnapshotEvent(event,
          gzipToString(event['data'], circularReferenceReplacer)));
    }
    if (event['type'] === INCREMENTAL_SNAPSHOT_EVENT_TYPE && event['data']['source'] === MUTATION_SOURCE_TYPE) {
      const d = event['data'];
      return compressedResult(buildCompressedIncrementalEvent(event, {
        'texts': gzipField(d['texts'], circularReferenceReplacer),
        'attributes': gzipField(d['attributes'], circularReferenceReplacer),
        'removes': gzipField(d['removes'], circularReferenceReplacer),
        'adds': gzipField(d['adds'], circularReferenceReplacer),
      }));
    }
    if (event['type'] === INCREMENTAL_SNAPSHOT_EVENT_TYPE && event['data']['source'] === STYLE_SHEET_RULE_SOURCE_TYPE) {
      const d = event['data'];
      return compressedResult(buildCompressedIncrementalEvent(event, {
        'adds': d['adds'] ? gzipToString(d['adds'], circularReferenceReplacer) : undefined,
        'removes': d['removes'] ? gzipToString(d['removes'], circularReferenceReplacer) : undefined,
      }));
    }
  } catch (e) {
    logger.warn('could not compress event - will use uncompressed event', e);
  }
  return {event: event, size: estimateSize(event)};
}

/**
 * @param {!Object} event
 * @return {!Promise<!CompressedEventResult>}
 */
function compressEventAsync(event) {
  let p;
  try {
    if (event['type'] === FULL_SNAPSHOT_EVENT_TYPE) {
      p = gzipToStringAsync(event['data'], circularReferenceReplacer).then(function(data) {
        return compressedResult(buildCompressedFullSnapshotEvent(event, data));
      });
    } else if (event['type'] === INCREMENTAL_SNAPSHOT_EVENT_TYPE &&
        event['data']['source'] === MUTATION_SOURCE_TYPE) {
      const d = event['data'];
      p = Promise.all([
        gzipFieldAsync(d['texts'], circularReferenceReplacer),
        gzipFieldAsync(d['attributes'], circularReferenceReplacer),
        gzipFieldAsync(d['removes'], circularReferenceReplacer),
        gzipFieldAsync(d['adds'], circularReferenceReplacer),
      ]).then(function(r) {
        return compressedResult(buildCompressedIncrementalEvent(event,
            {'texts': r[0], 'attributes': r[1], 'removes': r[2], 'adds': r[3]}));
      });
    } else if (event['type'] === INCREMENTAL_SNAPSHOT_EVENT_TYPE &&
        event['data']['source'] === STYLE_SHEET_RULE_SOURCE_TYPE) {
      const d = event['data'];
      p = Promise.all([
        d['adds'] ? gzipToStringAsync(d['adds'], circularReferenceReplacer) : undefined,
        d['removes'] ? gzipToStringAsync(d['removes'], circularReferenceReplacer) : undefined,
      ]).then(function(r) {
        return compressedResult(buildCompressedIncrementalEvent(event, {'adds': r[0], 'removes': r[1]}));
      });
    } else {
      return Promise.resolve({event: event, size: estimateSize(event)});
    }
  } catch (e) {
    p = Promise.reject(e);
  }
  return p.then(undefined, function(e) {
    if (isNativeAsyncGzipError(e)) nativeAsyncGzipDisabled = true;
    logger.warn('could not compress event asynchronously - trying synchronous compression', e);
    return compressEventSync(event);
  });
}

/**
 * @param {!Object} e
 * @param {string} tag
 * @return {boolean}
 */
function isCustomEvent(e, tag) {
  return e['type'] === CUSTOM_EVENT_TYPE && e['data']['tag'] === tag;
}

/**
 * @param {!Object} e
 * @return {?Object}
 */
function getSessionIdlePayload(e) {
  return isCustomEvent(e, 'sessionIdle') ? e['data']['payload'] : null;
}

/**
 * @param {!Object} e
 * @return {boolean}
 */
function isSessionEndingEvent(e) {
  return isCustomEvent(e, '$session_ending');
}

/**
 * @param {!Object} e
 * @return {boolean}
 */
function isSessionStartingEvent(e) {
  return isCustomEvent(e, '$session_starting');
}

/**
 * @param {!Object} e
 * @return {boolean}
 */
function isAllowedWhenIdle(e) {
  return isCustomEvent(e, 'sessionIdle') || isSessionEndingEvent(e) || isSessionStartingEvent(e);
}

/**
 * @param {!Object} e
 * @return {boolean}
 */
function isMirrorDesyncingWhenDropped(e) {
  if (e['type'] === FULL_SNAPSHOT_EVENT_TYPE || e['type'] === META_EVENT_TYPE) return true;
  return e['type'] === INCREMENTAL_SNAPSHOT_EVENT_TYPE && e['data']['source'] !== CANVAS_MUTATION_SOURCE_TYPE;
}

/**
 * @param {!Object} e
 * @return {boolean}
 */
function isRecordingPausedEvent(e) {
  return e['type'] === CUSTOM_EVENT_TYPE && e['data']['tag'] === 'recording paused';
}

/**
 * @param {*} config capture_performance
 * @return {boolean|undefined}
 */
function networkTimingFromConfig(config) {
  return isObject(config) ? config['network_timing'] : /** @type {boolean|undefined} */ (config);
}

/** @return {boolean} */
function isLocalhost() {
  return !!win && LOCAL_DOMAINS.indexOf(win.location.hostname) !== -1;
}

/**
 * @param {string} url
 * @return {?}
 */
function newURL(url) {
  const U = win['URL'];
  return new U(url);
}

/**
 * @typedef {{cancelled: boolean, cancel: function()}}
 */
let Cancellation;

/** @param {?Cancellation} cancellation */
function cancelHandoff(cancellation) {
  if (cancellation) cancellation.cancel();
}


export class LazyLoadedSessionRecording {
  /**
   * @param {!PostHog} instance
   * @param {boolean=} documentWasEverVisible
   */
  constructor(instance, documentWasEverVisible) {
    /** @private @const */
    this.instance_ = instance;
    /** @private {string} */
    this.endpoint_ = BASE_ENDPOINT;
    /** @private {?MutationThrottler} */
    this.mutationThrottler_ = null;
    /** @type {boolean} */
    this.forceAllowLocalhostNetworkCapture = false;
    /** @private {(function()|undefined)} */
    this.stopRrweb_ = undefined;
    /** @private {?Cancellation} */
    this.styleRuleSourceHandoff_ = null;
    /** @private {?{scan: function(boolean=), stop: function()}} */
    this.jsonLdCapture_ = null;
    /** @private {boolean} */
    this.jsonLdCaptureReady_ = false;
    /** @private {number} */
    this.lastActivityTimestamp_ = Date.now();
    /** @private {number} */
    this.sessionStartTimestamp_ = 0;
    /** @private {boolean} */
    this.isActivatingTrigger_ = false;
    /** @private {string|undefined} */
    this.lastHref_ = undefined;
    /** @private {!Array<!QueuedRRWebEvent>} */
    this.queuedRRWebEvents_ = [];
    /** @private {boolean|string} true, false or 'unknown' */
    this.isIdle_ = 'unknown';
    /** @private {number} */
    this.eventsDroppedWhileIdle_ = 0;
    /** @private {number} */
    this.throttledMutationsDropped_ = 0;
    /** @private {number} */
    this.oversizedMutationsDropped_ = 0;
    /** @private {number} */
    this.oversizedMutationBytesDropped_ = 0;
    /** @private {number} */
    this.unstringifiableEventsDropped_ = 0;
    /** @private {boolean} */
    this.holdFlushUntilInteraction_ = false;
    /** @private {string|undefined} */
    this.flushHoldReason_ = undefined;
    /** @private {string|undefined} */
    this.lastLoggedFlushHold_ = undefined;
    /** @private {boolean} */
    this.heldEpochShipsOnUnload_ = false;
    /** @private {boolean} */
    this.documentWasEverVisible_ = isUndefined(documentWasEverVisible) ? true : !!documentWasEverVisible;
    /** @private {boolean} */
    this.heldBufferOverflowed_ = false;
    /** @private {boolean} */
    this.suppressNextFreshStartHold_ = false;
    /** @private {boolean} */
    this.rrwebError_ = false;
    /** @private {boolean} */
    this.rrwebStartAttempted_ = false;
    /** @private {*} */
    this.lastSeenSnapshotCost_ = undefined;
    /** @private {boolean} */
    this.snapshotCostErrorLogged_ = false;
    /** @private {boolean} */
    this.hasWarnedClientMaskingOverride_ = false;
    /** @private {boolean} */
    this.hasWarnedExclusiveAttributeMasking_ = false;
    /** @private {boolean} */
    this.maskRegionsFnFailed_ = false;
    /** @private {boolean} */
    this.hasLoggedRecorderCallbackError_ = false;
    /** @private {!RecordingStrategy|undefined} */
    this.strategy_ = undefined;
    /** @private {number|undefined} */
    this.fullSnapshotTimer_ = undefined;
    /** @private {string|undefined} */
    this.lastFullSnapshotSessionId_ = undefined;
    /** @private {string|undefined} */
    this.fullSnapshotHealAttemptedFor_ = undefined;
    /** @private {number|undefined} */
    this.flushBufferTimer_ = undefined;
    /** @private {boolean} */
    this.pendingBufferRestored_ = false;
    /** @private {number|undefined} */
    this.lastParkedBufferSize_ = undefined;
    /** @private {?Promise<void>} */
    this.compressionQueue_ = null;
    /** @private {!Array<!QueuedCompressionEvent>} */
    this.pendingCompressionEvents_ = [];
    /** @private {number} */
    this.queuedCompressionEvents_ = 0;
    /** @private {number} */
    this.compressionQueueGeneration_ = 0;
    /** @private {boolean} */
    this.isStoppingAfterCompression_ = false;
    /** @private {(function()|undefined)} */
    this.removePageViewCaptureHook_ = undefined;
    /** @private {(function()|undefined)} */
    this.removeEventTriggerCaptureHook_ = undefined;
    /** @private {(function()|undefined)} */
    this.onSessionIdListener_ = undefined;
    /** @private {(function()|undefined)} */
    this.onSessionIdleResetForcedListener_ = undefined;
    /** @private {(function()|undefined)} */
    this.forceIdleSessionIdListener_ = undefined;
    /** @private {boolean} */
    this.isRestartingForSessionIdChange_ = false;
    /** @private {string|undefined} */
    this.lastLoggedBufferingReason_ = undefined;

    const s = this.sessionManager_().checkAndGetSessionAndWindowId();
    /** @private {string} */
    this.sessionId_ = s.sessionId;
    /** @private {string} */
    this.windowId_ = s.windowId;
    this.sessionStartTimestamp_ = s.sessionStartTimestamp;

    /** @private @const */
    this.linkedFlagMatching_ = new LinkedFlagMatching(instance);
    /** @private @const */
    this.urlTriggerMatching_ = new URLTriggerMatching(instance);
    /** @private @const */
    this.eventTriggerMatching_ = new EventTriggerMatching(instance);

    /** @private {!Object} SnapshotBuffer (quoted keys) */
    this.buffer_ = {};
    this.clearBuffer_();
    const persistenceName = instance.config['persistence_name'] || instance.config['token'];
    /** @private @const {string} */
    this.pendingBufferStorageKey_ = 'ph' + PENDING_BUFFER_STORAGE_SUFFIX + '_' +
        JSON.stringify([persistenceName, instance.config['token']]);

    if (this.sessionIdleThresholdMilliseconds_() >= this.sessionManager_().sessionTimeoutMs) {
      logger.warn('session_idle_threshold_ms (' + this.sessionIdleThresholdMilliseconds_() +
          ') is greater than the session timeout (' + this.sessionManager_().sessionTimeoutMs +
          '). Session will never be detected as idle');
    }
    /** @private @const */
    this.flushedSizeTracker_ = new FlushedSizeTracker(instance);

    const self = this;
    /** @private @const */
    this.onBeforeUnloadBound_ = function() {
      self.onBeforeUnload_();
    };
    /** @private @const */
    this.onPageHideBound_ = function() {
      self.onBeforeUnload_();
    };
    /** @private @const */
    this.onOfflineBound_ = function() {
      self.tryAddCustomEvent_('browser offline', {});
    };
    /** @private @const */
    this.onOnlineBound_ = function() {
      self.tryAddCustomEvent_('browser online', {});
    };
    /** @private @const */
    this.onVisibilityChangeBound_ = function() {
      if (doc && doc.visibilityState) {
        if (doc.visibilityState === 'visible') self.documentWasEverVisible_ = true;
        self.tryAddCustomEvent_('window ' + doc.visibilityState, {});
      }
    };
    /**
     * @private @const
     * @type {function(string, string, (!Object|undefined))}
     */
    this.onSessionIdCallbackBound_ = function(sessionId, windowId, changeReason) {
      self.onSessionIdCallback_(sessionId, windowId, changeReason);
    };
  }

  /** @return {string} */
  sessionId() {
    return this.sessionId_;
  }

  /**
   * @return {!SessionManagerLike}
   * @private
   */
  sessionManager_() {
    if (!this.instance_.sessionManager) {
      throw new Error(LOGGER_PREFIX + ' must be started with a valid sessionManager.');
    }
    return /** @type {!SessionManagerLike} */ (this.instance_.sessionManager);
  }

  /**
   * @return {!Object}
   * @private
   */
  srConfig_() {
    return this.instance_.config['session_recording'] || {};
  }

  /**
   * @return {number}
   * @private
   */
  sessionIdleThresholdMilliseconds_() {
    return this.srConfig_()['session_idle_threshold_ms'] || RECORDING_IDLE_THRESHOLD_MS;
  }

  /**
   * @return {?boolean}
   * @private
   */
  isSampled_() {
    return decodeSamplingDecision(this.instance_.get_property(SESSION_RECORDING_IS_SAMPLED), this.sessionId_);
  }

  /**
   * @return {?number}
   * @private
   */
  minimumDuration_() {
    if (!this.strategy_) return null;
    const d = this.strategy_.getMinimumDuration(this.sessionId_);
    return isNullish(d) ? null : d;
  }

  /** @param {boolean} documentWasEverVisible */
  setDocumentWasEverVisible(documentWasEverVisible) {
    if (documentWasEverVisible) this.documentWasEverVisible_ = true;
  }

  /**
   * @return {?Object}
   * @private
   */
  masking_() {
    const rc = this.remoteConfig();
    const server = rc ? rc['masking'] : undefined;
    const client = this.srConfig_();
    const pick = function(k) {
      const c = client[k];
      return !isNullish(c) ? c : (server ? server[k] : undefined);
    };
    const maskAllInputs = pick('maskAllInputs');
    const maskTextSelector = pick('maskTextSelector');
    const blockSelector = pick('blockSelector');
    const maskAllElementAttributes = pick('maskAllElementAttributes');
    return !isUndefined(maskAllInputs) || !isUndefined(maskTextSelector) || !isUndefined(blockSelector) ||
        !isUndefined(maskAllElementAttributes) ? {
          'maskAllInputs': isNullish(maskAllInputs) ? true : maskAllInputs,
          'maskTextSelector': maskTextSelector,
          'blockSelector': blockSelector,
          'maskAllElementAttributes': maskAllElementAttributes,
        } : null;
  }

  /** @private */
  warnIfClientMaskingShadowsServer_() {
    if (this.hasWarnedClientMaskingOverride_) return;
    const rc = this.remoteConfig();
    const server = rc ? rc['masking'] : undefined;
    if (isNullish(server)) return;
    const client = this.srConfig_();
    const divergent = ['maskAllInputs', 'maskTextSelector', 'blockSelector', 'maskAllElementAttributes']
        .filter(function(field) {
          const clientValue = client[field];
          return !isUndefined(clientValue) && clientValue !== server[field];
        });
    if (divergent.length === 0) return;
    this.hasWarnedClientMaskingOverride_ = true;
    logger.warn('Session recording masking is configured both in `posthog.init` and in your project settings, ' +
        'and they differ. The `session_recording` options in `posthog.init` take precedence, so the project ' +
        '("Privacy and masking") setting is ignored for: ' + divergent.join(', ') + '. Remove these masking ' +
        'options from `posthog.init` to use the project setting instead. ' +
        'See https://posthog.com/docs/session-replay/privacy', {
          'client': {
            'maskAllInputs': client['maskAllInputs'], 'maskTextSelector': client['maskTextSelector'],
            'blockSelector': client['blockSelector'], 'maskAllElementAttributes': client['maskAllElementAttributes'],
          },
          'project': server,
        });
  }

  /**
   * @return {number}
   * @private
   */
  canvasResolutionScale_() {
    const cc = this.srConfig_()['canvasCapture'];
    return clampToRange(cc ? cc['resolutionScale'] : undefined, MIN_CANVAS_SCALE, 1, 1);
  }

  /**
   * @return {{enabled: boolean, fps: number, quality: number}}
   * @private
   */
  canvasRecording_() {
    const client = this.srConfig_()['captureCanvas'];
    const rc = this.remoteConfig();
    const server = rc ? rc['canvasRecording'] : undefined;
    const first = function(clientKey, serverKey, dflt) {
      const c = client ? client[clientKey] : undefined;
      if (!isNullish(c)) return c;
      const s = server ? server[serverKey] : undefined;
      return isNullish(s) ? dflt : s;
    };
    const enabled = first('recordCanvas', 'enabled', false);
    const fps = first('canvasFps', 'fps', DEFAULT_CANVAS_FPS);
    let quality = first('canvasQuality', 'quality', DEFAULT_CANVAS_QUALITY);
    if (typeof quality === 'string') {
      const parsed = parseFloat(quality);
      quality = isNaN(parsed) ? 0.4 : parsed;
    }
    return {
      enabled: enabled,
      fps: clampToRange(fps, 0, MAX_CANVAS_FPS, DEFAULT_CANVAS_FPS),
      quality: clampToRange(quality, 0, MAX_CANVAS_QUALITY, DEFAULT_CANVAS_QUALITY),
    };
  }

  /**
   * @return {*}
   * @private
   */
  isConsoleLogCaptureEnabled_() {
    const rc = this.remoteConfig();
    const server = !!(rc && rc['consoleLogRecordingEnabled']);
    const client = this.instance_.config['enable_recording_console_log'];
    return isNullish(client) ? server : client;
  }

  /**
   * @return {?Object}
   * @private
   */
  networkPayloadCapture_() {
    const rc = this.remoteConfig();
    const server = rc ? rc['networkPayloadCapture'] : undefined;
    const sr = this.srConfig_();
    const clientHeaders = sr['recordHeaders'];
    const clientBody = sr['recordBody'];
    const headersEnabled = clientHeaders !== false && (clientHeaders || (server ? server['recordHeaders'] : undefined));
    const bodyEnabled = clientBody !== false && (clientBody || (server ? server['recordBody'] : undefined));
    const clientNetworkTiming = networkTimingFromConfig(this.instance_.config['capture_performance']);
    const serverNetworkTiming = networkTimingFromConfig(server ? server['capturePerformance'] : undefined);
    const networkTimingEnabled = !!(isBoolean(clientNetworkTiming) ? clientNetworkTiming : serverNetworkTiming);
    return headersEnabled || bodyEnabled || networkTimingEnabled ?
        {'recordHeaders': headersEnabled, 'recordBody': bodyEnabled, 'recordPerformance': networkTimingEnabled} :
        null;
  }

  /**
   * @return {!Array<?>}
   * @private
   */
  gatherRRWebPlugins_() {
    const plugins = [];
    const rrwebPlugins = getRRWebPlugins();
    const recordConsolePlugin = rrwebPlugins ? rrwebPlugins['getRecordConsolePlugin'] : undefined;
    if (recordConsolePlugin && this.isConsoleLogCaptureEnabled_()) plugins.push(recordConsolePlugin());
    const networkPlugin = rrwebPlugins ? rrwebPlugins['getRecordNetworkPlugin'] : undefined;
    const npc = this.networkPayloadCapture_();
    if (!!npc && isFunction(networkPlugin)) {
      const canRecordNetwork = !isLocalhost() || this.forceAllowLocalhostNetworkCapture;
      if (canRecordNetwork) {
        // Our request router has no ingestion-endpoint tracking (see README).
        const options = buildNetworkRequestOptions(this.instance_.config, npc, undefined);
        options['captureFetchSynchronously'] = this.instance_.config['__preview_replay_sync_fetch'] === true;
        plugins.push(networkPlugin(options));
      } else {
        logger.info('NetworkCapture not started because we are on localhost.');
      }
    }
    return plugins;
  }

  /**
   * @param {string} url
   * @return {string}
   * @private
   */
  stripUrlHash_(url) {
    return this.instance_.config['disable_capture_url_hashes'] ? /** @type {string} */ (stripUrlHash(url)) : url;
  }

  /**
   * @param {string} url
   * @param {boolean=} forceStripHash
   * @return {string|undefined}
   * @private
   */
  maskReplayUrl_(url, forceStripHash) {
    const href = forceStripHash ? stripUrlHash(url) : this.stripUrlHash_(url);
    const cfg = this.instance_.config;
    const paramsToMask = cfg['mask_personal_data_properties'] ?
        PERSONAL_DATA_CAMPAIGN_PARAMS.concat(cfg['custom_personal_data_properties'] || []) : [];
    return this.maskUrl_(/** @type {string} */ (maskQueryParams(href, paramsToMask, MASKED)));
  }

  /**
   * @param {string} url
   * @return {string|undefined}
   * @private
   */
  maskUrl_(url) {
    const sr = this.srConfig_();
    if (sr['maskCapturedNetworkRequestFn']) {
      const result = sr['maskCapturedNetworkRequestFn']({'name': url});
      if (!result) return undefined;
      return !isNullish(result['name']) ? result['name'] : result['url'];
    }
    if (sr['maskNetworkRequestFn']) {
      const result = sr['maskNetworkRequestFn']({'url': url});
      return result ? result['url'] : undefined;
    }
    return url;
  }

  /**
   * @param {!QueuedRRWebEvent} queued
   * @return {boolean}
   * @private
   */
  tryRRWebMethod_(queued) {
    try {
      queued.rrwebMethod();
      return true;
    } catch (e) {
      if (this.queuedRRWebEvents_.length < 10) {
        this.queuedRRWebEvents_.push({
          enqueuedAt: queued.enqueuedAt || Date.now(),
          attempt: queued.attempt + 1,
          rrwebMethod: queued.rrwebMethod,
        });
      } else {
        logger.warn('could not emit queued rrweb event.', e, queued);
      }
      return false;
    }
  }

  /**
   * @param {string} tag
   * @param {*} payload
   * @return {boolean}
   * @private
   */
  tryAddCustomEvent_(tag, payload) {
    return this.tryRRWebMethod_(newQueuedEvent(function() {
      getRRWebRecord()['addCustomEvent'](tag, payload);
    }));
  }

  /**
   * @return {boolean}
   * @private
   */
  canCaptureJsonLd_() {
    return this.jsonLdCaptureReady_ && this.srConfig_()['captureJsonLd'] === true &&
        !this.urlTriggerMatching_.urlBlocked && this.isIdle_ !== true;
  }

  /**
   * @param {*} jsonLd
   * @return {boolean}
   * @private
   */
  tryAddJsonLdEvent_(jsonLd) {
    if (!this.canCaptureJsonLd_()) return false;
    try {
      const record = getRRWebRecord();
      if (!record) return false;
      record['addCustomEvent'](JSON_LD_EVENT_TAG, jsonLd);
      return this.canCaptureJsonLd_();
    } catch (e) {
      return false;
    }
  }

  /**
   * @param {boolean=} force
   * @private
   */
  scheduleJsonLdScan_(force) {
    const self = this;
    Promise.resolve().then(function() {
      if (self.jsonLdCapture_) self.jsonLdCapture_.scan(!!force);
    });
  }

  /** @private */
  pageViewFallBack_() {
    try {
      if (this.instance_.config['capture_pageview'] || !win) return;
      const url = newURL(win.location.href);
      const currentUrl = this.maskReplayUrl_(url['origin'] + url['pathname'] + url['search']);
      if (this.lastHref_ !== currentUrl) {
        this.lastHref_ = currentUrl;
        this.tryAddCustomEvent_('$url_changed', {'href': currentUrl});
      }
    } catch (e) {
      // If URL processing fails, don't capture anything
    }
  }

  /** @private */
  processQueuedEvents_() {
    if (this.queuedRRWebEvents_.length) {
      const items = this.queuedRRWebEvents_.slice();
      this.queuedRRWebEvents_ = [];
      const self = this;
      items.forEach(function(q) {
        if (Date.now() - q.enqueuedAt <= TWO_SECONDS) self.tryRRWebMethod_(q);
      });
    }
  }

  /**
   * @return {boolean}
   * @private
   */
  tryTakeFullSnapshot_() {
    return this.tryRRWebMethod_(newQueuedEvent(function() {
      getRRWebRecord()['takeFullSnapshot']();
    }));
  }

  /**
   * @return {number}
   * @private
   */
  fullSnapshotIntervalMillis_() {
    const sr = this.srConfig_();
    if (this.strategy_ && this.strategy_.hasPendingTriggers(this.sessionId_) &&
        ['sampled', 'active'].indexOf(this.status()) === -1) {
      const configured = sr['trigger_pending_buffer_interval_millis'];
      return isNumber(configured) && isFinite(configured) && configured >= MIN_TRIGGER_PENDING_BUFFER_INTERVAL_MILLIS &&
          configured <= MAX_TRIGGER_PENDING_BUFFER_INTERVAL_MILLIS ? configured : ONE_MINUTE;
    }
    const v = sr['full_snapshot_interval_millis'];
    return isNullish(v) ? FIVE_MINUTES : v;
  }

  /** @private */
  scheduleFullSnapshot_() {
    if (this.fullSnapshotTimer_) clearInterval(this.fullSnapshotTimer_);
    if (this.isIdle_ === true) return;
    const interval = this.fullSnapshotIntervalMillis_();
    if (!interval) return;
    const self = this;
    this.fullSnapshotTimer_ = setInterval(function() {
      self.tryTakeFullSnapshot_();
    }, interval);
  }

  /**
   * @param {string=} triggerType
   * @private
   */
  onTriggerActivated_(triggerType) {
    if (triggerType === 'event') this.releaseHoldAndFlush_();
    if (this.urlTriggerMatching_.urlBlocked || ['sampled', 'active'].indexOf(this.status()) === -1) return;
    this.scheduleFullSnapshot_();
  }

  /** @private */
  pauseRecording_() {
    if (this.urlTriggerMatching_.urlBlocked) return;
    this.urlTriggerMatching_.urlBlocked = true;
    if (this.jsonLdCapture_) this.jsonLdCapture_.scan();
    clearInterval(this.fullSnapshotTimer_);
    logger.info('recording paused due to URL blocker');
    this.tryAddCustomEvent_('recording paused', {'reason': 'url blocker'});
  }

  /** @private */
  resumeRecording_() {
    if (!this.urlTriggerMatching_.urlBlocked) return;
    if (this.jsonLdCapture_) this.jsonLdCapture_.scan();
    this.urlTriggerMatching_.urlBlocked = false;
    this.tryTakeFullSnapshot_();
    this.scheduleJsonLdScan_();
    this.scheduleFullSnapshot_();
    this.tryAddCustomEvent_('recording resumed', {'reason': 'left blocked url'});
    logger.info('recording resumed');
  }

  /**
   * @param {string} triggerType
   * @param {string=} matchDetail
   * @private
   */
  activateTrigger_(triggerType, matchDetail) {
    if (triggerType === 'event') this.releaseHoldAndFlush_();
    if (this.isActivatingTrigger_) return;
    if (!this.strategy_ || !this.strategy_.hasPendingTriggers(this.sessionId_)) return;
    this.isActivatingTrigger_ = true;
    try {
      const key = triggerType === 'url' ? SESSION_RECORDING_URL_TRIGGER_ACTIVATED_SESSION :
          SESSION_RECORDING_EVENT_TRIGGER_ACTIVATED_SESSION;
      if (this.instance_.persistence) this.instance_.persistence.register({[key]: this.sessionId_});
      if (this.strategy_) this.strategy_.updateActiveTriggers(this.sessionId_);
      this.onTriggerActivated_();
      this.flushBuffer_();
      this.reportStarted_(triggerType + '_trigger_matched',
          {[triggerType === 'url' ? 'matchedUrl' : 'matchedEvent']: matchDetail});
    } finally {
      this.isActivatingTrigger_ = false;
    }
  }

  /** @return {boolean} */
  isStarted() {
    return !!this.stopRrweb_;
  }

  /**
   * The persisted remote config, or undefined when missing or (before
   * recording started) older than the 1h TTL.
   * @return {?Object|undefined}
   */
  remoteConfig() {
    const persisted = this.instance_.get_property(SESSION_RECORDING_REMOTE_CONFIG);
    if (!persisted) return undefined;
    let parsed;
    try {
      parsed = isObject(persisted) ? persisted : JSON.parse(/** @type {string} */ (persisted));
    } catch (e) {
      logger.warn('persisted remote config for session recording is invalid and will be ignored', e);
      return undefined;
    }
    if (!this.isStarted() && !this.isRestartingForSessionIdChange_) {
      const cacheTimestamp = isNullish(parsed['cache_timestamp']) ? Date.now() : parsed['cache_timestamp'];
      if (Date.now() - cacheTimestamp > RECORDING_REMOTE_CONFIG_TTL_MS) {
        logger.info('persisted remote config for session recording is stale and will be ignored',
            {'cacheTimestamp': cacheTimestamp, 'persistedConfig': persisted});
        return undefined;
      }
    }
    return /** @type {!Object} */ (parsed);
  }

  /**
   * @param {string} key
   * @param {function()} overrideFunction
   * @private
   */
  checkOverride_(key, overrideFunction) {
    if (this.instance_.get_property(key)) {
      overrideFunction();
      if (this.instance_.persistence) this.instance_.persistence.unregister(key);
    }
  }

  /** @param {string=} startReason */
  start(startReason) {
    const config = this.remoteConfig();
    if (!config) {
      logger.info('remote config must be stored in persistence before recording can start');
      return;
    }
    if (!this.isStarted()) {
      const holdFreshStart = this.isIdle_ !== false && !this.suppressNextFreshStartHold_;
      this.setFlushHold_(holdFreshStart ? 'no_interaction_since_recording_started' : undefined);
      this.suppressNextFreshStartHold_ = false;
      this.heldEpochShipsOnUnload_ = holdFreshStart;
      this.heldBufferOverflowed_ = false;
    }
    if (this.isStoppingAfterCompression_) {
      this.invalidateCompressionQueue_();
      this.clearBuffer_();
    }
    const s = this.sessionManager_().checkAndGetSessionAndWindowId();
    this.sessionId_ = s.sessionId;
    this.windowId_ = s.windowId;
    this.sessionStartTimestamp_ = s.sessionStartTimestamp;

    this.restorePendingBuffer_();
    if (this.instance_.persistence) this.instance_.persistence.unregister(SESSION_RECORDING_FIRST_FULL_SNAPSHOT_TIMESTAMP);
    if (config['endpoint']) this.endpoint_ = config['endpoint'];

    const isV2 = config['version'] === 2 && config['triggerGroups'] && config['triggerGroups'].length > 0;
    const self = this;
    /**
     * @param {string} reason
     * @param {?Object=} payload
     */
    const reportStarted = function(reason, payload) {
      self.reportStarted_(reason, payload);
    };
    /** @param {string=} triggerType */
    const onTriggerActivated = function(triggerType) {
      self.onTriggerActivated_(triggerType);
    };
    if (isV2) {
      this.strategy_ = new V2TriggerGroupStrategy(this.instance_, this.urlTriggerMatching_, reportStarted,
          function(tag, payload) {
            self.tryAddCustomEvent_(tag, payload);
          }, onTriggerActivated);
    } else {
      this.strategy_ = new V1RecordingStrategy(this.instance_, this.urlTriggerMatching_, this.eventTriggerMatching_,
          this.linkedFlagMatching_, reportStarted, function() {
            self.tryTakeFullSnapshot_();
          }, onTriggerActivated);
    }
    const strategy = this.strategy_;
    strategy.onRemoteConfig(config);

    if (this.removeEventTriggerCaptureHook_) this.removeEventTriggerCaptureHook_();
    this.removeEventTriggerCaptureHook_ = strategy.setupEventTriggerListeners(function(cb) {
      return self.instance_.on('eventCaptured', cb);
    }, this.sessionId_, function(triggerType, matchDetail) {
      self.activateTrigger_(triggerType, matchDetail);
    });

    this.checkOverride_(SESSION_RECORDING_OVERRIDE_SAMPLING, function() {
      self.overrideSampling();
    });
    this.checkOverride_(SESSION_RECORDING_OVERRIDE_LINKED_FLAG, function() {
      self.overrideLinkedFlag();
    });
    this.checkOverride_(SESSION_RECORDING_OVERRIDE_EVENT_TRIGGER, function() {
      self.overrideTrigger('event');
    });
    this.checkOverride_(SESSION_RECORDING_OVERRIDE_URL_TRIGGER, function() {
      self.overrideTrigger('url');
    });

    strategy.makeSamplingDecisions(this.sessionId_);
    this.startRecorder_();
    if (this.rrwebError_) return;

    addEventListener(win, 'beforeunload', this.onBeforeUnloadBound_);
    addEventListener(win, 'pagehide', this.onPageHideBound_);
    addEventListener(win, 'offline', this.onOfflineBound_);
    addEventListener(win, 'online', this.onOnlineBound_);
    addEventListener(doc, 'visibilitychange', this.onVisibilityChangeBound_);

    const sm = this.sessionManager_();
    if (!this.onSessionIdListener_) this.onSessionIdListener_ = sm.onSessionId(this.onSessionIdCallbackBound_);
    if (!this.onSessionIdleResetForcedListener_) {
      this.onSessionIdleResetForcedListener_ = sm.onForcedIdleReset(function() {
        self.clearConditionalRecordingPersistence_();
        self.isIdle_ = 'unknown';
        self.stop();
        self.forceIdleSessionIdListener_ = self.sessionManager_().onSessionId(function(sessionId, windowId, reason) {
          if (self.forceIdleSessionIdListener_) self.forceIdleSessionIdListener_();
          self.forceIdleSessionIdListener_ = undefined;
          self.onSessionIdCallback_(sessionId, windowId, reason);
        });
      });
    }

    if (isNullish(this.removePageViewCaptureHook_)) {
      this.removePageViewCaptureHook_ = this.instance_.on('eventCaptured', function(event) {
        try {
          if (event['event'] === '$pageview') {
            const cu = event && event['properties'] ? event['properties']['$current_url'] : undefined;
            const href = cu ? self.maskReplayUrl_(cu) : '';
            if (!href) return;
            self.tryAddCustomEvent_('$pageview', {'href': href});
          }
        } catch (e) {
          logger.error('Could not add $pageview to rrweb session', e);
        }
      });
    }

    if (this.status() === ACTIVE) this.reportStarted_(startReason || 'recording_initialized');
  }

  /**
   * @param {string} sessionId
   * @param {string} windowId
   * @param {!Object|undefined} changeReason
   * @private
   */
  onSessionIdCallback_(sessionId, windowId, changeReason) {
    if (!changeReason) return;
    if (sessionId === this.sessionId_ && windowId === this.windowId_) return;
    const wasLikelyReset = changeReason['noSessionId'];
    const shouldLinkSessions = !wasLikelyReset &&
        (changeReason['activityTimeout'] || changeReason['sessionPastMaximumLength']);
    const oldSessionId = this.sessionId_;
    const oldWindowId = this.windowId_;
    if (shouldLinkSessions) {
      this.tryAddCustomEvent_('$session_ending', {
        'currentSessionId': oldSessionId,
        'currentWindowId': oldWindowId,
        'nextSessionId': sessionId,
        'nextWindowId': windowId,
        'changeReason': changeReason,
        'lastActivityTimestamp': this.lastActivityTimestamp_,
        'flushed_size': this.flushedSizeTracker_.currentTrackedSize(oldSessionId),
      });
    }
    if (this.instance_.persistence) this.instance_.persistence.unregister(SESSION_RECORDING_FIRST_FULL_SNAPSHOT_TIMESTAMP);
    const rrweb = getRRWeb();
    if (rrweb && rrweb['resetMaxDepthState']) rrweb['resetMaxDepthState']();
    this.tryAddCustomEvent_('$session_id_change',
        {'sessionId': sessionId, 'windowId': windowId, 'changeReason': changeReason});
    this.clearConditionalRecordingPersistence_();
    if ((this.isIdle_ !== false || !this.isStarted()) &&
        (this.sessionId_ !== sessionId || this.windowId_ !== windowId)) {
      const holdNextEpoch = this.sessionId_ !== sessionId && this.isIdle_ !== false;
      this.isIdle_ = 'unknown';
      this.restartForSessionIdChange_(holdNextEpoch);
    }
    if (shouldLinkSessions) {
      this.tryAddCustomEvent_('$session_starting', {
        'previousSessionId': oldSessionId,
        'previousWindowId': oldWindowId,
        'nextSessionId': sessionId,
        'nextWindowId': windowId,
        'changeReason': changeReason,
        'lastActivityTimestamp': this.lastActivityTimestamp_,
      });
    }
    if (this.strategy_) this.strategy_.makeSamplingDecisions(sessionId);
  }

  /**
   * @param {boolean=} preserveStyleRuleSourceHandoff
   * @private
   */
  teardown_(preserveStyleRuleSourceHandoff) {
    if (win) {
      win.removeEventListener('beforeunload', this.onBeforeUnloadBound_);
      win.removeEventListener('pagehide', this.onPageHideBound_);
      win.removeEventListener('offline', this.onOfflineBound_);
      win.removeEventListener('online', this.onOnlineBound_);
    }
    if (doc) doc.removeEventListener('visibilitychange', this.onVisibilityChangeBound_);
    clearInterval(this.fullSnapshotTimer_);
    this.clearFlushBufferTimer_();
    if (this.removePageViewCaptureHook_) this.removePageViewCaptureHook_();
    this.removePageViewCaptureHook_ = undefined;
    if (this.removeEventTriggerCaptureHook_) this.removeEventTriggerCaptureHook_();
    this.removeEventTriggerCaptureHook_ = undefined;
    if (this.onSessionIdListener_) this.onSessionIdListener_();
    this.onSessionIdListener_ = undefined;
    if (this.onSessionIdleResetForcedListener_) this.onSessionIdleResetForcedListener_();
    this.onSessionIdleResetForcedListener_ = undefined;
    if (this.forceIdleSessionIdListener_) this.forceIdleSessionIdListener_();
    this.forceIdleSessionIdListener_ = undefined;
    if (this.strategy_) this.strategy_.stop();
    this.stopRecordingProducers_(preserveStyleRuleSourceHandoff);
    this.invalidateCompressionQueue_();
  }

  /** @private */
  invalidateCompressionQueue_() {
    this.compressionQueueGeneration_ += 1;
    this.pendingCompressionEvents_ = [];
    this.queuedCompressionEvents_ = 0;
    this.compressionQueue_ = null;
    this.isStoppingAfterCompression_ = false;
  }

  /**
   * @param {boolean=} preserveStyleRuleSourceHandoff
   * @private
   */
  stopRecordingProducers_(preserveStyleRuleSourceHandoff) {
    if (!preserveStyleRuleSourceHandoff) cancelHandoff(this.styleRuleSourceHandoff_);
    if (this.mutationThrottler_) this.mutationThrottler_.stop();
    this.queuedRRWebEvents_ = [];
    if (this.jsonLdCapture_) this.jsonLdCapture_.stop();
    this.jsonLdCapture_ = null;
    this.jsonLdCaptureReady_ = false;
    try {
      if (this.stopRrweb_) this.stopRrweb_();
    } catch (e) {
      logger.warn('could not stop rrweb', e);
    }
    this.stopRrweb_ = undefined;
  }

  /**
   * @return {boolean}
   * @private
   */
  stopAfterCompressionQueueDrains_() {
    if (!this.compressionQueue_ || this.queuedCompressionEvents_ === 0) return false;
    if (this.isStoppingAfterCompression_) return true;
    this.isStoppingAfterCompression_ = true;
    this.flushHoldReason_ = undefined;
    const generation = this.compressionQueueGeneration_;
    this.clearFlushBufferTimer_();
    this.stopRecordingProducers_();
    const self = this;
    this.compressionQueue_.then(undefined, function() {
      return undefined;
    }).then(function() {
      if (generation !== self.compressionQueueGeneration_) return;
      self.isStoppingAfterCompression_ = false;
      self.flushBuffer_();
      self.clearBuffer_();
      self.releaseHoldAfterStop_();
      self.teardown_();
      logger.info('stopped');
    }).then(undefined, function() {
      self.isStoppingAfterCompression_ = false;
      self.releaseHoldAfterStop_();
      self.teardown_();
      logger.info('stopped');
    });
    return true;
  }

  /** @param {boolean=} preserveStyleRuleSourceHandoff */
  stop(preserveStyleRuleSourceHandoff) {
    this.stopRecordingProducers_(preserveStyleRuleSourceHandoff);
    if (this.isRestartingForSessionIdChange_) {
      this.drainCompressionQueueSync_();
    } else if (this.stopAfterCompressionQueueDrains_()) {
      return;
    }
    this.flushBuffer_();
    this.clearBuffer_();
    this.releaseHoldAfterStop_();
    this.teardown_(preserveStyleRuleSourceHandoff);
    logger.info('stopped');
  }

  /** @private */
  releaseHoldAfterStop_() {
    this.setFlushHold_(undefined, this.isRestartingForSessionIdChange_);
    this.heldEpochShipsOnUnload_ = false;
  }

  flushBeforeIdentityReset() {
    if (!this.isStarted() && !this.isStoppingAfterCompression_) return;
    this.drainCompressionQueueSync_();
    this.flushBuffer_();
  }

  /**
   * @param {boolean} holdNextEpoch
   * @private
   */
  restartForSessionIdChange_(holdNextEpoch) {
    const previousHandoff = this.styleRuleSourceHandoff_;
    const wasRestarting = this.isRestartingForSessionIdChange_;
    this.isRestartingForSessionIdChange_ = true;
    this.lastActivityTimestamp_ = Date.now();
    /** @type {(function()|undefined)} */
    let cancelSources = undefined;
    /** @type {!Cancellation} */
    const cancellation = {
      cancelled: false,
      cancel: function() {
        cancellation.cancelled = true;
        cancelHandoff(previousHandoff);
        if (cancelSources) cancelSources();
      },
    };
    this.styleRuleSourceHandoff_ = cancellation;
    const self = this;
    const restart = function() {
      self.stop(true);
      if (cancellation.cancelled || self.instance_.config['disable_session_recording'] ||
          self.instance_.has_opted_out_capturing()) {
        cancellation.cancel();
        return;
      }
      self.lastSeenSnapshotCost_ = undefined;
      self.unstringifiableEventsDropped_ = 0;
      self.throttledMutationsDropped_ = 0;
      self.oversizedMutationsDropped_ = 0;
      self.oversizedMutationBytesDropped_ = 0;
      const rrweb = getRRWeb();
      if (rrweb && rrweb['resetSnapshotCostState']) rrweb['resetSnapshotCostState']();
      self.start('session_id_changed');
      if (cancellation.cancelled || self.instance_.config['disable_session_recording'] ||
          self.instance_.has_opted_out_capturing()) {
        cancellation.cancel();
        self.discard(true);
      }
    };
    try {
      const record = getRRWebRecord();
      const handoff = record ? record['withStyleRuleSourceHandoff'] : undefined;
      if (handoff && this.stopRrweb_) {
        handoff(this.stopRrweb_, function(cancel) {
          cancelSources = cancel;
          restart();
        });
      } else {
        restart();
      }
    } finally {
      this.styleRuleSourceHandoff_ = previousHandoff;
      this.isRestartingForSessionIdChange_ = wasRestarting;
    }
    if (cancellation.cancelled) return;
    this.setFlushHold_(holdNextEpoch ? 'no_interaction_since_session_rotated' : undefined);
    this.heldEpochShipsOnUnload_ = false;
  }

  /**
   * @param {string|undefined} reason
   * @param {boolean=} preserveLogDedup
   * @private
   */
  setFlushHold_(reason, preserveLogDedup) {
    this.holdFlushUntilInteraction_ = !isUndefined(reason);
    this.flushHoldReason_ = reason;
    if (isUndefined(reason)) {
      if (!preserveLogDedup) this.lastLoggedFlushHold_ = undefined;
      return;
    }
    if (this.isRestartingForSessionIdChange_) return;
    const holdKey = this.sessionId_ + ':' + reason;
    if (holdKey === this.lastLoggedFlushHold_) return;
    this.lastLoggedFlushHold_ = holdKey;
    logger.info('holding buffer: ' + reason + '. nothing is uploaded until the user interacts with the page');
  }

  /** @private */
  releaseHoldAndFlush_() {
    if (!this.isStarted()) this.suppressNextFreshStartHold_ = true;
    if (!this.holdFlushUntilInteraction_) return;
    this.setFlushHold_(undefined);
    this.heldEpochShipsOnUnload_ = false;
    if (this.heldBufferOverflowed_) {
      this.heldBufferOverflowed_ = false;
      this.tryTakeFullSnapshot_();
    }
    this.scheduleFlushBuffer_();
  }

  /** @param {boolean=} discardProducerEvents */
  discard(discardProducerEvents) {
    this.holdFlushUntilInteraction_ = true;
    if (discardProducerEvents) {
      this.clearBuffer_();
      this.stopRecordingProducers_();
    }
    this.clearBuffer_();
    this.teardown_();
    this.clearBuffer_();
    this.releaseHoldAfterStop_();
    logger.info('discarded');
  }

  /**
   * @param {!Object} event
   * @param {!Object} eventToSend
   * @param {number} size
   * @param {string} targetSessionId
   * @param {string} targetWindowId
   * @private
   */
  captureProcessedEvent_(event, eventToSend, size, targetSessionId, targetWindowId) {
    if (size === UNSTRINGIFIABLE_EVENT_SIZE) {
      this.unstringifiableEventsDropped_ += 1;
      logger.warn('could not stringify event - dropping it to keep the rest of the recording');
      return;
    }
    const properties = {
      '$snapshot_bytes': size,
      '$snapshot_data': eventToSend,
      '$session_id': targetSessionId,
      '$window_id': targetWindowId,
    };
    if (this.status() === DISABLED) {
      this.clearBuffer_();
      return;
    }
    this.ensureFullSnapshotForSession_(event, targetSessionId);
    this.captureSnapshotBuffered_(properties);
  }

  /** @private */
  safeTrackFullSnapshotCost_() {
    try {
      this.trackFullSnapshotCost_();
    } catch (e) {
      if (!this.snapshotCostErrorLogged_) {
        this.snapshotCostErrorLogged_ = true;
        logger.error('could not track full snapshot cost', e);
      }
    }
  }

  /** @private */
  trackFullSnapshotCost_() {
    const rrweb = getRRWeb();
    const cost = rrweb && rrweb['getLastSnapshotCost'] ? rrweb['getLastSnapshotCost']() : undefined;
    if (!cost || cost === this.lastSeenSnapshotCost_) return;
    this.lastSeenSnapshotCost_ = cost;
    if (cost['durationMs'] >= SLOW_FULL_SNAPSHOT_THRESHOLD_MS) {
      logger.warn('full snapshot was slow, the page may have been unresponsive while it ran', {
        'durationMs': Math.round(cost['durationMs']),
        'stylesheetMs': Math.round(cost['stylesheetMs']),
        'nodeCount': cost['nodeCount'],
        'cssRuleCount': cost['cssRuleCount'],
        'nonDeferrableCssRuleCount': cost['nonDeferrableCssRuleCount'],
        'deferredStylesheetCount': cost['deferredStylesheetCount'],
      });
    }
  }

  /**
   * @param {!Object} event
   * @param {string} targetSessionId
   * @private
   */
  ensureFullSnapshotForSession_(event, targetSessionId) {
    if (event['type'] === FULL_SNAPSHOT_EVENT_TYPE) {
      this.lastFullSnapshotSessionId_ = targetSessionId;
      return;
    }
    if (event['type'] !== INCREMENTAL_SNAPSHOT_EVENT_TYPE) return;
    if (isUndefined(this.lastFullSnapshotSessionId_) || this.lastFullSnapshotSessionId_ === targetSessionId ||
        this.fullSnapshotHealAttemptedFor_ === targetSessionId) {
      return;
    }
    this.fullSnapshotHealAttemptedFor_ = targetSessionId;
    logger.info('incremental snapshot for a session with no full snapshot - requesting one',
        {'sessionId': targetSessionId});
    this.tryTakeFullSnapshot_();
  }

  /**
   * @param {!QueuedCompressionEvent} q
   * @private
   */
  finishQueuedCompressionEvent_(q) {
    if (q.counted && q.generation === this.compressionQueueGeneration_) {
      this.queuedCompressionEvents_ = Math.max(0, this.queuedCompressionEvents_ - 1);
    }
    q.counted = false;
    this.pendingCompressionEvents_ = this.pendingCompressionEvents_.filter(function(x) {
      return x !== q;
    });
  }

  /**
   * @param {!QueuedCompressionEvent} q
   * @param {!Object} eventToSend
   * @param {number} size
   * @private
   */
  captureQueuedCompressionEvent_(q, eventToSend, size) {
    if (q.processed || q.generation !== this.compressionQueueGeneration_) return;
    q.processed = true;
    this.captureProcessedEvent_(q.event, eventToSend, size, q.targetSessionId, q.targetWindowId);
  }

  /**
   * @param {!QueuedCompressionEvent} q
   * @private
   */
  processQueuedCompressionEventSync_(q) {
    try {
      let eventToSend = q.event;
      let size;
      if (q.compressionEnabled) {
        try {
          const r = compressEventSync(q.event);
          eventToSend = r.event;
          size = r.size;
        } catch (e) {
          logger.warn('could not process queued compression event - will use uncompressed event', e);
        }
      }
      if (isUndefined(size)) size = estimateSize(q.event);
      try {
        this.captureQueuedCompressionEvent_(q, eventToSend, /** @type {number} */ (size));
      } catch (e) {
        logger.warn('could not capture queued compression event', e);
      }
    } finally {
      this.finishQueuedCompressionEvent_(q);
    }
  }

  /** @private */
  drainCompressionQueueSync_() {
    const queued = this.pendingCompressionEvents_.slice();
    const self = this;
    queued.forEach(function(q) {
      try {
        self.processQueuedCompressionEventSync_(q);
      } catch (e) {
        logger.warn('could not drain queued compression event', e);
      }
    });
  }

  /**
   * @param {!Object} event
   * @param {boolean} compressionEnabled
   * @param {string} targetSessionId
   * @param {string} targetWindowId
   * @private
   */
  enqueueCompression_(event, compressionEnabled, targetSessionId, targetWindowId) {
    /** @type {!QueuedCompressionEvent} */
    const q = {
      event: event,
      compressionEnabled: compressionEnabled,
      targetSessionId: targetSessionId,
      targetWindowId: targetWindowId,
      generation: this.compressionQueueGeneration_,
      processed: false,
      counted: true,
    };
    this.pendingCompressionEvents_.push(q);
    this.queuedCompressionEvents_ += 1;
    const self = this;
    /**
     * Upstream's async processEvent: runs synchronously unless the event
     * goes through native async gzip.
     * @return {!Promise<void>}
     */
    const processEvent = function() {
      if (q.processed) {
        self.finishQueuedCompressionEvent_(q);
        return Promise.resolve();
      }
      /**
       * @param {!Object} eventToSend
       * @param {number} size
       */
      const finish = function(eventToSend, size) {
        try {
          self.captureQueuedCompressionEvent_(q, eventToSend, size);
        } finally {
          self.finishQueuedCompressionEvent_(q);
        }
      };
      let asyncResult = null;
      let syncResult = null;
      try {
        if (compressionEnabled && shouldUseNativeAsyncGzip(event)) {
          asyncResult = compressEventAsync(event);
        } else {
          syncResult = compressionEnabled ? compressEventSync(event) : {event: event, size: estimateSize(event)};
        }
      } catch (e) {
        logger.warn('could not process queued compression event - will use uncompressed event', e);
        syncResult = {event: event, size: estimateSize(event)};
      }
      if (syncResult) {
        try {
          finish(syncResult.event, syncResult.size);
        } catch (e) {
          return Promise.reject(e);
        }
        return Promise.resolve();
      }
      return /** @type {!Promise<!CompressedEventResult>} */ (asyncResult).then(function(r) {
        finish(r.event, r.size);
      }, function(e) {
        logger.warn('could not process queued compression event - will use uncompressed event', e);
        finish(event, estimateSize(event));
      });
    };
    this.compressionQueue_ = this.compressionQueue_ ? this.compressionQueue_.then(undefined, function() {
      return undefined;
    }).then(processEvent) : processEvent();
  }

  /** @param {*} rawEvent rrweb event (quoted keys) */
  onRRwebEmit(rawEvent) {
    if (!this.instance_.sessionManager) return;
    this.processQueuedEvents_();
    if (!rawEvent || !isObject(rawEvent)) return;
    const raw = /** @type {!Object} */ (rawEvent);
    if (raw['type'] === META_EVENT_TYPE) {
      const href = this.maskReplayUrl_(raw['data']['href']);
      this.lastHref_ = href;
      if (!href) return;
      raw['data']['href'] = href;
    } else {
      this.pageViewFallBack_();
    }
    const self = this;
    if (this.strategy_) {
      this.strategy_.checkUrlTriggers(this.sessionId_, function() {
        self.pauseRecording_();
      }, function() {
        self.resumeRecording_();
      }, function(triggerType, matchDetail) {
        self.activateTrigger_(triggerType, matchDetail);
      });
    }
    if (this.urlTriggerMatching_.urlBlocked && !isRecordingPausedEvent(raw)) return;

    if (raw['type'] === FULL_SNAPSHOT_EVENT_TYPE) {
      this.safeTrackFullSnapshotCost_();
      Promise.resolve().then(function() {
        self.safeTrackFullSnapshotCost_();
      });
      this.scheduleFullSnapshot_();
      if (this.mutationThrottler_) this.mutationThrottler_.reset();
      if (this.instance_.persistence) {
        this.instance_.persistence.register_once(
            {[SESSION_RECORDING_FIRST_FULL_SNAPSHOT_TIMESTAMP]: raw['timestamp']}, undefined);
      }
    }

    const jsonLdRemovedFromPendingBuffer = raw['type'] === FULL_SNAPSHOT_EVENT_TYPE && !!this.strategy_ &&
        this.strategy_.hasPendingTriggers(this.sessionId_);
    if (jsonLdRemovedFromPendingBuffer) this.clearBufferBeforeMostRecentMeta_();

    const throttledEvent = this.mutationThrottler_ ? this.mutationThrottler_.throttleMutations(raw) : raw;
    if (!throttledEvent) {
      if (this.isIdle_ === true) this.eventsDroppedWhileIdle_++;
      return;
    }
    const event = truncateLargeConsoleLogs(throttledEvent);

    const sessionEndingPayload = isSessionEndingEvent(event) ? event['data']['payload'] : null;
    const sessionStartingPayload = isSessionStartingEvent(event) ? event['data']['payload'] : null;
    const sessionIdlePayload = getSessionIdlePayload(event);

    if (sessionEndingPayload || sessionStartingPayload) {
      if (sessionEndingPayload && sessionEndingPayload['lastActivityTimestamp']) {
        event['timestamp'] = sessionEndingPayload['lastActivityTimestamp'];
      }
    } else if (!(sessionIdlePayload && sessionIdlePayload['sessionId'])) {
      this.updateWindowAndSessionIds_(event);
    }

    const pick = function(key, fallback) {
      if (sessionEndingPayload && !isNullish(sessionEndingPayload['current' + key])) {
        return sessionEndingPayload['current' + key];
      }
      if (sessionStartingPayload && !isNullish(sessionStartingPayload['next' + key])) {
        return sessionStartingPayload['next' + key];
      }
      if (sessionIdlePayload && !isNullish(sessionIdlePayload[key.charAt(0).toLowerCase() + key.slice(1)])) {
        return sessionIdlePayload[key.charAt(0).toLowerCase() + key.slice(1)];
      }
      return fallback;
    };
    const targetSessionId = /** @type {string} */ (pick('SessionId', this.sessionId_));
    const targetWindowId = /** @type {string} */ (pick('WindowId', this.windowId_));

    if (this.isIdle_ === true && !isAllowedWhenIdle(event)) {
      if (isMirrorDesyncingWhenDropped(event)) this.eventsDroppedWhileIdle_++;
      return;
    }
    if (event['type'] === FULL_SNAPSHOT_EVENT_TYPE) this.eventsDroppedWhileIdle_ = 0;
    if (sessionIdlePayload) {
      event['timestamp'] = sessionIdlePayload['lastActivityTimestamp'] + sessionIdlePayload['threshold'];
    }

    const jsonLdCaptureWasReady = this.jsonLdCaptureReady_;
    this.jsonLdCaptureReady_ = true;
    if (jsonLdRemovedFromPendingBuffer) this.scheduleJsonLdScan_(true);
    else if (!jsonLdCaptureWasReady) this.scheduleJsonLdScan_();

    const ce = this.srConfig_()['compress_events'];
    const compressionEnabled = isNullish(ce) ? true : !!ce;

    if (event['type'] === CUSTOM_EVENT_TYPE && event['data']['tag'] === JSON_LD_EVENT_TAG) {
      let href;
      try {
        href = win ? this.maskReplayUrl_(win.location.href) : undefined;
      } catch (e) {
        // A masking callback failure must not expose the original URL or interrupt recording.
      }
      event['data']['href'] = href;
    }

    if (this.queuedCompressionEvents_ > 0 || (compressionEnabled && shouldUseNativeAsyncGzip(event))) {
      this.enqueueCompression_(event, compressionEnabled, targetSessionId, targetWindowId);
      return;
    }
    const r = compressionEnabled ? compressEventSync(event) : {event: event, size: estimateSize(event)};
    this.captureProcessedEvent_(event, r.event, r.size, targetSessionId, targetWindowId);
  }

  /** @return {string} */
  status() {
    if (!this.strategy_) return DISABLED;
    /** @type {!RecordingStrategyContext} */
    const context = {
      instance: this.instance_,
      sessionId: this.sessionId_,
      isSampled: this.isSampled_(),
      rrwebError: this.rrwebError_,
      urlTriggerMatching: this.urlTriggerMatching_,
      eventTriggerMatching: this.eventTriggerMatching_,
      linkedFlagMatching: this.linkedFlagMatching_,
      remoteConfig: this.remoteConfig(),
    };
    return this.strategy_.getStatus(context);
  }

  /**
   * @param {string} message
   * @param {string=} level
   */
  log(message, level) {
    const sr = /** @type {?} */ (this.instance_)['sessionRecording'];
    if (sr) {
      sr['onRRwebEmit']({
        'type': 6,
        'data': {
          'plugin': 'rrweb/console@1',
          'payload': {'level': level || 'log', 'trace': [], 'payload': [JSON.stringify(message)]},
        },
        'timestamp': Date.now(),
      });
    }
  }

  overrideLinkedFlag() {
    this.linkedFlagMatching_.linkedFlagSeen = true;
    this.tryTakeFullSnapshot_();
    this.releaseHoldAndFlush_();
    this.reportStarted_('linked_flag_overridden');
  }

  overrideSampling() {
    if (this.instance_.persistence) {
      this.instance_.persistence.register({
        [SESSION_RECORDING_IS_SAMPLED]: this.sessionId_,
        [SESSION_RECORDING_SAMPLE_RATE]: null,
      });
    }
    this.tryTakeFullSnapshot_();
    this.releaseHoldAndFlush_();
    this.reportStarted_('sampling_overridden');
  }

  /** @param {string} triggerType */
  overrideTrigger(triggerType) {
    this.activateTrigger_(triggerType);
    this.releaseHoldAndFlush_();
  }

  /**
   * @return {string|undefined}
   * @private
   */
  currentMaskedHostname_() {
    try {
      const href = win && win.location ? win.location.href : undefined;
      if (!href) return undefined;
      const masked = this.maskReplayUrl_(href);
      if (!masked) return undefined;
      return newURL(masked)['hostname'] || undefined;
    } catch (e) {
      return undefined;
    }
  }

  /** @private */
  clearFlushBufferTimer_() {
    if (this.flushBufferTimer_) {
      clearTimeout(this.flushBufferTimer_);
      this.flushBufferTimer_ = undefined;
    }
  }

  /** @private */
  scheduleFlushBuffer_() {
    if (!this.flushBufferTimer_) {
      const self = this;
      this.flushBufferTimer_ = setTimeout(function() {
        self.flushBuffer_();
      }, RECORDING_BUFFER_TIMEOUT);
    }
  }

  /**
   * @return {boolean}
   * @private
   */
  wouldOpenRecordingWithMarkersOnly_() {
    if (this.lastFullSnapshotSessionId_ === this.buffer_['sessionId'] || this.buffer_['data'].length === 0) {
      return false;
    }
    return this.buffer_['data'].every(function(event) {
      return !!event && event['type'] === CUSTOM_EVENT_TYPE && !isSessionEndingEvent(event) &&
          !isSessionStartingEvent(event);
    });
  }

  /**
   * @param {string} status
   * @private
   */
  maybeLogBufferingReason_(status) {
    if (status !== BUFFERING) {
      if (!isUndefined(this.lastLoggedBufferingReason_)) {
        this.instance_.register_for_session({[SDK_DEBUG_REPLAY_PENDING_TRIGGER_CONDITIONS]: []});
      }
      this.lastLoggedBufferingReason_ = undefined;
      return;
    }
    const pending = this.strategy_ ? this.strategy_.getPendingTriggerConditions(this.sessionId_) : [];
    if (pending.length === 0) {
      if (!isUndefined(this.lastLoggedBufferingReason_)) {
        this.instance_.register_for_session({[SDK_DEBUG_REPLAY_PENDING_TRIGGER_CONDITIONS]: []});
      }
      this.lastLoggedBufferingReason_ = undefined;
      return;
    }
    const reason = pending.join(', ');
    const reasonKey = this.sessionId_ + ':' + reason;
    if (reasonKey === this.lastLoggedBufferingReason_) return;
    this.lastLoggedBufferingReason_ = reasonKey;
    this.instance_.register_for_session({[SDK_DEBUG_REPLAY_PENDING_TRIGGER_CONDITIONS]: pending});
    logger.info('buffering: ' + reason);
  }

  /**
   * @return {boolean}
   * @private
   */
  canParkPendingBuffer_() {
    return this.instance_.config['persistence'] !== 'memory' &&
        !(this.instance_.persistence && this.instance_.persistence.disabled === true) && sessionStore.isSupported();
  }

  /** @private */
  parkBufferForNextPage_() {
    if (this.buffer_['data'].length === 0 || this.buffer_['size'] === this.lastParkedBufferSize_ ||
        this.buffer_['size'] > RECORDING_MAX_EVENT_SIZE || !this.canParkPendingBuffer_()) {
      return;
    }
    this.lastParkedBufferSize_ = this.buffer_['size'];
    sessionStore.set(this.pendingBufferStorageKey_, this.buffer_);
  }

  /** @private */
  restorePendingBuffer_() {
    if (this.pendingBufferRestored_ || !this.canParkPendingBuffer_()) return;
    this.pendingBufferRestored_ = true;
    const parked = sessionStore.parse(this.pendingBufferStorageKey_);
    sessionStore.remove(this.pendingBufferStorageKey_);
    if (!isObject(parked) || !isArray(parked['data']) || parked['data'].length === 0 || !isArray(parked['sizes']) ||
        parked['sizes'].length !== parked['data'].length || !isNumber(parked['size'])) {
      return;
    }
    if (parked['sessionId'] !== this.sessionId_ || parked['windowId'] !== this.windowId_) return;
    if (this.buffer_['data'].length > 0) return;
    this.buffer_ = /** @type {!Object} */ (parked);
  }

  /**
   * @param {boolean=} isUnloading
   * @return {!Object} the buffer
   * @private
   */
  flushBuffer_(isUnloading) {
    this.clearFlushBufferTimer_();
    if (this.holdFlushUntilInteraction_) return this.buffer_;
    if (this.wouldOpenRecordingWithMarkersOnly_()) {
      if (this.buffer_['size'] > RECORDING_MAX_EVENT_SIZE) return this.clearBuffer_();
      if (isUnloading) this.parkBufferForNextPage_();
      return this.buffer_;
    }
    const validatedBuffer = this.buffer_;
    if (this.strategy_) this.strategy_.ensureSamplingDecision(this.sessionId_);
    const isBelowMinimumDuration = this.isBelowMinimumDuration_();
    const status = this.status();
    this.maybeLogBufferingReason_(status);
    if (status === BUFFERING || status === PAUSED || status === DISABLED || isBelowMinimumDuration) {
      if (isUnloading && (status === ACTIVE || status === SAMPLED)) this.parkBufferForNextPage_();
      this.scheduleFlushBuffer_();
      return this.buffer_;
    }
    if (this.buffer_ !== validatedBuffer) return this.buffer_;
    if (validatedBuffer['data'].length > 0) {
      const snapshotHostname = this.currentMaskedHostname_();
      const chunks = splitBuffer(validatedBuffer);
      const self = this;
      chunks.forEach(function(chunk) {
        try {
          self.flushedSizeTracker_.trackSize(chunk['sessionId'], chunk['size']);
          const props = {
            '$snapshot_bytes': chunk['size'],
            '$snapshot_data': chunk['data'],
            '$session_id': chunk['sessionId'],
            '$window_id': chunk['windowId'],
            '$lib': Config.LIB_NAME,
            '$lib_version': Config.LIB_VERSION,
            '$snapshot_host': snapshotHostname,
          };
          if (self.throttledMutationsDropped_ > 0) {
            props['$sdk_debug_replay_throttled_mutations_dropped'] = self.throttledMutationsDropped_;
          }
          if (self.oversizedMutationsDropped_ > 0) {
            props['$sdk_debug_replay_oversized_mutations_dropped'] = self.oversizedMutationsDropped_;
          }
          if (self.oversizedMutationBytesDropped_ > 0) {
            props['$sdk_debug_replay_oversized_mutation_bytes_dropped'] = self.oversizedMutationBytesDropped_;
          }
          if (self.unstringifiableEventsDropped_ > 0) {
            props['$sdk_debug_replay_unstringifiable_events_dropped'] = self.unstringifiableEventsDropped_;
          }
          self.captureSnapshot_(props);
        } catch (e) {
          logger.warn('could not capture snapshot chunk - skipping it', e);
        }
      });
      if (!isUndefined(this.lastParkedBufferSize_)) {
        sessionStore.remove(this.pendingBufferStorageKey_);
        this.lastParkedBufferSize_ = undefined;
      }
      if (this.strategy_) this.strategy_.onFlushComplete();
    }
    return this.clearBuffer_();
  }

  /**
   * @return {boolean}
   * @private
   */
  hasPassedMinimumDuration_() {
    const p = this.instance_.persistence;
    return (p ? p.props[SESSION_RECORDING_PAST_MINIMUM_DURATION] : undefined) === this.sessionId_;
  }

  /**
   * @return {?number}
   * @private
   */
  getBufferDuration_() {
    const data = this.buffer_['data'];
    if (data.length === 0) return null;
    const first = data[0] ? data[0]['timestamp'] : undefined;
    const last = data[data.length - 1] ? data[data.length - 1]['timestamp'] : undefined;
    if (!isNumber(first) || !isNumber(last)) return null;
    return last - first;
  }

  /**
   * @return {boolean}
   * @private
   */
  isBelowMinimumDuration_() {
    const minimumDuration = this.minimumDuration_();
    if (!isNumber(minimumDuration)) return false;
    const min = /** @type {number} */ (minimumDuration);
    const strict = this.srConfig_()['strictMinimumDuration'];
    if (!(isNullish(strict) ? false : strict)) {
      const sessionDuration = this.sessionDuration_();
      return isNumber(sessionDuration) && sessionDuration >= 0 && /** @type {number} */ (sessionDuration) < min;
    }
    if (this.hasPassedMinimumDuration_()) return false;
    const bufferDuration = this.getBufferDuration_();
    if (isNull(bufferDuration)) return true;
    if (/** @type {number} */ (bufferDuration) >= min) {
      if (this.instance_.persistence) {
        this.instance_.persistence.register({[SESSION_RECORDING_PAST_MINIMUM_DURATION]: this.sessionId_});
      }
      return false;
    }
    return true;
  }

  /**
   * @param {!Object} properties
   * @private
   */
  captureSnapshotBuffered_(properties) {
    const additionalBytes = 2 + (this.buffer_ ? this.buffer_['data'].length : 0);
    const targetSessionId = properties['$session_id'];
    const sessionChanged = this.buffer_['sessionId'] !== targetSessionId;
    if (sessionChanged || (this.isIdle_ !== true && !this.holdFlushUntilInteraction_ &&
        this.buffer_['size'] + properties['$snapshot_bytes'] + additionalBytes > RECORDING_MAX_EVENT_SIZE)) {
      const sessionBeforeFlush = this.sessionId_;
      this.buffer_ = this.flushBuffer_();
      if (this.sessionId_ !== sessionBeforeFlush) return;
      if (sessionChanged && this.buffer_['data'].length > 0) this.buffer_ = this.clearBuffer_();
      this.buffer_['sessionId'] = targetSessionId;
      this.buffer_['windowId'] = properties['$window_id'];
    }
    if (this.holdFlushUntilInteraction_ && (this.heldBufferOverflowed_ ||
        this.buffer_['size'] + properties['$snapshot_bytes'] + additionalBytes > RECORDING_MAX_EVENT_SIZE)) {
      this.heldBufferOverflowed_ = true;
      return;
    }
    this.buffer_['size'] += properties['$snapshot_bytes'];
    this.buffer_['data'].push(properties['$snapshot_data']);
    this.buffer_['sizes'].push(properties['$snapshot_bytes']);
    if (this.isIdle_ !== true && !this.holdFlushUntilInteraction_) this.scheduleFlushBuffer_();
  }

  /**
   * @param {!Object} properties
   * @private
   */
  captureSnapshot_(properties) {
    this.instance_.capture('$snapshot', properties, {
      '_url': this.instance_.requestRouter.endpointFor('api', this.endpoint_),
      '_noTruncate': true,
      '_batchKey': SESSION_RECORDING_BATCH_KEY,
      'skip_client_rate_limiting': true,
    });
  }

  /**
   * @return {?number}
   * @private
   */
  sessionDuration_() {
    const data = this.buffer_ ? this.buffer_['data'] : [];
    const mostRecent = data[data.length - 1];
    return mostRecent ? mostRecent['timestamp'] - this.sessionStartTimestamp_ : null;
  }

  /**
   * @return {!Object}
   * @private
   */
  clearBufferBeforeMostRecentMeta_() {
    if (!this.buffer_ || this.buffer_['data'].length === 0) return this.clearBuffer_();
    let lastMetaIndex = -1;
    for (let i = this.buffer_['data'].length - 1; i >= 0; i--) {
      if (this.buffer_['data'][i]['type'] === META_EVENT_TYPE) {
        lastMetaIndex = i;
        break;
      }
    }
    if (lastMetaIndex >= 0) {
      this.buffer_['data'] = this.buffer_['data'].slice(lastMetaIndex);
      this.buffer_['sizes'] = this.buffer_['sizes'].slice(lastMetaIndex);
      this.buffer_['size'] = this.buffer_['sizes'].reduce(function(a, b) {
        return a + b;
      }, 0);
      return this.buffer_;
    }
    return this.clearBuffer_();
  }

  /**
   * @return {!Object}
   * @private
   */
  clearBuffer_() {
    this.buffer_ = {
      'size': 0,
      'data': [],
      'sizes': [],
      'sessionId': this.sessionId_,
      'windowId': this.windowId_,
    };
    return this.buffer_;
  }

  /** @private */
  onBeforeUnload_() {
    if (this.status() === BUFFERING) {
      this.clearBuffer_();
      return;
    }
    if (this.holdFlushUntilInteraction_ && this.heldEpochShipsOnUnload_ && this.documentWasEverVisible_) {
      this.setFlushHold_(undefined);
      if (this.heldBufferOverflowed_) {
        this.heldBufferOverflowed_ = false;
        this.tryTakeFullSnapshot_();
      }
    }
    this.drainCompressionQueueSync_();
    this.flushBuffer_(true);
  }

  /**
   * @param {string} startReason
   * @param {?Object=} tagPayload
   * @private
   */
  reportStarted_(startReason, tagPayload) {
    this.instance_.register_for_session({[SESSION_RECORDING_START_REASON]: startReason});
    logger.info(startReason.replace('_', ' '), tagPayload);
    if (startReason !== 'session_id_changed') {
      const payload = {'reason': startReason};
      if (tagPayload) for (const k in tagPayload) payload[k] = tagPayload[k];
      this.tryAddCustomEvent_('$recording_started', payload);
    }
  }

  /**
   * @param {!Object} event
   * @return {boolean}
   * @private
   */
  isInteractiveEvent_(event) {
    return event['type'] === INCREMENTAL_SNAPSHOT_EVENT_TYPE &&
        ACTIVE_SOURCES.indexOf(event['data'] ? event['data']['source'] : undefined) !== -1;
  }

  /**
   * @param {!Object} event
   * @private
   */
  updateWindowAndSessionIds_(event) {
    const isUserInteraction = this.isInteractiveEvent_(event);
    if (!isUserInteraction && this.isIdle_ !== true) {
      const timeSinceLastActivity = event['timestamp'] - this.lastActivityTimestamp_;
      if (timeSinceLastActivity > this.sessionIdleThresholdMilliseconds_()) {
        this.isIdle_ = true;
        clearInterval(this.fullSnapshotTimer_);
        this.tryAddCustomEvent_('sessionIdle', {
          'eventTimestamp': event['timestamp'],
          'lastActivityTimestamp': this.lastActivityTimestamp_,
          'threshold': this.sessionIdleThresholdMilliseconds_(),
          'bufferLength': this.buffer_['data'].length,
          'bufferSize': this.buffer_['size'],
          'sessionId': this.sessionId_,
          'windowId': this.windowId_,
        });
        this.flushBuffer_();
      }
    }
    const s = this.sessionManager_().checkAndGetSessionAndWindowId(!isUserInteraction, event['timestamp']);
    let returningFromIdle = false;
    if (isUserInteraction) {
      this.lastActivityTimestamp_ = event['timestamp'];
      if (this.isIdle_) {
        const idleWasUnknown = this.isIdle_ === 'unknown';
        this.isIdle_ = false;
        if (!idleWasUnknown) {
          this.tryAddCustomEvent_('sessionNoLongerIdle', {'reason': 'user activity', 'type': event['type']});
          returningFromIdle = true;
        }
      }
    }
    const sessionIdChanged = this.sessionId_ !== s.sessionId;
    const windowIdChanged = this.windowId_ !== s.windowId;
    this.windowId_ = s.windowId;
    this.sessionId_ = s.sessionId;
    if (sessionIdChanged || windowIdChanged) {
      const holdNextEpoch = sessionIdChanged && this.isIdle_ !== false;
      if (holdNextEpoch) this.isIdle_ = 'unknown';
      this.restartForSessionIdChange_(holdNextEpoch);
    } else {
      if (isUserInteraction) this.releaseHoldAndFlush_();
      if (returningFromIdle) {
        const bufferCanShip = ['sampled', 'active'].indexOf(this.status()) !== -1 ||
            (!!this.strategy_ && this.strategy_.hasPendingTriggers(this.sessionId_));
        if (this.eventsDroppedWhileIdle_ > 0 && bufferCanShip) this.tryTakeFullSnapshot_();
        this.scheduleJsonLdScan_();
        this.scheduleFullSnapshot_();
      }
    }
  }

  /** @private */
  clearConditionalRecordingPersistence_() {
    if (this.strategy_) this.strategy_.clearConditionalRecordingPersistence();
  }

  /** @return {!Object} */
  sdkDebugProperties() {
    return {
      '$recording_status': this.status(),
      '$sdk_debug_replay_flush_hold_reason': this.flushHoldReason_,
      '$sdk_debug_replay_internal_buffer_length': this.buffer_['data'].length,
      '$sdk_debug_replay_internal_buffer_size': this.buffer_['size'],
      '$sdk_debug_session_start': this.sessionStartTimestamp_,
      '$sdk_debug_replay_flushed_size': this.flushedSizeTracker_.currentTrackedSize(this.sessionId_),
      '$sdk_debug_replay_rrweb_error': this.rrwebError_,
      [SDK_DEBUG_REPLAY_RRWEB_ATTACHED]: this.rrwebAttached_(),
      [SDK_DEBUG_REPLAY_RRWEB_START_ATTEMPTED]: this.rrwebStartAttempted_,
    };
  }

  /**
   * @return {boolean}
   * @private
   */
  rrwebAttached_() {
    if (!this.stopRrweb_) return false;
    const record = getRRWebRecord();
    const r = record && record['isRecording'] ? record['isRecording']() : undefined;
    return isNullish(r) ? true : !!r;
  }

  /** @private */
  startRecorder_() {
    if (this.stopRrweb_) return;
    this.rrwebStartAttempted_ = true;
    const options = {
      'blockClass': 'ph-no-capture',
      'blockSelector': undefined,
      'ignoreClass': 'ph-ignore-input',
      'maskTextClass': 'ph-mask',
      'maskTextSelector': undefined,
      'maskTextFn': undefined,
      'maskAllInputs': true,
      'maskInputOptions': {'password': true},
      'maskInputFn': undefined,
      'maskAllElementAttributes': false,
      'maskAttributeFn': undefined,
      'slimDOMOptions': {},
      'collectFonts': false,
      'inlineStylesheet': true,
      'inlineStylesheetBudgetRules': 10000,
      'recordCrossOriginIframes': false,
      'sampling': undefined,
      'attributeFilter': undefined,
    };
    const userOptions = this.instance_.config['session_recording'];
    const entries = userOptions ? Object.keys(userOptions) : [];
    entries.forEach(function(key) {
      const value = userOptions[key];
      if (key in options) {
        if (key === 'maskInputOptions') {
          const m = {'password': true};
          if (value) for (const k in value) m[k] = value[k];
          options['maskInputOptions'] = m;
        } else if (key === 'sampling') {
          const userSampling = isNullish(value) ? {} : value;
          const sampling = {};
          if (!isUndefined(userSampling['mousemove'])) sampling['mousemove'] = userSampling['mousemove'];
          if (!isUndefined(userSampling['mouseInteraction'])) {
            sampling['mouseInteraction'] = userSampling['mouseInteraction'];
          }
          options['sampling'] = sampling;
        } else {
          options[key] = value;
        }
      }
    });
    if (userOptions && userOptions['captureJsonLd'] === true && options['slimDOMOptions'] !== true &&
        options['slimDOMOptions'] !== 'all') {
      const slim = {};
      for (const k in options['slimDOMOptions']) slim[k] = options['slimDOMOptions'][k];
      slim['script'] = true;
      options['slimDOMOptions'] = slim;
    }
    const canvas = this.canvasRecording_();
    const self = this;
    if (canvas && canvas.enabled) {
      options['recordCanvas'] = true;
      const sampling = {};
      if (options['sampling']) for (const k in options['sampling']) sampling[k] = options['sampling'][k];
      sampling['canvas'] = canvas.fps;
      options['sampling'] = sampling;
      options['dataURLOptions'] = {'type': 'image/webp', 'quality': canvas.quality};
      options['canvasResolutionScale'] = this.canvasResolutionScale_();
      const maskRegionsFn = function() {
        const cc = self.srConfig_()['canvasCapture'];
        return cc ? cc['maskRegionsFn'] : undefined;
      };
      options['canvasMasking'] = {
        'configured': function() {
          return isFunction(maskRegionsFn());
        },
        'regionsFn': function(canvasEl) {
          const fn = maskRegionsFn();
          if (!isFunction(fn)) return undefined;
          try {
            const r = fn(canvasEl);
            return isNullish(r) ? null : r;
          } catch (e) {
            if (!self.maskRegionsFnFailed_) {
              self.maskRegionsFnFailed_ = true;
              logger.warn('canvasCapture.maskRegionsFn threw, canvas frames will be skipped', e);
            }
            return null;
          }
        },
      };
    }
    const masking = this.masking_();
    if (masking) {
      options['maskAllInputs'] = isNullish(masking['maskAllInputs']) ? true : masking['maskAllInputs'];
      options['maskTextSelector'] = isNullish(masking['maskTextSelector']) ? undefined : masking['maskTextSelector'];
      options['blockSelector'] = isNullish(masking['blockSelector']) ? undefined : masking['blockSelector'];
      options['maskAllElementAttributes'] = isNullish(masking['maskAllElementAttributes']) ? false :
          masking['maskAllElementAttributes'];
    }
    if (options['maskAllElementAttributes'] && options['maskAttributeFn']) {
      options['maskAttributeFn'] = undefined;
      if (!this.hasWarnedExclusiveAttributeMasking_) {
        this.hasWarnedExclusiveAttributeMasking_ = true;
        logger.warn('`maskAllElementAttributes` and `maskAttributeFn` are mutually exclusive, and ' +
            '`maskAttributeFn` is being ignored. Remove one of the two. Note that `maskAllElementAttributes` can ' +
            'also come from your project\'s "Privacy and masking" settings. ' +
            'See https://posthog.com/docs/session-replay/privacy');
      }
    }
    this.warnIfClientMaskingShadowsServer_();

    const rrwebRecord = getRRWebRecord();
    if (!rrwebRecord) {
      logger.error('_startRecorder was called but rrwebRecord is not available. This indicates something has gone ' +
          'wrong.');
      return;
    }
    const sr = this.srConfig_();
    if (!this.mutationThrottler_) {
      this.mutationThrottler_ = new MutationThrottler(rrwebRecord, {
        refillRate: sr['__mutationThrottlerRefillRate'],
        bucketSize: sr['__mutationThrottlerBucketSize'],
        onBlockedNode: function(id, node) {
          const message = 'Too many mutations on node \'' + id + '\'. Rate limiting. This could be due to SVG ' +
              'animations or something similar';
          logger.info(message, {'node': node});
          self.log(LOGGER_PREFIX + ' ' + message, 'warn');
        },
        onDroppedAttributeMutations: function(count) {
          self.throttledMutationsDropped_ += count;
        },
        bytesRefillRate: sr['__mutationBytesRefillRate'],
        bytesBucketSize: sr['__mutationBytesBucketSize'],
        resyncIntervalMs: this.fullSnapshotIntervalMillis_(),
        onDroppedOversizedMutation: function(bytes) {
          if (self.oversizedMutationsDropped_ === 0) {
            self.log(LOGGER_PREFIX + ' Dropped an oversized DOM mutation to keep the recording playable. The ' +
                'recording will resync with a full snapshot.', 'warn');
          }
          self.oversizedMutationsDropped_ += 1;
          self.oversizedMutationBytesDropped_ += bytes;
        },
        requestFullSnapshot: function() {
          self.tryTakeFullSnapshot_();
        },
      });
    }
    const activePlugins = this.gatherRRWebPlugins_();
    const sourceHandoff = this.styleRuleSourceHandoff_;
    const recordOptions = {
      'emit': function(event) {
        if (sourceHandoff && sourceHandoff.cancelled) return;
        if (sourceHandoff && self.styleRuleSourceHandoff_ === sourceHandoff &&
            (self.instance_.config['disable_session_recording'] || self.instance_.has_opted_out_capturing())) {
          sourceHandoff.cancel();
          return;
        }
        self.onRRwebEmit(event);
      },
      'plugins': activePlugins,
      'errorHandler': function(error, context) {
        if (context !== 'rrweb') return false;
        if (!self.hasLoggedRecorderCallbackError_) {
          self.hasLoggedRecorderCallbackError_ = true;
          logger.error('rrweb internal error - recording will continue but may be incomplete', error);
        }
        return true;
      },
    };
    for (const k in options) recordOptions[k] = options[k];
    recordOptions['recordAfter'] = 'DOMContentLoaded';
    this.stopRrweb_ = rrwebRecord(recordOptions);
    if (!this.stopRrweb_) {
      this.rrwebError_ = true;
      logger.error('rrweb failed to start - Loss of recording data is possible. Check the browser console for rrweb ' +
          'errors.');
      return;
    }
    this.rrwebError_ = false;

    if (userOptions && userOptions['captureJsonLd'] === true && doc && win && win['MutationObserver'] &&
        !this.jsonLdCapture_) {
      this.jsonLdCapture_ = startJsonLdCapture(doc, win['MutationObserver'], {
        maskUrl: function(url) {
          return self.maskReplayUrl_(url);
        },
        attributeFilter: options['attributeFilter'],
        blockClass: options['blockClass'],
        blockSelector: options['blockSelector'],
        isRecordedElement: function(element) {
          return rrwebRecord['mirror']['getId'](element) > 0;
        },
        maskAllElementAttributes: options['maskAllElementAttributes'],
        maskAttributeFn: options['maskAttributeFn'],
        maskTextClass: options['maskTextClass'],
        maskTextSelector: options['maskTextSelector'],
        getCaptureState: function() {
          return self.srConfig_()['captureJsonLd'] !== true || self.urlTriggerMatching_.urlBlocked ||
              self.urlTriggerMatching_.isCurrentUrlBlocked() ? null : self.canCaptureJsonLd_();
        },
        emit: function(jsonLd) {
          return self.tryAddJsonLdEvent_(jsonLd);
        },
      });
      if (this.urlTriggerMatching_.isCurrentUrlBlocked()) this.jsonLdCapture_.scan();
    }

    this.lastActivityTimestamp_ = Date.now();
    this.isIdle_ = isBoolean(this.isIdle_) ? this.isIdle_ : 'unknown';

    this.tryAddCustomEvent('$remote_config_received', this.remoteConfig());
    this.tryAddCustomEvent_('$session_options', {
      'sessionRecordingOptions': options,
      'activePlugins': activePlugins.map(function(p) {
        return p ? p['name'] : undefined;
      }),
    });
    this.tryAddCustomEvent_('$posthog_config', {'config': this.instance_.config});
  }

  /**
   * @param {string} tag
   * @param {*} payload
   * @return {boolean}
   */
  tryAddCustomEvent(tag, payload) {
    return this.tryAddCustomEvent_(tag, payload);
  }
}

/**
 * The SessionManager surface the recorder uses.
 * @record
 */
export class SessionManagerLike {
  constructor() {
    /** @type {number} */
    this.sessionTimeoutMs;
  }
  /**
   * @param {boolean=} readOnly
   * @param {?number=} ts
   * @return {{sessionId: string, windowId: string, sessionStartTimestamp: number}}
   */
  checkAndGetSessionAndWindowId(readOnly, ts) {}
  /**
   * @param {function(string, string, (!Object|undefined))} cb
   * @return {function()}
   */
  onSessionId(cb) {}
  /**
   * @param {function()} cb
   * @return {function()}
   */
  onForcedIdleReset(cb) {}
}
