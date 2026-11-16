// Headless Chrome (chromedp/headless-shell in Docker) driven over CDP.
import { execFileSync } from 'node:child_process'
import net from 'node:net'

function freePort() {
    return new Promise((resolve) => {
        const srv = net.createServer()
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address()
            srv.close(() => resolve(port))
        })
    })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const CHROME_UA =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

export async function launchChrome() {
    const name = 'phc-diff-' + process.pid
    // Host networking: pick a free port so parallel runs (e.g. several worktrees) don't collide.
    const port = Number(process.env.CHROME_DEBUG_PORT) || await freePort()
    // The image's run.sh word-splits its arguments, so call the binary directly.
    execFileSync('docker', ['run', '-d', '--rm', '--name', name, '--network', 'host',
        '--entrypoint', '/headless-shell/headless-shell', 'chromedp/headless-shell:latest',
        '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
        '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`,
        '--disable-blink-features=AutomationControlled', // else navigator.webdriver=true and both SDKs drop events as bots
        '--host-resolver-rules=MAP *.example.test 127.0.0.1'])
    let ver
    for (let i = 0; i < 100 && !ver; i++) {
        try {
            ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
        } catch {
            await sleep(100)
        }
    }
    if (!ver) throw new Error('chrome did not start')
    const ws = new WebSocket(ver.webSocketDebuggerUrl.replace(/ws:\/\/[^/]+/, `ws://127.0.0.1:${port}`))
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })

    let nextId = 0
    const pending = new Map()
    const listeners = []
    ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data)
        if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id)
            pending.delete(msg.id)
            msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
        } else if (msg.method) {
            listeners.forEach((l) => l(msg))
        }
    }
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
        const id = ++nextId
        pending.set(id, { resolve, reject })
        ws.send(JSON.stringify({ id, method, params, sessionId }))
    })

    return {
        /** Opens a fresh, isolated browser context (own storage/cookies). */
        async newPage({ userAgent = CHROME_UA } = {}) {
            const { browserContextId } = await send('Target.createBrowserContext', { disposeOnDetach: true })
            const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId })
            const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
            const s = (m, p) => send(m, p, sessionId)
            await s('Page.enable')
            await s('Runtime.enable')
            await s('Network.enable')
            await s('Network.setUserAgentOverride', { userAgent })
            const consoleErrors = []
            // Trusted input for scenarios: the page calls window.__cdpInput(JSON.stringify({id, method, params}))
            // with an Input.* CDP method; we run it and call back window.__cdpInputDone(id, error).
            await s('Runtime.addBinding', { name: '__cdpInput' })
            let inputChain = Promise.resolve()
            const runInput = async ({ id, method, params }) => {
                let error = null
                try {
                    if (!/^Input\./.test(method)) throw new Error('only Input.* methods are allowed: ' + method)
                    await s(method, params || {})
                } catch (e) {
                    error = String(e && e.message || e)
                }
                await s('Runtime.evaluate', { expression: `window.__cdpInputDone && window.__cdpInputDone(${JSON.stringify(id)}, ${JSON.stringify(error)})` }).catch(() => {})
            }
            listeners.push((msg) => {
                if (msg.sessionId !== sessionId) return
                if (msg.method === 'Runtime.exceptionThrown') {
                    consoleErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text)
                }
                if (msg.method === 'Runtime.bindingCalled' && msg.params.name === '__cdpInput') {
                    const req = JSON.parse(msg.params.payload)
                    inputChain = inputChain.then(() => runInput(req))
                }
            })
            return {
                consoleErrors,
                async goto(url, referrer) {
                    await s('Page.navigate', { url, referrer })
                },
                async evaluate(expression) {
                    const r = await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
                    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
                    return r.result.value
                },
                async waitFor(expression, timeoutMs = 10000) {
                    const end = Date.now() + timeoutMs
                    while (Date.now() < end) {
                        try {
                            if (await this.evaluate(expression)) return true
                        } catch {}
                        await sleep(50)
                    }
                    throw new Error('timeout waiting for ' + expression)
                },
                async close() {
                    await send('Target.closeTarget', { targetId }).catch(() => {})
                    await send('Target.disposeBrowserContext', { browserContextId }).catch(() => {})
                },
            }
        },
        close() {
            ws.close()
            execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' })
        },
    }
}
