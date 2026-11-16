// Behavioural scenarios, run against raw sources and every compiled bundle.
// They encode upstream posthog-js 1.450.0 behaviour (remote config first,
// `$pageview` sent instantly, 250ms minimum flush interval, ...).
import strictAssert from 'node:assert/strict'

// Objects from compiled bundles live in another vm realm, so compare by value.
const plain = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)))
const assert = Object.assign((...a) => strictAssert(...a), strictAssert, {
    deepEqual: (a, b, m) => strictAssert.deepEqual(plain(a), plain(b), ...(m ? [m] : [])),
})
import { createBrowser, sleep, capturedEvents } from './harness.mjs'

const TOKEN = 'phc_test'
const FAST = { request_queue_config: { flush_interval_ms: 250 } } // upstream clamps to >= 250ms
const FLUSH = 450 // ms to wait for a batch flush

/** A realistic /array/<token>/config response (trimmed to what the core reads). */
export const REMOTE_CONFIG = {
    token: TOKEN,
    supportedCompression: ['gzip', 'gzip-js'],
    hasFeatureFlags: true,
    captureDeadClicks: false,
    capturePerformance: false,
    autocapture_opt_out: false,
    autocaptureExceptions: false,
    analytics: { endpoint: '/i/v0/e/' },
    elementsChainAsString: true,
    sessionRecording: false,
    heatmaps: false,
    surveys: false,
    defaultIdentifiedOnly: true,
    siteApps: [],
}

const FLAGS_RESPONSE = {
    flags: {
        'multi': { key: 'multi', enabled: true, variant: 'test', reason: { code: 'condition_match' },
            metadata: { id: 11, version: 3, payload: '{"color":"red"}' } },
        'bool': { key: 'bool', enabled: true, variant: null, metadata: { id: 12, version: 1 } },
        'off': { key: 'off', enabled: false, variant: null, metadata: { id: 13, version: 1 } },
        'exp-flag': { key: 'exp-flag', enabled: true, variant: 'test', metadata: { id: 14, version: 1 } },
    },
    errorsWhileComputingFlags: false,
    requestId: 'req-1',
}

const EXPERIMENTS_RESPONSE = {
    experiments: [{
        id: 7, name: 'Hero test', feature_flag_key: 'exp-flag',
        variants: {
            control: { transforms: [] },
            test: { transforms: [{ selector: '#hero', css: 'color: red' }] },
        },
    }],
}

/** Default fake PostHog: remote config JSON (config.js "fails" to load in the harness), /flags/, experiments. */
function defaultRouter(req) {
    if (req.path === `/array/${TOKEN}/config`) return { status: 200, body: REMOTE_CONFIG }
    if (req.path === '/flags/') return { status: 200, body: FLAGS_RESPONSE }
    if (req.path === '/api/web_experiments/') return { status: 200, body: EXPERIMENTS_RESPONSE }
    return undefined
}

/** Requests that carry events, wherever the remote config sends them. */
const eventRequests = (b) => b.requests.filter((r) => r.path === '/e/' || r.path === '/i/v0/e/')
const events = (b) => eventRequests(b).flatMap((r) => r.body.batch)

/**
 * Each scenario: { builds: [...], run(load) } where load(browserOpts) returns
 * { b, ph } with the SDK loaded from the build under test.
 */
export const scenarios = {
    'capture: remote config, instant pageview, batched gzip events with context': {
        builds: ['core', 'full'],
        async run(load) {
            const { b, ph } = await load()
            ph.init(TOKEN, { ...FAST })
            ph.capture('signed_up', { plan: 'pro' })
            await sleep(FLUSH)
            // Remote config: config.js script first, then the JSON fallback from the assets host.
            assert.deepEqual(b.requests.filter((r) => r.path.startsWith('/array/')).map((r) => [r.method, r.path, r.transport]),
                [['GET', `/array/${TOKEN}/config.js`, 'script'], ['GET', `/array/${TOKEN}/config`, 'fetch']])
            assert.match(b.requests[0].url, /^https:\/\/us-assets\.i\.posthog\.com\//)
            const reqs = eventRequests(b)
            assert.deepEqual(reqs.map((r) => r.body.batch.map((e) => e.event)), [['$pageview'], ['signed_up']])
            // gzip-js: compression is not a query param. signed_up was captured before the remote
            // config arrived, so (like upstream) it keeps the default endpoint.
            assert.match(reqs[1].url, /^https:\/\/us\.i\.posthog\.com\/e\/$/)
            ph.capture('later')
            await sleep(FLUSH)
            assert.match(eventRequests(b).at(-1).url, /\/i\/v0\/e\/$/, 'analytics.endpoint from remote config')
            assert.equal(eventRequests(b).at(-1).body.batch[0].properties.$pageview_id, reqs[0].body.batch[0].uuid)
            assert.equal(reqs[0].body.api_key, TOKEN)
            assert.ok(reqs[0].body.sent_at)
            const [pv, ev] = [reqs[0].body.batch[0], reqs[1].body.batch[0]]
            const p = ev.properties
            assert.equal(p.plan, 'pro')
            assert.equal(p.token, TOKEN)
            assert.match(p.distinct_id, /^[0-9a-f-]{36}$/)
            assert.equal(p.$device_id, p.distinct_id)
            assert.match(p.$session_id, /^[0-9a-f]{8}-[0-9a-f]{4}-7/)
            assert.ok(p.$window_id)
            assert.equal(p.$lib, 'web')
            assert.equal(p.$sdk_dist_channel, 'cdn')
            assert.equal(p.$config_defaults, 'unset')
            assert.equal(p.$configured_session_timeout_ms, 1800000)
            assert.equal(p.$browser, 'Chrome')
            assert.equal(p.$os, 'Mac OS X')
            assert.equal(p.$device_type, 'Desktop')
            assert.equal(p.$current_url, 'https://app.example.com/pricing?utm_source=newsletter')
            assert.equal(p.utm_source, 'newsletter')
            assert.equal(p.utm_medium, null, 'missing campaign params are null')
            assert.equal(p.$session_entry_utm_source, 'newsletter')
            assert.equal(p.$session_entry_referring_domain, 'www.google.com')
            assert.equal(p.$referring_domain, 'www.google.com')
            assert.equal(p.$process_person_profile, false)
            assert.equal(p.$is_identified, false)
            assert.equal(p.$sdk_debug_extensions_init_method, 'synchronous')
            assert.equal(typeof p.$lib_rate_limit_remaining_tokens, 'number')
            assert.equal(p.$pageview_id, undefined, 'captured before the deferred initial pageview')
            assert.equal(pv.properties.title, 'Pricing')
            assert.match(ev.timestamp, /^\d{4}-\d\d-\d\dT/)
            assert.equal(pv.properties.$session_id, p.$session_id)
            // Persistence uses upstream's key/format.
            const stored = JSON.parse(b.window.localStorage.getItem('ph_phc_test_posthog'))
            assert.equal(stored.distinct_id, p.distinct_id)
            assert.ok(Array.isArray(stored.$sesid) && stored.$sesid[1] === p.$session_id)
            assert.ok(b.document.cookie.includes('ph_phc_test_posthog='), 'identity mirrored to cookie')
            assert.equal(b.window.posthog.version, '0.1.0-closure')
        },
    },

    'remote config failing (500): defaults apply, flags still load': {
        builds: ['core-flags'],
        async run(load) {
            const { b, ph } = await load({ respond: (r) => (r.path.startsWith('/array/') ? { status: 500, body: {} } : defaultRouter(r)) })
            ph.init(TOKEN, { ...FAST, capture_pageview: false })
            ph.capture('x')
            await sleep(FLUSH)
            assert.equal(b.requests.filter((r) => r.path === '/flags/').length, 1)
            const reqs = eventRequests(b)
            assert.equal(reqs.length, 1)
            // No remote config: default endpoint, and no compression (upstream clears it on {ok:false}).
            assert.equal(reqs[0].path, '/e/')
            assert.equal(reqs[0].headers.get('Content-Type'), 'application/json')
            assert.equal(ph.getFeatureFlag('multi', { send_event: false }), 'test')
        },
    },

    'remote config hasFeatureFlags:false skips /flags': {
        builds: ['core-flags'],
        async run(load) {
            const { b, ph } = await load({
                respond: (r) => (r.path === `/array/${TOKEN}/config` ? { status: 200, body: { ...REMOTE_CONFIG, hasFeatureFlags: false } } : defaultRouter(r)),
            })
            ph.init(TOKEN, { ...FAST, capture_pageview: false })
            await sleep(FLUSH)
            assert.equal(b.requests.filter((r) => r.path === '/flags/').length, 0)
            assert.equal(ph.getFeatureFlag('multi'), undefined)
        },
    },

    'remote config is broadcast to extensions, including late ones': {
        builds: ['core'],
        sourceOnly: true, // hook names are renamed in compiled bundles; real extensions compile with the core
        async run(load) {
            const { b, ph } = await load()
            const seen = []
            ph.__registerExtension('early', () => ({ onRemoteConfig: (c) => seen.push(['early', c && c.analytics.endpoint]) }))
            ph.init(TOKEN, { ...FAST, capture_pageview: false })
            await sleep(100)
            ph.__registerExtension('late', () => ({ onRemoteConfig: (c) => seen.push(['late', c && c.analytics.endpoint]) }))
            assert.deepEqual(seen, [['early', '/i/v0/e/'], ['late', '/i/v0/e/']])
            assert.equal(b.requests.filter((r) => r.path === '/flags/').length, 0)
        },
    },

    'core-only build has no flags but facade is safe': {
        builds: ['core'],
        async run(load) {
            const { b, ph } = await load()
            ph.init(TOKEN, { ...FAST })
            assert.equal(ph.getFeatureFlag('multi'), undefined)
            assert.equal(ph.isFeatureEnabled('multi'), undefined)
            assert.equal(ph.featureFlags, undefined)
            let cb = null
            ph.onFeatureFlags((flags, variants, ctx) => (cb = ctx))
            assert.deepEqual(cb, { errorsLoading: true })
            await sleep(100)
            assert.equal(b.requests.filter((r) => r.path === '/flags/').length, 0)
            assert.equal(b.requests.filter((r) => r.path === '/api/web_experiments/').length, 0)
        },
    },

    'identify, person properties and reset': {
        builds: ['core', 'full'],
        async run(load) {
            const { b, ph } = await load()
            ph.init(TOKEN, { ...FAST, capture_pageview: false })
            const anon = ph.get_distinct_id()
            ph.identify('user-1', { email: 'a@b.c' }, { first_seen: 'x' })
            assert.equal(ph.get_distinct_id(), 'user-1')
            ph.capture('after')
            ph.group('company', 'acme', { name: 'Acme' })
            ph.register({ app: 'web' })
            ph.capture('grouped')
            await sleep(FLUSH)
            const reqs = eventRequests(b)
            // $identify carries options, so like upstream it is sent unbatched.
            assert.deepEqual(reqs[0].body.batch.map((e) => e.event), ['$identify'])
            const evs = events(b)
            const identify = evs.find((e) => e.event === '$identify')
            assert.equal(identify.properties.distinct_id, 'user-1')
            assert.equal(identify.properties.$anon_distinct_id, anon)
            assert.deepEqual(identify.$set, { email: 'a@b.c' })
            assert.equal(identify.$set_once.first_seen, 'x')
            assert.equal(identify.$set_once.$initial_referring_domain, 'www.google.com')
            assert.equal(identify.$set_once.$initial_utm_source, 'newsletter')
            assert.equal(identify.$set_once.$initial_utm_medium, null)
            const after = evs.find((e) => e.event === 'after')
            assert.equal(after.properties.$process_person_profile, true)
            assert.equal(after.properties.$is_identified, true)
            assert.equal(after.properties.$user_id, 'user-1')
            assert.equal(after.properties.$device_id, anon)
            const gi = evs.find((e) => e.event === '$groupidentify')
            assert.equal(gi.properties.$group_type, 'company')
            assert.deepEqual(gi.properties.$group_set, { name: 'Acme' })
            const grouped = evs.find((e) => e.event === 'grouped')
            assert.deepEqual(grouped.properties.$groups, { company: 'acme' })
            assert.equal(grouped.properties.app, 'web')
            const sid = ph.get_session_id()
            ph.reset()
            assert.notEqual(ph.get_distinct_id(), 'user-1')
            assert.notEqual(ph.get_distinct_id(), anon)
            assert.equal(ph.get_property('$device_id'), anon, 'reset keeps the device id')
            assert.notEqual(ph.get_session_id(), sid)
            assert.equal(ph.get_property('app'), undefined)
        },
    },

    'opt out by default, then opt in': {
        builds: ['core'],
        async run(load) {
            const { b, ph } = await load()
            ph.init(TOKEN, { ...FAST, opt_out_capturing_by_default: true })
            ph.capture('dropped')
            await sleep(100)
            assert.equal(events(b).length, 0)
            assert.equal(ph.is_capturing(), false)
            ph.opt_in_capturing()
            ph.capture('kept')
            await sleep(FLUSH)
            const names = eventRequests(b).map((r) => r.body.batch.map((e) => e.event))
            assert.deepEqual(names, [['$opt_in'], ['$pageview'], ['kept']])
            assert.equal(ph.has_opted_in_capturing(), true)
            assert.equal(b.window.localStorage.getItem('__ph_opt_in_out_phc_test'), '1')
        },
    },

    'consent_persistence_name stores consent under that key': {
        builds: ['core'],
        async run(load) {
            const { b, ph } = await load()
            ph.init(TOKEN, { ...FAST, capture_pageview: false, consent_persistence_name: 'my_consent' })
            ph.opt_out_capturing()
            assert.equal(b.window.localStorage.getItem('my_consent'), '0')
            assert.equal(ph.is_capturing(), false)
        },
    },

    'bot user agents are dropped': {
        builds: ['core'],
        browser: { userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
        async run(load) {
            const { b, ph } = await load()
            ph.init(TOKEN, { ...FAST })
            ph.capture('x')
            await sleep(FLUSH)
            assert.equal(events(b).length, 0)
        },
    },

    'before_send can drop and edit events; denylist strips props': {
        builds: ['core'],
        async run(load) {
            const { b, ph } = await load()
            ph.init(TOKEN, {
                ...FAST, capture_pageview: false, property_denylist: ['$screen_width'],
                before_send: (e) => (e.event === 'secret' ? null : { ...e, properties: { ...e.properties, edited: 1 } }),
            })
            ph.capture('secret')
            ph.capture('public')
            await sleep(FLUSH)
            const evs = events(b)
            assert.deepEqual(evs.map((e) => e.event), ['public'])
            assert.equal(evs[0].properties.edited, 1)
            assert.equal(evs[0].properties.$screen_width, undefined)
        },
    },

    'pagehide flushes via sendBeacon with $pageleave': {
        builds: ['core'],
        async run(load) {
            const { b, ph } = await load()
            ph.init(TOKEN, { request_queue_config: { flush_interval_ms: 5000 } })
            await sleep(100)
            ph.capture('pending')
            b.dispatch('pagehide')
            await sleep(50)
            const beacons = b.requests.filter((r) => r.transport === 'sendBeacon')
            assert.equal(beacons.length, 1)
            assert.ok(!beacons[0].url.includes('compression='), 'gzip-js beacon has no compression param')
            const names = beacons[0].body.batch.map((e) => e.event)
            assert.deepEqual(names, ['pending', '$pageleave'])
            const leave = beacons[0].body.batch.find((e) => e.event === '$pageleave')
            assert.equal(leave.properties.$prev_pageview_pathname, '/pricing')
            assert.equal(typeof leave.properties.$prev_pageview_max_scroll_percentage, 'number')
        },
    },

    'snippet stub calls are replayed': {
        builds: ['core', 'full'],
        async run(load) {
            const { b, ph } = await load({
                before(window) {
                    const stub = []
                    stub.__SV = 1
                    stub._i = [[TOKEN, { ...FAST, capture_pageview: false }, undefined]]
                    stub.push(['capture', 'from-snippet', { a: 1 }])
                    stub.push(['identify', 'snippet-user'])
                    window.posthog = stub
                },
            })
            assert.equal(ph.__loaded, true)
            await sleep(FLUSH)
            const ev = events(b).find((e) => e.event === 'from-snippet')
            assert.ok(ev)
            // identify is replayed before capture, so the event is attributed.
            assert.equal(ev.properties.distinct_id, 'snippet-user')
        },
    },

    'history_change captures SPA pageviews': {
        builds: ['core'],
        async run(load) {
            const { b, ph } = await load()
            ph.init(TOKEN, { ...FAST, capture_pageview: 'history_change' })
            await sleep(50)
            b.window.history.pushState({}, '', '/docs')
            b.window.history.pushState({}, '', '/docs')
            await sleep(FLUSH)
            const pv = events(b).filter((e) => e.event === '$pageview')
            assert.equal(pv.length, 2)
            assert.equal(pv[1].properties.$prev_pageview_pathname, '/pricing')
            assert.equal(pv[1].properties.$pathname, '/docs')
            assert.equal(pv[1].properties.navigation_type, 'pushState')
        },
    },

    'client rate limiting drops events and sends one warning': {
        builds: ['core'],
        async run(load) {
            const { b, ph } = await load()
            ph.init(TOKEN, { ...FAST, capture_pageview: false, rate_limiting: { events_per_second: 1, events_burst_limit: 3 } })
            for (let i = 0; i < 6; i++) ph.capture('spam', { i })
            await sleep(FLUSH)
            const evs = events(b)
            assert.deepEqual(evs.filter((e) => e.event === 'spam').map((e) => e.properties.i), [0, 1, 2])
            const warnings = evs.filter((e) => e.event === '$$client_ingestion_warning')
            assert.equal(warnings.length, 1)
            assert.match(warnings[0].properties.$$client_ingestion_warning_message, /1 event\(s\) dropped/)
        },
    },

    'feature flags load after remote config, enrich events and report calls': {
        builds: ['full', 'core-flags'],
        async run(load) {
            const { b, ph } = await load()
            let callbackArgs = null
            ph.init(TOKEN, { ...FAST, capture_pageview: false })
            ph.onFeatureFlags((flags, variants, ctx) => (callbackArgs = { flags, variants, ctx }))
            await sleep(100)
            const configIdx = b.requests.findIndex((r) => r.path === `/array/${TOKEN}/config`)
            const flagIdx = b.requests.findIndex((r) => r.path === '/flags/')
            assert.ok(configIdx >= 0 && flagIdx > configIdx, 'flags requested after remote config')
            const flagReq = b.requests[flagIdx]
            assert.equal(flagReq.query.v, '2')
            assert.equal(flagReq.body.token, TOKEN)
            assert.ok(flagReq.body.sent_at)
            assert.ok(!('group_properties' in flagReq.body))
            assert.equal(flagReq.body.distinct_id, ph.get_distinct_id())
            assert.equal(flagReq.body.person_properties.$lib, 'web')
            assert.deepEqual(callbackArgs.flags.sort(), ['bool', 'exp-flag', 'multi'])
            assert.equal(callbackArgs.ctx.errorsLoading, false)
            assert.equal(ph.getFeatureFlag('multi'), 'test')
            assert.equal(ph.getFeatureFlag('multi'), 'test')
            assert.equal(ph.isFeatureEnabled('bool'), true)
            assert.equal(ph.isFeatureEnabled('off'), false)
            assert.equal(ph.getFeatureFlag('missing'), undefined)
            assert.deepEqual(ph.getFeatureFlagPayload('multi'), { color: 'red' })
            ph.featureFlags.overrideFeatureFlags({ bool: 'forced' })
            assert.equal(ph.getFeatureFlag('bool', { send_event: false }), 'forced')
            ph.featureFlags.overrideFeatureFlags(false)
            ph.capture('with-flags')
            await sleep(FLUSH)
            const evs = events(b)
            const called = evs.filter((e) => e.event === '$feature_flag_called' && e.properties.$feature_flag === 'multi')
            assert.equal(called.length, 1, 'reported once')
            assert.equal(called[0].properties.$feature_flag_response, 'test')
            assert.equal(called[0].properties.$feature_flag_id, 11)
            assert.equal(called[0].properties.$feature_flag_version, 3)
            assert.equal(called[0].properties.$feature_flag_reason, 'condition_match')
            assert.equal(called[0].properties.$feature_flag_request_id, 'req-1')
            assert.equal(called[0].properties.$used_bootstrap_value, false)
            const missing = evs.find((e) => e.event === '$feature_flag_called' && e.properties.$feature_flag === 'missing')
            assert.equal(missing.properties.$feature_flag_error, 'flag_missing')
            const ev = evs.find((e) => e.event === 'with-flags')
            assert.equal(ev.properties['$feature/multi'], 'test')
            assert.equal(ev.properties['$feature/bool'], true)
            assert.equal(ev.properties['$feature/off'], false)
            assert.deepEqual(ev.properties.$feature_flag_payloads, { multi: '{"color":"red"}' })
            assert.ok(ev.properties.$active_feature_flags.includes('multi'))
            // identify triggers a reload carrying the anonymous id.
            const anon = ph.get_distinct_id()
            ph.identify('flag-user')
            await sleep(100)
            const reload = b.requests.filter((r) => r.path === '/flags/').at(-1)
            assert.equal(reload.body.distinct_id, 'flag-user')
            assert.equal(reload.body.$anon_distinct_id, anon)
        },
    },

    'bootstrapped flags are available synchronously': {
        builds: ['full'],
        async run(load) {
            const { ph } = await load({ respond: () => ({ status: 500, body: {} }) })
            ph.init(TOKEN, {
                ...FAST, capture_pageview: false,
                bootstrap: { distinctID: 'boot-user', isIdentifiedID: true, featureFlags: { early: 'v1' } },
            })
            assert.equal(ph.get_distinct_id(), 'boot-user')
            assert.equal(ph.getFeatureFlag('early', { send_event: false }), 'v1')
            await sleep(100)
            // A failing server must not wipe bootstrapped flags.
            assert.equal(ph.getFeatureFlag('early', { send_event: false }), 'v1')
        },
    },

    'web experiments apply the flag variant transforms when enabled': {
        builds: ['full'],
        async run(load) {
            const { b, ph } = await load()
            ph.init(TOKEN, { ...FAST, capture_pageview: false, disable_web_experiments: false })
            await sleep(150)
            const hero = b.elements['#hero'][0]
            assert.equal(hero.attrs.style, 'color: red')
            // Upstream reads the variant with getFeatureFlag, which reports the exposure.
            await sleep(FLUSH)
            assert.ok(events(b).some((e) => e.event === '$feature_flag_called' && e.properties.$feature_flag === 'exp-flag'))
        },
    },

    'web experiments are disabled by default (upstream default)': {
        builds: ['full'],
        async run(load) {
            const { b, ph } = await load()
            ph.init(TOKEN, { ...FAST, capture_pageview: false })
            await sleep(150)
            assert.equal(b.requests.filter((r) => r.path === '/api/web_experiments/').length, 0)
            assert.equal(b.elements['#hero'][0].attrs.style, undefined)
        },
    },

    'chunks: flags and experiments can be loaded after init': {
        builds: ['chunks'],
        async run() {
            const b = createBrowser({ respond: defaultRouter })
            b.loadScript('dist/chunks/core.js')
            const ph = b.window.posthog
            ph.init(TOKEN, { ...FAST, capture_pageview: false, disable_web_experiments: false })
            assert.equal(ph.getFeatureFlag('multi'), undefined)
            ph.capture('before-flags')
            await sleep(100)
            assert.equal(b.requests.filter((r) => r.path === '/flags/').length, 0)
            // Remote config already arrived: the late flags module loads flags straight away.
            b.loadScript('dist/chunks/flags.js')
            await sleep(100)
            assert.equal(b.requests.filter((r) => r.path === '/flags/').length, 1)
            assert.equal(ph.getFeatureFlag('multi'), 'test')
            b.loadScript('dist/chunks/experiments.js')
            await sleep(150)
            assert.equal(b.elements['#hero'][0].attrs.style, 'color: red')
            ph.capture('after-flags')
            await sleep(FLUSH)
            const ev = events(b).find((e) => e.event === 'after-flags')
            assert.equal(ev.properties['$feature/multi'], 'test')
        },
    },
}

// ---- exception capture (src/exceptions) ------------------------------------------------
Object.assign(scenarios, {
    'exceptions: without the module captureException is a no-op': {
        builds: ['core'],
        async run(load) {
            const { b, ph } = await load()
            ph.init(TOKEN, { ...FAST, capture_pageview: false })
            assert.equal(ph.captureException(new Error('x')), undefined)
            ph.addExceptionStep('step')
            ph.startExceptionAutocapture()
            assert.equal(ph.config.capture_exceptions, true)
            ph.stopExceptionAutocapture()
            assert.equal(ph.config.capture_exceptions, false)
            assert.equal(ph.exceptions, undefined)
            await sleep(FLUSH)
            assert.equal(events(b).filter((e) => e.event === '$exception').length, 0)
        },
    },
    'exceptions: captureException sends $exception with steps and extra properties': {
        builds: ['full'],
        async run(load) {
            const { b, ph } = await load()
            ph.init(TOKEN, { ...FAST, capture_pageview: false })
            ph.addExceptionStep('clicked', { button: 'buy' })
            const err = new Error('boom', { cause: 'root' })
            err.stack = 'Error: boom\n    at handler (https://app.example.com/app.js:10:5)\n    at https://app.example.com/main.js:1:2'
            const result = ph.captureException(err, { $exception_fingerprint: 'fp' })
            assert.ok(result)
            await sleep(FLUSH)
            const ev = events(b).find((e) => e.event === '$exception')
            assert.equal(ev.properties.$exception_fingerprint, 'fp')
            assert.equal(ev.properties.$exception_level, 'error')
            assert.deepEqual(ev.properties.$exception_steps.map((s) => [s.$message, s.button]), [['clicked', 'buy']])
            const [root, cause] = ev.properties.$exception_list
            assert.deepEqual(root.mechanism, { type: 'generic', handled: true, synthetic: false, exception_id: 0 })
            assert.deepEqual(root.stacktrace.frames.map((f) => [f.filename, f.function, f.lineno, f.colno, f.in_app]), [
                ['https://app.example.com/main.js', '?', 1, 2, true],
                ['https://app.example.com/app.js', 'handler', 10, 5, true],
            ])
            assert.deepEqual([cause.type, cause.value, cause.mechanism.source, cause.mechanism.parent_id], ['Error', 'root', 'cause', 0])
            // Autocapture follows the remote flag (off here) and is persisted like upstream.
            assert.equal(ph.get_property('$exception_capture_enabled_server_side'), false)
            assert.equal(ph.exceptionObserver.isEnabled, false)
        },
    },
    'chunks: exceptions can be loaded after init': {
        builds: ['chunks'],
        async run() {
            const b = createBrowser({ respond: defaultRouter })
            b.loadScript('dist/chunks/core.js')
            const ph = b.window.posthog
            ph.init(TOKEN, { ...FAST, capture_pageview: false, capture_exceptions: true })
            assert.equal(ph.captureException(new Error('too early')), undefined)
            await sleep(100)
            b.loadScript('dist/chunks/exceptions.js')
            assert.equal(ph.exceptionObserver.isEnabled, true)
            assert.equal(b.window.onerror.__POSTHOG_INSTRUMENTED__, true)
            assert.ok(ph.captureException('late'))
            await sleep(FLUSH)
            const ev = events(b).find((e) => e.event === '$exception')
            assert.equal(ev.properties.$exception_list[0].value, 'late')
        },
    },
})

// ---- Autocapture, heatmaps and dead clicks -------------------------------------
Object.assign(scenarios, {
    'autocapture, heatmaps, dead clicks: remote config switches are persisted like upstream': {
        builds: ['full'],
        async run(load) {
            const { b, ph } = await load()
            ph.init(TOKEN, { ...FAST, capture_pageview: false })
            assert.equal(ph.autocapture.isEnabled, false, 'waits for the remote config')
            await sleep(100)
            assert.equal(ph.autocapture.isEnabled, true)
            assert.equal(ph.heatmaps.isEnabled, false)
            assert.equal(ph.heatmaps.flushIntervalMilliseconds, 5000)
            assert.equal(ph.deadClicksAutocapture.lazyLoadedDeadClicksAutocapture, undefined)
            ph.capture('x')
            await sleep(FLUSH)
            const p = events(b).find((e) => e.event === 'x').properties
            assert.equal(p.$autocapture_disabled_server_side, false)
            assert.equal(p.$dead_clicks_enabled_server_side, false)
            assert.equal(p.$heatmaps_enabled_server_side, undefined, 'hidden persistence key')
            const stored = JSON.parse(b.window.localStorage.getItem('ph_phc_test_posthog'))
            assert.equal(stored.$heatmaps_enabled_server_side, false)
            ph.set_config({ autocapture: false, capture_heatmaps: true })
            assert.equal(ph.autocapture.isEnabled, false)
            assert.equal(ph.heatmaps.isEnabled, true)
        },
    },

    'chunks: dom, autocapture, dead clicks and heatmaps can be loaded after init': {
        builds: ['chunks'],
        async run() {
            const config = { ...REMOTE_CONFIG, autocapture_opt_out: true, heatmaps: true }
            const b = createBrowser({ respond: (r) => (r.path === '/array/' + TOKEN + '/config'
                ? { status: 200, body: config } : defaultRouter(r)) })
            b.loadScript('dist/chunks/core.js')
            const ph = b.window.posthog
            ph.init(TOKEN, { ...FAST, capture_pageview: false })
            await sleep(100)
            assert.equal(ph.autocapture, undefined)
            b.loadScript('dist/chunks/dom.js')
            b.loadScript('dist/chunks/autocapture.js')
            b.loadScript('dist/chunks/deadclicks.js')
            b.loadScript('dist/chunks/heatmaps.js')
            // The late modules got the remote config straight away.
            assert.equal(ph.autocapture.isEnabled, false, 'autocapture_opt_out')
            assert.equal(ph.heatmaps.isEnabled, true)
            ph.capture('after')
            await sleep(FLUSH)
            const p = events(b).find((e) => e.event === 'after').properties
            assert.equal(p.$autocapture_disabled_server_side, true)
            assert.equal(p.$dead_clicks_enabled_server_side, false)
        },
    },
})

// ---- Web vitals and tracing headers ----------------------------------------------
Object.assign(scenarios, {
    'web vitals and tracing headers: remote switch persisted, fetch patched': {
        builds: ['full'],
        async run(load) {
            const { b, ph } = await load()
            ph.init(TOKEN, { ...FAST, capture_pageview: false, tracing_headers: ['api.example.com'] })
            assert.equal(ph.webVitalsAutocapture.isEnabled, false, 'waits for the remote config')
            await sleep(100)
            assert.equal(ph.webVitalsAutocapture.isEnabled, false, 'capturePerformance: false')
            assert.deepEqual(ph.webVitalsAutocapture.allowedMetrics, ['CLS', 'FCP', 'INP', 'LCP'])
            await b.window.fetch('https://api.example.com/x')
            await b.window.fetch('https://other.example.com/y')
            ph.capture('x')
            await sleep(FLUSH)
            const p = events(b).find((e) => e.event === 'x').properties
            assert.equal(p.$web_vitals_enabled_server_side, false)
            const [api, other] = ['/x', '/y'].map((path) => b.requests.find((r) => r.path === path))
            assert.equal(new Headers(api.headers).get('X-POSTHOG-SESSION-ID'), p.$session_id)
            assert.equal(new Headers(api.headers).get('X-POSTHOG-WINDOW-ID'), p.$window_id)
            assert.equal(new Headers(api.headers).get('X-POSTHOG-DISTINCT-ID'), p.distinct_id)
            assert.equal(other.headers, undefined)
        },
    },

    'chunks: web vitals and tracing headers can be loaded after init': {
        builds: ['chunks'],
        async run() {
            const b = createBrowser({ respond: defaultRouter })
            b.loadScript('dist/chunks/core.js')
            const ph = b.window.posthog
            ph.init(TOKEN, { ...FAST, capture_pageview: false, addTracingHeaders: ['api.example.com'] })
            await sleep(100)
            assert.equal(ph.webVitalsAutocapture, undefined)
            const nativeFetch = b.window.fetch
            b.loadScript('dist/chunks/webvitals.js')
            b.loadScript('dist/chunks/tracingheaders.js')
            // The late modules got the remote config and the config straight away.
            assert.equal(ph.webVitalsAutocapture.isEnabled, false)
            assert.notEqual(b.window.fetch, nativeFetch)
            ph.capture('after')
            await sleep(FLUSH)
            assert.equal(events(b).find((e) => e.event === 'after').properties.$web_vitals_enabled_server_side, false)
            ph.set_config({ addTracingHeaders: [] })
            assert.equal(b.window.fetch, nativeFetch, 'patches removed')
            // Web vitals are compiled in: no /static/web-vitals*.js request.
            assert.ok(!b.requests.some((r) => /web-vitals|tracing-headers/.test(r.path)))
        },
    },
})

// ---- Logs, metrics and the toolbar loader -----------------------------------------
const otlpRequests = (b, path) => b.requests.filter((r) => r.path === path)

Object.assign(scenarios, {
    'logs, metrics: captureLog, logger and metrics reach their OTLP endpoints': {
        builds: ['full'],
        async run(load) {
            const { b, ph } = await load()
            ph.init(TOKEN, { ...FAST, capture_pageview: false, logs: { serviceName: 'svc' } })
            ph.captureLog({ body: 'hello', level: 'warn', attributes: { a: 1 } })
            ph.logger.error('oops')
            await ph.logs.flush()
            ph.metrics.count('n', 2)
            await ph.metrics.flush()
            const [logs] = otlpRequests(b, '/i/v1/logs')
            const records = logs.body.resourceLogs[0].scopeLogs[0].logRecords
            assert.deepEqual(records.map((r) => [r.severityText, r.body.stringValue]), [['WARN', 'hello'], ['ERROR', 'oops']])
            assert.deepEqual(logs.body.resourceLogs[0].resource.attributes.find((a) => a.key === 'service.name').value, { stringValue: 'svc' })
            assert.equal(logs.body.resourceLogs[0].scopeLogs[0].scope.name, 'web')
            const [metrics] = otlpRequests(b, '/i/v1/metrics')
            assert.equal(metrics.body.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].asDouble, 2)
        },
    },

    'logs, metrics, toolbar: without the modules the core methods are no-ops': {
        builds: ['core'],
        async run(load) {
            const { b, ph } = await load()
            ph.init(TOKEN, { ...FAST, capture_pageview: false })
            ph.captureLog({ body: 'dropped' })
            ph.logger.info('dropped')
            assert.equal(ph.loadToolbar({}), false)
            assert.equal(ph.logs, undefined)
            assert.equal(ph.metrics, undefined)
            await sleep(FLUSH)
            assert.equal(otlpRequests(b, '/i/v1/logs').length, 0)
        },
    },

    'chunks: otlp, logs, metrics and toolbar can be loaded after init': {
        builds: ['chunks'],
        async run() {
            const b = createBrowser({ respond: defaultRouter })
            b.loadScript('dist/chunks/core.js')
            const ph = b.window.posthog
            ph.init(TOKEN, { ...FAST, capture_pageview: false })
            await sleep(100)
            assert.equal(ph.logs, undefined)
            b.loadScript('dist/chunks/otlp.js')
            b.loadScript('dist/chunks/logs.js')
            b.loadScript('dist/chunks/metrics.js')
            b.loadScript('dist/chunks/toolbar.js')
            ph.captureLog({ body: 'late' })
            await ph.logs.flush()
            ph.metrics.gauge('g', 3)
            await ph.metrics.flush()
            assert.equal(otlpRequests(b, '/i/v1/logs')[0].body.resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue, 'late')
            assert.equal(otlpRequests(b, '/i/v1/metrics')[0].body.resourceMetrics[0].scopeMetrics[0].metrics[0].gauge.dataPoints[0].asDouble, 3)
            assert.equal(typeof ph.toolbar.maybeLoadToolbar, 'function')
        },
    },
})

/** Build name -> how to load it. */
export const BUILDS = {
    core: { file: 'dist/posthog.core.js', source: 'src/entry/core.js' },
    'core-flags': { file: 'dist/posthog.core-flags.js', source: 'src/entry/core-flags.js' },
    full: { file: 'dist/posthog.full.js', source: 'src/entry/full.js' },
    chunks: { file: null, source: null },
}

/** Returns a loader for a build, in 'compiled' or 'source' mode. */
export function loaderFor(build, mode, scenario) {
    return async (opts = {}) => {
        const b = createBrowser({ ...scenario.browser, ...opts, respond: opts.respond || defaultRouter })
        if (opts.before) opts.before(b.window)
        if (mode === 'compiled') b.loadScript(BUILDS[build].file)
        else await b.importSource(BUILDS[build].source)
        return { b, ph: b.window.posthog }
    }
}

// ---- regressions -----------------------------------------------------------------
Object.assign(scenarios, {
    'featureFlags.hasLoadedFlags getter works (no self-recursion in source mode)': {
        builds: ['full'],
        async run(load) {
            const { ph } = await load()
            ph.init(TOKEN, { ...FAST, capture_pageview: false })
            assert.equal(ph.featureFlags.hasLoadedFlags, false)
            await sleep(150)
            assert.equal(ph.featureFlags.hasLoadedFlags, true)
        },
    },
})
