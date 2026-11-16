// Scenario names defined in pages/scenarios.js (kept in sync by hand).
export const SCENARIO_NAMES = ['basic', 'identify', 'consent', 'filters', 'spa', 'flags', 'bootstrap', 'person_profiles',
    'person_profiles_never', 'capture_options', 'rate_limit', 'quota_limited', 'remote_config_failure', 'no_flags_config',
    'session_rotation', 'set_config', 'flags_api', 'web_experiments', 'opt_out_persistence', 'cookieless', 'snippet']
// Session replay scenarios (pages/scenarios.js, second block).
SCENARIO_NAMES.push('replay_recording', 'replay_server_disabled', 'replay_client_disabled', 'replay_sample_rate_0',
    'replay_sample_rate_1', 'replay_linked_flag_match', 'replay_linked_flag_miss', 'replay_url_trigger',
    'replay_url_blocklist', 'replay_event_trigger', 'replay_minimum_duration', 'replay_minimum_duration_strict',
    'replay_idle_rotation', 'replay_forced_rotation', 'replay_start_stop_api', 'replay_unload_flush',
    'replay_cached_config', 'replay_stale_cached_config', 'replay_masking_network', 'replay_v2_trigger_groups',
    'replay_idle_detection', 'replay_full_snapshot_interval')
