// Real-browser smoke test: loads test/smoke.html (compiled chunks) and
// test/smoke-lazy.html (the lazy build) in headless Chrome
// (chromedp/headless-shell) and reads the results over CDP.
// Usage: node test/smoke-chrome.mjs
import { execFileSync } from 'node:child_process'
import { ROOT, sleep } from './harness.mjs'

const PORT = 9333
const name = 'phc-smoke-' + process.pid

/** Opens test/<file> in a new tab and returns the JSON the page writes to #out. */
async function runPage(file) {
    let target
    for (let i = 0; i < 50 && !target; i++) {
        try {
            const res = await fetch(`http://127.0.0.1:${PORT}/json/new?file:///work/test/${file}`, { method: 'PUT' })
            target = await res.json()
        } catch { await sleep(200) }
    }
    if (!target) throw new Error('chrome did not start')
    const ws = new WebSocket(target.webSocketDebuggerUrl.replace(/ws:\/\/[^/]+/, `ws://127.0.0.1:${PORT}`))
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
    let id = 0
    const call = (method, params = {}) => new Promise((resolve) => {
        const myId = ++id
        ws.addEventListener('message', function on(ev) {
            const msg = JSON.parse(ev.data)
            if (msg.id === myId) { ws.removeEventListener('message', on); resolve(msg.result) }
        })
        ws.send(JSON.stringify({ id: myId, method, params }))
    })
    let out = 'pending'
    for (let i = 0; i < 50 && out === 'pending'; i++) {
        await sleep(200)
        const r = await call('Runtime.evaluate', { expression: "document.getElementById('out') ? document.getElementById('out').textContent : 'pending'" })
        out = r.result.value
    }
    ws.close()
    console.log(out)
    return JSON.parse(out)
}

execFileSync('docker', ['run', '-d', '--rm', '--name', name, '-p', `127.0.0.1:${PORT}:9222`,
    '-v', `${ROOT}:/work:ro`, 'chromedp/headless-shell:latest'])
try {
    const res = await runPage('smoke.html')
    const ok = res.errors.length === 0 && res.flag === 'test' && res.hero === 'New' && !res.xss && res.distinct && res.exception &&
        res.modules.every(Boolean) &&
        res.paths.some((p) => p.endsWith('/e/')) && res.paths.some((p) => p.endsWith('/flags/')) &&
        res.replay === 'disabled' && res.replayStarted === false &&
        res.webVitals === false && res.traced[0] === true && res.traced[1] === false &&
        // opt-in chunks: logs, metrics, toolbar
        res.optIn.modules.every(Boolean) && res.optIn.toolbarParamsless === false &&
        res.optIn.loggerKeys === 'debug,error,fatal,info,trace,warn' &&
        res.paths.some((p) => p.endsWith('/i/v1/logs')) && res.paths.some((p) => p.endsWith('/i/v1/metrics'))
    // The lazy build: chunks load from the directory of posthog.js once their feature turns on.
    const lazy = await runPage('smoke-lazy.html')
    const lazyOk = lazy.errors.length === 0 && lazy.flag === 'test' && lazy.distinct && lazy.exception &&
        !lazy.early.wrapped && !lazy.early.fetchPatched && !lazy.early.detector &&
        lazy.wrapped && lazy.detector && lazy.traced === true &&
        lazy.chunks.join() === 'dead-clicks-autocapture.js?v=0.1.0-closure,exception-autocapture.js?v=0.1.0-closure,logs.js?v=0.1.0-closure,tracing-headers.js?v=0.1.0-closure' &&
        lazy.namespaces.join() === 'object,undefined' &&
        lazy.paths.some((p) => p.endsWith('/e/')) && lazy.paths.some((p) => p.endsWith('/i/v1/logs'))
    console.log(ok ? 'SMOKE OK' : 'SMOKE FAILED')
    console.log(lazyOk ? 'SMOKE (lazy) OK' : 'SMOKE (lazy) FAILED')
    process.exitCode = ok && lazyOk ? 0 : 1
} finally {
    execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' })
}
