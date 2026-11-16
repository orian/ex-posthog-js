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

export const RESPONSES = {
    default: {
        '/flags/': { body: FLAGS_V2 },
        '/array/phc_diff/config': { body: REMOTE_CONFIG },
        '/array/phc_diff/config.js': { script: `(function(){window._POSTHOG_REMOTE_CONFIG = window._POSTHOG_REMOTE_CONFIG || {}; window._POSTHOG_REMOTE_CONFIG['phc_diff'] = {config: ${JSON.stringify(REMOTE_CONFIG)}, siteApps: []}})()` },
    },
}

/** Paths (regex on the diff location) whose differences are expected. Keep this short and justified. */
export const ALLOWED = [
    /\.properties\.\$lib_version$/, // different SDK
]
