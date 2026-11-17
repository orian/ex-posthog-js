// Recording equivalence: does our (optimised) rrweb build record exactly what the
// unmodified fork records? Both builds record the same session-bench journeys in the
// same page at the same time, and their event streams are compared.
//
//   npm run test:recorder-equivalence -- [--duration S] [--seed N] [--throttle R] [--runs N] [--fuzz B] [--no-build]
//
// - Builds third_party/posthog-rrweb/original (PostHog's fork as published in posthog-js
//   1.450.0) and third_party/posthog-rrweb/src (ours) with scripts/build-recorder.sh
//   into dist/equivalence/{original,current}/recorder.js. Both builds replace `Date.now`
//   and `setTimeout`/`clearTimeout` with the page's `__rrEquiv` clock and timers (see
//   below); nothing else differs from the shipped build.
// - The demo app page (test/bench/site) loads both, then our SDK (dist/posthog.full.js)
//   with session replay on, as in `npm run bench:session`. The SDK sees one rrweb whose
//   `record` starts both recorders with the options the SDK passes (plugins included) and
//   forwards addCustomEvent / takeFullSnapshot / freezePage to both, so both see the same
//   DOM, the same input and the same SDK calls. The SDK ships the original's events.
// - Every event each recorder emits is serialised when emitted. After the journeys the
//   two streams must be identical: same events, same order, same node ids. Only the
//   wall-clock `timestamp` of each event is normalised.
//
// - Then, in the same page, a seeded DOM fuzz (`--fuzz B` batches, default 400; 0 = off)
//   exercises what the journeys rarely do: nodes removed and re-added in one batch, a
//   removed subtree's children moved elsewhere, nested moves, blocked (ph-no-capture)
//   containers, text/attribute/style changes, innerHTML replacement, and batches
//   recorded while the page is frozen (freezePage, unfrozen by a custom event).
//
// Why a shared clock: rrweb's throttles (mouse moves, scroll, viewport) decide on
// Date.now(). The two recorders handle the same event one after the other, and a
// millisecond can tick in between, so the same build could sample a different mouse
// position in each copy. `__rrEquiv.now()` is frozen for the duration of a task, and
// `__rrEquiv.setTimeout` runs the callbacks the two copies schedule for the same moment
// in one task, so both copies see identical times. Same-build runs are identical (try
// `--self`, which compares the original with itself).
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ROOT } from '../harness.mjs'
import { startServer } from '../diff/server.mjs'
import { launchChrome } from '../diff/chrome.mjs'
import { benchResponses } from '../diff/fixtures.mjs'
import { Human } from './human.mjs'
import { siteSession } from './journeys.mjs'

const args = process.argv.slice(2)
const opt = (name, def) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : def
}
const opts = {
    duration: Number(opt('--duration', 60)),
    seed: Number(opt('--seed', 1)),
    throttle: args.includes('--no-throttle') ? 1 : Number(opt('--throttle', 4)),
    runs: Number(opt('--runs', 1)),
    build: !args.includes('--no-build'),
    self: args.includes('--self'),
    fuzz: Number(opt('--fuzz', 400)),
}
const VIEWPORT = { width: 1280, height: 800 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const OUT = path.join(ROOT, 'dist/equivalence')
const BUILDS = { original: 'third_party/posthog-rrweb/original', current: 'third_party/posthog-rrweb/src' }

if (opts.build) {
    for (const [name, src] of Object.entries(BUILDS)) {
        execFileSync(path.join(ROOT, 'scripts/build-recorder.sh'), {
            stdio: ['ignore', 'ignore', 'inherit'],
            env: { ...process.env, RECORDER_SRC: src, RECORDER_OUT: `dist/equivalence/${name}/recorder.js`, RECORDER_FLAGS: '--equivalence' },
        })
    }
}
for (const name of Object.keys(BUILDS)) {
    if (!fs.existsSync(path.join(OUT, name, 'recorder.js'))) throw new Error(`missing dist/equivalence/${name}/recorder.js (run without --no-build)`)
}
if (!fs.existsSync(path.join(ROOT, 'dist/posthog.full.js'))) throw new Error('missing dist/posthog.full.js: run ./scripts/build.sh')

// Runs in the page before its scripts (Page.addScriptToEvaluateOnNewDocument).
function injected(CFG) {
    if (window.top !== window || !/^https?:$/.test(location.protocol)) return
    var realNow = Date.now.bind(Date)
    var realSetTimeout = window.setTimeout.bind(window)
    var realClearTimeout = window.clearTimeout.bind(window)
    var channel = new MessageChannel()
    var frozen = null
    channel.port1.onmessage = function () { frozen = null }
    var buckets = {} // due time -> {handle, callbacks: {id: fn}}
    var owner = {} // our timer id -> due time
    var nextId = 1
    var E = (window.__rrEquiv = {
        // Frozen for the rest of the task: a message posted now is handled in a later task.
        now: function () {
            if (frozen === null) { frozen = realNow(); channel.port2.postMessage(0) }
            return frozen
        },
        // Callbacks due at the same (frozen) moment run in one task, in scheduling order.
        setTimeout: function (fn, delay) {
            var extra = Array.prototype.slice.call(arguments, 2)
            var due = E.now() + Math.max(0, Number(delay) || 0)
            var b = buckets[due]
            if (!b) {
                b = buckets[due] = { callbacks: {}, order: [] }
                b.handle = realSetTimeout(function () {
                    delete buckets[due]
                    for (var i = 0; i < b.order.length; i++) {
                        var cb = b.callbacks[b.order[i]]
                        if (!cb) continue
                        delete owner[b.order[i]]
                        try { cb() } catch (e) { realSetTimeout(function () { throw e }, 0) }
                    }
                }, Math.max(0, due - realNow()))
            }
            var id = nextId++
            b.callbacks[id] = function () { fn.apply(window, extra) }
            b.order.push(id)
            owner[id] = due
            return id
        },
        clearTimeout: function (id) {
            var due = owner[id]
            if (due === undefined) return
            delete owner[id]
            var b = buckets[due]
            if (b) delete b.callbacks[id]
        },
        a: [],
        b: [],
        errors: [],
    })
    function load(src, cb) {
        var s = document.createElement('script')
        s.src = src
        s.onload = function () { s.remove(); cb() }
        s.onerror = function () { E.errors.push('failed to load ' + src); cb() }
        ;(function add() {
            var root = document.head || document.documentElement
            if (root) root.appendChild(s)
            else realSetTimeout(add, 0)
        })()
    }
    function start() {
        var X = (window.__PosthogExtensions__ = window.__PosthogExtensions__ || {})
        load(CFG.a, function () {
            var A = X.rrweb, plugins = X.rrwebPlugins
            delete X.rrweb
            load(CFG.b, function () {
                var B = X.rrweb
                X.rrwebPlugins = plugins
                var push = function (log) {
                    return function (e) {
                        try { log.push(JSON.stringify(e)) } catch (err) { E.errors.push(String(err)) }
                    }
                }
                var record = function (options) {
                    var logA = push(E.a), logB = push(E.b)
                    var stopA = A.record(Object.assign({}, options, { emit: function (e, c) { logA(e); options.emit(e, c) } }))
                    var stopB = B.record(Object.assign({}, options, { emit: logB }))
                    return function () { if (stopA) stopA(); if (stopB) stopB() }
                }
                ;['addCustomEvent', 'takeFullSnapshot', 'freezePage', 'withStyleRuleSourceHandoff'].forEach(function (k) {
                    record[k] = function () {
                        var r = A.record[k].apply(null, arguments)
                        B.record[k].apply(null, arguments)
                        return r
                    }
                })
                record.isRecording = function () { return A.record.isRecording() }
                record.mirror = A.record.mirror
                var rrweb = {}
                for (var k in A) rrweb[k] = A[k]
                rrweb.record = record
                X.rrweb = rrweb
                load(CFG.sdk, function () {
                    window.posthog.init(CFG.token, CFG.init)
                    E.ready = true
                })
            })
        })
    }
    start()
}

// rrweb's own console warnings (e.g. "[rrweb] dropped N node(s)") are seen by the console
// plugin of both copies, so each stream gets both copies' warnings, in an order that
// depends on which copy ran first. They are compared separately (same messages, same
// count); the recorded DOM data they describe is compared in the streams.
const isRecorderWarning = (e) => e.type === 6 && e.data && e.data.plugin === 'rrweb/console@1' &&
    JSON.stringify(e.data.payload && e.data.payload.payload).startsWith('["\\"[rrweb]')

function normalise(json) {
    const e = JSON.parse(json)
    if (typeof e.timestamp === 'number') e.timestamp = '<t>'
    return JSON.stringify(e)
}

function firstDiff(a, b, p = '') {
    if (a === b) return null
    if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object' || Array.isArray(a) !== Array.isArray(b)) {
        return `${p || '.'}: original=${JSON.stringify(a)?.slice(0, 200)} current=${JSON.stringify(b)?.slice(0, 200)}`
    }
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const k of keys) {
        const d = firstDiff(a[k], b[k], `${p}.${k}`)
        if (d) return d
    }
    return null
}

// Runs in the page: `batches` tasks of random DOM operations under document.body.
function domFuzz(seed, batches) {
    let a = seed >>> 0
    const rnd = () => {
        a = (a + 0x6d2b79f5) >>> 0
        let t = a
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const pick = (xs) => xs[Math.floor(rnd() * xs.length)]
    const record = window.__PosthogExtensions__.rrweb.record
    const root = document.createElement('div')
    root.id = 'fuzz-root'
    document.body.appendChild(root)
    const TAGS = ['div', 'span', 'p', 'ul', 'li', 'section', 'b', 'a', 'input', 'textarea']
    let made = 0
    const make = (depth) => {
        const tag = pick(TAGS)
        const el = document.createElement(tag)
        if (rnd() < 0.3) el.className = pick(['x', 'y', 'ph-no-capture', 'ph-mask', 'x y'])
        if (tag === 'a') el.setAttribute('href', '/p/' + made)
        if (tag === 'input') el.setAttribute('value', 'v' + made)
        if (tag !== 'input') {
            el.appendChild(document.createTextNode('t' + made++))
            const n = depth > 0 ? Math.floor(rnd() * 4) : 0
            for (let i = 0; i < n; i++) el.appendChild(make(depth - 1))
        }
        return el
    }
    for (let i = 0; i < 8; i++) root.appendChild(make(3))
    const all = () => Array.from(root.querySelectorAll('*')).filter((e) => e.tagName !== 'INPUT' || true)
    const containers = () => [root, ...all().filter((e) => e.tagName !== 'INPUT')]
    const op = () => {
        const els = all()
        const r = rnd()
        if (r < 0.15) pick(containers()).appendChild(make(2))
        else if (r < 0.27 && els.length) { const e = pick(els); e.remove() }
        else if (r < 0.40 && els.length) {
            // move: into another container that is not inside it
            const e = pick(els), to = pick(containers())
            if (to !== e && !e.contains(to)) to.insertBefore(e, rnd() < 0.5 ? null : to.firstChild)
        } else if (r < 0.52 && els.length) {
            // remove a subtree, then move one of its descendants elsewhere (same batch)
            const e = pick(els)
            const kids = Array.from(e.querySelectorAll('*'))
            e.remove()
            if (kids.length) pick(containers()).appendChild(pick(kids))
        } else if (r < 0.60 && els.length) {
            // remove and re-add the same node
            const e = pick(els), parent = e.parentNode, next = e.nextSibling
            e.remove()
            if (parent && (parent === root || root.contains(parent))) parent.insertBefore(e, next && next.parentNode === parent ? next : null)
        } else if (r < 0.70 && els.length) {
            const e = pick(els)
            const tn = Array.from(e.childNodes).find((n) => n.nodeType === 3)
            if (tn) tn.data = 'c' + made++
            else e.appendChild(document.createTextNode('n' + made++))
        } else if (r < 0.80 && els.length) {
            const e = pick(els)
            const k = rnd()
            if (k < 0.3) e.classList.toggle('ph-no-capture')
            else if (k < 0.6) e.setAttribute('data-k', String(made++))
            else e.setAttribute('style', 'color: red; margin: ' + Math.floor(rnd() * 9) + 'px')
        } else if (r < 0.86 && els.length) {
            const e = pick(els.filter((x) => x.tagName !== 'INPUT')) || root
            e.innerHTML = '<i>h' + made++ + '</i><b>j<u>k</u></b>'
        } else if (r < 0.92 && els.length) {
            // wrap: move a node into a new element inserted in its place
            const e = pick(els), w = document.createElement('div')
            if (e.parentNode) { e.parentNode.insertBefore(w, e); w.appendChild(e) }
        } else if (els.length > 1) {
            // swap two siblings
            const e = pick(els)
            if (e.previousSibling && e.parentNode) e.parentNode.insertBefore(e, e.previousSibling)
        }
    }
    return new Promise((resolve) => {
        let i = 0
        let frozen = false
        const step = () => {
            if (i++ >= batches) {
                if (frozen) record.addCustomEvent('fuzz-unfreeze', { i })
                resolve(made)
                return
            }
            if (!frozen && rnd() < 0.04) { record.freezePage(); frozen = true }
            else if (frozen && rnd() < 0.2) { record.addCustomEvent('fuzz-unfreeze', { i }); frozen = false }
            const n = 1 + Math.floor(rnd() * 12)
            for (let k = 0; k < n; k++) op()
            if (root.querySelectorAll('*').length > 600) root.innerHTML = ''
            setTimeout(step, 0)
        }
        step()
    })
}

async function runOnce(chrome, srv, run) {
    srv.state.log = []
    srv.state.responses = benchResponses('phc_diff', {})
    const apiHost = `http://ph.example.test:${srv.port}`
    const page = await chrome.newPage()
    await page.cdp('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 1, mobile: false })
    if (opts.throttle > 1) await page.cdp('Emulation.setCPUThrottlingRate', { rate: opts.throttle })
    const cfg = {
        a: `${apiHost}/sdk/ours/equivalence/original/recorder.js`,
        b: `${apiHost}/sdk/ours/equivalence/${opts.self ? 'original' : 'current'}/recorder.js`,
        sdk: `${apiHost}/sdk/ours/posthog.full.js`,
        token: 'phc_diff',
        init: { api_host: apiHost, disable_surveys: true, capture_pageview: 'history_change' },
    }
    await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: `(${injected})(${JSON.stringify(cfg)})` })
    await page.goto(`http://app.example.test:${srv.port}/site/`)
    try {
        await page.waitFor(`document.readyState === 'complete' && window.__rrEquiv && window.__rrEquiv.ready`, 60000)
    } catch (e) {
        const state = await page.evaluate(`JSON.stringify({equiv: !!window.__rrEquiv, errors: window.__rrEquiv && __rrEquiv.errors, ready: document.readyState})`).catch((x) => String(x))
        throw new Error(`${e.message}: ${state} ${page.consoleErrors.join(' | ')}`)
    }
    await sleep(1000)
    const human = new Human(page, opts.seed + run, { budgetMs: opts.duration * 1000, viewport: VIEWPORT })
    await siteSession(human)
    if (opts.fuzz) await page.evaluate(`(${domFuzz})(${opts.seed + run}, ${opts.fuzz})`)
    await sleep(1000)
    const res = JSON.parse(await page.evaluate(`JSON.stringify({a: __rrEquiv.a, b: __rrEquiv.b, errors: __rrEquiv.errors})`))
    const pageErrors = page.consoleErrors.slice(0, 5)
    await page.close()
    // Each copy's warnings, told apart by the script URL in the stack trace (the console
    // plugin itself is the original's code, so any frame from current/ means current).
    const warnings = (copy) => res.a.map((x) => JSON.parse(x)).filter(isRecorderWarning)
        .filter((e) => JSON.stringify(e.data.payload.trace || []).includes('/equivalence/current/') === (copy === 'current'))
        .map((e) => JSON.stringify(e.data.payload.payload)).join()
    const a = res.a.filter((x) => !isRecorderWarning(JSON.parse(x))).map(normalise)
    const b = res.b.filter((x) => !isRecorderWarning(JSON.parse(x))).map(normalise)
    if (!opts.self && warnings('original') !== warnings('current')) {
        res.errors.push(`rrweb console warnings differ: original=${warnings('original').slice(0, 200)} current=${warnings('current').slice(0, 200)}`)
    }
    const types = {}
    for (const e of res.a) { const t = JSON.parse(e).type; types[t] = (types[t] || 0) + 1 }
    const diffs = []
    for (let i = 0; i < Math.max(a.length, b.length) && diffs.length < 10; i++) {
        if (a[i] === b[i]) continue
        diffs.push(`event ${i}: ` + (a[i] === undefined || b[i] === undefined
            ? `original=${(a[i] || 'missing').slice(0, 200)} current=${(b[i] || 'missing').slice(0, 200)}`
            : firstDiff(JSON.parse(a[i]), JSON.parse(b[i]))))
    }
    const bytes = res.a.reduce((n, e) => n + e.length, 0)
    return { a: a.length, b: b.length, types, bytes, diffs, errors: res.errors, pageErrors, input: human.stats }
}

const srv = await startServer()
const chrome = await launchChrome()
let failed = 0
try {
    console.log(`recording equivalence: original vs ${opts.self ? 'original (--self)' : 'current'} · ${opts.duration} s · CPU ${opts.throttle}x · seed ${opts.seed} · ${opts.runs} run(s)`)
    for (let run = 0; run < opts.runs; run++) {
        const r = await runOnce(chrome, srv, run)
        const same = !r.diffs.length && r.a === r.b && !r.errors.length
        if (!same) failed++
        console.log(`run ${run + 1}: ${same ? 'identical' : 'DIFFERENT'}: ${r.a} vs ${r.b} events (${(r.bytes / 1024).toFixed(0)} KB; by type ${JSON.stringify(r.types)}), ` +
            `input: ${r.input.moves} moves, ${r.input.clicks} clicks, ${r.input.keys} keys, ${r.input.wheels} wheels`)
        for (const d of r.diffs) console.log('  ' + d)
        for (const e of r.errors) console.log('  error: ' + e)
        for (const e of r.pageErrors) console.log('  page error: ' + e)
    }
} finally {
    chrome.close()
    srv.server.close()
}
process.exit(failed ? 1 : 0)
