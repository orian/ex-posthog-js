// Scenario names defined in pages/scenarios.js (kept in sync by hand).
export const SCENARIO_NAMES = ['basic', 'identify', 'consent', 'filters', 'spa', 'flags', 'bootstrap', 'person_profiles',
    'person_profiles_never', 'capture_options', 'rate_limit', 'quota_limited', 'remote_config_failure', 'no_flags_config',
    'session_rotation', 'set_config', 'flags_api', 'web_experiments', 'opt_out_persistence', 'cookieless', 'snippet']

// Exception capture (src/exceptions).
SCENARIO_NAMES.push('exc_capture_manual', 'exc_steps_release', 'exc_onerror', 'exc_rejection', 'exc_chained_handlers',
    'exc_console', 'exc_rate_limit', 'exc_config_remote_off', 'exc_config_remote_on', 'exc_config_remote_on_false',
    'exc_config_remote_on_object', 'exc_config_remote_off_object', 'exc_suppression', 'exc_extension_frames', 'exc_recursion')
// Autocapture, rageclicks, heatmaps and dead clicks.
SCENARIO_NAMES.push('ac_clicks', 'ac_forms', 'ac_rageclick', 'ac_rageclick_defaults', 'ac_rageclick_config', 'ac_copy',
    'ac_opt_out', 'ac_remote_config_failure', 'ac_persisted_opt_out', 'ac_elements_chain_off', 'ac_config',
    'heatmaps_config', 'heatmaps_remote', 'heatmaps_flush', 'dead_clicks', 'dead_clicks_no_external', 'dead_clicks_remote')
// Session replay scenarios (pages/scenarios.js, second block).
SCENARIO_NAMES.push('replay_recording', 'replay_server_disabled', 'replay_client_disabled', 'replay_sample_rate_0',
    'replay_sample_rate_1', 'replay_linked_flag_match', 'replay_linked_flag_miss', 'replay_url_trigger',
    'replay_url_blocklist', 'replay_event_trigger', 'replay_minimum_duration', 'replay_minimum_duration_strict',
    'replay_idle_rotation', 'replay_forced_rotation', 'replay_start_stop_api', 'replay_unload_flush',
    'replay_cached_config', 'replay_stale_cached_config', 'replay_masking_network', 'replay_v2_trigger_groups',
    'replay_idle_detection', 'replay_full_snapshot_interval')
