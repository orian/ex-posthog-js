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
    /\.properties\.\$autocapture_disabled_server_side$/, // TODO(module): autocapture (persisted from remote config)
    /\.properties\.\$dead_clicks_enabled_server_side$/, // TODO(module): dead clicks (persisted from remote config)
    /\.properties\.\$exception_capture_enabled_server_side$/, // TODO(module): exception autocapture (persisted from remote config)
    /\.properties\.\$web_vitals_enabled_server_side$/, // TODO(module): web vitals (persisted from remote config)
]

// ---- session replay -------------------------------------------------------------
// Remote configs with `sessionRecording` (the shape /array/<token>/config serves).
const RECORDING = {
    endpoint: '/s/',
    consoleLogRecordingEnabled: true,
    recorderVersion: 'v2',
    sampleRate: null,
    minimumDurationMilliseconds: null,
    linkedFlag: null,
    networkPayloadCapture: null,
    masking: null,
    urlTriggers: [],
    urlBlocklist: [],
    eventTriggers: [],
    triggerMatchType: null,
    scriptConfig: null,
}

/** Serves `sessionRecording` (merged into RECORDING, or false) from both config endpoints. */
function recordingConfig(sessionRecording, extra = {}) {
    const config = { ...REMOTE_CONFIG, ...extra, sessionRecording: sessionRecording === false ? false : { ...RECORDING, ...sessionRecording } }
    return {
        '/array/phc_diff/config': { body: config },
        '/array/phc_diff/config.js': { script: `(function(){window._POSTHOG_REMOTE_CONFIG = window._POSTHOG_REMOTE_CONFIG || {}; window._POSTHOG_REMOTE_CONFIG['phc_diff'] = {config: ${JSON.stringify(config)}, siteApps: []}})()` },
    }
}

Object.assign(RESPONSES, {
    replay_recording: recordingConfig({}),
    replay_server_disabled: recordingConfig(false),
    replay_client_disabled: recordingConfig({}),
    replay_sample_rate_0: recordingConfig({ sampleRate: '0.00' }),
    replay_sample_rate_1: recordingConfig({ sampleRate: '1.00' }),
    replay_linked_flag_match: recordingConfig({ linkedFlag: 'bool' }),
    replay_linked_flag_miss: recordingConfig({ linkedFlag: { flag: 'multi', variant: 'control' } }),
    replay_url_trigger: recordingConfig({ urlTriggers: [{ url: '/checkout', matching: 'regex' }] }),
    replay_url_blocklist: recordingConfig({ urlBlocklist: [{ url: '/private', matching: 'regex' }] }),
    replay_event_trigger: recordingConfig({ eventTriggers: ['purchase'] }),
    replay_minimum_duration: recordingConfig({ minimumDurationMilliseconds: 4000 }),
    replay_minimum_duration_strict: recordingConfig({ minimumDurationMilliseconds: 1500 }),
    replay_idle_rotation: recordingConfig({}),
    replay_forced_rotation: recordingConfig({}),
    replay_start_stop_api: recordingConfig({}),
    replay_unload_flush: recordingConfig({}),
    replay_cached_config: recordingConfig({}),
    replay_stale_cached_config: recordingConfig({}),
    replay_masking_network: recordingConfig({
        masking: { maskAllInputs: false, maskTextSelector: '.secret' },
        networkPayloadCapture: { recordHeaders: true, recordBody: true },
    }, { capturePerformance: { network_timing: true, web_vitals: false } }),
    replay_v2_trigger_groups: recordingConfig({
        version: 2,
        triggerGroups: [
            { id: 'g-all', name: 'Everyone', sampleRate: 1, conditions: { matchType: 'all', events: [], urls: [] } },
            // sample rates are 0 or 1: the decision hashes the (random) session id
            { id: 'g-buy', name: 'Buyers', sampleRate: 1, minDurationMs: 0, conditions: { matchType: 'any', events: [{ name: 'purchase', properties: [{ key: 'plan', value: 'pro', operator: 'exact', type: 'event' }] }] } },
            { id: 'g-never', name: 'Never', sampleRate: 0, conditions: { matchType: 'all', urls: [{ url: '/never', matching: 'regex' }] } },
        ],
    }),
})
