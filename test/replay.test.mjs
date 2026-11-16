// Session replay unit tests (node --test), ported from upstream's
// sessionRecordingStatus.test.ts, sessionrecording-utils.test.ts,
// lazy-sessionrecording.test.ts (sampling, buffering, compression) and
// triggerGroups.test.ts, run against the raw ES-module sources.
import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'

// A minimal window before the sources compute their `win`/`doc` globals.
class Storage {
    constructor() { this.m = new Map() }
    getItem(k) { return this.m.has(k) ? this.m.get(k) : null }
    setItem(k, v) { this.m.set(k, String(v)) }
    removeItem(k) { this.m.delete(k) }
}
const listeners = {}
globalThis.window = globalThis
globalThis.location = new URL('https://app.example.com/pricing?x=1')
globalThis.sessionStorage = new Storage()
globalThis.localStorage = new Storage()
globalThis.addEventListener = (t, fn) => { (listeners[t] ||= []).push(fn) }
globalThis.removeEventListener = (t, fn) => { listeners[t] = (listeners[t] || []).filter((f) => f !== fn) }
globalThis.document = {
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll() { return [] },
}

const { simpleHash, sampleOnProperty } = await import('../src/replay/sampling.js')
const tm = await import('../src/replay/trigger-matching.js')
const strategies = await import('../src/replay/recording-strategies.js')
const utils = await import('../src/replay/utils.js')
const { LazyLoadedSessionRecording, RECORDING_MAX_EVENT_SIZE } = await import('../src/replay/recorder.js')

const { TRIGGER_ACTIVATED, TRIGGER_DISABLED, TRIGGER_PENDING } = await import('../src/replay/constants.js')

// ---- sampling --------------------------------------------------------------------

test('simpleHash matches upstream (java-style, positive)', () => {
    assert.equal(simpleHash(''), 0)
    assert.equal(simpleHash('a'), 97)
    assert.equal(simpleHash('hello'), 99162322)
    // upstream lazy-sessionrecording.test.ts: session-a samples in at 50%, session-e out
    assert.equal(simpleHash('session-a') % 100, 46)
    assert.equal(simpleHash('session-e') % 100, 50)
})

test('sampleOnProperty: 0 never, 1 always, 0.5 by hash', () => {
    for (const id of ['a', 'b', 'session-a', '0190f5b8-0000-7000-8000-000000000001']) {
        assert.equal(sampleOnProperty(id, 0), false)
        assert.equal(sampleOnProperty(id, 1), true)
    }
    assert.equal(sampleOnProperty('session-a', 0.5), true)
    assert.equal(sampleOnProperty('session-e', 0.5), false)
})

test('sampling decisions are tagged with the session id', () => {
    assert.equal(strategies.encodeSamplingDecision('s1', true), 's1')
    assert.equal(strategies.encodeSamplingDecision('s1', false), '!s1')
    assert.equal(strategies.decodeSamplingDecision('s1', 's1'), true)
    assert.equal(strategies.decodeSamplingDecision('!s1', 's1'), false)
    assert.equal(strategies.decodeSamplingDecision('s2', 's1'), null)
    assert.equal(strategies.decodeSamplingDecision(true, 's1'), null) // legacy
})

// ---- status (upstream sessionRecordingStatus.test.ts) ----------------------------

const fakePostHog = { register_for_session() {}, get_property() {} }
const matcher = (status, extra = {}) => ({ triggerStatus: () => status, triggerStatusNoSideEffects: () => status, stop() {}, urlBlocked: false, ...extra })
const linked = (flag, seen) => {
    const l = new tm.LinkedFlagMatching(fakePostHog)
    l.linkedFlag = flag
    l.linkedFlagSeen = seen
    return l
}
const base = {
    receivedFlags: true, isRecordingEnabled: true, isSampled: undefined, rrwebError: false,
    urlTriggerMatching: matcher(TRIGGER_DISABLED), eventTriggerMatching: matcher(TRIGGER_DISABLED),
    linkedFlagMatching: matcher(TRIGGER_DISABLED), sessionId: 'test-session',
}
const STATUS_CASES = [
    ['rrweb error', { rrwebError: true }, 'rrweb_error', 'rrweb_error'],
    ['rrweb error overrides sampling true', { rrwebError: true, isSampled: true }, 'rrweb_error', 'rrweb_error'],
    ['rrweb error overrides active trigger', { rrwebError: true, urlTriggerMatching: matcher(TRIGGER_ACTIVATED) }, 'rrweb_error', 'rrweb_error'],
    ['flags not received', { receivedFlags: false }, 'buffering', 'buffering'],
    ['recording disabled', { isRecordingEnabled: false }, 'disabled', 'disabled'],
    ['URL blocked', { urlTriggerMatching: matcher(TRIGGER_DISABLED, { urlBlocked: true }) }, 'paused', 'paused'],
    ['no event trigger', {}, 'active', 'active'],
    ['event trigger pending', { eventTriggerMatching: matcher(TRIGGER_PENDING) }, 'buffering', 'buffering'],
    ['event trigger activated', { eventTriggerMatching: matcher(TRIGGER_ACTIVATED) }, 'active', 'active'],
    ['sampling false', { isSampled: false }, 'disabled', 'disabled'],
    ['sampling true', { isSampled: true }, 'sampled', 'sampled'],
    ['sampling undefined', { isSampled: undefined }, 'active', 'active'],
    ['linked flag present but not seen', { linkedFlagMatching: linked('some-flag', false) }, 'buffering', 'buffering'],
    ['linked flag present and seen', { linkedFlagMatching: linked('some-flag', true) }, 'active', 'active'],
    ['linked flag not present', { linkedFlagMatching: linked(null, false) }, 'active', 'active'],
    ['url trigger pending', { urlTriggerMatching: matcher(TRIGGER_PENDING) }, 'buffering', 'buffering'],
    ['url trigger activated', { urlTriggerMatching: matcher(TRIGGER_ACTIVATED) }, 'active', 'active'],
    ['sampling false, flag seen, url activated', { isSampled: false, linkedFlagMatching: linked('f', true), urlTriggerMatching: matcher(TRIGGER_ACTIVATED) }, 'active', 'disabled'],
    ['sampling false, flag seen, url pending', { isSampled: false, linkedFlagMatching: linked('f', true), urlTriggerMatching: matcher(TRIGGER_PENDING) }, 'active', 'buffering'],
    ['sampling true, url pending', { isSampled: true, urlTriggerMatching: matcher(TRIGGER_PENDING) }, 'sampled', 'buffering'],
    ['sampling true, event pending', { isSampled: true, eventTriggerMatching: matcher(TRIGGER_PENDING) }, 'sampled', 'buffering'],
    ['sampling true, event activated', { isSampled: true, eventTriggerMatching: matcher(TRIGGER_ACTIVATED) }, 'sampled', 'sampled'],
    ['all configured and satisfied', { isSampled: true, linkedFlagMatching: linked('f', true), urlTriggerMatching: matcher(TRIGGER_ACTIVATED) }, 'sampled', 'sampled'],
]
for (const [name, config, anyExpected, allExpected] of STATUS_CASES) {
    test(`status: ${name} (any=${anyExpected}, all=${allExpected})`, () => {
        assert.equal(tm.anyMatchSessionRecordingStatus({ ...base, ...config }), anyExpected)
        assert.equal(tm.allMatchSessionRecordingStatus({ ...base, ...config }), allExpected)
    })
}

// ---- trigger matching ------------------------------------------------------------

function fakeInstance(overrides = {}) {
    const props = {}
    const session = {}
    const handlers = { eventCaptured: [] }
    const captured = []
    const flagCallbacks = []
    const instance = {
        config: { token: 'phc_test', api_host: 'https://us.i.posthog.com', session_recording: {}, persistence: 'localStorage+cookie', capture_pageview: true },
        persistence: {
            props,
            disabled: false,
            register(p) { Object.assign(props, p) },
            register_once(p) { for (const k in p) if (!(k in props)) props[k] = p[k] },
            unregister(k) { delete props[k] },
            set_property(k, v) { props[k] = v },
            get_property(k) { return props[k] },
        },
        sessionPersistence: { props: session, get_property(k) { return session[k] } },
        get_property(k) { return props[k] },
        register_for_session(p) { Object.assign(session, p) },
        has_opted_out_capturing() { return false },
        consent: { isOptedOut() { return false } },
        on(name, cb) { (handlers[name] ||= []).push(cb); return () => { handlers[name] = handlers[name].filter((f) => f !== cb) } },
        onFeatureFlags(cb) { flagCallbacks.push(cb); return () => {} },
        capture(event, properties, options) { captured.push({ event, properties, options }) },
        requestRouter: { endpointFor: (t, p) => 'https://us.i.posthog.com' + p },
        sessionManager: {
            sessionTimeoutMs: 30 * 60 * 1000,
            sessionId: 'session-a',
            windowId: 'window-1',
            checkAndGetSessionAndWindowId() { return { sessionId: this.sessionId, windowId: this.windowId, sessionStartTimestamp: Date.now() - 10 } },
            onSessionId() { return () => {} },
            onForcedIdleReset() { return () => {} },
        },
        _test: { props, session, handlers, captured, flagCallbacks },
        ...overrides,
    }
    return instance
}

test('URL trigger: regex matches activate once; blocklist pauses and resumes', () => {
    const ph = fakeInstance()
    const url = new tm.URLTriggerMatching(ph)
    url.onConfig({ urlTriggers: [{ url: '/checkout', matching: 'regex' }], urlBlocklist: [{ url: '/private', matching: 'regex' }] })
    assert.equal(url.triggerStatus('s'), TRIGGER_PENDING)
    assert.equal(ph._test.session.$sdk_debug_replay_url_trigger_status, TRIGGER_PENDING)
    const calls = []
    const check = () => url.checkUrlTriggerConditions(() => calls.push('pause'), () => calls.push('resume'), (t, m) => calls.push(t + ':' + m), 's')
    globalThis.location = new URL('https://app.example.com/checkout/1')
    check()
    check() // same URL: skipped
    assert.deepEqual(calls, ['url:https://app.example.com/checkout/1'])
    globalThis.location = new URL('https://app.example.com/private')
    check()
    url.urlBlocked = true
    globalThis.location = new URL('https://app.example.com/ok')
    check()
    assert.deepEqual(calls.slice(1), ['pause', 'resume'])
    ph.persistence.register({ $session_recording_url_trigger_activated_session: 's' })
    assert.equal(url.triggerStatus('s'), TRIGGER_ACTIVATED)
    assert.equal(url.triggerStatus('other'), TRIGGER_PENDING)
    globalThis.location = new URL('https://app.example.com/pricing?x=1')
})

test('URL trigger: get_current_url overrides the targeting URL', () => {
    const ph = fakeInstance()
    ph.config.get_current_url = () => 'https://app.example.com/checkout'
    const url = new tm.URLTriggerMatching(ph)
    url.onConfig({ urlTriggers: [{ url: '/checkout', matching: 'regex' }] })
    const calls = []
    url.checkUrlTriggerConditions(() => {}, () => {}, (t) => calls.push(t), 's')
    assert.deepEqual(calls, ['url'])
})

test('event trigger: only configured events activate, once per session', () => {
    const ph = fakeInstance()
    const ev = new tm.EventTriggerMatching(ph)
    ev.onConfig({ eventTriggers: ['purchase'] })
    const calls = []
    ev.checkEventTriggerConditions('other', (t, m) => calls.push(m), 's')
    ev.checkEventTriggerConditions('purchase', (t, m) => calls.push(m), 's')
    ph.persistence.register({ $session_recording_event_trigger_activated_session: 's' })
    ev.checkEventTriggerConditions('purchase', (t, m) => calls.push(m), 's')
    assert.deepEqual(calls, ['purchase'])
    assert.equal(ev.triggerStatus('s'), TRIGGER_ACTIVATED)
})

test('linked flag: boolean, variant and any-variant matching; activation reported once', () => {
    const cases = [
        ['flag', { flag: true }, true],
        ['flag', { flag: false }, false],
        ['flag', { flag: 'v' }, true],
        [{ flag: 'flag', variant: 'v' }, { flag: 'v' }, true],
        [{ flag: 'flag', variant: 'v' }, { flag: 'w' }, false],
        ['flag', {}, false],
    ]
    for (const [linkedFlag, variants, expected] of cases) {
        const ph = fakeInstance()
        const lf = new tm.LinkedFlagMatching(ph)
        const started = []
        lf.onConfig({ linkedFlag }, (f, v) => started.push([f, v]))
        ph._test.flagCallbacks.forEach((cb) => cb(Object.keys(variants), variants))
        ph._test.flagCallbacks.forEach((cb) => cb(Object.keys(variants), variants))
        assert.equal(lf.linkedFlagSeen, expected, JSON.stringify([linkedFlag, variants]))
        assert.equal(started.length, expected ? 1 : 0)
        assert.equal(lf.triggerStatus(), expected ? TRIGGER_ACTIVATED : TRIGGER_PENDING)
    }
})

test('and/or trigger combination ignores disabled legs', () => {
    const a = new tm.AndTriggerMatching([matcher(TRIGGER_DISABLED), matcher(TRIGGER_ACTIVATED)])
    assert.equal(a.triggerStatus('s'), TRIGGER_ACTIVATED)
    assert.equal(new tm.AndTriggerMatching([matcher(TRIGGER_PENDING), matcher(TRIGGER_ACTIVATED)]).triggerStatus('s'), TRIGGER_PENDING)
    assert.equal(new tm.AndTriggerMatching([matcher(TRIGGER_DISABLED)]).triggerStatus('s'), TRIGGER_DISABLED)
    assert.equal(new tm.OrTriggerMatching([matcher(TRIGGER_PENDING), matcher(TRIGGER_ACTIVATED)]).triggerStatus('s'), TRIGGER_ACTIVATED)
    assert.equal(new tm.OrTriggerMatching([matcher(TRIGGER_PENDING), matcher(TRIGGER_DISABLED)]).triggerStatus('s'), TRIGGER_PENDING)
})

// ---- strategies ------------------------------------------------------------------

function v1(ph, config) {
    const url = new tm.URLTriggerMatching(ph)
    const ev = new tm.EventTriggerMatching(ph)
    const lf = new tm.LinkedFlagMatching(ph)
    const started = []
    const s = new strategies.V1RecordingStrategy(ph, url, ev, lf, (r, p) => started.push(r), () => {}, () => {})
    s.onRemoteConfig(config)
    return { s, url, ev, lf, started }
}

test('V1 sampling: decision persisted per session, re-made when the rate changes', () => {
    const ph = fakeInstance()
    const { s, started } = v1(ph, { sampleRate: 0.5 })
    s.makeSamplingDecisions('session-a')
    assert.equal(ph._test.props.$session_is_sampled, 'session-a')
    assert.equal(ph._test.props.$replay_sample_rate, 0.5)
    assert.deepEqual(started, ['sampled'])
    s.makeSamplingDecisions('session-a') // stored decision is reused
    assert.deepEqual(started, ['sampled'])
    s.makeSamplingDecisions('session-e')
    assert.equal(ph._test.props.$session_is_sampled, '!session-e')
    const { s: s2 } = v1(ph, { sampleRate: 1 })
    s2.makeSamplingDecisions('session-e')
    assert.equal(ph._test.props.$session_is_sampled, 'session-e')
    const { s: s3 } = v1(ph, { sampleRate: null })
    s3.makeSamplingDecisions('session-e')
    assert.equal('$session_is_sampled' in ph._test.props, false)
    assert.equal('$replay_sample_rate' in ph._test.props, false)
})

test('V1 override keeps a null stored rate', () => {
    const ph = fakeInstance()
    ph.persistence.register({ $session_is_sampled: 'session-e', $replay_sample_rate: null })
    const { s } = v1(ph, { sampleRate: 0.5 })
    s.makeSamplingDecisions('session-e')
    assert.equal(ph._test.props.$session_is_sampled, 'session-e')
    assert.equal(ph._test.props.$replay_sample_rate, null)
})

test('V1 minimum duration comes from the persisted remote config', () => {
    const ph = fakeInstance()
    const { s } = v1(ph, {})
    assert.equal(s.getMinimumDuration('s'), null)
    ph.persistence.register({ $session_recording_remote_config: { minimumDurationMilliseconds: 1500 } })
    assert.equal(s.getMinimumDuration('s'), 1500)
})

test('V1 pending trigger conditions name the unmatched legs', () => {
    const ph = fakeInstance()
    const { s } = v1(ph, { urlTriggers: [{ url: '/x', matching: 'regex' }], eventTriggers: ['e'], triggerMatchType: 'all' })
    assert.equal(s.hasPendingTriggers('s'), true)
    assert.deepEqual(s.getPendingTriggerConditions('s'), ['URL condition not matched', 'event condition not matched'])
    assert.equal(ph._test.session.$sdk_debug_replay_remote_trigger_matching_config, 'all')
})

test('V2 trigger groups: per-group sampling, union status, minimum duration of activated groups', () => {
    const ph = fakeInstance()
    const url = new tm.URLTriggerMatching(ph)
    const events = []
    const s = new strategies.V2TriggerGroupStrategy(ph, url, () => {}, (tag, payload) => events.push([tag, payload]), () => {})
    s.onRemoteConfig({
        version: 2,
        triggerGroups: [
            { id: 'all', name: 'All', sampleRate: 1, minDurationMs: 2000, conditions: { matchType: 'all', events: [], urls: [] } },
            { id: 'buy', name: 'Buy', sampleRate: 0, minDurationMs: 500, conditions: { matchType: 'any', events: [{ name: 'purchase' }] } },
        ],
    })
    s.makeSamplingDecisions('session-a')
    assert.deepEqual(ph._test.props.$posthog_sr_group_sampling_all, { sessionId: 'session-a', sampleRate: 1, sampled: true })
    assert.deepEqual(ph._test.props.$posthog_sr_group_sampling_buy, { sessionId: 'session-a', sampleRate: 0, sampled: false })
    assert.deepEqual(events.map((e) => e[0]), ['triggerGroupSamplingDecisionMade', 'triggerGroupSamplingDecisionMade'])
    const ctx = { sessionId: 'session-a', isSampled: null, rrwebError: false, urlTriggerMatching: url,
        eventTriggerMatching: new tm.EventTriggerMatching(ph), linkedFlagMatching: new tm.LinkedFlagMatching(ph) }
    assert.equal(s.getStatus(ctx), 'sampled')
    assert.equal(s.getMinimumDuration('session-a'), 2000)
    assert.equal(s.hasPendingTriggers('session-a'), true)
    assert.deepEqual(s.getPendingTriggerConditions('session-a'), ['trigger group "Buy": event condition not matched'])
    // event activation with property filters
    const off = s.setupEventTriggerListeners((cb) => ph.on('eventCaptured', cb), 'session-a', () => {})
    ph._test.handlers.eventCaptured.forEach((cb) => cb({ event: 'purchase', properties: {} }))
    assert.equal(ph._test.props.$posthog_sr_group_event_trigger_buy, 'session-a')
    assert.equal(s.getMinimumDuration('session-a'), 500)
    off()
})

test('trigger property filters: operators and missing values', () => {
    const f = strategies.matchTriggerPropertyFilters
    assert.equal(f([{ key: 'plan', value: 'pro' }], { plan: 'pro' }), true)
    assert.equal(f([{ key: 'plan', value: ['a', 'pro'], operator: 'exact' }], { plan: 'pro' }), true)
    assert.equal(f([{ key: 'plan', value: 'pro', operator: 'is_not' }], {}), true)
    assert.equal(f([{ key: 'plan', value: 'pro' }], {}), false)
    assert.equal(f([{ key: 'n', value: 5, operator: 'gt' }], { n: 6 }), true)
    assert.equal(f([{ key: 'n', value: 'P', operator: 'icontains' }], { n: 'upper' }), true)
    assert.equal(f([{ key: 'email', value: '@x', operator: 'icontains', type: 'person' }], {}, { email: 'a@x.com' }), true)
    assert.equal(f([{ key: 'n', value: 'x', operator: 'unknown' }], { n: 'x' }), false)
})

// ---- utils (upstream sessionrecording-utils.test.ts) -----------------------------

test('estimateSize reports UTF-8 bytes, and -1 when it cannot stringify', () => {
    assert.equal(utils.estimateSize({ text: '€' }), 14)
    const orig = JSON.stringify
    JSON.stringify = () => { throw new RangeError('Invalid string length') }
    try {
        assert.equal(utils.estimateSize({ text: 'hello' }), utils.UNSTRINGIFIABLE_EVENT_SIZE)
    } finally {
        JSON.stringify = orig
    }
})

test('estimateSize equals upstream new Blob([JSON.stringify(x, circularReferenceReplacer())]).size', () => {
    const upstream = (x) => {
        try {
            const s = JSON.stringify(x, utils.circularReferenceReplacer())
            return s ? new Blob([s]).size : 0
        } catch {
            return utils.UNSTRINGIFIABLE_EVENT_SIZE
        }
    }
    let seed = 99
    const r = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296)
    const strs = ['', 'a', 'héllo', '✓ 日本', '😀', '\ud800', '\udc00x', '\u0000', 'q"\\\n']
    const leaf = () => [null, undefined, true, 0, -1.5, 1e21, NaN, strs[Math.floor(r() * strs.length)], () => 1,
        new Date(0), Symbol('s')][Math.floor(r() * 11)]
    const build = (depth, pool) => {
        const k = r()
        if (depth > 4 || k < 0.35) return leaf()
        if (k < 0.45 && pool.length) return pool[Math.floor(r() * pool.length)] // shared or circular reference
        const v = r() < 0.5 ? [] : {}
        pool.push(v)
        const n = Math.floor(r() * 5)
        for (let i = 0; i < n; i++) {
            const child = build(depth + 1, pool)
            if (Array.isArray(v)) v.push(child)
            else v['k' + i] = child
        }
        if (!Array.isArray(v) && r() < 0.05) {
            const s = strs[Math.floor(r() * strs.length)]
            v.toJSON = () => ({ viaToJSON: s })
        }
        return v
    }
    let circular = 0
    for (let i = 0; i < 5000; i++) {
        const v = build(0, [])
        try { JSON.stringify(v) } catch { circular++ }
        assert.equal(utils.estimateSize(v), upstream(v))
    }
    assert.ok(circular > 100, `fuzz covered ${circular} circular values`)
    const big = { b: 10n }
    assert.equal(utils.estimateSize(big), utils.UNSTRINGIFIABLE_EVENT_SIZE)
    assert.equal(utils.estimateSize(undefined), 0)
    assert.equal(utils.estimateSize(() => 1), 0)
})

test('estimateCompressedEventSize matches JSON length for compressed-event-like values', () => {
    for (const v of [null, 'hello', '', 42, -1, 3.14, true, false, {}, [], { a: 1, b: 'two' }, { a: { b: { c: 3 } } },
        { a: 1, b: undefined, c: 'three' }, [1, 'two', true, null], [1, undefined, 3],
        { type: 3, timestamp: 1700000000000, cv: '2024-10', data: { source: 0, texts: 'H4sI', adds: 'H4sIAA==', isAttachIframe: true } }]) {
        assert.equal(utils.estimateCompressedEventSize(v), JSON.stringify(v).length, JSON.stringify(v))
    }
})

test('circularReferenceReplacer', () => {
    const o = {}
    o.o = o
    assert.equal(JSON.stringify(o, utils.circularReferenceReplacer()), '{"o":"[Circular]"}')
    const root = {}
    root.queue = { plugins: [{ instance: root }] }
    assert.equal(JSON.stringify(root, utils.circularReferenceReplacer()), '{"queue":{"plugins":[{"instance":"[Circular]"}]}}')
    const shared = { id: 1 }
    assert.equal(JSON.stringify({ a: shared, b: [shared] }, utils.circularReferenceReplacer()), '{"a":{"id":1},"b":[{"id":1}]}')
})

test('truncateLargeConsoleLogs', () => {
    const big = 'x'.repeat(3000)
    const ev = (payload, plugin = utils.CONSOLE_LOG_PLUGIN_NAME, type = 6) => ({ type, data: { plugin, payload: { payload } } })
    assert.equal(utils.truncateLargeConsoleLogs(null), null)
    assert.deepEqual(utils.truncateLargeConsoleLogs(ev(big, utils.CONSOLE_LOG_PLUGIN_NAME, 2)), ev(big, utils.CONSOLE_LOG_PLUGIN_NAME, 2))
    assert.deepEqual(utils.truncateLargeConsoleLogs(ev([big], 'other')), ev([big], 'other'))
    assert.deepEqual(utils.truncateLargeConsoleLogs(ev(['a', big])), ev(['a', big.slice(0, 2000) + '...[truncated]']))
    assert.deepEqual(utils.truncateLargeConsoleLogs(ev(Array(100).fill('a'))), ev([...Array(10).fill('a'), '...[truncated]']))
    assert.deepEqual(utils.truncateLargeConsoleLogs(ev([undefined, null])), ev([undefined, null]))
})

test('splitBuffer: halves recursively at 6.3MB, keeps single events', () => {
    const buf = (n, each) => ({ size: n * each, data: new Array(n).fill(0), sizes: new Array(n).fill(each), sessionId: 's', windowId: 'w' })
    const small = buf(100, (5 * 1024 * 1024) / 100)
    assert.deepEqual(utils.splitBuffer(small), [small])
    assert.equal(utils.SEVEN_MEGABYTES, 1024 * 1024 * 7 * 0.9)
    const exact = buf(100, utils.SEVEN_MEGABYTES / 100)
    assert.equal(utils.splitBuffer(exact).length, 2)
    const big = buf(100, 1024 * 1024 + 2)
    const parts = utils.splitBuffer(big)
    assert.equal(parts.length, 20)
    assert.equal(parts.reduce((a, p) => a + p.size, 0), big.size)
    parts.forEach((p) => assert.ok(p.size < utils.SEVEN_MEGABYTES))
    const one = { size: 10 * 1024 * 1024, data: [0], sizes: [10 * 1024 * 1024], sessionId: 's', windowId: 'w' }
    assert.deepEqual(utils.splitBuffer(one), [one])
})

test('network options: client false wins, denied headers redacted, PostHog paths ignored, bodies scrubbed', () => {
    const config = { api_host: 'https://us.i.posthog.com', capture_performance: undefined, session_recording: { recordBody: false } }
    const o = utils.buildNetworkRequestOptions(config, { recordHeaders: true, recordBody: true, recordPerformance: true, payloadHostDenyList: ['.example.org'] })
    assert.equal(o.recordHeaders, true)
    assert.equal(o.recordBody, false)
    assert.equal(o.recordInitialRequests, true)
    assert.equal(o.payloadHostDenyList[0], '.example.org')
    assert.equal(o.maskRequestFn({ name: 'https://us.i.posthog.com/s/?x' }), undefined)
    const r = o.maskRequestFn({ name: 'https://api.example.com/x', requestHeaders: { Authorization: 'a', 'x-my-token': 't', ok: '1' }, requestBody: '{"password":"x"}' })
    assert.deepEqual(r.requestHeaders, { Authorization: 'redacted', 'x-my-token': 'redacted', ok: '1' })
    assert.equal(r.requestBody, '[SessionRecording] Request body redacted as might contain: password')
})

test('network options: a nullish mask result keeps initial metadata and drops its server timings', () => {
    const config = { api_host: 'https://us.i.posthog.com', session_recording: { maskCapturedNetworkRequestFn: () => null } }
    const o = utils.buildNetworkRequestOptions(config, { recordPerformance: true })
    const parent = o.maskRequestFn({ name: 'https://x.test/', entryType: 'navigation', startTime: 1, duration: 2, isInitial: true, serverTimings: 'secret' })
    assert.deepEqual(parent, { name: '', entryType: 'navigation', startTime: 1, duration: 2, endTime: undefined, timeOrigin: undefined, timestamp: undefined, isInitial: true })
    assert.equal(o.maskRequestFn({ name: 'db', entryType: 'serverTiming' }), undefined)
})

// ---- recorder: buffering, compression, holds -------------------------------------

function fakeRRWeb() {
    const rr = { emit: null, options: null, stops: 0 }
    const record = (opts) => {
        rr.options = opts
        rr.emit = opts.emit
        return () => { rr.stops++ }
    }
    record.addCustomEvent = (tag, payload) => rr.emit && rr.emit({ type: 5, data: { tag, payload }, timestamp: Date.now() })
    record.takeFullSnapshot = () => rr.emit && rr.emit({ type: 2, data: { node: { id: 1, type: 0, childNodes: [] }, initialOffset: { left: 0, top: 0 } }, timestamp: Date.now() })
    record.mirror = { getId: () => 1, getNode: () => null }
    record.isRecording = () => true
    globalThis.__PosthogExtensions__ = { rrweb: { record }, rrwebPlugins: {} }
    return rr
}

function startRecorder(remote = {}) {
    const rr = fakeRRWeb()
    const ph = fakeInstance()
    ph.persistence.register({ $session_recording_remote_config: { enabled: true, endpoint: '/s/', cache_timestamp: Date.now(), ...remote } })
    const rec = new LazyLoadedSessionRecording(ph, true)
    rec.start()
    return { rr, ph, rec }
}

const meta = () => ({ type: 4, data: { href: 'https://app.example.com/pricing', width: 1, height: 1 }, timestamp: Date.now() })
const fullSnapshot = () => ({ type: 2, data: { node: { id: 1, type: 0, childNodes: [{ id: 2, type: 3, textContent: 'hi' }] }, initialOffset: { left: 0, top: 0 } }, timestamp: Date.now() })
const click = () => ({ type: 3, data: { source: 2, type: 2, id: 2, x: 0, y: 0 }, timestamp: Date.now() })
const mutation = (text = 'x') => ({ type: 3, data: { source: 0, texts: [], attributes: [], removes: [], adds: [{ parentId: 1, nextId: null, node: { id: 3, type: 3, textContent: text } }] }, timestamp: Date.now() })
const latin1Gunzip = (s) => JSON.parse(zlib.gunzipSync(Buffer.from(s, 'latin1')).toString('utf8'))

test('recorder: rrweb options, start custom events and the $snapshot capture options', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
    const { rr, ph, rec } = startRecorder()
    assert.equal(rec.isStarted(), true)
    assert.equal(rr.options.blockClass, 'ph-no-capture')
    assert.equal(rr.options.maskAllInputs, true)
    assert.deepEqual(rr.options.maskInputOptions, { password: true })
    assert.equal(rr.options.recordAfter, 'DOMContentLoaded')
    assert.equal(rr.options.inlineStylesheetBudgetRules, 10000)
    assert.equal(rec.status(), 'active')
    assert.equal(ph._test.session.$session_recording_start_reason, 'recording_initialized')
    rr.emit(meta())
    rr.emit(click()) // interaction releases the fresh-start hold
    t.mock.timers.tick(2000)
    const snap = ph._test.captured.find((c) => c.event === '$snapshot')
    assert.ok(snap, 'a $snapshot was captured')
    assert.deepEqual(snap.options, { _url: 'https://us.i.posthog.com/s/', _noTruncate: true, _batchKey: 'recordings', skip_client_rate_limiting: true })
    const tags = snap.properties.$snapshot_data.filter((e) => e.type === 5).map((e) => e.data.tag)
    assert.deepEqual(tags.slice(0, 4), ['$remote_config_received', '$session_options', '$posthog_config', '$recording_started'])
    assert.equal(snap.properties.$session_id, 'session-a')
    assert.equal(snap.properties.$window_id, 'window-1')
    assert.equal(snap.properties.$lib, 'web')
    assert.equal(snap.properties.$snapshot_host, 'app.example.com')
    rec.stop()
    assert.equal(rr.stops, 1)
})

test('recorder: nothing ships before an interaction (fresh-start hold), unload releases it', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
    const { rr, ph, rec } = startRecorder({ })
    rr.emit(meta())
    rr.emit({ type: 3, data: { source: 0, texts: [], attributes: [], removes: [], adds: [] }, timestamp: Date.now() })
    t.mock.timers.tick(5000)
    assert.equal(ph._test.captured.length, 0)
    assert.equal(rec.sdkDebugProperties().$sdk_debug_replay_flush_hold_reason, 'no_interaction_since_recording_started')
    listeners.beforeunload.forEach((fn) => fn())
    assert.equal(ph._test.captured.filter((c) => c.event === '$snapshot').length, 1)
    rec.stop()
})

test('recorder: full snapshots and mutations are gzip-compressed per event (cv 2024-10)', async () => {
    const { rr, ph, rec } = startRecorder()
    rr.emit(meta())
    rr.emit(fullSnapshot())
    rr.emit(click())
    rr.emit(mutation('hello'))
    // native CompressionStream path is async
    for (let i = 0; i < 50 && rec.sdkDebugProperties().$sdk_debug_replay_internal_buffer_length < 8; i++) await new Promise((r) => setTimeout(r, 5))
    rec.flushBeforeIdentityReset()
    const data = ph._test.captured.find((c) => c.event === '$snapshot').properties.$snapshot_data
    const fs = data.find((e) => e.type === 2)
    assert.equal(fs.cv, '2024-10')
    assert.equal(typeof fs.data, 'string')
    assert.deepEqual(latin1Gunzip(fs.data).node.childNodes[0].textContent, 'hi')
    const m = data.find((e) => e.type === 3 && e.data.source === 0)
    assert.equal(m.cv, '2024-10')
    assert.equal(latin1Gunzip(m.data.adds)[0].node.textContent, 'hello')
    assert.deepEqual(latin1Gunzip(m.data.texts), [])
    const c = data.find((e) => e.type === 3 && e.data.source === 2)
    assert.equal(c.cv, undefined)
    // sizes: compressed events are estimated, plain ones measured
    const props = ph._test.captured.find((c) => c.event === '$snapshot').properties
    const expected = data.reduce((a, e) => a + (e.cv ? utils.estimateCompressedEventSize(e) : Buffer.byteLength(JSON.stringify(e))), 0)
    assert.equal(props.$snapshot_bytes, expected)
    rec.stop()
})

test('recorder: the buffer flushes when it would exceed 0.9MB', async () => {
    const { rr, ph, rec } = startRecorder({})
    ph.config.session_recording.compress_events = false
    rr.emit(meta())
    rr.emit(click())
    const big = 'y'.repeat(300 * 1024)
    for (let i = 0; i < 4; i++) rr.emit({ type: 6, data: { plugin: 'big', payload: big }, timestamp: Date.now() })
    const snaps = ph._test.captured.filter((c) => c.event === '$snapshot')
    assert.equal(snaps.length, 1)
    assert.ok(snaps[0].properties.$snapshot_bytes <= RECORDING_MAX_EVENT_SIZE)
    assert.equal(rec.sdkDebugProperties().$sdk_debug_replay_internal_buffer_length, 1)
    rec.stop()
})

test('recorder: sample rate 0 disables, minimum duration holds the buffer', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
    const a = startRecorder({ sampleRate: 0 })
    assert.equal(a.rec.status(), 'disabled')
    assert.equal(a.ph._test.props.$session_is_sampled, '!session-a')
    a.rec.stop()
    const b = startRecorder({ minimumDurationMilliseconds: 60000 })
    b.rr.emit(meta())
    b.rr.emit(click())
    t.mock.timers.tick(2000)
    assert.equal(b.ph._test.captured.length, 0)
    b.rec.stop()
})

test('recorder: an unload below the minimum duration parks the buffer for the next page', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
    const { rr, ph, rec } = startRecorder({ minimumDurationMilliseconds: 60000 })
    rr.emit(meta())
    rr.emit(click())
    listeners.pagehide.forEach((fn) => fn())
    const key = 'ph_replay_pending_buffer_' + JSON.stringify(['phc_test', 'phc_test'])
    const parked = JSON.parse(sessionStorage.getItem(key))
    assert.equal(parked.sessionId, 'session-a')
    assert.equal(parked.data.length, parked.sizes.length)
    rec.stop()
    sessionStorage.removeItem(key)
})
