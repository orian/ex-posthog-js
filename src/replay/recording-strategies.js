/**
 * @fileoverview Port of upstream replay/external/recording-strategies.ts: V1
 * (global URL/event/flag triggers) and V2 (trigger groups) strategies, and the
 * session-tagged sampling decision encoding.
 */
import {PostHog} from '../core/posthog.js';
import {logger as baseLogger} from '../core/logger.js';
import {isArray, isBoolean, isNull, isNullish, isNumber, isObject, isUndefined} from '../core/utils.js';
import {
  SDK_DEBUG_REPLAY_MATCHED_RECORDING_TRIGGER_GROUPS, SDK_DEBUG_REPLAY_REMOTE_TRIGGER_MATCHING_CONFIG,
  SDK_DEBUG_REPLAY_TRIGGER_GROUPS_COUNT, SESSION_RECORDING_EVENT_TRIGGER_ACTIVATED_SESSION,
  SESSION_RECORDING_IS_SAMPLED, SESSION_RECORDING_PAST_MINIMUM_DURATION, SESSION_RECORDING_REMOTE_CONFIG,
  SESSION_RECORDING_SAMPLE_RATE, SESSION_RECORDING_TRIGGER_V2_GROUP_EVENT_PREFIX,
  SESSION_RECORDING_TRIGGER_V2_GROUP_SAMPLING_PREFIX, SESSION_RECORDING_TRIGGER_V2_GROUP_URL_PREFIX,
  SESSION_RECORDING_URL_TRIGGER_ACTIVATED_SESSION, STORED_PERSON_PROPERTIES_KEY, TRIGGER_ACTIVATED, TRIGGER_PENDING,
} from './constants.js';
import {
  AndTriggerMatching, EventTriggerMatching, LinkedFlagMatching, OrTriggerMatching, RecordingTriggersStatus,
  TriggerGroupMatching, TriggerStatusMatching, URLTriggerMatching, allMatchSessionRecordingStatus,
  anyMatchSessionRecordingStatus, pendingLegs, triggerGroupsMatchSessionRecordingStatus,
} from './trigger-matching.js';
import {sampleOnProperty} from './sampling.js';

const logger = baseLogger.createLogger('[SessionRecording]');

const NOT_SAMPLED_PREFIX = '!';

/**
 * @param {string} sessionId
 * @param {boolean} isSampled
 * @return {string}
 */
export function encodeSamplingDecision(sessionId, isSampled) {
  return isSampled ? sessionId : NOT_SAMPLED_PREFIX + sessionId;
}

/**
 * @param {*} storedValue
 * @param {string} sessionId
 * @return {?boolean}
 */
export function decodeSamplingDecision(storedValue, sessionId) {
  if (storedValue === sessionId) return true;
  if (storedValue === NOT_SAMPLED_PREFIX + sessionId) return false;
  return null;
}

// ---- property filters (browser-common property-utils / core property-matching) ----

/**
 * @param {string} value
 * @param {string} pattern
 * @return {boolean}
 */
function isMatchingRegex(value, pattern) {
  let re;
  try {
    re = new RegExp(pattern);
  } catch (e) {
    return false;
  }
  try {
    return re.test(value);
  } catch (e) {
    return false;
  }
}

/** @param {string} v @return {string} */
const lower = function(v) {
  return v.toLowerCase();
};

/** @const {!Object<string, function(!Array<string>, !Array<string>): boolean>} */
export const propertyComparisons = {
  'exact': function(targets, values) {
    return values.some(function(v) {
      return targets.some(function(t) {
        return v === t;
      });
    });
  },
  'is_not': function(targets, values) {
    return values.every(function(v) {
      return targets.every(function(t) {
        return v !== t;
      });
    });
  },
  'regex': function(targets, values) {
    return values.some(function(v) {
      return targets.some(function(t) {
        return isMatchingRegex(v, t);
      });
    });
  },
  'not_regex': function(targets, values) {
    return values.every(function(v) {
      return targets.every(function(t) {
        return !isMatchingRegex(v, t);
      });
    });
  },
  'icontains': function(targets, values) {
    const lt = targets.map(lower);
    return values.map(lower).some(function(v) {
      return lt.some(function(t) {
        return v.indexOf(t) !== -1;
      });
    });
  },
  'not_icontains': function(targets, values) {
    const lt = targets.map(lower);
    return values.map(lower).every(function(v) {
      return lt.every(function(t) {
        return v.indexOf(t) === -1;
      });
    });
  },
  'gt': function(targets, values) {
    return values.some(function(v) {
      const n = parseFloat(v);
      return !isNaN(n) && targets.some(function(t) {
        return n > parseFloat(t);
      });
    });
  },
  'lt': function(targets, values) {
    return values.some(function(v) {
      const n = parseFloat(v);
      return !isNaN(n) && targets.some(function(t) {
        return n < parseFloat(t);
      });
    });
  },
};

const NEGATIVE_OPERATORS = ['is_not', 'not_icontains', 'not_regex'];

/**
 * Upstream matchTriggerPropertyFilters: all filters must match.
 * @param {!Array<!Object>|undefined} filters
 * @param {?Object|undefined} eventProperties
 * @param {*} personProperties
 * @return {boolean}
 */
export function matchTriggerPropertyFilters(filters, eventProperties, personProperties) {
  if (!filters || filters.length === 0) return true;
  return filters.every(function(filter) {
    const source = filter['type'] === 'person' ? personProperties : eventProperties;
    const propertyValue = source ? source[filter['key']] : undefined;
    const operator = filter['operator'] || 'exact';
    if (isNullish(propertyValue)) return NEGATIVE_OPERATORS.indexOf(operator) !== -1;
    const comparison = Object.prototype.hasOwnProperty.call(propertyComparisons, operator) ?
        propertyComparisons[operator] : undefined;
    if (!comparison) return false;
    if (isNullish(filter['value'])) return false;
    const targets = isArray(filter['value']) ? filter['value'].map(String) : [String(filter['value'])];
    const actual = isArray(propertyValue) ? propertyValue.map(String) : [String(propertyValue)];
    return comparison(targets, actual);
  });
}

/**
 * @typedef {{
 *   instance: !PostHog,
 *   sessionId: string,
 *   isSampled: ?boolean,
 *   rrwebError: boolean,
 *   urlTriggerMatching: !URLTriggerMatching,
 *   eventTriggerMatching: !EventTriggerMatching,
 *   linkedFlagMatching: !LinkedFlagMatching,
 *   remoteConfig: (?Object|undefined),
 * }}
 */
export let RecordingStrategyContext;

/** @interface */
export class RecordingStrategy {
  /** @param {!Object} config */
  onRemoteConfig(config) {}
  /**
   * @param {!RecordingStrategyContext} context
   * @return {string}
   */
  getStatus(context) {}
  /**
   * @param {string} sessionId
   * @return {?number}
   */
  getMinimumDuration(sessionId) {}
  /**
   * @param {string} sessionId
   * @param {function()} onPause
   * @param {function()} onResume
   * @param {function(string, string=)} onActivate
   */
  checkUrlTriggers(sessionId, onPause, onResume, onActivate) {}
  /**
   * @param {function(function(!Object)): function()} onEvent
   * @param {string} sessionId
   * @param {function(string, string=)} onActivate
   * @return {(function()|undefined)}
   */
  setupEventTriggerListeners(onEvent, sessionId, onActivate) {}
  /** @param {string} sessionId */
  makeSamplingDecisions(sessionId) {}
  /** @param {string} sessionId */
  ensureSamplingDecision(sessionId) {}
  onFlushComplete() {}
  clearConditionalRecordingPersistence() {}
  /** @param {string} sessionId */
  updateActiveTriggers(sessionId) {}
  /**
   * @param {string} sessionId
   * @return {boolean}
   */
  hasPendingTriggers(sessionId) {}
  /**
   * @param {string} sessionId
   * @return {!Array<string>}
   */
  getPendingTriggerConditions(sessionId) {}
  stop() {}
}

/**
 * V1: legacy global URL/event/flag triggers.
 * @implements {RecordingStrategy}
 */
export class V1RecordingStrategy {
  /**
   * @param {!PostHog} instance
   * @param {!URLTriggerMatching} urlTriggerMatching
   * @param {!EventTriggerMatching} eventTriggerMatching
   * @param {!LinkedFlagMatching} linkedFlagMatching
   * @param {function(string, ?Object=)} reportStarted
   * @param {function()} tryTakeFullSnapshot
   * @param {function(string=)} onTriggerActivated
   */
  constructor(instance, urlTriggerMatching, eventTriggerMatching, linkedFlagMatching, reportStarted,
      tryTakeFullSnapshot, onTriggerActivated) {
    /** @private @const */ this.instance_ = instance;
    /** @private @const */ this.urlTriggerMatching_ = urlTriggerMatching;
    /** @private @const */ this.eventTriggerMatching_ = eventTriggerMatching;
    /** @private @const */ this.linkedFlagMatching_ = linkedFlagMatching;
    /** @private @const */ this.reportStarted_ = reportStarted;
    /** @private @const */ this.tryTakeFullSnapshot_ = tryTakeFullSnapshot;
    /** @private @const */ this.onTriggerActivated_ = onTriggerActivated;
    /** @private {!TriggerStatusMatching|undefined} */
    this.triggerStatusMatcher_ = undefined;
    /** @private {(function()|undefined)} */
    this.removeEventTriggerCaptureHook_ = undefined;
    /** @private {?number} */
    this.sampleRate_ = null;
    /** @private {function(!RecordingTriggersStatus): string} */
    this.recordingStatusFunction_ = allMatchSessionRecordingStatus;
  }

  /** @override */
  onRemoteConfig(config) {
    this.sampleRate_ = isNumber(config['sampleRate']) ? config['sampleRate'] : null;
    if (config['triggerMatchType'] === 'any') {
      this.triggerStatusMatcher_ = new OrTriggerMatching([this.eventTriggerMatching_, this.urlTriggerMatching_]);
      this.recordingStatusFunction_ = anyMatchSessionRecordingStatus;
    } else {
      this.triggerStatusMatcher_ = new AndTriggerMatching([this.eventTriggerMatching_, this.urlTriggerMatching_]);
      this.recordingStatusFunction_ = allMatchSessionRecordingStatus;
    }
    this.instance_.register_for_session({[SDK_DEBUG_REPLAY_REMOTE_TRIGGER_MATCHING_CONFIG]: config['triggerMatchType']});
    this.urlTriggerMatching_.onConfig(config);
    this.eventTriggerMatching_.onConfig(config);
    const self = this;
    this.linkedFlagMatching_.onConfig(config, function(flag, variant) {
      self.reportStarted_('linked_flag_matched', {'flag': flag, 'variant': variant});
      self.onTriggerActivated_();
    });
  }

  /** @override */
  getStatus(context) {
    return this.recordingStatusFunction_({
      receivedFlags: true,
      isRecordingEnabled: true,
      isSampled: context.isSampled,
      rrwebError: context.rrwebError,
      urlTriggerMatching: context.urlTriggerMatching,
      eventTriggerMatching: context.eventTriggerMatching,
      linkedFlagMatching: context.linkedFlagMatching,
      sessionId: context.sessionId,
      triggerGroupMatchers: undefined,
      triggerGroupSamplingResults: undefined,
      minimumDuration: undefined,
    });
  }

  /** @override */
  getMinimumDuration(sessionId) {
    const config = this.instance_.get_property(SESSION_RECORDING_REMOTE_CONFIG);
    const duration = config ? config['minimumDurationMilliseconds'] : undefined;
    return isNumber(duration) ? /** @type {number} */ (duration) : null;
  }

  /** @override */
  checkUrlTriggers(sessionId, onPause, onResume, onActivate) {
    this.urlTriggerMatching_.checkUrlTriggerConditions(onPause, onResume, onActivate, sessionId);
  }

  /** @override */
  setupEventTriggerListeners(onEvent, sessionId, onActivate) {
    if (this.eventTriggerMatching_.eventTriggers.length === 0 || !isNullish(this.removeEventTriggerCaptureHook_)) {
      return undefined;
    }
    const self = this;
    this.removeEventTriggerCaptureHook_ = onEvent(function(event) {
      try {
        self.eventTriggerMatching_.checkEventTriggerConditions(event['event'], onActivate, sessionId);
      } catch (e) {
        logger.error('Could not activate event trigger', e);
      }
    });
    return this.removeEventTriggerCaptureHook_;
  }

  /** @override */
  makeSamplingDecisions(sessionId) {
    const currentSampleRate = this.sampleRate_;
    const persistence = this.instance_.persistence;
    if (!isNumber(currentSampleRate)) {
      if (persistence) {
        persistence.unregister(SESSION_RECORDING_IS_SAMPLED);
        persistence.unregister(SESSION_RECORDING_SAMPLE_RATE);
      }
      return;
    }
    const rate = /** @type {number} */ (currentSampleRate);
    const storedValue = this.instance_.get_property(SESSION_RECORDING_IS_SAMPLED);
    const storedSampleRate = this.instance_.get_property(SESSION_RECORDING_SAMPLE_RATE);
    const storedIsSampled = decodeSamplingDecision(storedValue, sessionId);
    const sampleRateChanged = isNumber(storedSampleRate) && storedSampleRate !== rate;
    const sampledInWithoutStoredRate = isUndefined(storedSampleRate) && storedValue === sessionId;
    const makeDecision = sampleRateChanged || sampledInWithoutStoredRate || !isBoolean(storedIsSampled);
    const shouldSample = makeDecision ? sampleOnProperty(sessionId, rate) : !!storedIsSampled;
    if (makeDecision) {
      if (shouldSample) {
        this.reportStarted_('sampled');
      } else {
        logger.warn('Sample rate (' + rate + ') has determined that this sessionId (' + sessionId +
            ') will not be sent to the server.');
      }
    }
    if (persistence) {
      persistence.register({
        [SESSION_RECORDING_IS_SAMPLED]: encodeSamplingDecision(sessionId, shouldSample),
        [SESSION_RECORDING_SAMPLE_RATE]: isNull(storedSampleRate) && storedValue === sessionId ? null : rate,
      });
    }
  }

  /** @override */
  ensureSamplingDecision(sessionId) {
    if (!isNumber(this.sampleRate_)) return;
    const storedValue = this.instance_.get_property(SESSION_RECORDING_IS_SAMPLED);
    if (!isBoolean(decodeSamplingDecision(storedValue, sessionId))) this.makeSamplingDecisions(sessionId);
  }

  /** @override */
  onFlushComplete() {}

  /** @override */
  clearConditionalRecordingPersistence() {
    const p = this.instance_.persistence;
    if (!p) return;
    p.unregister(SESSION_RECORDING_EVENT_TRIGGER_ACTIVATED_SESSION);
    p.unregister(SESSION_RECORDING_URL_TRIGGER_ACTIVATED_SESSION);
    p.unregister(SESSION_RECORDING_IS_SAMPLED);
    p.unregister(SESSION_RECORDING_SAMPLE_RATE);
    p.unregister(SESSION_RECORDING_PAST_MINIMUM_DURATION);
  }

  /** @override */
  updateActiveTriggers(sessionId) {}

  /** @override */
  hasPendingTriggers(sessionId) {
    return !!this.triggerStatusMatcher_ && this.triggerStatusMatcher_.triggerStatus(sessionId) === TRIGGER_PENDING;
  }

  /** @override */
  getPendingTriggerConditions(sessionId) {
    return pendingLegs(this.urlTriggerMatching_, this.eventTriggerMatching_, this.linkedFlagMatching_, sessionId);
  }

  /** @override */
  stop() {
    if (this.removeEventTriggerCaptureHook_) this.removeEventTriggerCaptureHook_();
    this.removeEventTriggerCaptureHook_ = undefined;
    this.eventTriggerMatching_.stop();
    this.urlTriggerMatching_.stop();
    this.linkedFlagMatching_.stop();
  }
}

/**
 * V2: trigger groups with per-group sampling and union behaviour.
 * @implements {RecordingStrategy}
 */
export class V2TriggerGroupStrategy {
  /**
   * @param {!PostHog} instance
   * @param {!URLTriggerMatching} urlTriggerMatching
   * @param {function(string, ?Object=)} reportStarted
   * @param {function(string, *)} tryAddCustomEvent
   * @param {function(string=)} onTriggerActivated
   */
  constructor(instance, urlTriggerMatching, reportStarted, tryAddCustomEvent, onTriggerActivated) {
    /** @private @const */ this.instance_ = instance;
    /** @private @const */ this.urlTriggerMatching_ = urlTriggerMatching;
    /** @private @const */ this.reportStarted_ = reportStarted;
    /** @private @const */ this.tryAddCustomEvent_ = tryAddCustomEvent;
    /** @private @const */ this.onTriggerActivated_ = onTriggerActivated;
    /** @private {!Array<!TriggerGroupMatching>} */
    this.triggerGroupMatchers_ = [];
    /** @private {!Object<string, boolean>} */
    this.triggerGroupSamplingResults_ = {};
    /** @private {boolean} */
    this.hasCompletedInitialFlush_ = false;
    /** @private {(function()|undefined)} */
    this.removeEventTriggerCaptureHook_ = undefined;
  }

  /** @override */
  onRemoteConfig(config) {
    const groups = config['triggerGroups'];
    if (!groups || groups.length === 0) {
      logger.warn('[V2Strategy] No trigger groups configured');
      return;
    }
    this.setupTriggerGroups_(groups);
    this.instance_.register_for_session({
      [SDK_DEBUG_REPLAY_REMOTE_TRIGGER_MATCHING_CONFIG]: 'v2_trigger_groups',
      [SDK_DEBUG_REPLAY_TRIGGER_GROUPS_COUNT]: groups.length,
    });
    this.urlTriggerMatching_.onConfig(config);
  }

  /** @override */
  getStatus(context) {
    return triggerGroupsMatchSessionRecordingStatus({
      receivedFlags: true,
      isRecordingEnabled: true,
      isSampled: context.isSampled,
      rrwebError: context.rrwebError,
      urlTriggerMatching: context.urlTriggerMatching,
      eventTriggerMatching: context.eventTriggerMatching,
      linkedFlagMatching: context.linkedFlagMatching,
      sessionId: context.sessionId,
      triggerGroupMatchers: this.triggerGroupMatchers_,
      triggerGroupSamplingResults: this.triggerGroupSamplingResults_,
      minimumDuration: this.getMinimumDuration(context.sessionId),
    });
  }

  /** @override */
  getMinimumDuration(sessionId) {
    let lowest = null;
    this.triggerGroupMatchers_.forEach(function(matcher) {
      if (matcher.triggerStatus(sessionId) === TRIGGER_ACTIVATED) {
        const d = matcher.group['minDurationMs'];
        if (isNumber(d) && (isNull(lowest) || d < lowest)) lowest = d;
      }
    });
    return lowest;
  }

  /** @override */
  checkUrlTriggers(sessionId, onPause, onResume, onActivate) {
    this.urlTriggerMatching_.checkUrlBlocklist(onPause, onResume);
    const self = this;
    this.triggerGroupMatchers_.forEach(function(matcher) {
      matcher.checkUrlTriggerConditions(onPause, onResume, function(triggerType) {
        if (!self.checkGroupLevelProperties_(matcher, undefined)) return;
        matcher.activateTrigger(triggerType, sessionId);
        self.updateActiveTriggers(sessionId);
        self.onTriggerActivated_(triggerType);
      }, sessionId);
    });
  }

  /** @override */
  setupEventTriggerListeners(onEvent, sessionId, onActivate) {
    const self = this;
    this.removeEventTriggerCaptureHook_ = onEvent(function(event) {
      if (self.hasCompletedInitialFlush_) {
        logger.info('[SessionRecorder] Stopping trigger checks - initial buffer flushed');
        if (self.removeEventTriggerCaptureHook_) self.removeEventTriggerCaptureHook_();
        self.removeEventTriggerCaptureHook_ = undefined;
        return;
      }
      try {
        self.triggerGroupMatchers_.forEach(function(matcher) {
          matcher.checkEventTriggerConditions(event['event'], function(triggerType) {
            if (!self.checkGroupLevelProperties_(matcher, event['properties'])) return;
            const events = (matcher.group['conditions'] && matcher.group['conditions']['events']) || [];
            const matched = events.filter(function(t) {
              return t['name'] === event['event'];
            });
            const personProperties = self.instance_.get_property(STORED_PERSON_PROPERTIES_KEY);
            const anyMatched = matched.some(function(t) {
              return !t['properties'] || t['properties'].length === 0 ||
                  matchTriggerPropertyFilters(t['properties'], event['properties'], personProperties);
            });
            if (!anyMatched) return;
            matcher.activateTrigger(triggerType, sessionId);
            self.updateActiveTriggers(sessionId);
            self.onTriggerActivated_(triggerType);
          }, sessionId);
        });
      } catch (e) {
        logger.error('Could not activate event trigger for trigger groups', e);
      }
    });
    return this.removeEventTriggerCaptureHook_;
  }

  /** @override */
  makeSamplingDecisions(sessionId) {
    const self = this;
    this.triggerGroupMatchers_.forEach(function(matcher) {
      const group = matcher.group;
      const groupId = group['id'];
      const sampleRate = group['sampleRate'];
      const storageKey = SESSION_RECORDING_TRIGGER_V2_GROUP_SAMPLING_PREFIX + groupId;
      const storedValue = self.instance_.get_property(storageKey);
      let storedDecision = null;
      let sessionChanged = false;
      let sampleRateChanged = false;
      let sampledInWithoutStoredRate = false;
      if (isObject(storedValue)) {
        const storedSessionId = storedValue['sessionId'];
        const storedSampleRate = storedValue['sampleRate'];
        const storedSampled = storedValue['sampled'];
        sessionChanged = typeof storedSessionId === 'string' && storedSessionId !== sessionId;
        sampleRateChanged = isNumber(storedSampleRate) && storedSampleRate !== sampleRate;
        storedDecision = storedSessionId === sessionId && isNumber(storedSampleRate) &&
            storedSampleRate === sampleRate && isBoolean(storedSampled) ? storedSampled : null;
      } else {
        storedDecision = storedValue === sessionId ? true : null;
        sessionChanged = typeof storedValue === 'string' && storedValue !== sessionId;
        sampledInWithoutStoredRate = storedValue === sessionId;
      }
      const makeDecision = sessionChanged || sampleRateChanged || sampledInWithoutStoredRate || !isBoolean(storedDecision);
      const shouldSample = makeDecision ? sampleOnProperty(sessionId + groupId, sampleRate) : !!storedDecision;
      if (makeDecision) {
        self.tryAddCustomEvent_('triggerGroupSamplingDecisionMade', {
          'group_id': groupId,
          'group_name': group['name'],
          'sampleRate': sampleRate,
          'isSampled': shouldSample,
        });
      }
      self.triggerGroupSamplingResults_[groupId] = shouldSample;
      if (self.instance_.persistence) {
        self.instance_.persistence.register({
          [storageKey]: {'sessionId': sessionId, 'sampleRate': sampleRate, 'sampled': shouldSample},
        });
      }
    });
    this.updateActiveTriggers(sessionId);
  }

  /** @override */
  ensureSamplingDecision(sessionId) {}

  /** @override */
  onFlushComplete() {
    this.hasCompletedInitialFlush_ = true;
  }

  /** @override */
  clearConditionalRecordingPersistence() {
    const p = this.instance_.persistence;
    if (!p) return;
    p.unregister(SESSION_RECORDING_IS_SAMPLED);
    p.unregister(SESSION_RECORDING_SAMPLE_RATE);
    p.unregister(SESSION_RECORDING_PAST_MINIMUM_DURATION);
    this.triggerGroupMatchers_.forEach(function(matcher) {
      const groupId = matcher.group['id'];
      p.unregister(SESSION_RECORDING_TRIGGER_V2_GROUP_EVENT_PREFIX + groupId);
      p.unregister(SESSION_RECORDING_TRIGGER_V2_GROUP_URL_PREFIX + groupId);
      p.unregister(SESSION_RECORDING_TRIGGER_V2_GROUP_SAMPLING_PREFIX + groupId);
    });
  }

  /** @override */
  updateActiveTriggers(sessionId) {
    const recordingGroups = [];
    const self = this;
    this.triggerGroupMatchers_.forEach(function(matcher) {
      const group = matcher.group;
      const groupId = group['id'];
      if (matcher.triggerStatus(sessionId) === TRIGGER_ACTIVATED) {
        recordingGroups.push({
          'id': groupId,
          'name': group['name'],
          'matched': true,
          'sampled': self.triggerGroupSamplingResults_[groupId] === true,
        });
      }
    });
    this.instance_.register_for_session({[SDK_DEBUG_REPLAY_MATCHED_RECORDING_TRIGGER_GROUPS]: recordingGroups});
  }

  /** @override */
  hasPendingTriggers(sessionId) {
    return this.triggerGroupMatchers_.some(function(m) {
      return m.triggerStatus(sessionId) === TRIGGER_PENDING;
    });
  }

  /** @override */
  getPendingTriggerConditions(sessionId) {
    let out = [];
    this.triggerGroupMatchers_.forEach(function(matcher) {
      if (matcher.triggerStatusNoSideEffects(sessionId) !== TRIGGER_PENDING) return;
      out = out.concat(matcher.getPendingTriggerConditions(sessionId).map(function(c) {
        return 'trigger group "' + matcher.group['name'] + '": ' + c;
      }));
    });
    return out;
  }

  /** @override */
  stop() {
    if (this.removeEventTriggerCaptureHook_) this.removeEventTriggerCaptureHook_();
    this.removeEventTriggerCaptureHook_ = undefined;
    this.triggerGroupMatchers_.forEach(function(m) {
      m.stop();
    });
    this.triggerGroupMatchers_ = [];
    this.triggerGroupSamplingResults_ = {};
    this.urlTriggerMatching_.stop();
  }

  /**
   * @param {!TriggerGroupMatching} matcher
   * @param {?Object|undefined} eventProperties
   * @return {boolean}
   * @private
   */
  checkGroupLevelProperties_(matcher, eventProperties) {
    const groupProperties = matcher.group['conditions'] ? matcher.group['conditions']['properties'] : undefined;
    if (!groupProperties || groupProperties.length === 0) return true;
    return matchTriggerPropertyFilters(groupProperties, eventProperties,
        this.instance_.get_property(STORED_PERSON_PROPERTIES_KEY));
  }

  /**
   * @param {!Array<!Object>} groups
   * @private
   */
  setupTriggerGroups_(groups) {
    this.triggerGroupMatchers_.forEach(function(m) {
      m.stop();
    });
    this.triggerGroupMatchers_ = [];
    this.triggerGroupSamplingResults_ = {};
    const self = this;
    groups.forEach(function(group) {
      self.triggerGroupMatchers_.push(new TriggerGroupMatching(self.instance_, group, function(flag, variant) {
        self.reportStarted_('linked_flag_matched',
            {'flag': flag, 'variant': variant, 'group_id': group['id'], 'group_name': group['name']});
        self.onTriggerActivated_();
      }));
    });
  }
}
