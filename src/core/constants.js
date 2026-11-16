/**
 * @fileoverview Persistence keys, protocol constants and the mutable SDK
 * `Config` (upstream config.ts). These strings are wire/storage formats shared
 * with upstream posthog-js, so they must not change.
 */

/** @const {string} */ export const LIB_NAME = 'web';
/** @const {string} */ export const LIB_VERSION = '0.1.0-closure';
/**
 * The upstream posthog-js release this SDK tracks. Lazy-loaded PostHog assets
 * (e.g. /static/<version>/recorder.js) are requested for this version, because
 * our code was ported against exactly those builds; LIB_VERSION is ours and
 * does not exist on PostHog's CDN.
 * @const {string}
 */
export const UPSTREAM_VERSION = '1.450.0';

/**
 * Mutable SDK-wide settings (upstream `Config`). SDK_DIST_CHANNEL is set by
 * the entry point ('cdn' for script bundles, like upstream's array.js).
 */
export const Config = {
  /** @type {boolean} */
  DEBUG: false,
  /** @type {string} */
  LIB_NAME: LIB_NAME,
  /** @type {string} */
  LIB_VERSION: LIB_VERSION,
  /** @type {string|undefined} */
  SDK_DIST_CHANNEL: undefined,
};

/** @const {string} */ export const PEOPLE_DISTINCT_ID_KEY = '$people_distinct_id';
/** @const {string} */ export const DISTINCT_ID = 'distinct_id';
/** @const {string} */ export const DEVICE_ID = '$device_id';
/** @const {string} */ export const DEVICE_MODEL = '$device_model';
/** @const {string} */ export const ALIAS_ID_KEY = '__alias';
/** @const {string} */ export const CAMPAIGN_IDS_KEY = '__cmpns';
/** @const {string} */ export const EVENT_TIMERS_KEY = '__timers';
/** @const {string} */ export const SESSION_ID = '$sesid';
/** @const {string} */ export const GROUPS_KEY = '$groups';
/** @const {string} */ export const USER_STATE = '$user_state';
/** @const {string} */ export const CLIENT_SESSION_PROPS = '$client_session_props';
/** @const {string} */ export const CAPTURE_RATE_LIMIT = '$capture_rate_limit';
/** @const {string} */ export const INITIAL_CAMPAIGN_PARAMS = '$initial_campaign_params';
/** @const {string} */ export const INITIAL_REFERRER_INFO = '$initial_referrer_info';
/** @const {string} */ export const INITIAL_PERSON_INFO = '$initial_person_info';
/** @const {string} */ export const ENABLE_PERSON_PROCESSING = '$epp';
/** @const {string} */ export const WEB_EXPERIMENTS = '$web_experiments';
/** @const {string} */ export const SDK_DEBUG_EXTENSIONS_INIT_METHOD = '$sdk_debug_extensions_init_method';
/** @const {string} */ export const SDK_DEBUG_EXTENSIONS_INIT_TIME_MS = '$sdk_debug_extensions_init_time_ms';
/** @const {string} */ export const SESSION_RECORDING_REMOTE_CONFIG = '$session_recording_remote_config';
/** @const {string} */ export const SESSION_RECORDING_IS_SAMPLED = '$session_is_sampled';
/** @const {string} */ export const PERSISTENCE_FACEBOOK_CLICK_ID = '$fbc_persistence';
/** @const {string} */ export const PERSISTENCE_FACEBOOK_BROWSER_ID = '$fbp_persistence';
/** @const {string} */ export const FACEBOOK_CLICK_ID = '$fbc';
/** @const {string} */ export const FACEBOOK_BROWSER_ID = '$fbp';
/** @const {string} */ export const SDK_DIST_CHANNEL_KEY = '$sdk_dist_channel';

// Feature-flag keys (browser-common constants).
/** @const {string} */ export const PERSISTENCE_EARLY_ACCESS_FEATURES = '$early_access_features';
/** @const {string} */ export const PERSISTENCE_ACTIVE_FEATURE_FLAGS = '$active_feature_flags';
/** @const {string} */ export const PERSISTENCE_FEATURE_FLAG_DETAILS = '$feature_flag_details';
/** @const {string} */ export const PERSISTENCE_FEATURE_FLAG_ERRORS = '$feature_flag_errors';
/** @const {string} */ export const PERSISTENCE_FEATURE_FLAG_EVALUATED_AT = '$feature_flag_evaluated_at';
/** @const {string} */ export const PERSISTENCE_FEATURE_FLAG_REQUEST_ID = '$feature_flag_request_id';
/** @const {string} */ export const PERSISTENCE_MINIMAL_FLAG_CALLED_EVENTS = '$minimal_flag_called_events';
/** @const {string} */ export const ENABLED_FEATURE_FLAGS = '$enabled_feature_flags';
/** @const {string} */ export const STORED_GROUP_PROPERTIES_KEY = '$stored_group_properties';
/** @const {string} */ export const STORED_PERSON_PROPERTIES_KEY = '$stored_person_properties';
/** @const {string} */ export const FLAG_CALL_REPORTED = '$flag_call_reported';
/** @const {string} */ export const FLAG_CALL_REPORTED_SESSION_ID = '$flag_call_reported_session_id';
/** @const {string} */ export const PERSISTENCE_FEATURE_FLAG_PAYLOADS = '$feature_flag_payloads';
/** @const {string} */ export const PERSISTENCE_OVERRIDE_FEATURE_FLAGS = '$override_feature_flags';
/** @const {string} */ export const PERSISTENCE_OVERRIDE_FEATURE_FLAG_PAYLOADS = '$override_feature_flag_payloads';

/** @const {string} */ export const USER_STATE_ANONYMOUS = 'anonymous';
/** @const {string} */ export const USER_STATE_IDENTIFIED = 'identified';
/** @const {string} */ export const PERSON_PROFILES_IDENTIFIED_ONLY = 'identified_only';
/** @const {string} */ export const OPT_IN_CONSENT_PREFIX = '__ph_opt_in_out_';
/** @const {string} */ export const COOKIELESS_SENTINEL_VALUE = '$posthog_cookieless';

/** @const {string} */ export const EVENT_PAGEVIEW = '$pageview';
/** @const {string} */ export const EVENT_PAGELEAVE = '$pageleave';
/** @const {string} */ export const EVENT_IDENTIFY = '$identify';
/** @const {string} */ export const EVENT_GROUPIDENTIFY = '$groupidentify';

/**
 * Persistence keys that are never exposed as event properties (upstream
 * persistence-key-policy.ts entries with exposure 'hidden', plus the replay
 * trigger-group prefixes handled in `isHiddenPersistenceKey`).
 * @const {!Array<string>}
 */
export const HIDDEN_PERSISTENCE_KEYS = [
  PEOPLE_DISTINCT_ID_KEY, ALIAS_ID_KEY, CAMPAIGN_IDS_KEY, EVENT_TIMERS_KEY,
  PERSISTENCE_FACEBOOK_CLICK_ID, PERSISTENCE_FACEBOOK_BROWSER_ID,
  '$heatmaps_enabled_server_side', '$logs_capture_enabled_server_side', '$error_tracking_suppression_rules',
  '$product_tours_enabled_server_side', SESSION_RECORDING_REMOTE_CONFIG,
  '$session_recording_enabled_server_side', SESSION_ID, '$sess_rec_flush_size',
  ENABLED_FEATURE_FLAGS, PERSISTENCE_ACTIVE_FEATURE_FLAGS, PERSISTENCE_EARLY_ACCESS_FEATURES,
  PERSISTENCE_FEATURE_FLAG_DETAILS, PERSISTENCE_FEATURE_FLAG_PAYLOADS, PERSISTENCE_FEATURE_FLAG_REQUEST_ID,
  PERSISTENCE_MINIMAL_FLAG_CALLED_EVENTS, PERSISTENCE_OVERRIDE_FEATURE_FLAGS,
  PERSISTENCE_OVERRIDE_FEATURE_FLAG_PAYLOADS, STORED_PERSON_PROPERTIES_KEY, STORED_GROUP_PROPERTIES_KEY,
  '$surveys', '$surveys_loaded_at', '$surveys_activated_session', '$surveys_activated_timestamps',
  'ph_product_tours', '$product_tours_activated', '$product_tours_activated_session',
  FLAG_CALL_REPORTED, FLAG_CALL_REPORTED_SESSION_ID, PERSISTENCE_FEATURE_FLAG_ERRORS,
  PERSISTENCE_FEATURE_FLAG_EVALUATED_AT, USER_STATE, CLIENT_SESSION_PROPS, CAPTURE_RATE_LIMIT,
  INITIAL_CAMPAIGN_PARAMS, INITIAL_REFERRER_INFO, INITIAL_PERSON_INFO, ENABLE_PERSON_PROCESSING,
  '$sdk_debug_recording_script_not_loaded', '$sdk_debug_replay_stale_config',
  '$sdk_debug_replay_event_trigger_status', '$sdk_debug_replay_linked_flag_trigger_status',
  '$sdk_debug_replay_matched_recording_trigger_groups', '$sdk_debug_replay_pending_trigger_conditions',
  '$sdk_debug_replay_remote_trigger_matching_config', '$sdk_debug_replay_trigger_groups_count',
  '$sdk_debug_replay_url_trigger_status',
];

/** @const {!Array<string>} */
const HIDDEN_PERSISTENCE_KEY_PREFIXES = [
  '$posthog_sr_group_event_trigger_', '$posthog_sr_group_url_trigger_', '$posthog_sr_group_sampling_',
];

/**
 * @param {string} key
 * @return {boolean}
 */
export function isHiddenPersistenceKey(key) {
  if (HIDDEN_PERSISTENCE_KEYS.indexOf(key) !== -1) return true;
  for (let i = 0; i < HIDDEN_PERSISTENCE_KEY_PREFIXES.length; i++) {
    if (key.indexOf(HIDDEN_PERSISTENCE_KEY_PREFIXES[i]) === 0) return true;
  }
  return false;
}

/** Properties mirrored into the cookie by `localStorage+cookie` (upstream COOKIE_PERSISTED_PROPERTIES). */
/** @const {!Array<string>} */
export const COOKIE_PERSISTED_PROPERTIES = [
  DEVICE_ID, DISTINCT_ID, SESSION_ID, SESSION_RECORDING_IS_SAMPLED, ENABLE_PERSON_PROCESSING,
  INITIAL_PERSON_INFO, PERSISTENCE_FACEBOOK_CLICK_ID, USER_STATE,
];

/** @const {!Array<string>} */
export const PERSONAL_DATA_CAMPAIGN_PARAMS = [
  'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'twclid', 'li_fat_id',
  'igshid', 'ttclid', 'rdt_cid', 'epik', 'qclid', 'sccid', 'oppref', 'bfcid', 'irclid', '_kx',
];

/** @const {!Array<string>} */
export const CAMPAIGN_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gad_source', 'mc_cid']
    .concat(PERSONAL_DATA_CAMPAIGN_PARAMS);

/** @const {!Array<string>} */
export const COOKIE_CAMPAIGN_PARAMS = ['li_fat_id'];

/** Events whose drop in before_send is warned about (upstream knownUnsafeEditableEvent). */
/** @const {!Array<string>} */
export const KNOWN_UNSAFE_EDITABLE_EVENTS = [
  '$snapshot', '$pageview', '$pageleave', '$set', 'survey dismissed', 'survey sent', 'survey shown',
  '$identify', '$groupidentify', '$create_alias', '$$client_ingestion_warning', '$web_experiment_applied',
  '$feature_enrollment_update', '$feature_flag_called',
];

/** Upstream MINIMAL_FLAG_CALLED_EVENT_PROPERTIES. */
/** @const {!Array<string>} */
export const MINIMAL_FLAG_CALLED_EVENT_PROPERTIES = [
  '$feature_flag', '$feature_flag_response', '$feature_flag_has_experiment', '$feature_flag_id',
  '$feature_flag_version', '$feature_flag_reason', '$feature_flag_request_id', '$feature_flag_evaluated_at',
  '$feature_flag_error', 'locally_evaluated', '$groups', '$process_person_profile', '$geoip_disable',
  '$current_url', '$pathname', '$referring_domain',
].concat(CAMPAIGN_PARAMS).concat([
  '$session_id', '$window_id', '$lib', '$lib_version', '$device_id', '$is_server',
]);

/** Upstream CONFIG_DEFAULTS_DATES (packages/types). */
/** @const {!Array<string>} */
export const CONFIG_DEFAULTS_DATES = ['2026-08-30', '2026-08-29', '2026-06-25', '2026-05-30', '2026-01-30', '2025-11-30', '2025-05-24'];
