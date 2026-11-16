// Differential test: runs each scenario in real headless Chrome against the
// official posthog-js bundle and ours, then diffs the normalised traffic.
//   node test/diff/run.mjs [scenario ...]      (requires ./scripts/build.sh first)
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { startServer } from './server.mjs'
import { launchChrome } from './chrome.mjs'
import { ROOT } from '../harness.mjs'
import { RESPONSES, ALLOWED } from './fixtures.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const REFERRER = 'https://www.google.com/search?q=posthog'

async function runScenario(chrome, srv, scenario, sdk) {
    srv.state.log = []
    srv.state.responses = { ...RESPONSES.default, ...(RESPONSES[scenario] || {}) }
    const page = await chrome.newPage()
    const bundle = process.env.DIFF_BUNDLE ? `&bundle=${process.env.DIFF_BUNDLE}` : ''
    const url = `http://app.example.test:${srv.port}/page.html?sdk=${sdk}&scenario=${scenario}&utm_source=newsletter&utm_campaign=launch${bundle}`
    await page.goto(url, REFERRER)
    await page.waitFor('window.__done === true', 20000)
    const error = await page.evaluate('window.__error || null')
    const results = await page.evaluate('window.__flagResults || null')
    await sleep(700)
    await page.goto('about:blank') // real unload: pagehide / beforeunload
    await sleep(700)
    await page.close()
    return { log: srv.state.log.slice(), error, results, pageErrors: page.consoleErrors.slice() }
}

// ---- normalisation -----------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/
const VOLATILE_KEYS = new Set(['$time', '$insert_id', 'sent_at', 'timestamp', '$lib_version', '_', 'ver',
    '$duration', '$prev_pageview_duration', '$initialization_time', '$sdk_debug_extensions_init_time_ms',
    '$event_time_override_system_time', '$sdk_debug_retry_queue_size', '$lib_rate_limit_remaining_tokens',
    '$timezone_offset', '$time_since_page_load'])
// Dead click/swipe timing: wall-clock timestamps and measured delays (presence still compared).
const VOLATILE_KEY_PATTERN = /^\$dead_(click|swipe)_(.*_timestamp|.*_delay_ms)$/

// ---- session replay ($snapshot) --------------------------------------------------
// Replay payloads are made comparable without hiding structure:
// - `cv: '2024-10'` events carry gzip (latin1 string) fields: they are decoded,
//   so the recorded DOM/mutations are compared, not the encoder's bytes (the
//   unload path uses our sync encoder, which differs from fflate).
// - rrweb/recorder timestamps (`timestamp`, `timeOffset`, idle/activity
//   timestamps, session start, cache_timestamp) are wall-clock: volatile.
// - The recorded DOM contains the SDK and recorder <script> tags, whose URLs
//   differ by design (array.js vs posthog.full.js, lazy-recorder.js vs
//   recorder.js, 1.450.0 vs our version): those URLs are normalised.
// - Byte sizes depend on those URLs, so `$snapshot_bytes` is checked for
//   consistency with the payload instead (each SDK's reported size must equal
//   upstream's estimate of what it sent), and buffer/flushed sizes are volatile.
// Node ids are kept: both SDKs record the same page with the same rrweb build.
const REPLAY_VOLATILE_KEYS = new Set(['timeOffset', 'lastActivityTimestamp', 'eventTimestamp', 'cache_timestamp',
    '$sdk_debug_session_start', '$debug_first_full_snapshot_timestamp', '$sdk_debug_replay_internal_buffer_size',
    '$sdk_debug_replay_flushed_size', 'flushed_size', 'bufferSize'])

function gunzipLatin1(s) {
    return JSON.parse(zlib.gunzipSync(Buffer.from(s, 'latin1')).toString('utf8'))
}

function decompressReplayEvent(e) {
    if (!e || e.cv !== '2024-10') return e
    const out = { ...e }
    if (e.type === 2 && typeof e.data === 'string') out.data = gunzipLatin1(e.data)
    else if (e.type === 3 && e.data) {
        out.data = { ...e.data }
        for (const k of ['texts', 'attributes', 'removes', 'adds']) {
            if (typeof e.data[k] === 'string') out.data[k] = gunzipLatin1(e.data[k])
        }
    }
    return out
}

// upstream estimateCompressedEventSize
function estimateCompressedEventSize(value) {
    if (value === null) return 4
    if (value === undefined) return 0
    switch (typeof value) {
        case 'string': return value.length + 2
        case 'number': return String(value).length
        case 'boolean': return value ? 4 : 5
        case 'object': {
            if (Array.isArray(value)) {
                let size = 2
                value.forEach((el, i) => { size += (i > 0 ? 1 : 0) + (el == null ? 4 : estimateCompressedEventSize(el)) })
                return size
            }
            let size = 2
            let first = true
            for (const k of Object.keys(value)) {
                if (value[k] === undefined) continue
                if (!first) size += 1
                first = false
                size += k.length + 3 + estimateCompressedEventSize(value[k])
            }
            return size
        }
        default: return 0
    }
}

function expandSnapshot(e) {
    const p = e.properties
    if (!p || !Array.isArray(p.$snapshot_data)) return e
    const expected = p.$snapshot_data.reduce((sum, ev) => sum + (ev && ev.cv
        ? estimateCompressedEventSize(ev) : Buffer.byteLength(JSON.stringify(ev))), 0)
    // Upstream sizes events when they are buffered, so an event that changes
    // before it is sent (e.g. `$posthog_config` holds the live config) is off by
    // the same delta in both SDKs.
    const bytes = p.$snapshot_bytes === expected ? '<consistent>' : `<inconsistent by ${p.$snapshot_bytes - expected}>`
    return { ...e, properties: { ...p, $snapshot_bytes: bytes, $snapshot_data: p.$snapshot_data.map(decompressReplayEvent) } }
}

function normaliseUrls(value) {
    return value
        .replace(/\/sdk\/(official\/array\.js|ours\/[\w.\/-]+\.js)/g, '/sdk/<sdk>')
        .replace(/\/static\/(?:[\w.-]+\/)?(?:lazy-)?recorder\.js(?:\?v=[\w.-]+)?/g, '/static/<recorder>')
}

// Network plugin entries: browser-measured timings and transfer sizes, the
// response `date` header and Chrome's navigation `confidence` (system load).
const NETWORK_VOLATILE = /(Start|End|Time|duration|timeOrigin|Size|Complete|Interactive)$/

function normalise(value, ids, key, inNetwork) {
    if (inNetwork && NETWORK_VOLATILE.test(key || '') && typeof value === 'number') return '<volatile>'
    if (inNetwork && (key === 'date' || key === 'confidence') && value !== undefined) return '<volatile>'
    if (REPLAY_VOLATILE_KEYS.has(key) && value !== undefined && value !== null) return '<volatile>'
    if ((VOLATILE_KEYS.has(key) || VOLATILE_KEY_PATTERN.test(key || '')) && value !== undefined && value !== null) return '<volatile>'
    if (typeof value === 'string') {
        if (UUID.test(value)) {
            if (!ids.has(value)) ids.set(value, `<id${ids.size}>`)
            return ids.get(value)
        }
        if (ISO.test(value)) return '<iso>'
        // UUIDs embedded in longer strings (e.g. a session id inside a message).
        value = value.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (u) => {
            if (!ids.has(u)) ids.set(u, `<id${ids.size}>`)
            return ids.get(u)
        })
        return normaliseUrls(value).replace(/:\d{4,5}\//g, ':<port>/').replace(/:\d{4,5}$/, ':<port>').replace(/sdk=(official|ours)/g, 'sdk=<sdk>').replace(/&bundle=[^&]*/g, '')
    }
    if (Array.isArray(value)) return value.map((v) => normalise(v, ids, undefined, inNetwork))
    if (value && typeof value === 'object') {
        const out = {}
        // Keys can be URLs too (e.g. $heatmap_data is keyed by page URL).
        const net = inNetwork || value.plugin === 'rrweb/network@1'
        for (const k of Object.keys(value).sort()) out[k.includes('://') ? normalise(k, ids) : k] = normalise(value[k], ids, k, net)
        return out
    }
    return value
}

// Stack frames inside the SDK itself differ by construction: another file (official
// array.js and its lazy-loaded /static/ bundles vs ours), other lines/columns, other
// minified function names, and as many frames as each bundler left after inlining
// (e.g. upstream's console.error wrapper reaches the builder through 4 helpers). Each run
// of consecutive SDK frames becomes one placeholder frame. Page frames are left untouched.
const SDK_FILE = /\/sdk\/(official|ours)\/|ph\.example\.test:\d+\/static\//
function normaliseSdkFrames(event) {
    const list = event && event.properties && event.properties.$exception_list
    if (!Array.isArray(list)) return event
    for (const exception of list) {
        const frames = exception && exception.stacktrace && exception.stacktrace.frames
        if (!Array.isArray(frames)) continue
        const out = []
        for (const f of frames) {
            if (!SDK_FILE.test(f.filename || '')) out.push(f)
            else if (!out.length || out[out.length - 1].filename !== '<sdk>') {
                out.push({ ...f, filename: '<sdk>', function: '<sdk>', lineno: '<sdk>', colno: '<sdk>' })
            }
        }
        exception.stacktrace.frames = out
    }
    return event
}

// ---- logs / metrics (OTLP bodies) and the toolbar script --------------------------------
// OTLP payloads are compared in full, except:
// - `timeUnixNano` / `observedTimeUnixNano` / `startTimeUnixNano`: wall-clock nanos;
// - the `sessionStartTimestamp` / `lastActivityTimestamp` log attributes: wall-clock millis;
// - `telemetry.sdk.version` and the scope `version`: the SDK version (as `$lib_version`).
const OTLP_PATHS = new Set(['/i/v1/logs', '/i/v1/metrics'])
const OTLP_TIME_KEYS = new Set(['timeUnixNano', 'observedTimeUnixNano', 'startTimeUnixNano'])
const OTLP_VOLATILE_ATTRIBUTES = new Set(['sessionStartTimestamp', 'lastActivityTimestamp'])
const isOtlpPath = (p) => OTLP_PATHS.has(p)

function normaliseOtlp(value, key) {
    if (Array.isArray(value)) return value.map((v) => normaliseOtlp(v))
    if (!value || typeof value !== 'object') return value
    const out = {}
    for (const k of Object.keys(value)) {
        if (OTLP_TIME_KEYS.has(k) && typeof value[k] === 'string' && /^\d+000000$/.test(value[k])) out[k] = '<volatile>'
        else out[k] = normaliseOtlp(value[k], k)
    }
    if (typeof out.key === 'string' && out.value && (OTLP_VOLATILE_ATTRIBUTES.has(out.key) || out.key === 'telemetry.sdk.version')) {
        out.value = OTLP_VOLATILE_ATTRIBUTES.has(out.key) ? '<volatile>' : '<lib_version>'
    }
    if (key === 'scope' && typeof out.version === 'string') out.version = '<lib_version>'
    return out
}

// The toolbar script URL: `/static/toolbar.js?v=<version>&t=<5 minute boundary>`, or
// `/static/<version>/toolbar.js` under strict_script_versioning. The version differs by
// design (as `$lib_version`); `t` is wall-clock time, so only its shape is compared.
const isToolbarScript = (p) => /^\/static\/(?:[\w.-]+\/)?toolbar\.js$/.test(p)
function normaliseToolbarScript(path, query) {
    if ('v' in query) query.v = '<version>'
    if ('t' in query) query.t = /^\d+$/.test(query.t) && Number(query.t) % 300000 === 0 ? '<5min>' : `<bad t=${query.t}>`
    return path.replace(/^\/static\/[\w.-]+\/toolbar\.js$/, '/static/<version>/toolbar.js')
}

/** Turns a request log into a list of comparable items (requests + events). */
function digest(log) {
    const ids = new Map()
    const requests = []
    const events = []
    for (const r of log) {
        const query = { ...r.query }
        delete query._
        delete query.ver
        delete query.sent_at
        const body = isOtlpPath(r.path) ? normaliseOtlp(r.body) : r.body
        const batch = body && typeof body === 'object' ? (Array.isArray(body) ? body : body.batch) : null
        const path = isToolbarScript(r.path) ? normaliseToolbarScript(r.path, query) : r.path
        requests.push({ method: r.method, path, query: normalise(query, ids), contentType: r.contentType, events: batch ? batch.map((e) => e.event) : undefined })
        if (batch) for (const e of batch) events.push(normalise(e && e.event === '$snapshot' ? expandSnapshot(e) : normaliseSdkFrames(e), ids))
        else if (body && typeof body === 'object' && r.path !== '/e/') events.push({ __request: r.path, body: normalise(body, ids) })
    }
    return { requests, events }
}

function diffValues(a, b, at, out) {
    if (ALLOWED.some((re) => re.test(at))) return
    if (JSON.stringify(a) === JSON.stringify(b)) return
    // Same-length arrays (e.g. $snapshot_data) are compared element by element for readable diffs.
    if (Array.isArray(a) && Array.isArray(b) && a.length === b.length && at.indexOf('$snapshot_data') !== -1) {
        a.forEach((x, i) => diffValues(x, b[i], `${at}[${i}]`, out))
        return
    }
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffValues(a[k], b[k], `${at}.${k}`, out)
        return
    }
    out.push(`${at}: official=${JSON.stringify(a)?.slice(0, 160)} ours=${JSON.stringify(b)?.slice(0, 160)}`)
}

function compare(official, ours) {
    const out = []
    const o = digest(official.log)
    const m = digest(ours.log)
    const seq = (d) => d.requests.filter((r) => !r.path.startsWith('/static/') || isToolbarScript(r.path)).map((r) => {
        const q = Object.keys(r.query).sort().map((k) => `${k}=${r.query[k]}`).join('&')
        return `${r.method} ${r.path}${q ? '?' + q : ''}${r.contentType ? ' (' + r.contentType + ')' : ''}${r.events ? ' [' + r.events.join(',') + ']' : ''}`
    })
    diffValues(seq(o), seq(m), 'requests', out)
    const names = (d) => d.events.map((e) => e.event || e.__request)
    diffValues(names(o), names(m), 'event-order', out)
    // Pair events by name + occurrence index.
    const index = (d) => {
        const seen = {}
        const map = new Map()
        for (const e of d.events) {
            const n = e.event || e.__request
            seen[n] = (seen[n] || 0) + 1
            map.set(`${n}#${seen[n]}`, e)
        }
        return map
    }
    const io = index(o)
    const im = index(m)
    for (const [k, e] of io) diffValues(e, im.get(k), k, out)
    for (const k of im.keys()) if (!io.has(k)) out.push(`${k}: only in ours`)
    diffValues(official.results, ours.results, 'results', out)
    if (official.error || ours.error) out.push(`errors: official=${official.error} ours=${ours.error}`)
    // Errors thrown on purpose by exception scenarios are marked 'diff-expected'.
    const pageErrors = ours.pageErrors.filter((e) => !/diff-?expected/i.test(e))
    if (pageErrors.length) out.push(`page errors (ours): ${pageErrors.join(' | ')}`)
    return out
}

// ---- main ----------------------------------------------------------------------

const all = Object.keys((await import('./scenario-list.mjs')).SCENARIO_NAMES.reduce((a, n) => ({ ...a, [n]: 1 }), {}))
const selected = process.argv.slice(2).length ? process.argv.slice(2) : all
const srv = await startServer()
const chrome = await launchChrome()
let failures = 0
const report = {}
try {
    for (const scenario of selected) {
        const official = await runScenario(chrome, srv, scenario, 'official')
        const ours = await runScenario(chrome, srv, scenario, 'ours')
        const diffs = compare(official, ours)
        report[scenario] = { diffs, official: digest(official.log), ours: digest(ours.log) }
        if (diffs.length) failures++
        console.log(`${diffs.length ? 'DIFF' : 'same'}  ${scenario}${diffs.length ? ` (${diffs.length})` : ''}`)
        for (const d of diffs.slice(0, 60)) console.log('      ' + d)
        if (diffs.length > 60) console.log(`      ... ${diffs.length - 60} more`)
    }
} finally {
    chrome.close()
    srv.server.close()
}
fs.writeFileSync(path.join(ROOT, 'test/diff/last-report.json'), JSON.stringify(report, null, 1))
console.log(`\n${selected.length - failures}/${selected.length} scenarios identical (full report: test/diff/last-report.json)`)
process.exit(failures ? 1 : 0)
