/**
 * @fileoverview Session entry attribution (port of upstream session-props.ts):
 * stores the entry URL/referrer per session id and exposes them as
 * `$session_entry_*` event properties and `$set_once` person properties.
 */
import {SessionManager} from './session.js';
import {Persistence} from './persistence.js';
import {CLIENT_SESSION_PROPS} from './constants.js';
import {getPersonInfo, getPersonPropsFromInfo} from './event-utils.js';
import {each, stripEmptyProperties, stripLeadingDollar} from './utils.js';

export class SessionPropsManager {
  /**
   * @param {!Object} config PostHog config (quoted keys, live object)
   * @param {!SessionManager} sessionManager
   * @param {!Persistence} persistence
   */
  constructor(config, sessionManager, persistence) {
    /** @private @const {!Object} */
    this.config_ = config;
    /** @private @const {!Persistence} */
    this.persistence_ = persistence;
    const self = this;
    sessionManager.onSessionId(function(sessionId) {
      self.onSessionId_(sessionId);
    });
  }

  /** @return {?Object|undefined} @private */
  getStored_() {
    return this.persistence_.props[CLIENT_SESSION_PROPS];
  }

  /**
   * @param {string} sessionId
   * @private
   */
  onSessionId_(sessionId) {
    const stored = this.getStored_();
    if (stored && stored['sessionId'] === sessionId) return;
    const c = this.config_;
    this.persistence_.register({
      [CLIENT_SESSION_PROPS]: {
        'sessionId': sessionId,
        'props': getPersonInfo(c['mask_personal_data_properties'], c['custom_personal_data_properties'],
            c['disable_capture_url_hashes']),
      },
    });
  }

  /** @return {!Object} */
  getSetOnceProps() {
    const stored = this.getStored_();
    const p = stored ? stored['props'] : undefined;
    if (!p) return {};
    if ('r' in p) return getPersonPropsFromInfo(p, this.config_['disable_capture_url_hashes']);
    return {
      '$referring_domain': p['referringDomain'],
      '$pathname': p['initialPathName'],
      'utm_source': p['utm_source'],
      'utm_campaign': p['utm_campaign'],
      'utm_medium': p['utm_medium'],
      'utm_content': p['utm_content'],
      'utm_term': p['utm_term'],
    };
  }

  /** @return {!Object} */
  getSessionProps() {
    const p = {};
    each(stripEmptyProperties(this.getSetOnceProps()), function(v, k) {
      if (k === '$current_url') k = 'url';
      p['$session_entry_' + stripLeadingDollar(k)] = v;
    });
    return p;
  }
}
