/**
 * @fileoverview Session & window ID management. Port of upstream sessionid.ts.
 *
 * Session = [lastActivityTs, sessionId, sessionStartTs] stored under `$sesid`.
 * A new session starts after `session_idle_timeout_seconds` of inactivity
 * (clamped to 60s..10h) or after 24h. The window ID is per tab
 * (sessionStorage) and detects duplicated tabs.
 */
import {Persistence} from './persistence.js';
import {sessionStore} from './storage.js';
import {uuidv7, uuid7ToTimestampMs} from './uuid.js';
import {addEventListener, clampToRange, isArray, isNull, isPositiveNumber, isUndefined, win} from './utils.js';
import {logger as baseLogger} from './logger.js';
import {SESSION_ID} from './constants.js';

const logger = baseLogger.createLogger('[SessionId]');

/** @const {number} */ export const DEFAULT_SESSION_IDLE_TIMEOUT_SECONDS = 30 * 60;
const MAX_SESSION_IDLE_TIMEOUT_SECONDS = 10 * 60 * 60;
const MIN_SESSION_IDLE_TIMEOUT_SECONDS = 60;
const SESSION_LENGTH_LIMIT_MILLISECONDS = 24 * 3600 * 1000;
const BOOTSTRAP_SESSION_CLOCK_SKEW_TOLERANCE_MILLISECONDS = 60 * 1000;
const ACTIVITY_TIMESTAMP_PERSIST_GRANULARITY_MS = 5000;

/**
 * Callback(sessionId, windowId, changeReason). changeReason has public keys
 * (noSessionId, activityTimeout, sessionPastMaximumLength, crossTabAdoption)
 * and is undefined for the immediate call made on subscription.
 * @typedef {function(string, string, (!Object|undefined))}
 */
export let SessionIdCallback;

/**
 * @typedef {{
 *   sessionId: string,
 *   windowId: string,
 *   sessionStartTimestamp: number,
 *   changeReason: (!Object|undefined),
 *   lastActivityTimestamp: number
 * }}
 */
export let SessionInfo;

/**
 * @param {string} sessionID
 * @param {number=} timestamp
 * @return {number|undefined}
 */
function parseBootstrapSessionId(sessionID, timestamp) {
  const ts = timestamp || new Date().getTime();
  try {
    const start = uuid7ToTimestampMs(sessionID);
    if (start > ts + BOOTSTRAP_SESSION_CLOCK_SKEW_TOLERANCE_MILLISECONDS) {
      logger.error('Bootstrap sessionID cannot be in the future');
      return undefined;
    }
    return start;
  } catch (e) {
    logger.error('Invalid sessionID in bootstrap', e);
    return undefined;
  }
}

export class SessionManager {
  /**
   * @param {!Object} config PostHog config (quoted keys)
   * @param {!Persistence} persistence
   */
  constructor(config, persistence) {
    /** @private @const {!Object} */
    this.config_ = config;
    /** @private @const {!Persistence} */
    this.persistence_ = persistence;
    /** @private {?string|undefined} */
    this.windowId_ = undefined;
    /** @private {?string|undefined} */
    this.sessionId_ = undefined;
    /** @private {?number} */
    this.sessionStartTimestamp_ = null;
    /** @private {{sessionId: string, sessionStartTimestamp: number}|undefined} */
    this.pendingBootstrapSession_ = undefined;
    /** @private {?number} */
    this.sessionActivityTimestamp_ = null;
    /** @private {?number} */
    this.lastPersistedActivityTimestamp_ = null;
    /** @private {!Array<!SessionIdCallback>} */
    this.handlers_ = [];
    /** @private {number|undefined} */
    this.enforceIdleTimeout_ = undefined;
    /** @private {boolean} */
    this.destroyed_ = false;
    /** @private {function()|undefined} */
    this.beforeUnloadListener_ = undefined;
    /** @private {!Array<function()>} */
    this.forcedIdleResetHandlers_ = [];

    const persistenceName = config['persistence_name'] || config['token'];
    const desired = config['session_idle_timeout_seconds'] || DEFAULT_SESSION_IDLE_TIMEOUT_SECONDS;
    /** @const {number} */
    this.sessionTimeoutMs = clampToRange(desired, MIN_SESSION_IDLE_TIMEOUT_SECONDS, MAX_SESSION_IDLE_TIMEOUT_SECONDS,
        DEFAULT_SESSION_IDLE_TIMEOUT_SECONDS) * 1000;

    persistence.register({'$configured_session_timeout_ms': this.sessionTimeoutMs});
    this.resetIdleTimer_();

    /** @private @const {string} */
    this.windowKey_ = 'ph_' + persistenceName + '_window_id';
    /** @private @const {string} */
    this.primaryKey_ = 'ph_' + persistenceName + '_primary_window_exists';

    if (this.canUseSessionStorage_()) {
      const lastWindowId = sessionStore.parse(this.windowKey_);
      const primaryExists = sessionStore.parse(this.primaryKey_);
      if (lastWindowId && !primaryExists) {
        this.windowId_ = /** @type {string} */ (lastWindowId);
      } else {
        sessionStore.remove(this.windowKey_);
      }
      sessionStore.set(this.primaryKey_, true);
    }

    const bootstrap = config['bootstrap'];
    if (bootstrap && bootstrap['sessionID']) this.setBootstrapSessionId(bootstrap['sessionID']);

    this.listenToReloadWindow_();
  }

  /**
   * @param {function()} handler
   * @return {function()}
   */
  onForcedIdleReset(handler) {
    this.forcedIdleResetHandlers_.push(handler);
    const self = this;
    return function() {
      self.forcedIdleResetHandlers_ = self.forcedIdleResetHandlers_.filter(function(h) {
        return h !== handler;
      });
    };
  }

  /**
   * @param {!SessionIdCallback} callback
   * @return {function()}
   */
  onSessionId(callback) {
    this.handlers_.push(callback);
    if (this.sessionId_) callback(this.sessionId_, /** @type {string} */ (this.windowId_), undefined);
    const self = this;
    return function() {
      self.handlers_ = self.handlers_.filter(function(h) {
        return h !== callback;
      });
    };
  }

  /** @return {boolean} @private */
  canUseSessionStorage_() {
    return this.config_['persistence'] !== 'memory' && !this.persistence_.disabled && sessionStore.isSupported();
  }

  /**
   * @param {string} windowId
   * @private
   */
  setWindowId_(windowId) {
    if (windowId !== this.windowId_) {
      this.windowId_ = windowId;
      if (this.canUseSessionStorage_()) sessionStore.set(this.windowKey_, windowId);
    }
  }

  /** @return {?string} @private */
  getWindowId_() {
    if (this.windowId_) return this.windowId_;
    if (this.canUseSessionStorage_()) return /** @type {?string} */ (sessionStore.parse(this.windowKey_));
    return null;
  }

  /**
   * @param {?number} ts
   * @return {boolean}
   * @private
   */
  isActivityChangeBelowGranularity_(ts) {
    const last = this.lastPersistedActivityTimestamp_;
    if (isNull(last) || isNull(ts)) return false;
    return Math.abs(/** @type {number} */ (ts) - /** @type {number} */ (last)) < ACTIVITY_TIMESTAMP_PERSIST_GRANULARITY_MS;
  }

  /**
   * @param {?string} sessionId
   * @param {?number} activity
   * @param {?number} start
   * @private
   */
  setSessionId_(sessionId, activity, start) {
    const idChanged = sessionId !== this.sessionId_;
    const startChanged = start !== this.sessionStartTimestamp_;
    const activityChanged = activity !== this.sessionActivityTimestamp_;
    const activityOnly = !idChanged && !startChanged;
    this.sessionStartTimestamp_ = start;
    this.sessionActivityTimestamp_ = activity;
    this.sessionId_ = sessionId;
    if (activityOnly && !activityChanged) return;
    if (activityOnly && this.isActivityChangeBelowGranularity_(activity)) return;
    this.lastPersistedActivityTimestamp_ = activity;
    this.persistence_.register({[SESSION_ID]: [activity, sessionId, start]});
  }

  /** @private */
  refreshSessionIdFromStorage_() {
    this.persistence_.flush();
    this.persistence_.load();
  }

  /** @private */
  flushPendingActivityTimestamp_() {
    if (isNull(this.sessionActivityTimestamp_) || this.sessionActivityTimestamp_ === this.lastPersistedActivityTimestamp_) {
      return;
    }
    this.refreshSessionIdFromStorage_();
    const stored = this.getSessionId_();
    if (stored[1] !== this.sessionId_ || stored[2] !== this.sessionStartTimestamp_) return;
    this.lastPersistedActivityTimestamp_ = this.sessionActivityTimestamp_;
    this.persistence_.register({
      [SESSION_ID]: [this.sessionActivityTimestamp_, isUndefined(this.sessionId_) ? null : this.sessionId_,
        this.sessionStartTimestamp_],
    });
    this.persistence_.flush();
  }

  /** @return {number} @private */
  freshestActivityTimestamp_() {
    const persisted = this.getSessionId_()[0];
    const p = isPositiveNumber(persisted) ? /** @type {number} */ (persisted) : 0;
    const m = isPositiveNumber(this.sessionActivityTimestamp_) ? /** @type {number} */ (this.sessionActivityTimestamp_) : 0;
    return Math.max(p, m);
  }

  /**
   * @param {number} timestamp
   * @return {boolean}
   * @private
   */
  isSessionIdleAfterCrossTabRefresh_(timestamp) {
    this.refreshSessionIdFromStorage_();
    return this.idleTooLong_(timestamp, this.freshestActivityTimestamp_());
  }

  /** @return {!Array} @private */
  getSessionId_() {
    const info = this.persistence_.props[SESSION_ID];
    if (isArray(info) && info.length === 2) info.push(info[0]);
    return info || [0, null, 0];
  }

  resetSessionId() {
    this.lastPersistedActivityTimestamp_ = null;
    this.pendingBootstrapSession_ = undefined;
    clearTimeout(this.enforceIdleTimeout_);
    this.enforceIdleTimeout_ = undefined;
    this.setSessionId_(null, null, null);
  }

  /**
   * @param {string} sessionID
   * @param {boolean=} deferUntilNextSession
   * @return {boolean}
   */
  setBootstrapSessionId(sessionID, deferUntilNextSession) {
    const start = parseBootstrapSessionId(sessionID);
    if (isUndefined(start)) return false;
    if (deferUntilNextSession) {
      this.pendingBootstrapSession_ = {sessionId: sessionID, sessionStartTimestamp: /** @type {number} */ (start)};
    } else {
      this.setSessionId_(sessionID, new Date().getTime(), /** @type {number} */ (start));
    }
    return true;
  }

  destroy() {
    this.destroyed_ = true;
    this.flushPendingActivityTimestamp_();
    clearTimeout(this.enforceIdleTimeout_);
    this.enforceIdleTimeout_ = undefined;
    if (this.beforeUnloadListener_ && win) {
      win.removeEventListener('beforeunload', this.beforeUnloadListener_, false);
      this.beforeUnloadListener_ = undefined;
    }
    this.handlers_ = [];
  }

  /** @private */
  listenToReloadWindow_() {
    const self = this;
    this.beforeUnloadListener_ = function() {
      self.flushPendingActivityTimestamp_();
      if (self.canUseSessionStorage_()) sessionStore.remove(self.primaryKey_);
    };
    addEventListener(win, 'beforeunload', this.beforeUnloadListener_, {capture: false, passive: undefined});
  }

  /**
   * @param {*} timestamp
   * @param {*} lastActivity
   * @return {boolean}
   * @private
   */
  idleTooLong_(timestamp, lastActivity) {
    if (!isPositiveNumber(timestamp) || !isPositiveNumber(lastActivity)) return false;
    return Math.abs(/** @type {number} */ (timestamp) - /** @type {number} */ (lastActivity)) > this.sessionTimeoutMs;
  }

  /**
   * Returns the active session/window IDs, rotating them if needed.
   * @param {boolean=} readOnly don't extend activity / rotate on idle
   * @param {?number=} ts
   * @param {boolean=} persistenceAlreadySynced
   * @return {!SessionInfo}
   */
  checkAndGetSessionAndWindowId(readOnly, ts, persistenceAlreadySynced) {
    const timestamp = ts || new Date().getTime();
    const managedBefore = this.sessionId_;
    let stored = this.getSessionId_();
    let sessionId = stored[1];
    let startTimestamp = stored[2];
    const cookieSessionAdoption = !isUndefined(managedBefore) && sessionId !== managedBefore;
    const lastActivityTimestamp = this.freshestActivityTimestamp_();
    let windowId = this.getWindowId_();

    const pending = this.pendingBootstrapSession_;
    const pendingPastMax = !!pending &&
        (pending.sessionStartTimestamp > timestamp + BOOTSTRAP_SESSION_CLOCK_SKEW_TOLERANCE_MILLISECONDS ||
         timestamp - pending.sessionStartTimestamp > SESSION_LENGTH_LIMIT_MILLISECONDS);
    const sessionPastMaximumLength = pending ? pendingPastMax :
        isPositiveNumber(startTimestamp) && Math.abs(timestamp - startTimestamp) > SESSION_LENGTH_LIMIT_MILLISECONDS;

    let valuesChanged = false;
    let crossTabAdoption = cookieSessionAdoption;
    let noSessionId = !sessionId || !!pending;
    const preRefreshSessionId = sessionId;
    let activityTimeout = !noSessionId && !readOnly && this.idleTooLong_(timestamp, lastActivityTimestamp);
    if (activityTimeout) {
      activityTimeout = this.isSessionIdleAfterCrossTabRefresh_(timestamp);
      if (!activityTimeout) logger.info('cross-tab refresh kept the session alive', {'sessionId': sessionId});
      stored = this.getSessionId_();
      sessionId = stored[1];
      startTimestamp = stored[2];
      if (!activityTimeout) noSessionId = !sessionId || !!pending;
    }
    if (noSessionId || activityTimeout || sessionPastMaximumLength) {
      crossTabAdoption = false;
      const usePending = pending && !pendingPastMax;
      sessionId = usePending ? pending.sessionId : uuidv7();
      windowId = uuidv7();
      logger.info('new session ID assigned', {'sessionId': sessionId, 'windowId': windowId});
      startTimestamp = usePending ? pending.sessionStartTimestamp : timestamp;
      this.pendingBootstrapSession_ = undefined;
      valuesChanged = true;
    } else {
      if (!windowId) {
        windowId = uuidv7();
        valuesChanged = true;
      }
      crossTabAdoption = crossTabAdoption || sessionId !== preRefreshSessionId;
      if (crossTabAdoption) valuesChanged = true;
    }

    const noActivityTimestamp = !isPositiveNumber(lastActivityTimestamp);
    const preserve = !noActivityTimestamp && readOnly && !sessionPastMaximumLength;
    const newActivity = preserve ? lastActivityTimestamp : timestamp;
    const sessionStartTimestamp = !isPositiveNumber(startTimestamp) ? new Date().getTime() : startTimestamp;

    this.setWindowId_(/** @type {string} */ (windowId));
    this.setSessionId_(sessionId, newActivity, sessionStartTimestamp);
    if (!readOnly) this.resetIdleTimer_();

    const changeReason = {
      'noSessionId': noSessionId,
      'activityTimeout': activityTimeout,
      'sessionPastMaximumLength': sessionPastMaximumLength,
      'crossTabAdoption': crossTabAdoption,
    };
    if (valuesChanged) {
      this.handlers_.forEach(function(h) {
        h(sessionId, /** @type {string} */ (windowId), changeReason);
      });
    }
    return {
      sessionId: sessionId,
      windowId: /** @type {string} */ (windowId),
      sessionStartTimestamp: sessionStartTimestamp,
      changeReason: valuesChanged ? changeReason : undefined,
      lastActivityTimestamp: lastActivityTimestamp,
    };
  }

  /** @private */
  resetIdleTimer_() {
    if (this.destroyed_) return;
    clearTimeout(this.enforceIdleTimeout_);
    const self = this;
    this.enforceIdleTimeout_ = setTimeout(function() {
      if (self.destroyed_) return;
      if (self.isSessionIdleAfterCrossTabRefresh_(new Date().getTime())) {
        self.resetSessionId();
        self.forcedIdleResetHandlers_.forEach(function(h) {
          h();
        });
      } else {
        self.resetIdleTimer_();
      }
    }, this.sessionTimeoutMs * 1.1);
  }
}
