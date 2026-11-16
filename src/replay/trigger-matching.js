/**
 * @fileoverview Port of upstream replay/external/triggerMatching.ts: URL,
 * event and linked-flag triggers, the URL blocklist, V2 trigger groups and the
 * status functions. Configs and persisted values use quoted keys.
 */
import {PostHog} from '../core/posthog.js';
import {logger} from '../core/logger.js';
import {isBoolean, isFunction, isNullish, isObject, isString, isUndefined, win} from '../core/utils.js';
import {
  ACTIVE, BUFFERING, DISABLED, PAUSED, RRWEB_ERROR, SAMPLED,
  SDK_DEBUG_REPLAY_EVENT_TRIGGER_STATUS, SDK_DEBUG_REPLAY_LINKED_FLAG_TRIGGER_STATUS,
  SDK_DEBUG_REPLAY_URL_TRIGGER_STATUS, SESSION_RECORDING_EVENT_TRIGGER_ACTIVATED_SESSION,
  SESSION_RECORDING_TRIGGER_V2_GROUP_EVENT_PREFIX, SESSION_RECORDING_TRIGGER_V2_GROUP_URL_PREFIX,
  SESSION_RECORDING_URL_TRIGGER_ACTIVATED_SESSION, TRIGGER_ACTIVATED, TRIGGER_DISABLED, TRIGGER_PENDING,
} from './constants.js';

/**
 * Upstream getTargetingUrl: window.location.href through `get_current_url`.
 * @param {?PostHog|undefined} instance
 * @return {string|undefined}
 */
export function getTargetingUrl(instance) {
  const defaultUrl = win && win.location ? win.location.href : undefined;
  if (isUndefined(defaultUrl)) return undefined;
  const override = instance && instance.config ? instance.config['get_current_url'] : undefined;
  if (!isFunction(override)) return defaultUrl;
  try {
    const result = override(defaultUrl);
    return isString(result) && result ? result : defaultUrl;
  } catch (e) {
    logger.error('Error in get_current_url, falling back to window.location.href', e);
    return defaultUrl;
  }
}

/**
 * @param {?PostHog|undefined} instance
 * @param {number} triggerCount
 * @param {string|undefined} groupId
 * @param {string} groupPrefix
 * @param {string} fallbackPersistenceKey
 * @param {string} sessionId
 * @return {string}
 */
function persistedTriggerStatus(instance, triggerCount, groupId, groupPrefix, fallbackPersistenceKey, sessionId) {
  if (triggerCount === 0) return TRIGGER_DISABLED;
  const persistenceKey = groupId ? groupPrefix + groupId : fallbackPersistenceKey;
  const currentTriggerSession = instance ? instance.get_property(persistenceKey) : undefined;
  return currentTriggerSession === sessionId ? TRIGGER_ACTIVATED : TRIGGER_PENDING;
}

/**
 * @param {string} url
 * @param {!Array<!Object>} triggers
 * @param {!Object<string, !RegExp>=} compiledRegexCache
 * @return {boolean}
 */
function sessionRecordingUrlTriggerMatches(url, triggers, compiledRegexCache) {
  return triggers.some(function(trigger) {
    switch (trigger['matching']) {
      case 'regex': {
        const cached = compiledRegexCache && Object.prototype.hasOwnProperty.call(compiledRegexCache, trigger['url']) ?
            compiledRegexCache[trigger['url']] : undefined;
        const regex = cached || new RegExp(trigger['url']);
        return regex.test(url);
      }
      default:
        return false;
    }
  });
}

/**
 * @interface
 */
export class TriggerStatusMatching {
  /**
   * @param {string} sessionId
   * @return {string}
   */
  triggerStatus(sessionId) {}
  /**
   * @param {string} sessionId
   * @return {string}
   */
  triggerStatusNoSideEffects(sessionId) {}
  stop() {}
}

/**
 * @param {!Array<string>} statuses
 * @return {string}
 */
function orTriggerStatus(statuses) {
  if (statuses.indexOf(TRIGGER_ACTIVATED) !== -1) return TRIGGER_ACTIVATED;
  if (statuses.indexOf(TRIGGER_PENDING) !== -1) return TRIGGER_PENDING;
  return TRIGGER_DISABLED;
}

/**
 * @param {!Array<string>} statuses
 * @return {string}
 */
function andTriggerStatus(statuses) {
  const enabled = [];
  statuses.forEach(function(s) {
    if (s !== TRIGGER_DISABLED && enabled.indexOf(s) === -1) enabled.push(s);
  });
  switch (enabled.length) {
    case 0:
      return TRIGGER_DISABLED;
    case 1:
      return enabled[0];
    default:
      return TRIGGER_PENDING;
  }
}

/** @implements {TriggerStatusMatching} */
export class OrTriggerMatching {
  /** @param {!Array<!TriggerStatusMatching>} matchers */
  constructor(matchers) {
    /** @private @const */
    this.matchers_ = matchers;
  }
  /** @override */
  triggerStatus(sessionId) {
    return orTriggerStatus(this.matchers_.map(function(m) {
      return m.triggerStatus(sessionId);
    }));
  }
  /** @override */
  triggerStatusNoSideEffects(sessionId) {
    return orTriggerStatus(this.matchers_.map(function(m) {
      return m.triggerStatusNoSideEffects(sessionId);
    }));
  }
  /** @override */
  stop() {
    this.matchers_.forEach(function(m) {
      m.stop();
    });
  }
}

/** @implements {TriggerStatusMatching} */
export class AndTriggerMatching {
  /** @param {!Array<!TriggerStatusMatching>} matchers */
  constructor(matchers) {
    /** @private @const */
    this.matchers_ = matchers;
  }
  /** @override */
  triggerStatus(sessionId) {
    return andTriggerStatus(this.matchers_.map(function(m) {
      return m.triggerStatus(sessionId);
    }));
  }
  /** @override */
  triggerStatusNoSideEffects(sessionId) {
    return andTriggerStatus(this.matchers_.map(function(m) {
      return m.triggerStatusNoSideEffects(sessionId);
    }));
  }
  /** @override */
  stop() {
    this.matchers_.forEach(function(m) {
      m.stop();
    });
  }
}

/** @implements {TriggerStatusMatching} */
export class PendingTriggerMatching {
  /** @override */
  triggerStatus(sessionId) {
    return TRIGGER_PENDING;
  }
  /** @override */
  triggerStatusNoSideEffects(sessionId) {
    return TRIGGER_PENDING;
  }
  /** @override */
  stop() {}
}

/** @implements {TriggerStatusMatching} */
export class AlwaysActivatedTriggerMatching {
  /** @override */
  triggerStatus(sessionId) {
    return TRIGGER_ACTIVATED;
  }
  /** @override */
  triggerStatusNoSideEffects(sessionId) {
    return TRIGGER_ACTIVATED;
  }
  /** @override */
  stop() {}
}

/**
 * A config is "eager loaded" (a full remote config) when it has `sessionRecording`.
 * @param {!Object} config
 * @param {string} key
 * @param {*} emptyValue value when sessionRecording is not an object
 * @return {*}
 */
function readTriggerConfig(config, key, emptyValue) {
  if ('sessionRecording' in config) {
    const sr = config['sessionRecording'];
    return isObject(sr) ? sr[key] : emptyValue;
  }
  return config ? config[key] : undefined;
}

/** @implements {TriggerStatusMatching} */
export class URLTriggerMatching {
  /**
   * @param {?PostHog} instance
   * @param {string=} groupId
   */
  constructor(instance, groupId) {
    /** @private @const */
    this.instance_ = instance;
    /** @type {!Array<!Object>} */
    this.urlTriggers = [];
    /** @type {!Array<!Object>} */
    this.urlBlocklist = [];
    /** @private {!Object<string, !RegExp>} */
    this.compiledTriggerRegexes_ = {};
    /** @private {!Object<string, !RegExp>} */
    this.compiledBlocklistRegexes_ = {};
    /** @private {string} */
    this.lastCheckedUrl_ = '';
    /** @private @const {string|undefined} */
    this.groupId_ = groupId;
    /** @type {boolean} */
    this.urlBlocked = false;
  }

  /** @param {!Object} config */
  onConfig(config) {
    this.urlTriggers = /** @type {!Array<!Object>} */ (readTriggerConfig(config, 'urlTriggers', []) || []);
    this.urlBlocklist = /** @type {!Array<!Object>} */ (readTriggerConfig(config, 'urlBlocklist', []) || []);
    this.compileRegexCache_();
  }

  /** @private */
  compileRegexCache_() {
    const triggers = {};
    const blocklist = {};
    this.urlTriggers.forEach(function(trigger) {
      if (trigger['matching'] === 'regex' && !Object.prototype.hasOwnProperty.call(triggers, trigger['url'])) {
        try {
          triggers[trigger['url']] = new RegExp(trigger['url']);
        } catch (e) {
          logger.error('Invalid URL trigger regex pattern:', trigger['url'], e);
        }
      }
    });
    this.urlBlocklist.forEach(function(trigger) {
      if (trigger['matching'] === 'regex' && !Object.prototype.hasOwnProperty.call(blocklist, trigger['url'])) {
        try {
          blocklist[trigger['url']] = new RegExp(trigger['url']);
        } catch (e) {
          logger.error('Invalid URL blocklist regex pattern:', trigger['url'], e);
        }
      }
    });
    this.compiledTriggerRegexes_ = triggers;
    this.compiledBlocklistRegexes_ = blocklist;
  }

  /** @param {!Object} response @deprecated */
  onRemoteConfig(response) {
    this.onConfig(response);
  }

  /**
   * @param {string} sessionId
   * @return {string}
   * @private
   */
  urlTriggerStatus_(sessionId) {
    return persistedTriggerStatus(this.instance_, this.urlTriggers.length, this.groupId_,
        SESSION_RECORDING_TRIGGER_V2_GROUP_URL_PREFIX, SESSION_RECORDING_URL_TRIGGER_ACTIVATED_SESSION, sessionId);
  }

  /** @override */
  triggerStatus(sessionId) {
    const result = this.triggerStatusNoSideEffects(sessionId);
    if (this.instance_) this.instance_.register_for_session({[SDK_DEBUG_REPLAY_URL_TRIGGER_STATUS]: result});
    return result;
  }

  /** @override */
  triggerStatusNoSideEffects(sessionId) {
    return this.urlTriggerStatus_(sessionId);
  }

  /** @return {boolean} */
  isCurrentUrlBlocked() {
    const url = getTargetingUrl(this.instance_);
    if (!url) return false;
    try {
      return sessionRecordingUrlTriggerMatches(url, this.urlBlocklist, this.compiledBlocklistRegexes_);
    } catch (e) {
      return true;
    }
  }

  /**
   * @param {function()} onPause
   * @param {function()} onResume
   */
  checkUrlBlocklist(onPause, onResume) {
    const url = getTargetingUrl(this.instance_);
    if (!url) return;
    if (url === this.lastCheckedUrl_) return;
    this.lastCheckedUrl_ = url;
    const wasBlocked = this.urlBlocked;
    const isNowBlocked = sessionRecordingUrlTriggerMatches(url, this.urlBlocklist, this.compiledBlocklistRegexes_);
    if (wasBlocked && isNowBlocked) return;
    if (isNowBlocked && !wasBlocked) onPause();
    else if (!isNowBlocked && wasBlocked) onResume();
  }

  /**
   * @param {function()} onPause
   * @param {function()} onResume
   * @param {function(string, string=)} onActivate
   * @param {string} sessionId
   */
  checkUrlTriggerConditions(onPause, onResume, onActivate, sessionId) {
    const url = getTargetingUrl(this.instance_);
    if (!url) return;
    if (url === this.lastCheckedUrl_) return;
    this.lastCheckedUrl_ = url;
    const wasBlocked = this.urlBlocked;
    const isNowBlocked = sessionRecordingUrlTriggerMatches(url, this.urlBlocklist, this.compiledBlocklistRegexes_);
    if (isNowBlocked && !wasBlocked) onPause();
    else if (!isNowBlocked && wasBlocked) onResume();
    const isActivated = this.urlTriggerStatus_(sessionId) === TRIGGER_ACTIVATED;
    const urlMatches = sessionRecordingUrlTriggerMatches(url, this.urlTriggers, this.compiledTriggerRegexes_);
    if (!isActivated && urlMatches) onActivate('url', url);
  }

  /** @override */
  stop() {
    this.lastCheckedUrl_ = '';
  }
}

/** @implements {TriggerStatusMatching} */
export class LinkedFlagMatching {
  /** @param {?PostHog} instance */
  constructor(instance) {
    /** @private @const */
    this.instance_ = instance;
    /** @type {string|?Object} */
    this.linkedFlag = null;
    /** @type {boolean} */
    this.linkedFlagSeen = false;
    /** @private {function()} */
    this.flagListenerCleanup_ = function() {};
  }

  /** @override */
  triggerStatus(sessionId) {
    const result = this.triggerStatusNoSideEffects(sessionId);
    if (this.instance_) this.instance_.register_for_session({[SDK_DEBUG_REPLAY_LINKED_FLAG_TRIGGER_STATUS]: result});
    return result;
  }

  /** @override */
  triggerStatusNoSideEffects(sessionId) {
    let result = TRIGGER_PENDING;
    if (isNullish(this.linkedFlag)) result = TRIGGER_DISABLED;
    if (this.linkedFlagSeen) result = TRIGGER_ACTIVATED;
    return result;
  }

  /**
   * @param {!Object} config
   * @param {function(string, ?string)} onStarted
   */
  onConfig(config, onStarted) {
    this.linkedFlag = /** @type {string|?Object} */ (readTriggerConfig(config, 'linkedFlag', null) || null);
    if (!isNullish(this.linkedFlag) && !this.linkedFlagSeen && this.instance_) {
      const lf = this.linkedFlag;
      const linkedFlag = /** @type {string} */ (isString(lf) ? lf : lf['flag']);
      const linkedVariant = isString(lf) ? null : /** @type {?string} */ (lf['variant']);
      const self = this;
      this.flagListenerCleanup_ = this.instance_.onFeatureFlags(function(_flags, variants) {
        const flagIsPresent = isObject(variants) && linkedFlag in variants;
        let linkedFlagMatches = false;
        if (flagIsPresent) {
          const variantForFlagKey = variants[linkedFlag];
          if (isBoolean(variantForFlagKey)) {
            linkedFlagMatches = variantForFlagKey === true;
          } else if (linkedVariant) {
            linkedFlagMatches = variantForFlagKey === linkedVariant;
          } else {
            linkedFlagMatches = !!variantForFlagKey;
          }
        }
        const isNewActivation = linkedFlagMatches && !self.linkedFlagSeen;
        self.linkedFlagSeen = linkedFlagMatches;
        if (isNewActivation) onStarted(linkedFlag, linkedVariant);
      });
    }
  }

  /** @override */
  stop() {
    this.flagListenerCleanup_();
  }
}

/** @implements {TriggerStatusMatching} */
export class EventTriggerMatching {
  /**
   * @param {?PostHog} instance
   * @param {string=} groupId
   */
  constructor(instance, groupId) {
    /** @private @const */
    this.instance_ = instance;
    /** @type {!Array<string>} */
    this.eventTriggers = [];
    /** @private @const {string|undefined} */
    this.groupId_ = groupId;
  }

  /** @param {!Object} config */
  onConfig(config) {
    this.eventTriggers = /** @type {!Array<string>} */ (readTriggerConfig(config, 'eventTriggers', []) || []);
  }

  /**
   * @param {string} sessionId
   * @return {string}
   * @private
   */
  eventTriggerStatus_(sessionId) {
    return persistedTriggerStatus(this.instance_, this.eventTriggers.length, this.groupId_,
        SESSION_RECORDING_TRIGGER_V2_GROUP_EVENT_PREFIX, SESSION_RECORDING_EVENT_TRIGGER_ACTIVATED_SESSION, sessionId);
  }

  /** @override */
  triggerStatus(sessionId) {
    const result = this.triggerStatusNoSideEffects(sessionId);
    if (this.instance_) this.instance_.register_for_session({[SDK_DEBUG_REPLAY_EVENT_TRIGGER_STATUS]: result});
    return result;
  }

  /** @override */
  triggerStatusNoSideEffects(sessionId) {
    return this.eventTriggerStatus_(sessionId);
  }

  /**
   * @param {string} eventName
   * @param {function(string, string=)} onActivate
   * @param {string} sessionId
   */
  checkEventTriggerConditions(eventName, onActivate, sessionId) {
    if (this.eventTriggers.length === 0) return;
    const isActivated = this.eventTriggerStatus_(sessionId) === TRIGGER_ACTIVATED;
    if (!isActivated && this.eventTriggers.indexOf(eventName) !== -1) onActivate('event', eventName);
  }

  /** @override */
  stop() {}
}

/**
 * V2: one trigger group with its own conditions.
 * @implements {TriggerStatusMatching}
 */
export class TriggerGroupMatching {
  /**
   * @param {?PostHog} instance
   * @param {!Object} group server group (quoted keys)
   * @param {function(string, ?string)} onFlagStarted
   */
  constructor(instance, group, onFlagStarted) {
    /** @private @const */
    this.instance_ = instance;
    /** @const {!Object} */
    this.group = group;
    /** @private @const */
    this.urlTriggerMatching_ = new URLTriggerMatching(instance, group['id']);
    /** @private @const */
    this.eventTriggerMatching_ = new EventTriggerMatching(instance, group['id']);
    /** @private @const */
    this.linkedFlagMatching_ = new LinkedFlagMatching(instance);
    const conditions = group['conditions'] || {};
    const hasEvents = conditions['events'] && conditions['events'].length > 0;
    const hasUrls = conditions['urls'] && conditions['urls'].length > 0;
    const hasFlag = !!conditions['flag'];
    /** @private {!TriggerStatusMatching} */
    this.combinedMatching_;
    if (!hasEvents && !hasUrls && !hasFlag) {
      this.combinedMatching_ = new AlwaysActivatedTriggerMatching();
    } else {
      const eventNames = (conditions['events'] || []).map(function(e) {
        return e['name'];
      });
      const config = {
        'urlTriggers': conditions['urls'] || [],
        'eventTriggers': eventNames,
        'linkedFlag': conditions['flag'] || null,
        'urlBlocklist': [],
      };
      this.urlTriggerMatching_.onConfig(config);
      this.eventTriggerMatching_.onConfig(config);
      this.linkedFlagMatching_.onConfig(config, onFlagStarted);
      const matchers = [this.eventTriggerMatching_, this.urlTriggerMatching_, this.linkedFlagMatching_];
      this.combinedMatching_ = conditions['matchType'] === 'any' ?
          new OrTriggerMatching(matchers) : new AndTriggerMatching(matchers);
    }
  }

  /** @override */
  triggerStatus(sessionId) {
    return this.combinedMatching_.triggerStatus(sessionId);
  }

  /** @override */
  triggerStatusNoSideEffects(sessionId) {
    return this.combinedMatching_.triggerStatusNoSideEffects(sessionId);
  }

  /**
   * @param {string} sessionId
   * @return {!Array<string>}
   */
  getPendingTriggerConditions(sessionId) {
    if (this.triggerStatusNoSideEffects(sessionId) !== TRIGGER_PENDING) return [];
    return pendingLegs(this.urlTriggerMatching_, this.eventTriggerMatching_, this.linkedFlagMatching_, sessionId);
  }

  /**
   * @param {string} eventName
   * @param {function(string, string=)} onActivate
   * @param {string} sessionId
   */
  checkEventTriggerConditions(eventName, onActivate, sessionId) {
    this.eventTriggerMatching_.checkEventTriggerConditions(eventName, onActivate, sessionId);
  }

  /**
   * @param {function()} onPause
   * @param {function()} onResume
   * @param {function(string, string=)} onActivate
   * @param {string} sessionId
   */
  checkUrlTriggerConditions(onPause, onResume, onActivate, sessionId) {
    this.urlTriggerMatching_.checkUrlTriggerConditions(onPause, onResume, onActivate, sessionId);
  }

  /**
   * @param {string} triggerType
   * @param {string} sessionId
   */
  activateTrigger(triggerType, sessionId) {
    const key = (triggerType === 'url' ? SESSION_RECORDING_TRIGGER_V2_GROUP_URL_PREFIX :
        SESSION_RECORDING_TRIGGER_V2_GROUP_EVENT_PREFIX) + this.group['id'];
    if (this.instance_ && this.instance_.persistence) this.instance_.persistence.register({[key]: sessionId});
  }

  /** @override */
  stop() {
    this.urlTriggerMatching_.stop();
    this.eventTriggerMatching_.stop();
    this.linkedFlagMatching_.stop();
  }
}

/**
 * Labels of the trigger legs that are still pending (no side effects).
 * @param {!URLTriggerMatching} url
 * @param {!EventTriggerMatching} event
 * @param {!LinkedFlagMatching} flag
 * @param {string} sessionId
 * @return {!Array<string>}
 */
export function pendingLegs(url, event, flag, sessionId) {
  const legs = [
    {label: 'URL condition not matched', status: url.triggerStatusNoSideEffects(sessionId)},
    {label: 'event condition not matched', status: event.triggerStatusNoSideEffects(sessionId)},
    {label: 'linked flag condition not matched', status: flag.triggerStatusNoSideEffects(sessionId)},
  ];
  return legs.filter(function(l) {
    return l.status === TRIGGER_PENDING;
  }).map(function(l) {
    return l.label;
  });
}

/**
 * @typedef {{
 *   receivedFlags: boolean,
 *   isRecordingEnabled: (boolean|undefined),
 *   isSampled: ?boolean,
 *   rrwebError: boolean,
 *   urlTriggerMatching: !URLTriggerMatching,
 *   eventTriggerMatching: !EventTriggerMatching,
 *   linkedFlagMatching: !LinkedFlagMatching,
 *   sessionId: string,
 *   triggerGroupMatchers: (!Array<!TriggerGroupMatching>|undefined),
 *   triggerGroupSamplingResults: (!Object<string, boolean>|undefined),
 *   minimumDuration: (?number|undefined),
 * }}
 */
export let RecordingTriggersStatus;

/**
 * @param {!RecordingTriggersStatus} s
 * @return {string}
 */
export function nullMatchSessionRecordingStatus(s) {
  if (s.rrwebError) return RRWEB_ERROR;
  if (!s.isRecordingEnabled) return DISABLED;
  return BUFFERING;
}

/**
 * @param {!RecordingTriggersStatus} s
 * @return {string}
 */
export function anyMatchSessionRecordingStatus(s) {
  if (s.rrwebError) return RRWEB_ERROR;
  if (!s.receivedFlags) return BUFFERING;
  if (!s.isRecordingEnabled) return DISABLED;
  if (s.urlTriggerMatching.urlBlocked) return PAUSED;
  const sampledActive = s.isSampled === true;
  const triggerMatches = new OrTriggerMatching([s.eventTriggerMatching, s.urlTriggerMatching, s.linkedFlagMatching])
      .triggerStatus(s.sessionId);
  if (sampledActive) return SAMPLED;
  if (triggerMatches === TRIGGER_ACTIVATED) return ACTIVE;
  if (triggerMatches === TRIGGER_PENDING) return BUFFERING;
  if (s.isSampled === false) return DISABLED;
  return ACTIVE;
}

/**
 * @param {!RecordingTriggersStatus} s
 * @return {string}
 */
export function allMatchSessionRecordingStatus(s) {
  if (s.rrwebError) return RRWEB_ERROR;
  if (!s.receivedFlags) return BUFFERING;
  if (!s.isRecordingEnabled) return DISABLED;
  if (s.urlTriggerMatching.urlBlocked) return PAUSED;
  const currentTriggerStatus = new AndTriggerMatching(
      [s.eventTriggerMatching, s.urlTriggerMatching, s.linkedFlagMatching]).triggerStatus(s.sessionId);
  const hasTriggersConfigured = currentTriggerStatus !== TRIGGER_DISABLED;
  const hasSamplingConfigured = isBoolean(s.isSampled);
  if (hasTriggersConfigured && currentTriggerStatus === TRIGGER_PENDING) return BUFFERING;
  if (hasTriggersConfigured && currentTriggerStatus === TRIGGER_DISABLED) return DISABLED;
  if (hasSamplingConfigured && !s.isSampled) return DISABLED;
  if (s.isSampled === true) return SAMPLED;
  return ACTIVE;
}

/**
 * V2 union behaviour: record when any activated group's sample rate hit.
 * @param {!RecordingTriggersStatus} s
 * @return {string}
 */
export function triggerGroupsMatchSessionRecordingStatus(s) {
  if (s.rrwebError) return RRWEB_ERROR;
  if (!s.receivedFlags) return BUFFERING;
  if (!s.isRecordingEnabled) return DISABLED;
  if (s.urlTriggerMatching.urlBlocked) return PAUSED;
  const groupMatchers = s.triggerGroupMatchers || [];
  const samplingResults = s.triggerGroupSamplingResults || {};
  if (groupMatchers.length === 0) return DISABLED;
  let anyGroupPending = false;
  let anyGroupSampled = false;
  groupMatchers.forEach(function(matcher) {
    const groupStatus = matcher.triggerStatus(s.sessionId);
    if (groupStatus === TRIGGER_ACTIVATED) {
      const groupId = matcher.group['id'];
      const samplingResult = Object.prototype.hasOwnProperty.call(samplingResults, groupId) ?
          samplingResults[groupId] : undefined;
      if (isUndefined(samplingResult)) {
        logger.warn('[V2 Triggers] Group activated but no sampling decision found', {'groupId': groupId});
      } else if (samplingResult === true) {
        anyGroupSampled = true;
      }
    } else if (groupStatus === TRIGGER_PENDING) {
      anyGroupPending = true;
    }
  });
  if (anyGroupSampled) return SAMPLED;
  if (anyGroupPending) return BUFFERING;
  return DISABLED;
}
