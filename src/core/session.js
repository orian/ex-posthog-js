/**
 * @fileoverview Session & window ID management.
 *
 * Session = [lastActivityTs, sessionId, sessionStartTs] stored under `$sesid`
 * (upstream format). A new session starts after `session_idle_timeout_seconds`
 * of inactivity or after 24h. Window ID is per-tab (sessionStorage).
 */
import {Persistence} from './persistence.js';
import {WebStorageStore} from './storage.js';
import {uuidv7} from './uuid.js';
import {isArray, isNumber, now, addEventListener, win} from './utils.js';
import {SESSION_ID, SESSION_IDLE_TIMEOUT_SECONDS, SESSION_LENGTH_LIMIT_MS} from './constants.js';

/**
 * Callback(sessionId, windowId, changeReason); reason uses quoted public keys.
 * @typedef {function(string, string, ?Object)}
 */
export let SessionIdCallback;

export class SessionManager {
  /**
   * @param {!Object} config
   * @param {!Persistence} persistence
   */
  constructor(config, persistence) {
    /** @private @const */
    this.persistence_ = persistence;
    /** @private @const {number} */
    this.idleTimeoutMs_ = Math.min(
        Math.max(Number(config['session_idle_timeout_seconds']) || SESSION_IDLE_TIMEOUT_SECONDS, 60),
        10 * 3600) * 1000;
    /** @private @const */
    this.tabStore_ = new WebStorageStore('sessionStorage');
    /** @private @const {string} */
    this.windowKey_ = persistence.name + '_window_id';
    /** @private @const {string} */
    this.primaryKey_ = persistence.name + '_primary_window_exists';
    /** @private {?string} */
    this.windowId_ = null;
    /** @private {?string} */
    this.sessionId_ = null;
    /** @private @const {!Array<!SessionIdCallback>} */
    this.listeners_ = [];

    // When a tab is duplicated sessionStorage is copied too; the "primary
    // window exists" marker lets us detect that and mint a fresh window id.
    if (this.tabStore_.isSupported()) {
      const stored = this.tabStore_.parse(this.windowKey_);
      const primary = this.tabStore_.parse(this.primaryKey_);
      if (stored && !primary) this.windowId_ = stored['id'] || null;
      this.tabStore_.set(this.primaryKey_, {'v': true});
      const self = this;
      addEventListener(win, 'beforeunload', function() {
        self.tabStore_.remove(self.primaryKey_);
      });
    }
  }

  /** @return {!Array} [lastActivity, sessionId, startTs] */
  read_() {
    const v = this.persistence_.get(SESSION_ID);
    return isArray(v) && /** @type {!Array} */ (v).length >= 2 ? /** @type {!Array} */ (v) : [0, null, 0];
  }

  /**
   * @param {?string} sessionId
   * @param {number} lastActivity
   * @param {number} startTs
   */
  write_(sessionId, lastActivity, startTs) {
    this.persistence_.register({[SESSION_ID]: [lastActivity, sessionId, startTs]});
  }

  /** @param {?string} id */
  setWindowId_(id) {
    this.windowId_ = id;
    if (this.tabStore_.isSupported()) this.tabStore_.set(this.windowKey_, {'id': id});
  }

  /**
   * Returns the active session/window IDs, rotating them if expired.
   * @param {boolean=} readOnly don't extend activity / rotate
   * @param {number=} timestamp
   * @return {{sessionId: string, windowId: string, sessionStartTimestamp: number}}
   */
  checkAndGetSessionAndWindowId(readOnly, timestamp) {
    const ts = timestamp || now();
    const stored = this.read_();
    let lastActivity = Number(stored[0]) || 0;
    let sessionId = /** @type {?string} */ (stored[1]);
    let startTs = isNumber(stored[2]) ? /** @type {number} */ (stored[2]) : 0;

    const activityTimeout = lastActivity > 0 && Math.abs(ts - lastActivity) > this.idleTimeoutMs_;
    const pastMax = startTs > 0 && Math.abs(ts - startTs) > SESSION_LENGTH_LIMIT_MS;
    const noSessionId = !sessionId;
    let changed = false;

    if (noSessionId || ((activityTimeout || pastMax) && !readOnly)) {
      sessionId = uuidv7(ts);
      startTs = ts;
      this.setWindowId_(uuidv7(ts));
      changed = true;
    } else if (!this.windowId_) {
      this.setWindowId_(uuidv7(ts));
    }

    const newActivity = readOnly && lastActivity > 0 && !changed ? lastActivity : ts;
    if (changed || newActivity !== lastActivity) {
      this.write_(sessionId, newActivity, startTs);
    }
    this.sessionId_ = sessionId;

    if (changed) {
      const reason = {'noSessionId': noSessionId, 'activityTimeout': activityTimeout, 'sessionPastMaximumLength': pastMax};
      const sid = /** @type {string} */ (sessionId);
      const wid = /** @type {string} */ (this.windowId_);
      this.listeners_.forEach(function(cb) {
        cb(sid, wid, reason);
      });
    }
    return {
      sessionId: /** @type {string} */ (sessionId),
      windowId: /** @type {string} */ (this.windowId_),
      sessionStartTimestamp: startTs,
    };
  }

  /** Forces a new session on next access (used by reset()). */
  resetSessionId() {
    this.write_(null, 0, 0);
    this.setWindowId_(null);
  }

  /**
   * @param {!SessionIdCallback} cb
   * @return {function()}
   */
  onSessionId(cb) {
    this.listeners_.push(cb);
    if (this.sessionId_ && this.windowId_) cb(this.sessionId_, this.windowId_, null);
    const listeners = this.listeners_;
    return function() {
      const i = listeners.indexOf(cb);
      if (i !== -1) listeners.splice(i, 1);
    };
  }
}
