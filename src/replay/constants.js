/**
 * @fileoverview Session replay persistence keys and statuses (upstream
 * constants.ts and replay/external/triggerMatching.ts). Wire/storage formats.
 */

/** @const {string} */ export const SESSION_RECORDING_REMOTE_CONFIG = '$session_recording_remote_config';
/** @const {number} */ export const RECORDING_REMOTE_CONFIG_TTL_MS = 1000 * 60 * 60;
/** @const {string} */ export const SESSION_RECORDING_SAMPLE_RATE = '$replay_sample_rate';
/** @const {string} */ export const SESSION_RECORDING_OVERRIDE_SAMPLING = '$replay_override_sampling';
/** @const {string} */ export const SESSION_RECORDING_OVERRIDE_LINKED_FLAG = '$replay_override_linked_flag';
/** @const {string} */ export const SESSION_RECORDING_OVERRIDE_URL_TRIGGER = '$replay_override_url_trigger';
/** @const {string} */ export const SESSION_RECORDING_OVERRIDE_EVENT_TRIGGER = '$replay_override_event_trigger';
/** @const {string} */ export const SESSION_RECORDING_IS_SAMPLED = '$session_is_sampled';
/** @const {string} */ export const SESSION_RECORDING_PAST_MINIMUM_DURATION = '$session_past_minimum_duration';
/** @const {string} */ export const SESSION_RECORDING_URL_TRIGGER_ACTIVATED_SESSION =
    '$session_recording_url_trigger_activated_session';
/** @const {string} */ export const SESSION_RECORDING_EVENT_TRIGGER_ACTIVATED_SESSION =
    '$session_recording_event_trigger_activated_session';
/** @const {string} */ export const SESSION_RECORDING_TRIGGER_V2_GROUP_EVENT_PREFIX = '$posthog_sr_group_event_trigger_';
/** @const {string} */ export const SESSION_RECORDING_TRIGGER_V2_GROUP_URL_PREFIX = '$posthog_sr_group_url_trigger_';
/** @const {string} */ export const SESSION_RECORDING_TRIGGER_V2_GROUP_SAMPLING_PREFIX = '$posthog_sr_group_sampling_';
/** @const {string} */ export const SESSION_RECORDING_FIRST_FULL_SNAPSHOT_TIMESTAMP = '$debug_first_full_snapshot_timestamp';
/** @const {string} */ export const SESSION_RECORDING_FLUSHED_SIZE = '$sess_rec_flush_size';
/** @const {string} */ export const SESSION_RECORDING_START_REASON = '$session_recording_start_reason';
/** @const {string} */ export const STORED_PERSON_PROPERTIES_KEY = '$stored_person_properties';

/** @const {string} */ export const SDK_DEBUG_RECORDING_SCRIPT_NOT_LOADED = '$sdk_debug_recording_script_not_loaded';
/** @const {string} */ export const SDK_DEBUG_REPLAY_STALE_CONFIG = '$sdk_debug_replay_stale_config';
/** @const {string} */ export const SDK_DEBUG_REPLAY_EVENT_TRIGGER_STATUS = '$sdk_debug_replay_event_trigger_status';
/** @const {string} */ export const SDK_DEBUG_REPLAY_LINKED_FLAG_TRIGGER_STATUS =
    '$sdk_debug_replay_linked_flag_trigger_status';
/** @const {string} */ export const SDK_DEBUG_REPLAY_MATCHED_RECORDING_TRIGGER_GROUPS =
    '$sdk_debug_replay_matched_recording_trigger_groups';
/** @const {string} */ export const SDK_DEBUG_REPLAY_PENDING_TRIGGER_CONDITIONS =
    '$sdk_debug_replay_pending_trigger_conditions';
/** @const {string} */ export const SDK_DEBUG_REPLAY_REMOTE_TRIGGER_MATCHING_CONFIG =
    '$sdk_debug_replay_remote_trigger_matching_config';
/** @const {string} */ export const SDK_DEBUG_REPLAY_TRIGGER_GROUPS_COUNT = '$sdk_debug_replay_trigger_groups_count';
/** @const {string} */ export const SDK_DEBUG_REPLAY_URL_TRIGGER_STATUS = '$sdk_debug_replay_url_trigger_status';
/** @const {string} */ export const SDK_DEBUG_REPLAY_RRWEB_ATTACHED = '$sdk_debug_rrweb_attached';
/** @const {string} */ export const SDK_DEBUG_REPLAY_RRWEB_START_ATTEMPTED = '$sdk_debug_rrweb_start_attempted';

// Recording statuses.
/** @const {string} */ export const DISABLED = 'disabled';
/** @const {string} */ export const SAMPLED = 'sampled';
/** @const {string} */ export const ACTIVE = 'active';
/** @const {string} */ export const BUFFERING = 'buffering';
/** @const {string} */ export const PAUSED = 'paused';
/** @const {string} */ export const LAZY_LOADING = 'lazy_loading';
/** @const {string} */ export const AWAITING_CONFIG = 'awaiting_config';
/** @const {string} */ export const MISSING_CONFIG = 'missing_config';
/** @const {string} */ export const RRWEB_ERROR = 'rrweb_error';

// Trigger statuses.
/** @const {string} */ export const TRIGGER_ACTIVATED = 'trigger_activated';
/** @const {string} */ export const TRIGGER_PENDING = 'trigger_pending';
/** @const {string} */ export const TRIGGER_DISABLED = 'trigger_disabled';
