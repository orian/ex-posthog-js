// Tracing headers unit tests (node --test), ported from upstream's
// src/__tests__/tracing-headers.test.ts and
// extensions/replay/rrweb-plugins/patch.test.ts, run against the raw sources.
import test, { describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'

globalThis.window = globalThis
globalThis.location = new URL('https://app.example.com/page')
globalThis.document = { addEventListener() {}, removeEventListener() {}, querySelectorAll() { return [] } }

// A minimal XMLHttpRequest whose methods the patches wrap; calls are recorded.
const xhrCalls = []
class FakeXHR {
    open(method, url) { xhrCalls.push(['open', method, String(url)]) }
    setRequestHeader(name, value) { xhrCalls.push(['setRequestHeader', name, value]) }
    send() { xhrCalls.push(['send']) }
}
globalThis.XMLHttpRequest = FakeXHR
const NATIVE = { open: FakeXHR.prototype.open, setRequestHeader: FakeXHR.prototype.setRequestHeader, send: FakeXHR.prototype.send }

const { patchFetch, patchXHR } = await import('../src/tracing-headers/patch-fns.js')
const { patch } = await import('../src/tracing-headers/patch.js')
// lazy.js registers the patch functions the extension uses (its lazy part).
await import('../src/tracing-headers/lazy.js')
const { TracingHeaders } = await import('../src/tracing-headers/tracing-headers.js')

const COOKIELESS_SENTINEL_VALUE = '$posthog_cookieless'
const TRACEPARENT_PATTERN = /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/
const APP_TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'

let sessionCalls = 0
const sessionManager = {
    checkAndGetSessionAndWindowId(readOnly) {
        assert.equal(readOnly, true)
        sessionCalls++
        return { sessionId: 'session-id', windowId: 'window-id' }
    },
}

/** A recording fetch stand-in. */
function mockFetch(impl) {
    const calls = []
    const fn = function (...args) {
        calls.push(args)
        return impl ? impl(...args) : Promise.resolve(new Response())
    }
    fn.calls = calls
    window.fetch = fn
    return fn
}
const downstreamHeaders = (fetchMock, call = 0) => {
    const [input, init] = fetchMock.calls[call]
    return input instanceof Request ? input.headers : new Headers(init && init.headers)
}
const sentTraceparents = () => xhrCalls.filter((c) => c[0] === 'setRequestHeader' && String(c[1]).toLowerCase() === 'traceparent').map((c) => String(c[2]))

let restores = []
const originalFetch = globalThis.fetch
afterEach(() => {
    restores.reverse().forEach((r) => r())
    restores = []
    window.fetch = originalFetch
    Object.assign(FakeXHR.prototype, NATIVE)
    xhrCalls.length = 0
    sessionCalls = 0
})
const track = (restore) => { restores.push(restore); return restore }

// The extension's private helpers have renamed names in source mode too (trailing underscore).
const newTracingHeaders = (config, extra = {}) => new TracingHeaders({ config, get_distinct_id: () => 'id', sessionManager, ...extra })

describe('config aliases', () => {
    const cases = [
        ['uses the public tracing_headers option', { tracing_headers: ['example.com'] }, ['example.com']],
        ['falls back to deprecated addTracingHeaders', { addTracingHeaders: ['camel.example'] }, ['camel.example']],
        ['falls back to deprecated __add_tracing_headers', { __add_tracing_headers: ['legacy.example'] }, ['legacy.example']],
        ['prefers tracing_headers over deprecated addTracingHeaders', { tracing_headers: ['public.example'], addTracingHeaders: ['camel.example'] }, ['public.example']],
        ['prefers addTracingHeaders over deprecated __add_tracing_headers', { addTracingHeaders: ['camel.example'], __add_tracing_headers: ['legacy.example'] }, ['camel.example']],
        ['prefers tracing_headers over deprecated __add_tracing_headers', { tracing_headers: ['public.example'], __add_tracing_headers: ['legacy.example'] }, ['public.example']],
        ['allows an empty tracing_headers list to override deprecated aliases', { tracing_headers: [], addTracingHeaders: ['camel.example'], __add_tracing_headers: ['legacy.example'] }, []],
    ]
    for (const [name, config, expected] of cases) {
        test(name, () => assert.deepEqual(newTracingHeaders(config).configuredHostnames_(), expected))
    }

    test('mutates the installed hostname list when tracing_headers changes', () => {
        const config = { tracing_headers: ['example.com'] }
        const th = newTracingHeaders(config)
        const hostnames = th.syncHostnamesForPatch_()
        assert.deepEqual(hostnames, ['example.com'])
        config.tracing_headers = []
        assert.equal(th.syncHostnamesForPatch_(), undefined)
        assert.deepEqual(hostnames, [])
    })
})

describe('fetch', () => {
    test('adds tracing headers without spreading init or mutating caller headers', async () => {
        const f = mockFetch()
        track(patchFetch(['example.com'], 'distinct-id', sessionManager))

        const callerHeaders = new Headers({ 'x-original': 'original-header-value' })
        const controller = new AbortController()
        const initPrototype = {}
        Object.defineProperty(initPrototype, 'method', { get: () => 'POST' })
        Object.defineProperty(initPrototype, 'body', { get: () => 'request-body' })
        Object.defineProperty(initPrototype, 'duplex', { get: () => 'half' })
        const init = Object.create(initPrototype)
        Object.defineProperty(init, 'headers', { configurable: true, value: callerHeaders })
        Object.defineProperty(init, 'credentials', { configurable: true, value: 'include' })
        Object.defineProperty(init, 'signal', { configurable: true, value: controller.signal })

        await window.fetch('https://example.com/path', init)

        assert.equal(f.calls.length, 1)
        const [input, downstreamInit] = f.calls[0]
        assert.equal(input, 'https://example.com/path')
        assert.notEqual(downstreamInit, init)
        assert.equal(downstreamInit.method, 'POST')
        assert.equal(downstreamInit.body, 'request-body')
        assert.equal(downstreamInit.credentials, 'include')
        assert.equal(downstreamInit.signal, controller.signal)
        assert.equal(downstreamInit.duplex, 'half')
        // Downstream wrappers that still spread init keep the effective RequestInit fields.
        const spreadInit = { ...downstreamInit }
        assert.equal(spreadInit.method, 'POST')
        assert.equal(spreadInit.body, 'request-body')
        assert.equal(spreadInit.credentials, 'include')
        assert.equal(spreadInit.signal, controller.signal)
        assert.equal(spreadInit.duplex, 'half')

        const headers = new Headers(downstreamInit.headers)
        assert.equal(headers.get('x-original'), 'original-header-value')
        assert.equal(headers.get('X-POSTHOG-SESSION-ID'), 'session-id')
        assert.equal(headers.get('X-POSTHOG-WINDOW-ID'), 'window-id')
        assert.equal(headers.get('X-POSTHOG-DISTINCT-ID'), 'distinct-id')
        assert.equal(callerHeaders.get('X-POSTHOG-SESSION-ID'), null)
        assert.equal(callerHeaders.get('X-POSTHOG-DISTINCT-ID'), null)
    })

    test('delegates unchanged when the hostname does not match', async () => {
        const f = mockFetch()
        track(patchFetch(['example.com'], 'distinct-id', sessionManager))
        const init = { method: 'POST', headers: { 'x-original': 'value' }, body: 'request-body' }
        await window.fetch('https://other.example/path', init)
        assert.deepEqual(f.calls[0], ['https://other.example/path', init])
        assert.equal(f.calls[0][1], init)
        assert.equal(sessionCalls, 0)
    })

    test('uses the latest configured hostnames from a mutated hostname list without re-patching', async () => {
        const f = mockFetch()
        const hostnames = ['example.com']
        track(patchFetch(hostnames, 'distinct-id', sessionManager))
        await window.fetch('https://example.com/path')
        assert.equal(downstreamHeaders(f).get('X-POSTHOG-DISTINCT-ID'), 'distinct-id')
        sessionCalls = 0
        hostnames.splice(0)
        await window.fetch('https://example.com/path')
        assert.deepEqual(f.calls[1], ['https://example.com/path'])
        assert.equal(sessionCalls, 0)
    })

    test('uses the latest distinct ID from a provider without re-patching', async () => {
        const f = mockFetch()
        let distinctId = 'first-distinct-id'
        track(patchFetch(['example.com'], () => distinctId, sessionManager))
        await window.fetch('https://example.com/path')
        assert.equal(downstreamHeaders(f, 0).get('X-POSTHOG-DISTINCT-ID'), 'first-distinct-id')
        distinctId = 'second-distinct-id'
        await window.fetch('https://example.com/path')
        assert.equal(downstreamHeaders(f, 1).get('X-POSTHOG-DISTINCT-ID'), 'second-distinct-id')
    })

    test('does not add the distinct id header in cookieless mode', async () => {
        const f = mockFetch()
        track(patchFetch(['example.com'], COOKIELESS_SENTINEL_VALUE, sessionManager))
        await window.fetch('https://example.com/path')
        assert.equal(downstreamHeaders(f).get('X-POSTHOG-SESSION-ID'), 'session-id')
        assert.equal(downstreamHeaders(f).has('X-POSTHOG-DISTINCT-ID'), false)
    })

    test('passes the cloned Request downstream when a Request input hostname does not match', async () => {
        let downstreamRequest
        const f = mockFetch(async (input, init) => {
            downstreamRequest = new Request(input, init)
            return {}
        })
        track(patchFetch(['example.com'], 'distinct-id', sessionManager))
        const request = new Request('https://other.example/path', { body: 'request-body', headers: { 'x-request': 'request-header' }, method: 'POST' })
        await window.fetch(request)
        const [input, init] = f.calls[0]
        assert.ok(input instanceof Request)
        assert.notEqual(input, request)
        assert.equal(init, undefined)
        assert.equal(downstreamRequest.url, 'https://other.example/path')
        assert.equal(downstreamRequest.method, 'POST')
        assert.equal(downstreamRequest.headers.get('x-request'), 'request-header')
        assert.equal(downstreamRequest.headers.get('X-POSTHOG-SESSION-ID'), null)
        assert.equal(await downstreamRequest.clone().text(), 'request-body')
        assert.equal(sessionCalls, 0)
    })

    test('preserves Request input semantics and init overrides', async () => {
        const f = mockFetch()
        track(patchFetch(['example.com'], 'distinct-id', sessionManager))
        const request = new Request('https://example.com/path', { body: 'request-body', headers: { 'x-request': 'request-header' }, method: 'POST' })
        await window.fetch(request, { body: 'override-body', headers: { 'x-init': 'init-header' }, method: 'PUT' })
        const [input, init] = f.calls[0]
        assert.ok(input instanceof Request)
        assert.equal(init, undefined)
        assert.notEqual(input, request)
        assert.equal(input.method, 'PUT')
        assert.equal(input.headers.get('x-request'), null)
        assert.equal(input.headers.get('x-init'), 'init-header')
        assert.equal(input.headers.get('X-POSTHOG-SESSION-ID'), 'session-id')
        assert.equal(input.headers.get('X-POSTHOG-WINDOW-ID'), 'window-id')
        assert.equal(input.headers.get('X-POSTHOG-DISTINCT-ID'), 'distinct-id')
        assert.equal(await input.clone().text(), 'override-body')
    })

    test('propagates synchronous downstream fetch errors without retrying', () => {
        const error = new Error('sync fetch failure')
        const f = mockFetch(() => { throw error })
        track(patchFetch(['example.com'], 'distinct-id', sessionManager))
        assert.throws(() => window.fetch('https://example.com/path'), error)
        assert.equal(f.calls.length, 1)
    })
})

describe('xhr', () => {
    const cases = [
        ['adds tracing headers to matching XHR requests', 'https://example.com/path', 'distinct-id',
            [['X-POSTHOG-SESSION-ID', 'session-id'], ['X-POSTHOG-WINDOW-ID', 'window-id'], ['X-POSTHOG-DISTINCT-ID', 'distinct-id']], []],
        ['does not add tracing headers to non-matching XHR requests', 'https://other.example/path', 'distinct-id',
            [], ['X-POSTHOG-SESSION-ID', 'X-POSTHOG-WINDOW-ID', 'X-POSTHOG-DISTINCT-ID']],
        ['does not add the distinct ID header to XHR requests when cookieless mode is active', 'https://example.com/path', COOKIELESS_SENTINEL_VALUE,
            [['X-POSTHOG-SESSION-ID', 'session-id'], ['X-POSTHOG-WINDOW-ID', 'window-id']], ['X-POSTHOG-DISTINCT-ID']],
    ]
    for (const [name, url, distinctId, expected, absent] of cases) {
        test(name, () => {
            track(patchXHR(['example.com'], distinctId, sessionManager))
            const xhr = new XMLHttpRequest()
            xhr.open('GET', url)
            assert.deepEqual(xhrCalls[0], ['open', 'GET', url]) // headers are set after open
            const set = xhrCalls.filter((c) => c[0] === 'setRequestHeader')
            for (const [h, v] of expected) assert.ok(set.some((c) => c[1] === h && c[2] === v), h)
            for (const h of absent) assert.ok(!set.some((c) => c[1].toLowerCase() === h.toLowerCase()), h)
        })
    }
})

describe('traceparent', () => {
    test('adds a fresh sampled traceparent per fetch to listed hostnames only', async () => {
        const f = mockFetch()
        track(patchFetch([], 'distinct-id', sessionManager, ['api.example.com']))
        await window.fetch('https://api.example.com/a')
        await window.fetch('https://api.example.com/b', { method: 'POST', body: 'x' })
        await window.fetch('https://other.example/c')
        const first = downstreamHeaders(f, 0).get('traceparent')
        const second = downstreamHeaders(f, 1).get('traceparent')
        assert.match(first, TRACEPARENT_PATTERN)
        assert.match(second, TRACEPARENT_PATTERN)
        assert.notEqual(first.split('-')[1], second.split('-')[1])
        assert.notEqual(first.split('-')[2], second.split('-')[2])
        assert.equal(f.calls[1][1].body, 'x')
        assert.deepEqual(f.calls[2], ['https://other.example/c'])
        // tracing_headers is empty, so the PostHog headers are not added alongside
        assert.equal(downstreamHeaders(f, 0).get('X-POSTHOG-SESSION-ID'), null)
    })

    const matches = [
        ['https://api.example.com', 'https://api.example.com/path', true],
        ['https://api.example.com/', 'https://api.example.com/path', true],
        ['https://api.example.com', 'http://api.example.com/path', false],
        ['https://api.example.com', 'https://api.example.com:8443/path', false],
        ['http://localhost:8000', 'http://localhost:8000/path', true],
        ['https://api.example.com:443', 'https://api.example.com/path', true],
        ['http://API.example.com:80', 'http://api.example.com/path', true],
        ['API.example.com', 'https://api.example.com:8443/path', true],
        ['example.com', 'https://api.example.com/path', false],
        ['api.example.com', 'https://api.example.com.evil.test/path', false],
    ]
    for (const [target, url, expected] of matches) {
        test(`matches ${target} against ${url}: ${expected}`, async () => {
            const f = mockFetch()
            track(patchFetch(undefined, 'distinct-id', sessionManager, [target]))
            await window.fetch(url)
            assert.equal(downstreamHeaders(f).has('traceparent'), expected)
        })
    }

    test('does not overwrite a traceparent set by the app', async () => {
        const f = mockFetch()
        track(patchFetch(['api.example.com'], 'distinct-id', sessionManager, ['api.example.com']))
        await window.fetch('https://api.example.com/a', { headers: { TraceParent: APP_TRACEPARENT } })
        await window.fetch(new Request('https://api.example.com/b', { headers: { traceparent: APP_TRACEPARENT } }))
        assert.equal(downstreamHeaders(f, 0).get('traceparent'), APP_TRACEPARENT)
        assert.equal(downstreamHeaders(f, 0).get('X-POSTHOG-SESSION-ID'), 'session-id')
        assert.equal(downstreamHeaders(f, 1).get('traceparent'), APP_TRACEPARENT)
    })

    test('adds traceparent to Request inputs', async () => {
        const f = mockFetch()
        track(patchFetch(undefined, 'distinct-id', sessionManager, ['api.example.com']))
        await window.fetch(new Request('https://api.example.com/a'))
        assert.match(downstreamHeaders(f).get('traceparent'), TRACEPARENT_PATTERN)
    })

    test('reads the live target list without re-patching', async () => {
        const f = mockFetch()
        const targets = []
        track(patchFetch(undefined, 'distinct-id', sessionManager, targets))
        await window.fetch('https://api.example.com/a')
        targets.push('api.example.com')
        await window.fetch('https://api.example.com/b')
        assert.deepEqual(f.calls[0], ['https://api.example.com/a'])
        assert.match(downstreamHeaders(f, 1).get('traceparent'), TRACEPARENT_PATTERN)
    })

    describe('xhr', () => {
        const setUpXHR = (targets) => track(patchXHR(undefined, 'distinct-id', sessionManager, targets))

        test('sets traceparent on send for listed hosts', () => {
            setUpXHR(['api.example.com'])
            const xhr = new XMLHttpRequest()
            xhr.open('GET', 'https://api.example.com/path')
            assert.deepEqual(sentTraceparents(), [])
            xhr.send()
            const sent = sentTraceparents()
            assert.equal(sent.length, 1)
            assert.match(sent[0], TRACEPARENT_PATTERN)
        })

        test('does not set traceparent for unlisted hosts', () => {
            setUpXHR(['api.example.com'])
            const xhr = new XMLHttpRequest()
            xhr.open('GET', 'https://other.example/path')
            xhr.send()
            assert.deepEqual(sentTraceparents(), [])
        })

        test('does not add a second traceparent when the app set one', () => {
            setUpXHR(['api.example.com'])
            const xhr = new XMLHttpRequest()
            xhr.open('GET', 'https://api.example.com/path')
            xhr.setRequestHeader('Traceparent', APP_TRACEPARENT)
            xhr.send()
            assert.deepEqual(sentTraceparents(), [APP_TRACEPARENT])
        })

        test('treats a String object header name as traceparent', () => {
            setUpXHR(['api.example.com'])
            const xhr = new XMLHttpRequest()
            xhr.open('GET', 'https://api.example.com/path')
            xhr.setRequestHeader(new String('traceparent'), APP_TRACEPARENT)
            xhr.send()
            assert.deepEqual(sentTraceparents(), [APP_TRACEPARENT])
        })

        test('rechecks the live target list at send', () => {
            const targets = ['api.example.com', 'other.example']
            setUpXHR(targets)
            const xhr = new XMLHttpRequest()
            xhr.open('GET', 'https://api.example.com/path')
            targets.splice(0, 1)
            xhr.send()
            assert.deepEqual(sentTraceparents(), [])
        })

        test('sets traceparent when the host is added to the target list between open and send', () => {
            const targets = ['other.example']
            setUpXHR(targets)
            const xhr = new XMLHttpRequest()
            xhr.open('GET', 'https://api.example.com/path')
            targets.push('api.example.com')
            xhr.send()
            assert.equal(sentTraceparents().length, 1)
        })

        describe('with OpenTelemetry XHR instrumentation', () => {
            const otelKey = Symbol.for('opentelemetry.js.api.1')
            const otelTraceparent = '00-11111111111111111111111111111111-2222222222222222-01'
            const otelSend = function () { this.setRequestHeader('traceparent', otelTraceparent) }
            Object.defineProperty(otelSend, '__wrapped', { value: true })
            const withOtelBelow = (wrapper, run) => {
                window[otelKey] = { version: '1.9.0', propagation: {} }
                FakeXHR.prototype.send = wrapper
                try {
                    const restore = patchXHR(undefined, 'distinct-id', sessionManager, [location.hostname, 'api.example.com'])
                    try { run() } finally { restore() }
                } finally {
                    delete window[otelKey]
                }
            }

            test('leaves same-origin requests to it when it wrapped send before PostHog', () => {
                withOtelBelow(otelSend, () => {
                    const xhr = new XMLHttpRequest()
                    xhr.open('GET', `${location.origin}/path`)
                    xhr.send()
                    assert.deepEqual(sentTraceparents(), [otelTraceparent])
                })
            })

            test('still sets traceparent on cross-origin targets it skips by default', () => {
                const skipping = function () {}
                Object.defineProperty(skipping, '__wrapped', { value: true })
                withOtelBelow(skipping, () => {
                    const xhr = new XMLHttpRequest()
                    xhr.open('GET', 'https://api.example.com/path')
                    xhr.send()
                    const sent = sentTraceparents()
                    assert.equal(sent.length, 1)
                    assert.match(sent[0], TRACEPARENT_PATTERN)
                })
            })

            test('does not add a second value when it wrapped send after PostHog', () => {
                setUpXHR(['api.example.com'])
                const posthogSend = FakeXHR.prototype.send
                FakeXHR.prototype.send = function () {
                    this.setRequestHeader('traceparent', otelTraceparent)
                    return posthogSend.call(this)
                }
                const xhr = new XMLHttpRequest()
                xhr.open('GET', 'https://api.example.com/path')
                xhr.send()
                assert.deepEqual(sentTraceparents(), [otelTraceparent])
            })
        })

        test('restores send and setRequestHeader', () => {
            const restore = patchXHR(undefined, 'distinct-id', sessionManager, ['api.example.com'])
            assert.notEqual(FakeXHR.prototype.send, NATIVE.send)
            assert.notEqual(FakeXHR.prototype.setRequestHeader, NATIVE.setRequestHeader)
            restore()
            assert.equal(FakeXHR.prototype.send, NATIVE.send)
            assert.equal(FakeXHR.prototype.setRequestHeader, NATIVE.setRequestHeader)
            assert.equal(FakeXHR.prototype.open, NATIVE.open)
        })

        test('does not patch send when no traceparent targets are passed (older core)', () => {
            track(patchXHR(['example.com'], 'distinct-id', sessionManager))
            assert.equal(FakeXHR.prototype.send, NATIVE.send)
        })
    })
})

describe('trace_propagation_targets config', () => {
    test('enables patching with only trace_propagation_targets and keeps live arrays', () => {
        const config = { trace_propagation_targets: ['api.example.com', 42, ''] }
        const th = newTracingHeaders(config)
        assert.equal(th.syncHostnamesForPatch_(), undefined)
        const traceparentTargets = th.syncTraceparentTargetsForPatch_()
        assert.deepEqual(traceparentTargets, ['api.example.com'])
        config.trace_propagation_targets = undefined
        assert.equal(th.syncTraceparentTargetsForPatch_(), undefined)
        assert.deepEqual(traceparentTargets, [])
    })

    test('reinstalls the patches when leaving legacy __add_tracing_headers: true', async () => {
        const f = mockFetch()
        const config = { __add_tracing_headers: true, trace_propagation_targets: ['api.example.com'] }
        const th = newTracingHeaders(config)
        th.startIfEnabledOrStop()
        const firstWrapper = window.fetch
        assert.notEqual(firstWrapper, f)
        await window.fetch('https://any.example/a')
        assert.equal(downstreamHeaders(f, 0).get('X-POSTHOG-DISTINCT-ID'), 'id') // `true`: every host

        config.tracing_headers = []
        th.startIfEnabledOrStop()
        assert.notEqual(window.fetch, firstWrapper) // re-installed with the (empty) array
        await window.fetch('https://any.example/b')
        assert.equal(downstreamHeaders(f, 1).has('X-POSTHOG-DISTINCT-ID'), false)

        // A later array change reaches the installed patches in place, without re-patching.
        const secondWrapper = window.fetch
        config.tracing_headers = ['example.com']
        th.startIfEnabledOrStop()
        assert.equal(window.fetch, secondWrapper)
        await window.fetch('https://example.com/c')
        assert.equal(downstreamHeaders(f, 2).get('X-POSTHOG-DISTINCT-ID'), 'id')

        config.tracing_headers = undefined
        config.__add_tracing_headers = undefined
        config.trace_propagation_targets = []
        th.startIfEnabledOrStop()
        assert.equal(window.fetch, f) // stopped: patches removed
        assert.equal(FakeXHR.prototype.open, NATIVE.open)
    })

    test('keeps the hostname array instance when tracing_headers is removed', () => {
        const config = { tracing_headers: ['example.com'] }
        const th = newTracingHeaders(config)
        const hostnames = th.syncHostnamesForPatch_()
        config.tracing_headers = undefined
        assert.equal(th.syncHostnamesForPatch_(), undefined)
        config.tracing_headers = ['example.com']
        assert.equal(th.syncHostnamesForPatch_(), hostnames)
    })

    test('refuses to patch while disable_external_dependency_loading is set, like the script load', () => {
        const f = mockFetch()
        const config = { tracing_headers: ['example.com'], disable_external_dependency_loading: true }
        const th = newTracingHeaders(config)
        th.startIfEnabledOrStop()
        assert.equal(window.fetch, f)
        config.disable_external_dependency_loading = false
        th.startIfEnabledOrStop()
        assert.notEqual(window.fetch, f)
        config.disable_external_dependency_loading = true
        th.startIfEnabledOrStop() // already "loaded": stays patched
        assert.notEqual(window.fetch, f)
        config.tracing_headers = []
        th.startIfEnabledOrStop()
        assert.equal(window.fetch, f)
    })
})

// ---- patch (upstream extensions/replay/rrweb-plugins/patch.test.ts) -------------------
describe('patch', () => {
    const wrapper = (tag, log) => (next) => function (...args) { log.push(tag); return next.apply(this, args) }

    test('returns a no-op when the property is missing', () => {
        const restore = patch({}, 'missing', () => () => {})
        assert.equal(typeof restore, 'function')
        restore()
    })

    test('marks a function as wrapped', () => {
        const source = { fn() {} }
        patch(source, 'fn', (next) => function () { return next() })
        assert.equal(source.fn.__posthog_wrapped__, true)
        assert.ok(source.fn.__posthog_layer__)
    })

    test('restores in LIFO order', () => {
        const log = []
        const original = function () { log.push('orig') }
        const source = { fn: original }
        const r1 = patch(source, 'fn', wrapper('a', log))
        const r2 = patch(source, 'fn', wrapper('b', log))
        source.fn()
        assert.deepEqual(log, ['b', 'a', 'orig'])
        r2()
        r1()
        assert.equal(source.fn, original)
    })

    test('tears down a buried wrapper without clobbering newer wrappers', () => {
        const log = []
        const original = function () { log.push('orig') }
        const source = { fn: original }
        const r1 = patch(source, 'fn', wrapper('a', log))
        patch(source, 'fn', wrapper('b', log))
        const top = source.fn
        r1()
        assert.equal(source.fn, top)
        source.fn()
        assert.deepEqual(log, ['b', 'orig'])
    })

    test('splices itself out from under an rrweb wrapper', () => {
        const log = []
        const original = function () { log.push('orig') }
        const source = { fn: original }
        const r1 = patch(source, 'fn', wrapper('posthog', log))
        // An rrweb-style layer on top.
        const rrwebLayer = { next: source.fn }
        const rrwebWrapped = function (...args) { log.push('rrweb'); return rrwebLayer.next.apply(this, args) }
        Object.defineProperty(rrwebWrapped, '__rrweb_layer__', { value: rrwebLayer })
        source.fn = rrwebWrapped
        r1()
        source.fn()
        assert.deepEqual(log, ['rrweb', 'orig'])
    })

    test('does not grow the wrapper chain when independent layers are re-patched out of order', () => {
        const original = function () { return 1 }
        const source = { fn: original }
        let depth = 0
        const counting = (next) => function () { depth++; return next() }
        let ra = patch(source, 'fn', counting)
        let rb = patch(source, 'fn', counting)
        for (let i = 0; i < 50; i++) {
            ra()
            ra = patch(source, 'fn', counting)
            rb()
            rb = patch(source, 'fn', counting)
        }
        depth = 0
        source.fn()
        assert.equal(depth, 2)
    })
})
