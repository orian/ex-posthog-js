// Session benchmark: analytics + autocapture + session replay during a realistic,
// human-paced session, in real headless Chrome. Compares no SDK (baseline), the
// official posthog-js bundle and ours (and dist/lazy/posthog.js when it exists).
//
//   ./scripts/build.sh && npm run bench:session -- [options]
//
//   --runs N             runs per variant, medians reported (default 5)
//   --duration S         planned journey time per run in seconds (default 60)
//   --throttle R         CPU throttling rate (default 4); --no-throttle = 1
//   --variants a,b       none,official,ours[,lazy] (default: all available)
//   --seed N             journey seed (default 1): same seed = same session
//   --url URL            bring your own site instead of the demo app (test/bench/site)
//   --journey J          site (demo app journeys) | generic (default for --url)
//   --token T            project token the SDK is initialised with (default phc_diff)
//   --config JSON        remote config overrides, e.g. '{"sessionRecording":{"sampleRate":"1.00"}}'
//   --init JSON          extra posthog.init options
//   --out FILE           JSON results path (default test/bench/results/<timestamp>.json)
//
// Positional `[runs] [seconds]` still work. See README.md "Benchmarks".
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { ROOT } from '../harness.mjs'
import { startServer, OFFICIAL_VERSION } from '../diff/server.mjs'
import { launchChrome } from '../diff/chrome.mjs'
import { benchResponses } from '../diff/fixtures.mjs'
import { Human } from './human.mjs'
import { siteSession, genericSession } from './journeys.mjs'

// ---- options -------------------------------------------------------------------
function parseArgs(argv) {
    const o = { runs: 5, duration: 60, throttle: 4, seed: 1, token: 'phc_diff', config: {}, init: {} }
    const pos = []
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        const val = () => argv[++i]
        if (a === '--runs') o.runs = Number(val())
        else if (a === '--duration') o.duration = Number(val())
        else if (a === '--throttle') o.throttle = Number(val())
        else if (a === '--no-throttle') o.throttle = 1
        else if (a === '--variants') o.variants = val().split(',')
        else if (a === '--seed') o.seed = Number(val())
        else if (a === '--url') o.url = val()
        else if (a === '--journey') o.journey = val()
        else if (a === '--token') o.token = val()
        else if (a === '--config') o.config = JSON.parse(val())
        else if (a === '--init') o.init = JSON.parse(val())
        else if (a === '--out') o.out = val()
        else if (a.startsWith('--')) throw new Error('unknown option ' + a)
        else pos.push(a)
    }
    if (pos[0]) o.runs = Number(pos[0])
    if (pos[1]) o.duration = Number(pos[1])
    o.journey = o.journey || (o.url ? 'generic' : 'site')
    return o
}
const opts = parseArgs(process.argv.slice(2))

const hasLazy = fs.existsSync(path.join(ROOT, 'dist/lazy/posthog.js'))
const ALL_VARIANTS = {
    none: { key: 'none', name: 'no SDK (baseline)' },
    official: { key: 'official', name: `official ${OFFICIAL_VERSION} array.js`, sdkPath: '/sdk/official/array.js' },
    ours: { key: 'ours', name: 'ours posthog.full.js', sdkPath: '/sdk/ours/posthog.full.js' },
    lazy: { key: 'lazy', name: 'ours lazy/posthog.js', sdkPath: '/sdk/ours/lazy/posthog.js' },
}
const VARIANTS = (opts.variants || ['none', 'official', 'ours'].concat(hasLazy ? ['lazy'] : [])).map((k) => {
    if (!ALL_VARIANTS[k]) throw new Error('unknown variant ' + k)
    return ALL_VARIANTS[k]
})
const VIEWPORT = { width: 1280, height: 800 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- page instrumentation + SDK loader (injected before any page script) --------------
// Runs in the top frame only. Observes long tasks and Event Timing (for INP), and for SDK
// variants appends <script src=sdk> as soon as the document has a root, then calls
// posthog.init. With `guard`, link clicks and form submits are prevented so a generic
// journey stays on the page.
function injected(CFG) {
    if (window.top !== window || !/^https?:$/.test(location.protocol)) return // not iframes, not the final about:blank
    var B = (window.__phbench = { ready: CFG.sdk === 'none', longTasks: 0, longTaskMs: 0, inter: {}, slow: [] })
    try {
        new PerformanceObserver(function (l) { l.getEntries().forEach(function (e) { B.longTasks++; B.longTaskMs += e.duration }) })
            .observe({ type: 'longtask', buffered: true })
    } catch (e) {}
    try {
        new PerformanceObserver(function (l) {
            l.getEntries().forEach(function (e) {
                if (!e.interactionId) return
                if (!(B.inter[e.interactionId] >= e.duration)) B.inter[e.interactionId] = e.duration
                if (e.duration > 100 && B.slow.length < 20) {
                    var t = e.target
                    B.slow.push({ name: e.name, ms: e.duration, delay: Math.round(e.processingStart - e.startTime), processing: Math.round(e.processingEnd - e.processingStart),
                        target: t && t.nodeType === 1 ? t.tagName.toLowerCase() + (t.id ? '#' + t.id : '') + (t.className && typeof t.className === 'string' ? '.' + t.className.split(' ')[0] : '') : null })
                }
                B.minId = Math.min(B.minId || Infinity, e.interactionId)
                B.maxId = Math.max(B.maxId || 0, e.interactionId)
            })
        }).observe({ type: 'event', durationThreshold: 16, buffered: true })
    } catch (e) {}
    // Interaction count: performance.interactionCount where available, else web-vitals' estimate
    // from the interaction id range (Chrome increments ids by 7).
    var count = function () { return 'interactionCount' in performance ? performance.interactionCount : B.maxId ? (B.maxId - B.minId) / 7 + 1 : 0 }
    // Next-paint probe: time from each keydown/click to the first task after the next frame.
    // Kept alongside Event Timing because headless Chrome sometimes reports no presentation
    // for keystrokes in a text field for seconds (all of them then end at the same frame).
    B.lat = []
    var probe = function (e) {
        var t0 = e.timeStamp
        requestAnimationFrame(function () { setTimeout(function () { B.lat.push(performance.now() - t0) }, 0) })
    }
    addEventListener('keydown', probe, true)
    addEventListener('click', probe, true)
    B.reset = function () { B.longTasks = 0; B.longTaskMs = 0; B.inter = {}; B.slow = []; B.lat = []; B.minId = B.maxId = 0; B.count0 = 'interactionCount' in performance ? performance.interactionCount : 0 }
    B.result = function () {
        var d = Object.keys(B.inter).map(function (k) { return B.inter[k] }).sort(function (a, b) { return a - b })
        // Interactions under the 16 ms reporting threshold have no entry: count them as 0.
        var total = Math.max(d.length, Math.round(count() - (B.count0 || 0)))
        var all = new Array(total - d.length).fill(0).concat(d)
        var lat = B.lat.slice().sort(function (a, b) { return a - b })
        return {
            nextPaintP75: lat.length ? lat[Math.ceil(lat.length * 0.75) - 1] : 0,
            nextPaintMax: lat.length ? lat[lat.length - 1] : 0,
            interactions: total,
            inpP75: all.length ? all[Math.ceil(all.length * 0.75) - 1] : 0,
            inpMax: all.length ? all[all.length - 1] : 0,
            longTasks: B.longTasks,
            longTaskMs: B.longTaskMs,
            nodes: document.getElementsByTagName('*').length,
            sdkError: B.error || null,
            slowInteractions: B.slow, // > 100 ms (first 20), for diagnosis
        }
    }
    if (CFG.guard) {
        document.addEventListener('click', function (e) { var a = e.target.closest && e.target.closest('a[href]'); if (a) e.preventDefault() }, true)
        document.addEventListener('submit', function (e) { e.preventDefault() }, true)
    }
    if (CFG.sdk === 'none') return
    var s = document.createElement('script')
    s.async = true
    s.src = CFG.sdkUrl
    s.onload = function () {
        var t = performance.now()
        window.posthog.init(CFG.token, CFG.init)
        B.initMs = performance.now() - t
        B.ready = true
    }
    s.onerror = function () { B.error = 'failed to load ' + CFG.sdkUrl; B.ready = true }
    ;(function add() {
        var root = document.head || document.documentElement
        if (root) root.appendChild(s)
        else setTimeout(add, 0)
    })()
}

// ---- BYO site: route api_host (https://ph.example.test) to the fake server via CDP Fetch -------
// An https page can't call an http api_host (mixed content), and nothing listens on
// ph.example.test:443, so requests to it are paused by the Fetch domain and fulfilled
// with the fake server's response. Navigations away from the page are failed.
const BYO_API = 'https://ph.example.test'
function forward(port, req) {
    const u = new URL(req.url)
    const body = req.postDataEntries
        ? Buffer.concat(req.postDataEntries.map((e) => Buffer.from(e.bytes || '', 'base64')))
        : req.postData ? Buffer.from(req.postData, 'utf8') : null
    const headers = {}
    for (const [k, v] of Object.entries(req.headers || {})) if (!/^(content-length|host)$/i.test(k)) headers[k] = v
    headers.host = `ph.example.test:${port}`
    if (body) headers['content-length'] = body.length
    return new Promise((resolve, reject) => {
        const r = http.request({ host: '127.0.0.1', port, path: u.pathname + u.search, method: req.method, headers }, (res) => {
            const chunks = []
            res.on('data', (c) => chunks.push(c))
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
        })
        r.on('error', reject)
        if (body) r.write(body)
        r.end()
    })
}
async function interceptApi(page, port) {
    const { frameTree } = await page.cdp('Page.getFrameTree')
    const state = { mainFrame: frameTree.frame.id, blockNavigation: false, blocked: 0, forwarded: 0 }
    page.on('Fetch.requestPaused', async (p) => {
        try {
            if (p.request.url.startsWith(BYO_API + '/')) {
                const res = await forward(port, p.request)
                state.forwarded++
                const responseHeaders = Object.entries(res.headers).filter(([k]) => !/^(connection|transfer-encoding|keep-alive)$/i.test(k))
                    .map(([name, value]) => ({ name, value: String(value) }))
                await page.cdp('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: res.status, responseHeaders, body: res.body.toString('base64') })
            } else if (state.blockNavigation && p.resourceType === 'Document' && p.frameId === state.mainFrame) {
                state.blocked++
                await page.cdp('Fetch.failRequest', { requestId: p.requestId, errorReason: 'Aborted' })
            } else {
                await page.cdp('Fetch.continueRequest', { requestId: p.requestId })
            }
        } catch (e) {
            await page.cdp('Fetch.failRequest', { requestId: p.requestId, errorReason: 'Failed' }).catch(() => {})
        }
    })
    await page.cdp('Fetch.enable', { patterns: [{ urlPattern: BYO_API + '/*' }, { urlPattern: '*', resourceType: 'Document' }] })
    return state
}

// ---- one run ---------------------------------------------------------------------
async function metrics(page) {
    const { metrics } = await page.cdp('Performance.getMetrics')
    return Object.fromEntries(metrics.map((m) => [m.name, m.value]))
}

/** Events in a request body: an array, `{batch: [...]}` or a single event. */
function eventsOf(body) {
    if (!body || typeof body !== 'object') return []
    if (Array.isArray(body)) return body
    if (Array.isArray(body.batch)) return body.batch
    return body.event ? [body] : []
}

function summariseTraffic(log, navStart) {
    const api = log.filter((e) => !e.path.startsWith('/static/') && !e.path.startsWith('/sdk/'))
    const analytics = api.filter((e) => /^\/(e|i\/v0\/e|batch|capture|track)\/?$/.test(e.path))
    const replay = api.filter((e) => /^\/s\/?$/.test(e.path))
    const counts = {}
    for (const r of analytics) for (const e of eventsOf(r.body)) counts[e.event] = (counts[e.event] || 0) + 1
    let snapshots = 0
    let rrweb = 0
    let fullSnapshots = 0
    let firstFull = null
    const rrwebTypes = {}
    for (const r of replay) {
        for (const e of eventsOf(r.body)) {
            if (e.event !== '$snapshot') continue
            snapshots++
            const data = e.properties?.$snapshot_data || []
            rrweb += data.length
            for (const d of data) {
                rrwebTypes[d.type] = (rrwebTypes[d.type] || 0) + 1
                if (d.type === 2) {
                    fullSnapshots++
                    if (firstFull === null) firstFull = r.at - navStart
                }
            }
        }
    }
    const sum = (rs) => rs.reduce((a, e) => a + (e.bytes || 0), 0)
    return {
        eventRequests: analytics.length, eventBytes: sum(analytics), events: Object.values(counts).reduce((a, b) => a + b, 0), eventCounts: counts,
        replayRequests: replay.length, replayBytes: sum(replay), snapshots, rrwebEvents: rrweb, rrwebTypes, fullSnapshots,
        firstFullSnapshotMs: firstFull, otherApiRequests: api.length - analytics.length - replay.length,
        staticRequests: log.filter((e) => e.path.startsWith('/static/')).map((e) => `${e.path} ${e.status}`),
        // Per request: wire bytes vs decoded JSON size, to tell payload from encoding differences.
        requests: api.map((e) => ({ path: e.path, at: e.at - navStart, compression: e.query.compression || null, contentType: e.contentType || null,
            bytes: e.bytes, jsonBytes: e.body === undefined ? 0 : Buffer.byteLength(typeof e.body === 'string' ? e.body : JSON.stringify(e.body)),
            events: eventsOf(e.body).map((x) => x.event) })),
    }
}

async function runOnce(chrome, srv, v, run) {
    srv.state.log = []
    srv.state.responses = benchResponses(opts.token, opts.config)
    const byo = !!opts.url
    const apiHost = byo ? BYO_API : `http://ph.example.test:${srv.port}`
    const page = await chrome.newPage()
    await page.cdp('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 1, mobile: false })
    if (opts.throttle > 1) await page.cdp('Emulation.setCPUThrottlingRate', { rate: opts.throttle })
    await page.cdp('Performance.enable')
    if (byo) await page.cdp('Page.setBypassCSP', { enabled: true })
    const cfg = {
        sdk: v.key === 'none' ? 'none' : v.key, sdkUrl: v.sdkPath ? apiHost + v.sdkPath : null, token: opts.token, guard: byo,
        init: { api_host: apiHost, disable_surveys: true, capture_pageview: 'history_change', ...opts.init },
    }
    await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: `(${injected})(${JSON.stringify(cfg)})` })
    const fetchState = byo ? await interceptApi(page, srv.port) : null
    const url = byo ? opts.url : `http://app.example.test:${srv.port}/site/`
    const navStart = Date.now()
    await page.goto(url)
    await page.waitFor(`document.readyState === 'complete' && window.__phbench && window.__phbench.ready`, 60000)
    const loadMs = Date.now() - navStart
    await sleep(1000) // remote config, recorder script, first full snapshot
    if (fetchState) fetchState.blockNavigation = true
    await page.evaluate('window.__phbench.reset()')
    const before = await metrics(page)
    let peakHeap = before.JSHeapUsedSize
    let sampling = true
    const sampler = (async () => {
        while (sampling) {
            await sleep(1000)
            if (!sampling) break
            const m = await metrics(page).catch(() => null)
            if (m) peakHeap = Math.max(peakHeap, m.JSHeapUsedSize)
        }
    })()
    const human = new Human(page, opts.seed, { budgetMs: opts.duration * 1000, viewport: VIEWPORT })
    const journeys = await (opts.journey === 'generic' ? genericSession(human) : siteSession(human))
    const wallMs = Date.now() - human.t0
    sampling = false
    await sampler
    const after = await metrics(page)
    peakHeap = Math.max(peakHeap, after.JSHeapUsedSize)
    const page_ = await page.evaluate('window.__phbench.result()')
    await sleep(1000)
    await page.goto('about:blank') // unload: final flushes ($pageleave, last replay batch)
    await sleep(2000)
    await page.close()
    const d = (k) => (after[k] - before[k]) * 1000
    return {
        variant: v.key, run, loadMs, wallMs, journeys, input: human.stats,
        taskMs: d('TaskDuration'), scriptMs: d('ScriptDuration'), layoutMs: d('LayoutDuration'), styleMs: d('RecalcStyleDuration'),
        heapEndMB: after.JSHeapUsedSize / 1048576, heapPeakMB: peakHeap / 1048576,
        ...page_, ...summariseTraffic(srv.state.log, navStart),
        pageErrors: page.consoleErrors.slice(0, 5), fetch: fetchState && { forwarded: fetchState.forwarded, blockedNavigations: fetchState.blocked },
    }
}

// ---- main --------------------------------------------------------------------------
const median = (xs) => {
    const s = xs.filter((x) => x !== null && x !== undefined && !Number.isNaN(x)).sort((a, b) => a - b)
    if (!s.length) return null
    const m = Math.floor(s.length / 2)
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const srv = await startServer()
const chrome = await launchChrome()
const samples = Object.fromEntries(VARIANTS.map((v) => [v.key, []]))
const started = new Date()
console.error(`${opts.url || 'demo app'} · journey ${opts.journey} · ${opts.duration}s · ${opts.runs} runs · CPU ${opts.throttle}x · seed ${opts.seed}`)
try {
    // Variants are interleaved run by run, so slow drift (thermal, other load) hits all equally.
    for (let run = 0; run < opts.runs; run++) {
        for (const v of VARIANTS) {
            const s = await runOnce(chrome, srv, v, run)
            samples[v.key].push(s)
            console.error(`run ${run + 1}/${opts.runs} ${v.key.padEnd(8)} task ${s.taskMs.toFixed(0)} ms, script ${s.scriptMs.toFixed(0)} ms, ` +
                `${s.events} events, ${s.snapshots} $snapshot (${s.rrwebEvents} rrweb), lag ${s.input.lagMs.toFixed(0)} ms` +
                (s.pageErrors.length ? `, page errors: ${s.pageErrors.join(' | ').slice(0, 200)}` : '') + (s.sdkError ? ` SDK: ${s.sdkError}` : ''))
        }
    }
} finally {
    chrome.close()
    srv.server.close()
}

const KEYS = ['taskMs', 'scriptMs', 'layoutMs', 'styleMs', 'longTasks', 'longTaskMs', 'interactions', 'inpP75', 'inpMax', 'nextPaintP75', 'nextPaintMax', 'heapEndMB', 'heapPeakMB',
    'eventRequests', 'eventBytes', 'events', 'replayRequests', 'replayBytes', 'snapshots', 'rrwebEvents', 'fullSnapshots', 'firstFullSnapshotMs', 'otherApiRequests', 'nodes', 'wallMs']
const medians = Object.fromEntries(VARIANTS.map((v) => [v.key, Object.fromEntries(KEYS.map((k) => [k, median(samples[v.key].map((s) => s[k]))]))]))
const base = medians.none
const f = (x, d = 0) => (x === null || x === undefined ? '-' : x.toFixed(d))
const over = (m, k) => (base && m !== base ? f(m[k] - base[k]) : '-')
console.log(`\n${opts.url || 'demo app (test/bench/site)'}, ${opts.journey} journeys, ${opts.duration} s planned, CPU ${opts.throttle}x, medians of ${opts.runs} runs.`)
console.log('Overhead = variant minus the no-SDK baseline (same seeded session).\n')
console.table(Object.fromEntries(VARIANTS.map((v) => {
    const m = medians[v.key]
    return [v.key, {
        'task ms': f(m.taskMs), 'Δ task': over(m, 'taskMs'), 'script ms': f(m.scriptMs), 'Δ script': over(m, 'scriptMs'),
        'long tasks (ms)': `${f(m.longTasks)} (${f(m.longTaskMs)})`, 'INP p75/max': `${f(m.inpP75)}/${f(m.inpMax)}`, 'next paint p75/max': `${f(m.nextPaintP75)}/${f(m.nextPaintMax)}`,
        'heap end/peak MB': `${f(m.heapEndMB, 1)}/${f(m.heapPeakMB, 1)}`,
    }]
})))
console.table(Object.fromEntries(VARIANTS.filter((v) => v.key !== 'none').map((v) => {
    const m = medians[v.key]
    return [v.key, {
        'events (reqs)': `${f(m.events)} (${f(m.eventRequests)})`, 'events KB': f(m.eventBytes / 1024, 1),
        '$snapshot (reqs)': `${f(m.snapshots)} (${f(m.replayRequests)})`, 'rrweb events': f(m.rrwebEvents), 'full snapshots': f(m.fullSnapshots),
        'replay KB': f(m.replayBytes / 1024, 1), '1st full snapshot ms': f(m.firstFullSnapshotMs), 'other API reqs': f(m.otherApiRequests),
    }]
})))

const out = opts.out || path.join(ROOT, 'test/bench/results', started.toISOString().replace(/[:.]/g, '-') + '.json')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, JSON.stringify({ started: started.toISOString(), options: opts, viewport: VIEWPORT, officialVersion: OFFICIAL_VERSION, medians, samples }, null, 2))
console.log(`results: ${path.relative(process.cwd(), out)}`)
process.exit(0)
