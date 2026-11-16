/**
 * @fileoverview Persistence keys and protocol constants. These strings are
 * wire/storage formats shared with upstream posthog-js, so they must not change.
 */

/** @const {string} */ export const LIB_NAME = 'web';
/** @const {string} */ export const LIB_VERSION = '0.1.0-closure';

/** @const {string} */ export const DISTINCT_ID = 'distinct_id';
/** @const {string} */ export const DEVICE_ID = '$device_id';
/** @const {string} */ export const USER_STATE = '$user_state';
/** @const {string} */ export const ALIAS_ID_KEY = '__alias';
/** @const {string} */ export const SESSION_ID = '$sesid';
/** @const {string} */ export const PEOPLE_DISTINCT_ID_KEY = '$people_distinct_id';
/** @const {string} */ export const EVENT_TIMERS_KEY = '__timers';
/** @const {string} */ export const GROUPS_KEY = '$groups';
/** @const {string} */ export const CAMPAIGN_IDS_KEY = '__cmpns';
/** @const {string} */ export const INITIAL_PERSON_INFO = '$initial_person_info';
/** @const {string} */ export const ENABLE_PERSON_PROCESSING = '$epp';
/** @const {string} */ export const STORED_PERSON_PROPERTIES_KEY = '$stored_person_properties';
/** @const {string} */ export const STORED_GROUP_PROPERTIES_KEY = '$stored_group_properties';
/** @const {string} */ export const OPT_IN_CONSENT_PREFIX = '__ph_opt_in_out_';

/** Keys that are internal state and never sent as super properties. */
/** @const {!Array<string>} */
export const PERSISTENCE_RESERVED_PROPERTIES = [
  '$people_distinct_id', ALIAS_ID_KEY, CAMPAIGN_IDS_KEY, EVENT_TIMERS_KEY, SESSION_ID,
  '$enabled_feature_flags', '$active_feature_flags', '$feature_flag_payloads',
  '$feature_flag_details', '$override_feature_flags', '$override_feature_flag_payloads',
  USER_STATE, ENABLE_PERSON_PROCESSING, INITIAL_PERSON_INFO, STORED_PERSON_PROPERTIES_KEY,
  STORED_GROUP_PROPERTIES_KEY, '$web_experiments',
];

/** @const {!Array<string>} */
export const CAMPAIGN_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'gad_source', 'mc_cid', 'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid',
  'fbclid', 'msclkid', 'twclid', 'li_fat_id', 'igshid', 'ttclid', 'rdt_cid',
  'epik', 'qclid', 'sccid', 'irclid', '_kx',
];

/** Default session idle timeout (seconds), same as upstream. */
/** @const {number} */ export const SESSION_IDLE_TIMEOUT_SECONDS = 30 * 60;
/** Hard upper bound for a session's length (ms). */
/** @const {number} */ export const SESSION_LENGTH_LIMIT_MS = 24 * 3600 * 1000;
