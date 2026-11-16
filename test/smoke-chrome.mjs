// Real-browser smoke test: loads test/smoke.html (compiled chunks) in
// headless Chrome (chromedp/headless-shell) and reads the result over CDP.
// Usage: node test/smoke-chrome.mjs
import { execFileSync } from 'node:child_process'
import { ROOT, sleep } from './harness.mjs'

const PORT = 9333
const name = 'phc-smoke-' + process.pid
execFileSync('docker', ['run', '-d', '--rm', '--name', name, '-p', `127.0.0.1:${PORT}:9222`,
    '-v', `${ROOT}:/work:ro`, 'chromedp/headless-shell:latest'])
try {
    let target
    for (let i = 0; i < 50 && !target; i++) {
        try {
            const res = await fetch(`http://127.0.0.1:${PORT}/json/new?file:///work/test/smoke.html`, { method: 'PUT' })
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
    const res = JSON.parse(out)
    const ok = res.errors.length === 0 && res.flag === 'test' && res.hero === 'New' && !res.xss && res.distinct &&
        res.paths.some((p) => p.endsWith('/e/')) && res.paths.some((p) => p.endsWith('/flags/'))
    console.log(ok ? 'SMOKE OK' : 'SMOKE FAILED')
    process.exitCode = ok ? 0 : 1
} finally {
    execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' })
}
