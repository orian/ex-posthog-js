// Unit tests for the logs and metrics modules (src/otlp, src/logs, src/metrics).
// Expected values follow upstream posthog-js 1.450.0: core/src/utils/otlp-any-value.spec.ts,
// otlp-resource.spec.ts, core/src/logs/logs-utils.spec.ts and index.spec.ts,
// core/src/metrics/index.spec.ts, browser-common/tests/console-logs.spec.ts and logs-config.spec.ts.
// Run: node --test test/logs-metrics.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import {
    toOtlpAnyValue, toOtlpKeyValueList, buildOtlpResourceAttributes, toOtlpResourceKeyValueList,
    osResourceAttributes, backoffDelayMs, sanitizeString, patch,
} from '../src/otlp/otlp.js'
import { buildOtlpLogRecord, buildOtlpLogsPayload, resolveLogsConfig, LogsPipeline } from '../src/logs/logs-core.js'
import { stringifyArgsSafely, initializeLogs, replayConsoleBuffer } from '../src/logs/console-logs.js'
import {
    MetricsAggregator, resolveMetricsConfig, seriesKey, bucketIndexFor, DEFAULT_HISTOGRAM_BOUNDS,
} from '../src/metrics/metrics-core.js'

const silent = { info() {}, warn() {}, error() {}, critical() {}, uninitializedWarning() {}, createLogger() { return silent } }
const recordingLogger = () => {
    const calls = { info: [], warn: [], error: [] }
    return { calls, info: (...a) => calls.info.push(a), warn: (...a) => calls.warn.push(a), error: (...a) => calls.error.push(a),
        critical() {}, uninitializedWarning() {}, createLogger() { return this } }
}
const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0))

// ---- otlp-any-value ------------------------------------------------------------------------

test('any value: primitives', () => {
    assert.deepEqual(toOtlpAnyValue('hello'), { stringValue: 'hello' })
    assert.deepEqual(toOtlpAnyValue(42), { intValue: '42' })
    assert.deepEqual(toOtlpAnyValue(0), { intValue: '0' })
    assert.deepEqual(toOtlpAnyValue(-7), { intValue: '-7' })
    assert.deepEqual(toOtlpAnyValue(3.14), { doubleValue: 3.14 })
    assert.deepEqual(toOtlpAnyValue(true), { boolValue: true })
    assert.deepEqual(toOtlpAnyValue(false), { boolValue: false })
    assert.deepEqual(toOtlpAnyValue(NaN), { stringValue: 'NaN' })
    assert.deepEqual(toOtlpAnyValue(Infinity), { stringValue: 'Infinity' })
    assert.deepEqual(toOtlpAnyValue(-Infinity), { stringValue: '-Infinity' })
})

test('any value: integers outside int64 become strings, large in-range ones stay exact', () => {
    assert.deepEqual(toOtlpAnyValue(2 ** 63), { stringValue: '9223372036854775808' })
    assert.deepEqual(toOtlpAnyValue(-(2 ** 64)), { stringValue: '-18446744073709551616' })
    assert.deepEqual(toOtlpAnyValue(1e21), { stringValue: '1000000000000000000000' })
    assert.deepEqual(toOtlpAnyValue(-(2 ** 63)), { intValue: '-9223372036854775808' })
    assert.deepEqual(toOtlpAnyValue(Number.MAX_SAFE_INTEGER), { intValue: '9007199254740991' })
    assert.deepEqual(toOtlpAnyValue(9223372036854774784), { intValue: '9223372036854774784' })
    assert.deepEqual(toOtlpAnyValue(2 ** 62), { intValue: '4611686018427387904' })
})

test('any value: bigints', () => {
    assert.deepEqual(toOtlpAnyValue(9007199254740993n), { intValue: '9007199254740993' })
    assert.deepEqual(toOtlpAnyValue(18446744073709551616n), { stringValue: '18446744073709551616' })
})

test('any value: arrays, objects, nesting, nullish entries', () => {
    assert.deepEqual(toOtlpAnyValue(['a', 'b']), { arrayValue: { values: [{ stringValue: 'a' }, { stringValue: 'b' }] } })
    assert.deepEqual(toOtlpAnyValue([1, 'x', true]), { arrayValue: { values: [{ intValue: '1' }, { stringValue: 'x' }, { boolValue: true }] } })
    assert.deepEqual(toOtlpAnyValue({ a: 1, b: 'two' }), { kvlistValue: { values: [
        { key: 'a', value: { intValue: '1' } }, { key: 'b', value: { stringValue: 'two' } }] } })
    assert.deepEqual(toOtlpAnyValue({ outer: { inner: 1 } }), { kvlistValue: { values: [
        { key: 'outer', value: { kvlistValue: { values: [{ key: 'inner', value: { intValue: '1' } }] } } }] } })
    assert.deepEqual(toOtlpAnyValue({ kept: 1, gone: null, alsoGone: undefined }), { kvlistValue: { values: [{ key: 'kept', value: { intValue: '1' } }] } })
    // eslint-disable-next-line no-sparse-arrays
    assert.deepEqual(toOtlpAnyValue([1, , 3]), { arrayValue: { values: [{ intValue: '1' }, { intValue: '3' }] } })
    assert.deepEqual(toOtlpAnyValue([1, null, undefined, 3]), { arrayValue: { values: [{ intValue: '1' }, { intValue: '3' }] } })
    assert.deepEqual(toOtlpAnyValue({}), { kvlistValue: { values: [] } })
    assert.deepEqual(toOtlpAnyValue([]), { arrayValue: { values: [] } })
})

test('any value: dates, functions, symbols, toJSON', () => {
    assert.deepEqual(toOtlpAnyValue(new Date('2026-08-20T10:00:00.000Z')), { stringValue: '2026-08-20T10:00:00.000Z' })
    assert.deepEqual(toOtlpAnyValue({ handler: () => 1, retries: 2 }), { kvlistValue: { values: [
        { key: 'handler', value: { stringValue: '[Function]' } }, { key: 'retries', value: { intValue: '2' } }] } })
    assert.deepEqual(toOtlpAnyValue({ sym: Symbol('x') }), { kvlistValue: { values: [{ key: 'sym', value: { stringValue: 'Symbol(x)' } }] } })
    assert.deepEqual(toOtlpAnyValue({ toJSON: () => ({ amount: 5 }) }), { kvlistValue: { values: [{ key: 'amount', value: { intValue: '5' } }] } })
    assert.deepEqual(toOtlpAnyValue({ kept: 1, toJSON: () => { throw new Error('nope') } }), { kvlistValue: { values: [
        { key: 'kept', value: { intValue: '1' } }, { key: 'toJSON', value: { stringValue: '[Function]' } }] } })
    const broken = new Date('2026-08-20T10:00:00.000Z')
    broken.toISOString = () => ({})
    assert.equal(typeof toOtlpAnyValue(broken).stringValue, 'string')
})

test('any value: cycles, siblings, depth and node budgets', () => {
    const cyclic = { name: 'root' }
    cyclic.self = cyclic
    assert.deepEqual(toOtlpAnyValue(cyclic), { kvlistValue: { values: [
        { key: 'name', value: { stringValue: 'root' } }, { key: 'self', value: { stringValue: '[Circular]' } }] } })
    const viaToJSON = {}
    viaToJSON.toJSON = () => ({ inner: viaToJSON })
    assert.deepEqual(toOtlpAnyValue(viaToJSON), { kvlistValue: { values: [{ key: 'inner', value: { stringValue: '[Circular]' } }] } })
    const shared = { id: 1 }
    const one = { kvlistValue: { values: [{ key: 'id', value: { intValue: '1' } }] } }
    assert.deepEqual(toOtlpAnyValue({ a: shared, b: shared }), { kvlistValue: { values: [{ key: 'a', value: one }, { key: 'b', value: one }] } })

    let deep = { end: true }
    for (let i = 0; i < 25; i++) deep = { next: deep }
    const encoded = JSON.stringify(toOtlpAnyValue(deep))
    assert.ok(encoded.includes('[Truncated]'))
    assert.equal(encoded.split('"next"').length - 1, 20)
    let veryDeep = { end: true }
    for (let i = 0; i < 25000; i++) veryDeep = { next: veryDeep }
    assert.doesNotThrow(() => toOtlpAnyValue(veryDeep))

    const row = {}
    for (let i = 0; i < 20; i++) row[`k${i}`] = i
    const values = toOtlpAnyValue(Array.from({ length: 1000 }, () => ({ ...row }))).arrayValue.values
    assert.deepEqual(values[values.length - 1], { stringValue: '[Truncated]' })
    assert.equal(values.filter((v) => v.stringValue === '[Truncated]').length, 1)

    let graph = { leaf: true }
    for (let i = 0; i < 20; i++) graph = { a: graph, b: graph }
    const g = JSON.stringify(toOtlpAnyValue(graph))
    assert.ok(g.includes('[Truncated]') && g.length < 1000000)

    const wide = {}
    for (let i = 0; i < 5000; i++) wide[`k${i}`] = i
    const kv = toOtlpAnyValue(wide).kvlistValue.values
    assert.equal(kv.length, 1000)
    assert.ok(kv.every((v) => v.key.startsWith('k')))
})

test('any value: throwing getters, inherited keys, surrogates, empty keys', () => {
    const attrs = { ok: 1, get bad() { throw new Error('getter blew up') } }
    assert.deepEqual(toOtlpKeyValueList(attrs), [{ key: 'ok', value: { intValue: '1' } }, { key: 'bad', value: { stringValue: '[Unserializable]' } }])
    const inherited = Object.create({ fromPrototype: 'leaked' })
    inherited.own = 1
    assert.deepEqual(toOtlpAnyValue(inherited), { kvlistValue: { values: [{ key: 'own', value: { intValue: '1' } }] } })
    assert.deepEqual(toOtlpAnyValue('ok\ud83d'), { stringValue: 'ok�' })
    assert.deepEqual(toOtlpKeyValueList({ 'key\ud83d': 1 }), [{ key: 'key�', value: { intValue: '1' } }])
    assert.equal(sanitizeString('a\udc00b😀'), 'a�b😀')
    assert.deepEqual(toOtlpKeyValueList({ '': 'nameless', kept: 'yes' }), [{ key: 'kept', value: { stringValue: 'yes' } }])
    assert.deepEqual(toOtlpKeyValueList({ outer: { '': 'nameless', kept: 'yes' } }), [
        { key: 'outer', value: { kvlistValue: { values: [{ key: 'kept', value: { stringValue: 'yes' } }] } } }])
    assert.deepEqual(toOtlpKeyValueList({ kept: 'yes', nullish: null, missing: undefined }), [{ key: 'kept', value: { stringValue: 'yes' } }])
})

// ---- otlp-resource -----------------------------------------------------------------------------

test('resource attributes: identity keys layered over user attributes, defaults', () => {
    const conflicting = {
        serviceName: 'checkout', serviceVersion: '2.1.0', environment: 'production',
        resourceAttributes: { 'service.name': 'spoofed', 'telemetry.sdk.name': 'spoofed', 'host.name': 'web-01' },
    }
    assert.deepEqual(buildOtlpResourceAttributes(conflicting, 'posthog-node', '1.0.0'), {
        'service.name': 'checkout', 'service.version': '2.1.0', 'deployment.environment': 'production',
        'telemetry.sdk.name': 'posthog-node', 'telemetry.sdk.version': '1.0.0', 'host.name': 'web-01',
    })
    assert.deepEqual(buildOtlpResourceAttributes({}, 'posthog-node', '1.0.0'),
        { 'service.name': 'unknown_service', 'telemetry.sdk.name': 'posthog-node', 'telemetry.sdk.version': '1.0.0' })
})

test('resource attributes: SDK keys are encoded on their own budget, after the user keys', () => {
    const identity = { serviceName: 'checkout', serviceVersion: '2.1.0', environment: 'production' }
    for (const key of ['payload', '0']) {
        const attrs = buildOtlpResourceAttributes({ ...identity, resourceAttributes: { [key]: Array.from({ length: 10 }, () => Array(1000).fill(1)) } }, 'posthog-node', '1.0.0')
        const encoded = toOtlpResourceKeyValueList(attrs)
        assert.deepEqual(encoded.map((a) => a.key), [key, 'service.name', 'deployment.environment', 'service.version', 'telemetry.sdk.name', 'telemetry.sdk.version'])
        assert.deepEqual(encoded[1], { key: 'service.name', value: { stringValue: 'checkout' } })
    }
})

test('osResourceAttributes', () => {
    assert.deepEqual(osResourceAttributes('Mac OS X', '14.1'), { 'os.name': 'macOS', 'os.version': '14.1' })
    assert.deepEqual(osResourceAttributes('win32', undefined), { 'os.name': 'Windows' })
    assert.deepEqual(osResourceAttributes('Plan 9', ''), { 'os.name': 'Plan 9' })
    assert.deepEqual(osResourceAttributes('', ''), {})
})

test('backoff: doubles per failure, capped, jitter applied to the SDK delay', () => {
    assert.equal(backoffDelayMs(3000, 0, 1, 30000), 3000)
    assert.equal(backoffDelayMs(3000, 1, 1, 30000), 3000)
    assert.equal(backoffDelayMs(3000, 2, 1, 30000), 6000)
    assert.equal(backoffDelayMs(3000, 5, 1, 30000), 30000)
    assert.equal(backoffDelayMs(60000, 3, 1, 30000), 60000) // a longer interval is kept
    assert.equal(backoffDelayMs(1000, 2, 1.25, 30000), 2500)
})

// ---- logs: config, records, payload ------------------------------------------------------------

test('resolveLogsConfig: defaults, resource attribute precedence, console capture', () => {
    const c = resolveLogsConfig(undefined)
    assert.equal(c.flushIntervalMs, 3000)
    assert.equal(c.maxBufferSize, 100)
    assert.equal(c.maxLogsPerInterval, 1000)
    assert.equal(c.maxQueueSize, 1000)
    assert.equal(c.maxBatchRecordsPerPost, 100)
    assert.equal(c.rateCapWindowMs, 3000)
    assert.equal(c.serviceName, undefined)
    const r = resolveLogsConfig({ serviceName: 'a', environment: 'e', resourceAttributes: { 'service.name': 'b' }, flushIntervalMs: 500 })
    assert.equal(r.serviceName, 'b')
    assert.equal(r.environment, 'e')
    assert.equal(r.rateCapWindowMs, 500)
    const consoleCfg = resolveLogsConfig({ maxLogsPerInterval: 5 }, { serviceNameDefault: 'posthog-browser-logs', consoleCapture: true })
    assert.equal(consoleCfg.maxLogsPerInterval, undefined)
    assert.equal(consoleCfg.maxQueueSize, 2048)
    assert.equal(consoleCfg.serviceName, 'posthog-browser-logs')
})

test('buildOtlpLogRecord: minimal record, severities and fallback', () => {
    const record = buildOtlpLogRecord({ body: 'hello' }, {}, undefined, 1700000000000)
    assert.deepEqual(record, {
        timeUnixNano: '1700000000000000000', observedTimeUnixNano: '1700000000000000000',
        severityNumber: 9, severityText: 'INFO', body: { stringValue: 'hello' }, attributes: [],
    })
    const expected = { trace: ['TRACE', 1], debug: ['DEBUG', 5], info: ['INFO', 9], warn: ['WARN', 13], error: ['ERROR', 17], fatal: ['FATAL', 21], bogus: ['INFO', 9] }
    for (const [level, [text, number]] of Object.entries(expected)) {
        const r = buildOtlpLogRecord({ body: 'x', level }, {})
        assert.equal(r.severityText, text)
        assert.equal(r.severityNumber, number)
    }
})

test('buildOtlpLogRecord: SDK context attributes, user attributes win, trace context', () => {
    const record = buildOtlpLogRecord({ body: 'x', attributes: { 'url.full': 'override', extra: 1 } }, {
        distinctId: 'd', sessionId: 's', windowId: 'w', sessionStartTimestamp: 0, lastActivityTimestamp: 5,
        currentUrl: 'https://a/b', activeFeatureFlags: ['f1'],
    })
    assert.deepEqual(record.attributes, [
        { key: 'posthogDistinctId', value: { stringValue: 'd' } },
        { key: 'sessionId', value: { stringValue: 's' } },
        { key: 'window.id', value: { stringValue: 'w' } },
        { key: 'sessionStartTimestamp', value: { stringValue: '0' } },
        { key: 'lastActivityTimestamp', value: { stringValue: '5' } },
        { key: 'url.full', value: { stringValue: 'override' } },
        { key: 'feature_flags', value: { arrayValue: { values: [{ stringValue: 'f1' }] } } },
        { key: 'extra', value: { intValue: '1' } },
    ])
    assert.equal(buildOtlpLogRecord({ body: 'x' }, { activeFeatureFlags: [] }).attributes.length, 0)
    const traced = buildOtlpLogRecord({ body: 'x', trace_id: 't', span_id: 's', trace_flags: 0 }, {})
    assert.equal(traced.traceId, 't')
    assert.equal(traced.spanId, 's')
    assert.equal(traced.flags, 0)
    const untraced = buildOtlpLogRecord({ body: 'x' }, {})
    assert.ok(!('traceId' in untraced) && !('spanId' in untraced) && !('flags' in untraced))
})

test('buildOtlpLogRecord: hostile attributes and bodies', () => {
    const r1 = buildOtlpLogRecord({ body: 'x', attributes: { ok: 1, get bad() { throw new Error('disposed') } } }, {})
    assert.deepEqual(r1.attributes, [{ key: 'ok', value: { intValue: '1' } }, { key: 'bad', value: { stringValue: '[Unserializable]' } }])
    const r2 = buildOtlpLogRecord({ body: 'x', attributes: JSON.parse('{"__proto__": {"a": 1}, "normal": "n"}') }, {})
    assert.ok(r2.attributes.map((a) => a.key).includes('__proto__'))
    assert.deepEqual(buildOtlpLogRecord({ body: 12345 }, {}).body, { stringValue: '12345' })
    assert.deepEqual(buildOtlpLogRecord({ body: { toString() { throw new Error('boom') } } }, {}).body, { stringValue: '[Unserializable]' })
    assert.deepEqual(buildOtlpLogRecord({ body: Object.create(null) }, {}).body, { stringValue: '[Unserializable]' })
    const revocable = Proxy.revocable({ a: 1 }, {})
    revocable.revoke()
    assert.deepEqual(buildOtlpLogRecord({ body: 'x', attributes: revocable.proxy }, {}).body, { stringValue: 'x' })
})

test('buildOtlpLogsPayload: envelope with scope name and version', () => {
    const records = [buildOtlpLogRecord({ body: 'a' }, {}), buildOtlpLogRecord({ body: 'b' }, {})]
    const payload = buildOtlpLogsPayload(records, { 'service.name': 'svc' }, 'web', '1.2.3')
    assert.deepEqual(payload.resourceLogs[0].resource.attributes, [{ key: 'service.name', value: { stringValue: 'svc' } }])
    assert.deepEqual(payload.resourceLogs[0].scopeLogs[0].scope, { name: 'web', version: '1.2.3' })
    assert.equal(payload.resourceLogs[0].scopeLogs[0].logRecords.length, 2)
})

// ---- logs: the pipeline ------------------------------------------------------------------------

function logsHarness(config = {}, { outcomes = [], logger = silent } = {}) {
    let queue = []
    const sent = []
    let optedOut = false
    const host = {
        optedOut: () => optedOut,
        getQueue: () => queue,
        setQueue: (q) => { queue = q },
        sendLogsBatch: (payload) => {
            sent.push(payload.resourceLogs[0].scopeLogs[0].logRecords.map((r) => r.body.stringValue))
            return Promise.resolve(outcomes.length ? outcomes.shift() : { kind: 'ok' })
        },
        libraryId: () => 'web',
        libraryVersion: () => '9.9.9',
    }
    const resolved = { ...resolveLogsConfig(config), ...(config.resolved || {}) }
    const pipeline = new LogsPipeline(host, resolved, logger, () => ({ distinctId: 'd' }))
    return { pipeline, sent, queue: () => queue, optOut: (v) => { optedOut = v } }
}

test('logs pipeline: flushes at maxBufferSize and drains in maxBatchRecordsPerPost slices', async () => {
    const h = logsHarness({ maxBufferSize: 3, flushIntervalMs: 60000 })
    for (let i = 0; i < 2; i++) h.pipeline.captureLog({ body: `r${i}` })
    assert.equal(h.sent.length, 0)
    h.pipeline.captureLog({ body: 'r2' })
    assert.deepEqual(h.sent, [['r0', 'r1', 'r2']]) // sent synchronously
    await flushMicrotasks()
    assert.equal(h.queue().length, 0)
    for (let i = 0; i < 2; i++) h.pipeline.captureLog({ body: `m${i}` })
    await h.pipeline.flush()
    assert.deepEqual(h.sent[1], ['m0', 'm1'])
    h.pipeline.reset()
})

test('logs pipeline: drops empty bodies, runs beforeSend chains, rate caps per window', async () => {
    const logger = recordingLogger()
    const h = logsHarness({
        maxLogsPerInterval: 2, flushIntervalMs: 60000,
        beforeSend: [(l) => (l.body === 'drop' ? null : l), (l) => ({ ...l, body: l.body.toUpperCase() })],
    }, { logger })
    h.pipeline.captureLog({ body: '' })
    h.pipeline.captureLog({ body: 'drop' })
    h.pipeline.captureLog({ body: 'a' })
    h.pipeline.captureLog({ body: 'b' })
    h.pipeline.captureLog({ body: 'c' }) // over the cap
    h.pipeline.captureLog({ body: 'd' })
    await h.pipeline.flush()
    assert.deepEqual(h.sent, [['A', 'B']])
    assert.equal(logger.calls.warn.filter((w) => /exceeded 2 logs per/.test(w[0])).length, 1)
    assert.equal(logger.calls.info.filter((w) => /rejected in beforeSend/.test(w[0])).length, 1)
    h.pipeline.reset()
})

test('logs pipeline: beforeSend that throws drops the record; opted out drops captures', async () => {
    const h = logsHarness({ beforeSend: () => { throw new Error('x') }, flushIntervalMs: 60000 })
    h.pipeline.captureLog({ body: 'a' })
    h.optOut(true)
    await h.pipeline.flush()
    assert.deepEqual(h.sent, [])
    const h2 = logsHarness({ flushIntervalMs: 60000 })
    h2.optOut(true)
    h2.pipeline.captureLog({ body: 'a' })
    assert.equal(h2.queue().length, 0)
})

test('logs pipeline: 413 halves the batch and retries the same records', async () => {
    const h = logsHarness({ flushIntervalMs: 60000 }, { outcomes: [{ kind: 'too-large' }] })
    for (let i = 0; i < 4; i++) h.pipeline.captureLog({ body: `r${i}` })
    await h.pipeline.flush()
    assert.deepEqual(h.sent, [['r0', 'r1', 'r2', 'r3'], ['r0', 'r1'], ['r2', 'r3']])
    h.pipeline.reset()
})

test('logs pipeline: a transient failure keeps the records, a fatal one drops them', async () => {
    const h = logsHarness({ flushIntervalMs: 60000 }, { outcomes: [{ kind: 'retry-later', error: new Error('503') }] })
    h.pipeline.captureLog({ body: 'keep' })
    await assert.rejects(h.pipeline.flush())
    assert.equal(h.queue().length, 1)
    await h.pipeline.flush()
    assert.equal(h.queue().length, 0)
    assert.deepEqual(h.sent, [['keep'], ['keep']])

    const f = logsHarness({ flushIntervalMs: 60000 }, { outcomes: [{ kind: 'fatal', error: new Error('400') }] })
    f.pipeline.captureLog({ body: 'gone' })
    await assert.rejects(f.pipeline.flush())
    assert.equal(f.queue().length, 0)
    h.pipeline.reset()
})

test('logs pipeline: the queue evicts the oldest record above maxQueueSize; clearQueue retires an in-flight batch', async () => {
    // The console pipeline's shape: no rate cap, a queue deeper than the flush trigger.
    const h = logsHarness({ maxBufferSize: 3, flushIntervalMs: 60000, resolved: { maxQueueSize: 5, maxLogsPerInterval: undefined } })
    for (let i = 0; i < 6; i++) h.pipeline.captureLog({ body: `r${i}` }) // the 3rd triggers a flush
    assert.equal(h.queue().length, 5)
    assert.equal(h.queue()[0].record.body.stringValue, 'r1')
    h.pipeline.clearQueue()
    await flushMicrotasks()
    assert.equal(h.queue().length, 0)
    h.pipeline.reset()
})

// ---- logs: console capture ------------------------------------------------------------------------

test('stringifyArgsSafely: bounded serialization, flattened attributes, circular refs', () => {
    const circular = { value: 42 }
    circular.self = circular
    const s = stringifyArgsSafely([circular], 10000)
    assert.equal(s.body, '{"value":42,"self":"[Circular]"}')
    assert.equal(s.truncated, false)
    assert.deepEqual(s.attributes, { value: 42, self: '[Circular]' })
    const nested = stringifyArgsSafely([{ user: { id: 7 }, skip: undefined, f() {} }, 'tail'], 10000)
    assert.equal(nested.body, '{"user":{"id":7}} "tail"')
    // A function counts as an object (upstream isObject) and has no own keys, so it adds nothing.
    assert.deepEqual(nested.attributes, { 'user.id': 7, skip: undefined })
    const long = stringifyArgsSafely(['x'.repeat(20)], 10)
    assert.equal(long.body, '"xxxxxxxx"...')
    assert.equal(long.truncated, true)
    const err = stringifyArgsSafely([new Error('boom')], 10000)
    assert.ok(err.body.startsWith('{"name":"Error","message":"boom","stack":'))
    assert.equal(stringifyArgsSafely(['a', 1, true, null, undefined], 1000).body, '"a" 1 true null ')
})

test('console capture: wraps console methods, records context, replays buffered entries, restores on dispose', () => {
    const calls = []
    const methods = {}
    for (const level of ['debug', 'log', 'warn', 'error', 'info']) methods[level] = (...args) => calls.push([level, args])
    const originals = { ...methods }
    const captured = []
    const buffered = []
    const host = {
        console: methods,
        hostname: 'example.test',
        getCapturingLogs: () => ({
            captureConsoleLog: (o) => captured.push(o),
            captureBufferedConsoleLog: (o, c, t) => buffered.push([o, c, t]),
        }),
    }
    const dispose = initializeLogs(host)
    methods.log({ value: 42 })
    methods.warn('w', 1)
    methods.log()
    assert.deepEqual(calls.map((c) => c[0]), ['log', 'warn', 'log'])
    assert.deepEqual(captured, [
        { level: 'info', body: '{"value":42}', attributes: { 'log.source': 'console.log', host: 'example.test', value: 42 } },
        { level: 'warn', body: '"w" 1', attributes: { 'log.source': 'console.warn', host: 'example.test' } },
    ])
    replayConsoleBuffer(host, [{ level: 'warn', args: ['prior'], occurredAtMs: 123, context: { distinctId: 'prior-user' } }])
    assert.deepEqual(buffered, [[{ level: 'warn', body: '"prior"', attributes: { 'log.source': 'console.warn', host: 'example.test' } }, { distinctId: 'prior-user' }, 123]])
    dispose()
    for (const level of Object.keys(originals)) assert.equal(methods[level], originals[level])
})

test('patch: a layer under a newer wrapper is spliced out on restore', () => {
    const target = { fn: () => 'base' }
    const restoreA = patch(target, 'fn', (next) => () => 'A>' + next())
    patch(target, 'fn', (next) => () => 'B>' + next())
    assert.equal(target.fn(), 'B>A>base')
    restoreA()
    assert.equal(target.fn(), 'B>base')
})

// ---- metrics ------------------------------------------------------------------------------------

test('metrics utils: series key sorts attributes, bucket index', () => {
    assert.equal(seriesKey('count', 'n', undefined, { b: 1, a: 2 }), seriesKey('count', 'n', undefined, { a: 2, b: 1 }))
    assert.notEqual(seriesKey('count', 'n', 'ms', undefined), seriesKey('count', 'n', undefined, undefined))
    assert.equal(bucketIndexFor(0, DEFAULT_HISTOGRAM_BOUNDS), 0)
    assert.equal(bucketIndexFor(5, DEFAULT_HISTOGRAM_BOUNDS), 1)
    assert.equal(bucketIndexFor(6, DEFAULT_HISTOGRAM_BOUNDS), 2)
    assert.equal(bucketIndexFor(20000, DEFAULT_HISTOGRAM_BOUNDS), 15)
    const c = resolveMetricsConfig({ resourceAttributes: { 'service.name': 'x' }, serviceName: 'y' })
    assert.equal(c.serviceName, 'x')
    assert.equal(c.flushIntervalMs, 10000)
    assert.equal(c.maxSeriesPerFlush, 1000)
})

function metricsHarness(config = {}, { outcomes = [], logger = silent } = {}) {
    const sent = []
    let optedOut = false
    const host = {
        optedOut: () => optedOut,
        sendMetricsBatch: (payload) => {
            sent.push(payload)
            return Promise.resolve(outcomes.length ? outcomes.shift() : { kind: 'ok' })
        },
        libraryId: () => 'web',
        libraryVersion: () => '9.9.9',
    }
    const agg = new MetricsAggregator(host, resolveMetricsConfig({ flushIntervalMs: 60000, ...config }), logger)
    return { agg, sent, optOut: (v) => { optedOut = v } }
}

const metricsOf = (payload) => payload.resourceMetrics[0].scopeMetrics[0].metrics

test('metrics: counts sum, gauges keep the last value, histograms fill buckets', async () => {
    const h = metricsHarness()
    h.agg.count('orders', 1)
    h.agg.count('orders', 2)
    h.agg.count('orders', 1, { attributes: { plan: 'pro' } })
    h.agg.gauge('conn', 42)
    h.agg.gauge('conn', 40)
    h.agg.histogram('lat', 187, { unit: 'ms' })
    h.agg.histogram('lat', 12, { unit: 'ms' })
    await h.agg.flush()
    const [orders, conn, lat] = metricsOf(h.sent[0])
    assert.equal(orders.name, 'orders')
    assert.deepEqual(orders.sum.dataPoints.map((d) => d.asDouble), [3, 1])
    assert.equal(orders.sum.aggregationTemporality, 1)
    assert.equal(orders.sum.isMonotonic, true)
    assert.deepEqual(orders.sum.dataPoints[1].attributes, [{ key: 'plan', value: { stringValue: 'pro' } }])
    assert.equal(conn.gauge.dataPoints[0].asDouble, 40)
    assert.equal(lat.unit, 'ms')
    const dp = lat.histogram.dataPoints[0]
    assert.deepEqual([dp.count, dp.sum, dp.min, dp.max], [2, 199, 12, 187])
    assert.deepEqual(dp.explicitBounds, DEFAULT_HISTOGRAM_BOUNDS)
    assert.equal(dp.bucketCounts[3], 1)
    assert.equal(dp.bucketCounts[7], 1)
    assert.deepEqual(h.sent[0].resourceMetrics[0].scopeMetrics[0].scope, { name: 'web', version: '9.9.9' })
    await h.agg.flush()
    assert.equal(h.sent.length, 1) // an empty window sends nothing
})

test('metrics: invalid samples are dropped with a warning', async () => {
    const logger = recordingLogger()
    const h = metricsHarness({}, { logger })
    h.agg.count('', 1)
    h.agg.count('neg', -1)
    h.agg.gauge('nan', NaN)
    h.agg.histogram('bad', 1, { bounds: [3, 2] })
    h.agg.histogram('bad', 1, { bounds: [] })
    await h.agg.flush()
    assert.equal(h.sent.length, 0)
    assert.equal(logger.calls.warn.length, 5)
})

test('metrics: histogram bounds are fixed by the first sample; type collisions warn once', async () => {
    const logger = recordingLogger()
    const h = metricsHarness({}, { logger })
    h.agg.histogram('payload', 3, { bounds: [1, 2, 4] })
    h.agg.histogram('payload', 9, { bounds: [1, 2, 8] })
    h.agg.histogram('payload', 9, { bounds: [1, 2, 8] })
    h.agg.count('mixed')
    h.agg.gauge('mixed', 1)
    h.agg.gauge('mixed', 2)
    await h.agg.flush()
    const dp = metricsOf(h.sent[0])[0].histogram.dataPoints[0]
    assert.deepEqual(dp.explicitBounds, [1, 2, 4])
    assert.deepEqual(dp.bucketCounts, [0, 0, 1, 2])
    assert.equal(logger.calls.warn.filter((w) => /already uses the bounds/.test(w[0])).length, 1)
    assert.equal(logger.calls.warn.filter((w) => /already used as a count/.test(w[0])).length, 1)
})

test('metrics: series cap, beforeSend, opt-out', async () => {
    const h = metricsHarness({ maxSeriesPerFlush: 2, beforeSend: (s) => (s.name === 'secret' ? null : { ...s, attributes: { tagged: true } }) })
    h.agg.count('a')
    h.agg.count('secret')
    h.agg.count('b')
    h.agg.count('c') // over the cap
    h.agg.count('a') // existing series still folds
    h.optOut(true)
    h.agg.count('a')
    await h.agg.flush()
    const metrics = metricsOf(h.sent[0])
    assert.deepEqual(metrics.map((m) => m.name), ['a', 'b'])
    assert.equal(metrics[0].sum.dataPoints[0].asDouble, 2)
    assert.deepEqual(metrics[0].sum.dataPoints[0].attributes, [{ key: 'tagged', value: { boolValue: true } }])
})

test('metrics: a transient failure merges the window back; reset drops it', async () => {
    const h = metricsHarness({}, { outcomes: [{ kind: 'retry-later', error: new Error('503') }] })
    h.agg.count('a', 2)
    await h.agg.flush()
    h.agg.count('a', 3)
    await h.agg.flush()
    assert.equal(metricsOf(h.sent[1])[0].sum.dataPoints[0].asDouble, 5)
    h.agg.count('dropped')
    h.agg.reset()
    await h.agg.flush()
    assert.equal(h.sent.length, 2)
})

test('metrics: drainWindow snapshots and resets synchronously', () => {
    const h = metricsHarness()
    assert.equal(h.agg.drainWindow(), null)
    h.agg.count('a')
    const payload = h.agg.drainWindow()
    assert.equal(metricsOf(payload)[0].name, 'a')
    assert.equal(h.agg.drainWindow(), null)
    h.agg.reset()
})
