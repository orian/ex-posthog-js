// Scenario names defined in pages/scenarios.js (kept in sync by hand).
export const SCENARIO_NAMES = ['basic', 'identify', 'consent', 'filters', 'spa', 'flags', 'bootstrap', 'person_profiles',
    'person_profiles_never', 'capture_options', 'rate_limit', 'quota_limited', 'remote_config_failure', 'no_flags_config',
    'session_rotation', 'set_config', 'flags_api', 'web_experiments', 'opt_out_persistence', 'cookieless', 'snippet']
// Autocapture, rageclicks, heatmaps and dead clicks.
SCENARIO_NAMES.push('ac_clicks', 'ac_forms', 'ac_rageclick', 'ac_rageclick_defaults', 'ac_rageclick_config', 'ac_copy',
    'ac_opt_out', 'ac_remote_config_failure', 'ac_persisted_opt_out', 'ac_elements_chain_off', 'ac_config',
    'heatmaps_config', 'heatmaps_remote', 'heatmaps_flush', 'dead_clicks', 'dead_clicks_no_external', 'dead_clicks_remote')
