// Canned fake-server responses and the explicit allowlist of accepted diffs.

const FLAGS_V2 = {
    flags: {
        multi: { key: 'multi', enabled: true, variant: 'test', reason: { code: 'condition_match', description: 'Matched condition set 1', condition_index: 0 },
            metadata: { id: 11, version: 3, payload: '{"color":"red"}', description: null } },
        bool: { key: 'bool', enabled: true, variant: null, reason: { code: 'condition_match', description: 'Matched', condition_index: 0 }, metadata: { id: 12, version: 1 } },
        off: { key: 'off', enabled: false, variant: null, reason: { code: 'no_condition_match', description: 'No match' }, metadata: { id: 13, version: 1 } },
    },
    errorsWhileComputingFlags: false,
    requestId: '0193f5b8-0000-7000-8000-000000000001',
}

const REMOTE_CONFIG = {
    token: 'phc_diff',
    supportedCompression: ['gzip', 'gzip-js'],
    hasFeatureFlags: true,
    captureDeadClicks: false,
    capturePerformance: false,
    autocapture_opt_out: false,
    autocaptureExceptions: false,
    analytics: { endpoint: '/i/v0/e/' },
    elementsChainAsString: true,
    errorTracking: { autocaptureExceptions: false, suppressionRules: [] },
    sessionRecording: false,
    heatmaps: false,
    surveys: false,
    defaultIdentifiedOnly: true,
    siteApps: [],
}

const WEB_EXPERIMENTS = {
    experiments: [{
        id: 3, name: 'Hero', feature_flag_key: 'multi',
        variants: {
            control: { transforms: [] },
            test: { transforms: [
                { selector: '#hero', css: 'color: red', html: 'New <b>hero</b><script>window.__xss=1</script><img src=x onerror="window.__xss=1"><a href="javascript:alert(1)" target="_blank">x</a>' },
                { selector: '#link', html: '<svg><foreignObject><p id="cookie">p</p></foreignObject></svg>' },
            ] },
        },
    }],
}

// The batch carrying 'first' is answered as quota limited, so later events are dropped client-side.
const QUOTA = (entry) => (entry.body && entry.body.batch && entry.body.batch.some((e) => e.event === 'first')
    ? { body: { status: 1, quota_limited: ['events'] } } : { body: { status: 1 } })

export const RESPONSES = {
    default: {
        '/api/web_experiments/': { body: WEB_EXPERIMENTS },
        '/flags/': { body: FLAGS_V2 },
        '/array/phc_diff/config': { body: REMOTE_CONFIG },
        '/array/phc_diff/config.js': { script: `(function(){window._POSTHOG_REMOTE_CONFIG = window._POSTHOG_REMOTE_CONFIG || {}; window._POSTHOG_REMOTE_CONFIG['phc_diff'] = {config: ${JSON.stringify(REMOTE_CONFIG)}, siteApps: []}})()` },
    },
    remote_config_failure: {
        '/array/phc_diff/config.js': { status: 500, body: {} },
        '/array/phc_diff/config': { status: 500, body: {} },
    },
    no_flags_config: {
        // config.js loads but defines nothing, so the JSON fallback is used.
        '/array/phc_diff/config.js': { script: '/* empty */' },
        '/array/phc_diff/config': { body: { ...REMOTE_CONFIG, hasFeatureFlags: false } },
    },
    quota_limited: {
        '/e/': QUOTA,
    },
}

/** Paths (regex on the diff location) whose differences are expected. Keep this short and justified. */
export const ALLOWED = [
    /\.properties\.\$lib_version$/, // different SDK
    /\.properties\.\$recording_status$/, // TODO(module): session replay
    /\.properties\.\$autocapture_disabled_server_side$/, // TODO(module): autocapture (persisted from remote config)
    /\.properties\.\$dead_clicks_enabled_server_side$/, // TODO(module): dead clicks (persisted from remote config)
    /\.properties\.\$exception_capture_enabled_server_side$/, // TODO(module): exception autocapture (persisted from remote config)
    /\.properties\.\$web_vitals_enabled_server_side$/, // TODO(module): web vitals (persisted from remote config)
]
