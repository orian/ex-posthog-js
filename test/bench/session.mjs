// "AI app" session benchmark: analytics + autocapture + session replay under a
// realistic, deterministic workload (streaming chat DOM, grid re-renders, SPA
// route changes, trusted clicks/typing/scrolling via CDP, custom events).
// Compares no SDK (baseline), the official posthog-js bundle and ours.
//   ./scripts/build.sh && node test/bench/session.mjs [runs] [seconds]
import { startServer } from '../diff/server.mjs'
import { launchChrome } from '../diff/chrome.mjs'
import { RESPONSES } from '../diff/fixtures.mjs'

const RUNS = Number(process.argv[2]) || 5
const SECONDS = Number(process.argv[3]) || 20
const VARIANTS = (process.env.BENCH_VARIANTS || 'none,official,ours').split(',').map((v) => ({
    none: { name: 'no SDK (baseline)', sdk: 'none' },
    official: { name: 'official array.js', sdk: 'official' },
    ours: { name: 'ours posthog.full.js', sdk: 'ours', bundle: 'posthog.full.js' },
    lazy: { name: 'ours lazy/posthog.js', sdk: 'ours', bundle: 'lazy/posthog.js' },
}[v]))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }

async function metrics(page) {
    const { metrics } = await page.cdp('Performance.getMetrics')
    return Object.fromEntries(metrics.map((m) => [m.name, m.value]))
}

async function center(page, selector) {
    return page.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
}

async function click(page, selector) {
    const { x, y } = await center(page, selector)
    for (const type of ['mousePressed', 'mouseReleased']) {
        await page.cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
    }
}

async function type(page, text) {
    await click(page, '#prompt')
    for (const ch of text) {
        await page.cdp('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch })
        await page.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
    }
}

async function runOnce(chrome, srv, v) {
    srv.state.log = []
    srv.state.responses = { ...RESPONSES.default, ...RESPONSES.replay_recording }
    const page = await chrome.newPage()
    await page.cdp('Emulation.setCPUThrottlingRate', { rate: 4 })
    await page.cdp('Performance.enable', { timeDomain: 'threadTicks' })
    const qs = `sdk=${v.sdk}${v.bundle ? '&bundle=' + v.bundle : ''}`
    await page.goto(`http://app.example.test:${srv.port}/session.html?${qs}`)
    await page.waitFor('window.__bench && window.__bench.ready === true', 30000)
    await sleep(1500) // let startup (remote config, recorder load) settle
    const before = await metrics(page)
    const end = Date.now() + SECONDS * 1000
    let i = 0
    while (Date.now() < end) {
        if (i % 3 === 0) await click(page, '#send')
        else if (i % 3 === 1) await click(page, '#grid .buy')
        else await type(page, 'hello')
        if (i % 4 === 0) await page.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 300, y: 300, deltaX: 0, deltaY: 400 })
        i++
        await sleep(700)
    }
    const after = await metrics(page)
    const res = await page.evaluate('window.__benchResult()')
    await page.goto('about:blank') // unload: final flushes
    await sleep(1500)
    await page.close()
    const log = srv.state.log.filter((e) => e.method === 'POST')
    const bytesTo = (re) => log.filter((e) => re.test(e.path)).reduce((a, e) => a + (e.bytes || 0), 0)
    return {
        scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000,
        taskMs: (after.TaskDuration - before.TaskDuration) * 1000,
        heapMB: after.JSHeapUsedSize / 1048576,
        inpP75: res.inpP75,
        inpMax: res.inpMax,
        longTaskMs: res.longTaskMs,
        eventKB: bytesTo(/^\/(e|i\/v0\/e)\/$/) / 1024,
        replayKB: bytesTo(/^\/s\/$/) / 1024,
        requests: log.length,
    }
}

const srv = await startServer()
const chrome = await launchChrome()
const rows = []
try {
    for (const v of VARIANTS) {
        const samples = []
        for (let r = 0; r < RUNS; r++) samples.push(await runOnce(chrome, srv, v))
        const m = (k) => median(samples.map((s) => s[k]))
        rows.push({ v, m })
        console.error(`done: ${v.name}`)
    }
} finally {
    chrome.close()
    srv.server.close()
}
const base = rows.find((r) => r.v.sdk === 'none')
const fmt = (x, d = 0) => x.toFixed(d)
console.log(`\n${SECONDS}s session, 4x CPU throttle, medians of ${RUNS} runs. "SDK overhead" = variant minus no-SDK baseline.\n`)
console.table(rows.map(({ v, m }) => ({
    variant: v.name,
    'main-thread task ms': fmt(m('taskMs')),
    'SDK overhead task ms': base && v.sdk !== 'none' ? fmt(m('taskMs') - base.m('taskMs')) : '-',
    'script ms': fmt(m('scriptMs')),
    'SDK overhead script ms': base && v.sdk !== 'none' ? fmt(m('scriptMs') - base.m('scriptMs')) : '-',
    'INP p75 / max ms': `${fmt(m('inpP75'))} / ${fmt(m('inpMax'))}`,
    'long tasks ms': fmt(m('longTaskMs')),
    'JS heap MB': fmt(m('heapMB'), 1),
    'events KB up': fmt(m('eventKB'), 1),
    'replay KB up': fmt(m('replayKB'), 1),
    requests: m('requests'),
})))
process.exit(0)
