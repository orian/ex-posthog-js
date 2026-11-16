// Minimal fake browser for running the SDK (source or compiled) under Node.
// Captures every network request so tests can assert on the wire format.
import vm from 'node:vm'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

class FakeStorage {
    constructor() { this.m = new Map() }
    getItem(k) { return this.m.has(k) ? this.m.get(k) : null }
    setItem(k, v) { this.m.set(k, String(v)) }
    removeItem(k) { this.m.delete(k) }
    clear() { this.m.clear() }
}

class FakeElement {
    constructor(tag, id) {
        this.tagName = tag.toUpperCase()
        this.id = id
        this.textContent = ''
        this.innerHTML = ''
        this.attrs = {}
    }
    setAttribute(k, v) { this.attrs[k] = String(v) }
    getAttribute(k) { return this.attrs[k] ?? null }
}

/**
 * @param {object} opts
 * @param {string} [opts.url]
 * @param {(req) => {status:number, body:any}|undefined} [opts.respond]
 */
export function createBrowser(opts = {}) {
    const url = new URL(opts.url || 'https://app.example.com/pricing?utm_source=newsletter')
    const requests = []
    const listeners = {}
    const cookies = new Map()
    const elements = { '#hero': [new FakeElement('h1', 'hero')] }

    const respond = opts.respond || (() => undefined)

    const document = {
        title: 'Pricing',
        referrer: 'https://www.google.com/search?q=x',
        get cookie() {
            return [...cookies].map(([k, v]) => `${k}=${v}`).join('; ')
        },
        set cookie(str) {
            const [pair, ...attrs] = str.split(';')
            const i = pair.indexOf('=')
            const k = pair.slice(0, i).trim()
            const v = pair.slice(i + 1)
            const expires = attrs.find((a) => a.trim().toLowerCase().startsWith('expires='))
            const domain = attrs.find((a) => a.trim().toLowerCase().startsWith('domain='))
            // Reject cookies for the public suffix, like a real browser.
            if (domain && domain.split('=')[1].trim() === '.com') return
            if (expires && new Date(expires.split('=')[1]) < new Date()) cookies.delete(k)
            else cookies.set(k, v)
        },
        querySelectorAll(sel) { return elements[sel] || [] },
        addEventListener() {},
    }

    const decodeBody = async (u, body) => {
        if (body === undefined || body === null) return undefined
        if (typeof body !== 'string') {
            const buf = typeof body.arrayBuffer === 'function'
                ? Buffer.from(await body.arrayBuffer())
                : Buffer.from(ArrayBuffer.isView(body) ? body.buffer : body)
            return JSON.parse(zlib.gunzipSync(buf).toString('utf8'))
        }
        if (body.startsWith('data=')) {
            const b64 = decodeURIComponent(body.slice(5))
            return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
        }
        return JSON.parse(body)
    }

    const record = async (u, method, body, headers, transport) => {
        const req = { url: u, method, headers, transport, body: await decodeBody(u, body) }
        req.path = new URL(u).pathname
        requests.push(req)
        return req
    }

    const window = {
        location: {
            href: url.href, host: url.host, hostname: url.hostname, pathname: url.pathname,
            search: url.search, protocol: url.protocol, hash: url.hash,
        },
        navigator: {
            userAgent: opts.userAgent ||
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
            language: 'en-US',
            onLine: true,
            sendBeacon(u, blob) {
                blob.text().then((t) => record(u, 'POST', t, {}, 'sendBeacon'))
                return true
            },
        },
        document,
        screen: { width: 1440, height: 900 },
        innerWidth: 1200, innerHeight: 800,
        localStorage: new FakeStorage(),
        sessionStorage: new FakeStorage(),
        history: {
            pushState(_s, _t, p) { window.location.pathname = p; window.location.href = url.origin + p },
            replaceState() {},
        },
        console,
        crypto: globalThis.crypto,
        CompressionStream: globalThis.CompressionStream,
        Response: globalThis.Response,
        Blob: globalThis.Blob,
        Promise,
        AbortController,
        Intl, JSON, Math, Date, Object, Array, String, Number, RegExp, Uint8Array, Error,
        encodeURIComponent, decodeURIComponent, unescape, escape, btoa, atob, parseFloat, isNaN,
        setTimeout, clearTimeout, setInterval, clearInterval,
        addEventListener(type, fn) { (listeners[type] ||= []).push(fn) },
        removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((f) => f !== fn) },
        async fetch(u, init = {}) {
            const req = await record(u, init.method || 'GET', init.body, init.headers, 'fetch')
            const res = respond(req) || { status: 200, body: { status: 1 } }
            const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body)
            return { status: res.status, text: async () => text }
        },
    }
    window.window = window
    window.self = window
    window.globalThis = window

    return {
        window, document, requests, elements, cookies,
        dispatch(type) { (listeners[type] || []).forEach((fn) => fn({ type })) },
        /** Runs a compiled bundle (or chunk) as a classic script. */
        loadScript(file) {
            if (!this.context) this.context = vm.createContext(window)
            vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), this.context, { filename: file })
        },
        /** Imports raw ES module sources with this window as the global. */
        async importSource(entry) {
            // The SDK only reads the `window` global (everything else hangs off it).
            globalThis.window = window
            // Each import needs fresh module state: add a cache-busting query.
            const u = pathToFileURL(path.join(ROOT, entry)).href + '?t=' + Math.random()
            return import(u)
        },
    }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Flattens all captured events from /e/ requests. */
export function capturedEvents(requests) {
    return requests.filter((r) => r.path === '/e/').flatMap((r) => r.body.batch)
}
