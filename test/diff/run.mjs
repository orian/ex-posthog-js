// Differential test: runs each scenario in real headless Chrome against the
// official posthog-js bundle and ours, then diffs the normalised traffic.
//   node test/diff/run.mjs [scenario ...]      (requires ./scripts/build.sh first)
import fs from 'node:fs'
import path from 'node:path'
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

function normalise(value, ids, key) {
    if (VOLATILE_KEYS.has(key) && value !== undefined && value !== null) return '<volatile>'
    if (typeof value === 'string') {
        if (UUID.test(value)) {
            if (!ids.has(value)) ids.set(value, `<id${ids.size}>`)
            return ids.get(value)
        }
        if (ISO.test(value)) return '<iso>'
        return value.replace(/:\d{4,5}\//g, ':<port>/').replace(/:\d{4,5}$/, ':<port>').replace(/sdk=(official|ours)/g, 'sdk=<sdk>').replace(/&bundle=[^&]*/g, '')
    }
    if (Array.isArray(value)) return value.map((v) => normalise(v, ids))
    if (value && typeof value === 'object') {
        const out = {}
        for (const k of Object.keys(value).sort()) out[k] = normalise(value[k], ids, k)
        return out
    }
    return value
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
        const body = r.body
        const batch = body && typeof body === 'object' ? (Array.isArray(body) ? body : body.batch) : null
        requests.push({ method: r.method, path: r.path, query: normalise(query, ids), contentType: r.contentType, events: batch ? batch.map((e) => e.event) : undefined })
        if (batch) for (const e of batch) events.push(normalise(e, ids))
        else if (body && typeof body === 'object' && r.path !== '/e/') events.push({ __request: r.path, body: normalise(body, ids) })
    }
    return { requests, events }
}

function diffValues(a, b, at, out) {
    if (ALLOWED.some((re) => re.test(at))) return
    if (JSON.stringify(a) === JSON.stringify(b)) return
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
    const seq = (d) => d.requests.filter((r) => !r.path.startsWith('/static/')).map((r) => {
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
    if (ours.pageErrors.length) out.push(`page errors (ours): ${ours.pageErrors.join(' | ')}`)
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
