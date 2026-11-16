// Behavioural scenarios, run against raw sources and every compiled bundle.
import strictAssert from 'node:assert/strict'

// Objects from compiled bundles live in another vm realm, so compare by value.
const plain = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)))
const assert = Object.assign((...a) => strictAssert(...a), strictAssert, {
    deepEqual: (a, b, m) => strictAssert.deepEqual(plain(a), plain(b), m),
})
import { createBrowser, sleep, capturedEvents } from './harness.mjs'

const TOKEN = 'phc_test'
const FAST = { request_queue_config: { flush_interval_ms: 30 } }

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
            test: { transforms: [{ selector: '#hero', text: 'New headline', css: 'color: red' }] },
        },
    }],
}

function router(req) {
    if (req.path === '/flags/') return { status: 200, body: FLAGS_RESPONSE }
    if (req.path === '/api/web_experiments/') return { status: 200, body: EXPERIMENTS_RESPONSE }
    return undefined
}

/**
 * Each scenario: { builds: [...], run(load) } where load(browserOpts) returns
 * { b, ph } with the SDK loaded from the build under test.
 */
export const scenarios = {
    'capture sends batched gzip events with context': {
        builds: ['core', 'full'],
        async run(load) {
            const { b, ph } = await load()
            ph.init(TOKEN, { ...FAST })
            ph.capture('signed_up', { plan: 'pro' })
            await sleep(120)
            const reqs = b.requests.filter((r) => r.path === '/e/')
            assert.equal(reqs.length, 1, 'one batched request')
            assert.match(reqs[0].url, /^https:\/\/us\.i\.posthog\.com\/e\/\?compression=gzip-js/)
            assert.equal(reqs[0].body.api_key, TOKEN)
            const events = reqs[0].body.batch
            assert.deepEqual(events.map((e) => e.event), ['$pageview', 'signed_up'])
            const p = events[1].properties
            assert.equal(p.plan, 'pro')
            assert.equal(p.token, TOKEN)
            assert.match(p.distinct_id, /^[0-9a-f-]{36}$/)
            assert.equal(p.$device_id, p.distinct_id)
            assert.match(p.$session_id, /^[0-9a-f]{8}-[0-9a-f]{4}-7/)
            assert.ok(p.$window_id)
            assert.equal(p.$lib, 'web')
            assert.equal(p.$browser, 'Chrome')
            assert.equal(p.$os, 'Mac OS X')
            assert.equal(p.$device_type, 'Desktop')
            assert.equal(p.$current_url, 'https://app.example.com/pricing?utm_source=newsletter')
            assert.equal(p.utm_source, 'newsletter')
            assert.equal(p.$referring_domain, 'www.google.com')
            assert.equal(p.$process_person_profile, false)
            assert.equal(p.$is_identified, false)
            assert.equal(p.$pageview_id, events[0].uuid)
            assert.equal(events[0].properties.title, 'Pricing')
            assert.match(events[1].timestamp, /^\d{4}-\d\d-\d\dT/)
            assert.equal(events[0].properties.$session_id, p.$session_id)
            // Persistence uses upstream's key/format.
            const stored = JSON.parse(b.window.localStorage.getItem('ph_phc_test_posthog'))
            assert.equal(stored.distinct_id, p.distinct_id)
            assert.ok(Array.isArray(stored.$sesid) && stored.$sesid[1] === p.$session_id)
            assert.ok(b.document.cookie.includes('ph_phc_test_posthog='), 'identity mirrored to cookie')
            assert.equal(b.window.posthog.version, '0.1.0-closure')
        },
    },

    'core-only build has no flags but facade is safe': {
        builds: ['core'],
        async run(load) {
            const { b, ph } = await load()
            ph.init(TOKEN, { ...FAST })
            assert.equal(ph.getFeatureFlag('multi'), undefined)
            assert.equal(ph.isFeatureEnabled('multi'), undefined)
            assert.deepEqual(ph.getFeatureFlags(), {})
            await sleep(80)
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
            await sleep(120)
            const events = capturedEvents(b.requests)
            const identify = events.find((e) => e.event === '$identify')
            assert.ok(identify)
            assert.equal(identify.properties.distinct_id, 'user-1')
            assert.equal(identify.properties.$anon_distinct_id, anon)
            assert.deepEqual(identify.$set, { email: 'a@b.c' })
            assert.equal(identify.$set_once.first_seen, 'x')
            assert.equal(identify.$set_once.$initial_referring_domain, 'www.google.com')
            assert.equal(identify.$set_once.$initial_utm_source, 'newsletter')
            const after = events.find((e) => e.event === 'after')
            assert.equal(after.properties.$process_person_profile, true)
            assert.equal(after.properties.$is_identified, true)
            assert.equal(after.properties.$device_id, anon)
            const gi = events.find((e) => e.event === '$groupidentify')
            assert.equal(gi.properties.$group_type, 'company')
            assert.deepEqual(gi.properties.$group_set, { name: 'Acme' })
            const grouped = events.find((e) => e.event === 'grouped')
            assert.deepEqual(grouped.properties.$groups, { company: 'acme' })
            assert.equal(grouped.properties.app, 'web')
            const sid = ph.get_session_id()
            ph.reset()
            assert.notEqual(ph.get_distinct_id(), 'user-1')
            assert.notEqual(ph.get_distinct_id(), anon)
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
            await sleep(80)
            assert.equal(capturedEvents(b.requests).length, 0)
            assert.equal(ph.is_capturing(), false)
            ph.opt_in_capturing()
            ph.capture('kept')
            await sleep(120)
            const names = capturedEvents(b.requests).map((e) => e.event)
            assert.ok(names.includes('$opt_in'))
            assert.ok(names.includes('kept'))
            assert.ok(!names.includes('dropped'))
            assert.equal(ph.has_opted_in_capturing(), true)
        },
    },

    'bot user agents are dropped': {
        builds: ['core'],
        browser: { userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
        async run(load) {
            const { b, ph } = await load()
            ph.init(TOKEN, { ...FAST })
            ph.capture('x')
            await sleep(80)
            assert.equal(capturedEvents(b.requests).length, 0)
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
            await sleep(120)
            const events = capturedEvents(b.requests)
            assert.deepEqual(events.map((e) => e.event), ['public'])
            assert.equal(events[0].properties.edited, 1)
            assert.equal(events[0].properties.$screen_width, undefined)
        },
    },

    'pagehide flushes via sendBeacon with $pageleave': {
        builds: ['core'],
        async run(load) {
            const { b, ph } = await load()
            ph.init(TOKEN, { request_queue_config: { flush_interval_ms: 10000 } })
            ph.capture('pending')
            b.dispatch('pagehide')
            await sleep(50)
            const beacons = b.requests.filter((r) => r.transport === 'sendBeacon')
            assert.ok(beacons.length >= 1)
            assert.ok(beacons.every((r) => r.url.includes('compression=base64')))
            const names = beacons.flatMap((r) => r.body.batch).map((e) => e.event)
            assert.ok(names.includes('$pageview') && names.includes('pending') && names.includes('$pageleave'))
            const leave = beacons.flatMap((r) => r.body.batch).find((e) => e.event === '$pageleave')
            assert.equal(leave.properties.$prev_pageview_pathname, '/pricing')
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
            await sleep(120)
            const ev = capturedEvents(b.requests).find((e) => e.event === 'from-snippet')
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
            b.window.history.pushState({}, '', '/docs')
            b.window.history.pushState({}, '', '/docs')
            await sleep(120)
            const pv = capturedEvents(b.requests).filter((e) => e.event === '$pageview')
            assert.equal(pv.length, 2)
            assert.equal(pv[1].properties.$prev_pageview_pathname, '/pricing')
            assert.equal(pv[1].properties.$pathname, '/docs')
        },
    },

    'feature flags load, enrich events and report calls': {
        builds: ['full', 'core-flags'],
        async run(load) {
            const { b, ph } = await load({ respond: router })
            let callbackArgs = null
            ph.init(TOKEN, { ...FAST, capture_pageview: false })
            ph.onFeatureFlags((flags, variants, ctx) => (callbackArgs = { flags, variants, ctx }))
            await sleep(60)
            const flagReq = b.requests.find((r) => r.path === '/flags/')
            assert.ok(flagReq, 'flags requested')
            assert.match(flagReq.url, /v=2/)
            assert.equal(flagReq.body.token, TOKEN)
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
            ph.overrideFeatureFlags({ bool: 'forced' })
            assert.equal(ph.getFeatureFlag('bool', { send_event: false }), 'forced')
            ph.overrideFeatureFlags(false)
            ph.capture('with-flags')
            await sleep(120)
            const events = capturedEvents(b.requests)
            const called = events.filter((e) => e.event === '$feature_flag_called' && e.properties.$feature_flag === 'multi')
            assert.equal(called.length, 1, 'reported once')
            assert.equal(called[0].properties.$feature_flag_response, 'test')
            assert.equal(called[0].properties.$feature_flag_id, 11)
            assert.equal(called[0].properties.$feature_flag_request_id, 'req-1')
            const ev = events.find((e) => e.event === 'with-flags')
            assert.equal(ev.properties['$feature/multi'], 'test')
            assert.equal(ev.properties['$feature/bool'], true)
            assert.equal(ev.properties['$feature/off'], undefined)
            assert.ok(ev.properties.$active_feature_flags.includes('multi'))
            // identify triggers a reload carrying the anonymous id.
            ph.identify('flag-user')
            await sleep(60)
            const reload = b.requests.filter((r) => r.path === '/flags/').at(-1)
            assert.equal(reload.body.distinct_id, 'flag-user')
            assert.ok(reload.body.$anon_distinct_id)
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
            await sleep(60)
            // A failing server must not wipe bootstrapped flags.
            assert.equal(ph.getFeatureFlag('early', { send_event: false }), 'v1')
        },
    },

    'web experiments apply the flag variant transforms': {
        builds: ['full'],
        async run(load) {
            const { b, ph } = await load({ respond: router })
            ph.init(TOKEN, { ...FAST, capture_pageview: false })
            await sleep(80)
            const hero = b.elements['#hero'][0]
            assert.equal(hero.textContent, 'New headline')
            assert.equal(hero.attrs.style, 'color: red')
        },
    },

    'web experiments can be disabled': {
        builds: ['full'],
        async run(load) {
            const { b, ph } = await load({ respond: router })
            ph.init(TOKEN, { ...FAST, capture_pageview: false, disable_web_experiments: true })
            await sleep(80)
            assert.equal(b.requests.filter((r) => r.path === '/api/web_experiments/').length, 0)
            assert.equal(b.elements['#hero'][0].textContent, '')
        },
    },

    'chunks: flags and experiments can be loaded after init': {
        builds: ['chunks'],
        async run(_load, b0) {
            const b = createBrowser({ respond: router })
            b.loadScript('dist/chunks/core.js')
            const ph = b.window.posthog
            ph.init(TOKEN, { ...FAST, capture_pageview: false })
            assert.equal(ph.getFeatureFlag('multi'), undefined)
            ph.capture('before-flags')
            await sleep(60)
            assert.equal(b.requests.filter((r) => r.path === '/flags/').length, 0)
            b.loadScript('dist/chunks/flags.js')
            await sleep(60)
            assert.equal(b.requests.filter((r) => r.path === '/flags/').length, 1)
            assert.equal(ph.getFeatureFlag('multi'), 'test')
            b.loadScript('dist/chunks/experiments.js')
            await sleep(80)
            assert.equal(b.elements['#hero'][0].textContent, 'New headline')
            ph.capture('after-flags')
            await sleep(120)
            const ev = capturedEvents(b.requests).find((e) => e.event === 'after-flags')
            assert.equal(ev.properties['$feature/multi'], 'test')
        },
    },
}

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
        const b = createBrowser({ ...scenario.browser, ...opts })
        if (opts.before) opts.before(b.window)
        if (mode === 'compiled') b.loadScript(BUILDS[build].file)
        else await b.importSource(BUILDS[build].source)
        return { b, ph: b.window.posthog }
    }
}
