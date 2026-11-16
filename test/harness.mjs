// Minimal fake browser for running the SDK (source or compiled) under Node.
// Captures every network request so tests can assert on the wire format.
import vm from 'node:vm'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export class FakeStorage {
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
    get localName() { return this.tagName.toLowerCase() }
}

/**
 * @param {object} opts
 * @param {string} [opts.url]
 * @param {(req) => {status:number, body:any}|undefined} [opts.respond]
 * @param {Map<string, string>} [opts.cookies] cookie jar; give two browsers the same one
 *   (and the same localStorage) to model two tabs of one site
 * @param {FakeStorage} [opts.localStorage]
 */
export function createBrowser(opts = {}) {
    const url = new URL(opts.url || 'https://app.example.com/pricing?utm_source=newsletter')
    const requests = []
    const listeners = {}
    const cookies = opts.cookies || new Map() // pass the same Map (and localStorage) to two browsers for two tabs
    const elements = { '#hero': [new FakeElement('h1', 'hero')] }

    const respond = opts.respond || (() => undefined)

    const listenersDoc = {}
    const scripts = []
    // <script> injection: the request is recorded, then the load fails (scripts
    // don't execute here), so the SDK takes its JSON fallback paths. A route
    // answering { script: fn } instead runs fn(window) (awaited when it returns
    // a promise) and fires onload.
    const appendScript = (el) => {
        if (el.tagName !== 'SCRIPT') return el
        scripts.push(el)
        const u = new URL(el.src)
        const req = { url: el.src, method: 'GET', path: u.pathname, transport: 'script' }
        requests.push(req)
        const res = respond(req)
        setTimeout(async () => {
            if (res && typeof res.script === 'function') {
                await res.script(window)
                el.onload && el.onload({ type: 'load' })
            } else {
                el.onerror && el.onerror({ type: 'error' })
            }
        }, 1)
        return el
    }
    const makeElement = (tag) => {
        const el = new FakeElement(tag)
        el.addEventListener = () => {}
        return el
    }
    const document = {
        title: 'Pricing',
        URL: url.href,
        readyState: 'complete',
        visibilityState: 'visible',
        body: { appendChild: appendScript, tagName: 'BODY' },
        head: { appendChild: appendScript, tagName: 'HEAD' },
        documentElement: { scrollHeight: 2000, clientHeight: 800, scrollTop: 0, scrollLeft: 0 },
        createElement: makeElement,
        removeEventListener() {},
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
        querySelectorAll(sel) { return sel === 'script' || sel === 'body > script' ? [] : elements[sel] || [] },
        querySelector(sel) { return (elements[sel] || [])[0] || null },
        addEventListener(type, fn) { (listenersDoc[type] ||= []).push(fn) },
        getSelection() { return null },
    }

    const decodeBody = async (u, body) => {
        if (body === undefined || body === null) return undefined
        if (typeof body !== 'string') {
            const buf = Buffer.isBuffer(body) ? body : typeof body.arrayBuffer === "function"
                ? Buffer.from(await body.arrayBuffer())
                : Buffer.from(ArrayBuffer.isView(body) ? body.buffer : body)
            if (buf[0] === 0x1f && buf[1] === 0x8b) return JSON.parse(zlib.gunzipSync(buf).toString('utf8'))
            body = buf.toString('utf8')
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
        req.query = Object.fromEntries(new URL(u).searchParams)
        requests.push(req)
        return req
    }

    const window = {
        location: {
            href: url.href, host: url.host, hostname: url.hostname, pathname: url.pathname,
            search: url.search, protocol: url.protocol, hash: url.hash, origin: url.origin,
        },
        navigator: {
            userAgent: opts.userAgent ||
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
            language: 'en-US',
            onLine: true,
            sendBeacon(u, blob) {
                blob.arrayBuffer().then((b) => record(u, 'POST', Buffer.from(b), {}, 'sendBeacon'))
                return true
            },
        },
        document,
        screen: { width: 1440, height: 900 },
        innerWidth: 1200, innerHeight: 800,
        localStorage: opts.localStorage || new FakeStorage(),
        sessionStorage: new FakeStorage(),
        history: {
            pushState(_s, _t, p) { window.location.pathname = p; window.location.href = url.origin + p; document.URL = window.location.href },
            replaceState() {},
        },
        console,
        crypto: globalThis.crypto,
        CompressionStream: globalThis.CompressionStream,
        Response: globalThis.Response,
        Blob: globalThis.Blob,
        Promise,
        AbortController,
        Intl, JSON, Math, Date, Object, Array, String, Number, RegExp, Uint8Array, Int32Array, ArrayBuffer, Error,
        URL, Headers, TypeError,
        // Observes nothing (no DOM here); enough for the dead click detector to start.
        MutationObserver: class { observe() {} disconnect() {} takeRecords() { return [] } },
        performance: { now: () => performance.now() },
        encodeURIComponent, decodeURIComponent, unescape, escape, btoa, atob, parseFloat, isNaN,
        setTimeout, clearTimeout, setInterval, clearInterval,
        onpagehide: null,
        addEventListener(type, fn) { (listeners[type] ||= []).push(fn) },
        removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((f) => f !== fn) },
        async fetch(u, init = {}) {
            const req = await record(u, init.method || 'GET', init.body, init.headers, 'fetch')
            const res = respond(req) || { status: 200, body: { status: 1 } }
            const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body)
            return { status: res.status, text: async () => text, headers: new Headers() }
        },
    }
    window.window = window
    document.location = window.location
    window.self = window
    window.globalThis = window

    return {
        window, document, requests, elements, cookies, scripts,
        dispatch(type) { (listeners[type] || []).forEach((fn) => fn({ type })) },
        /**
         * Runs a compiled bundle (or chunk) as a classic script, served from
         * `<origin>/<file>` (document.currentScript while it runs).
         */
        loadScript(file) {
            if (!this.context) this.context = vm.createContext(window)
            document.currentScript = { src: `${url.origin}/${file}` }
            try {
                vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), this.context, { filename: file })
            } finally {
                document.currentScript = null
            }
        },
        /**
         * Imports raw ES module sources with this window as the global. With
         * `fresh`, the entry gets its own module state (a cache-busting query);
         * modules it imports are shared within the process.
         */
        async importSource(entry, fresh = true) {
            // The SDK only reads the `window` global (everything else hangs off it).
            globalThis.window = window
            document.currentScript = { src: `${url.origin}/${entry}` }
            try {
                const u = pathToFileURL(path.join(ROOT, entry)).href + (fresh ? '?t=' + Math.random() : '')
                return await import(u)
            } finally {
                document.currentScript = null
            }
        },
    }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Flattens all captured events from /e/ requests. */
export function capturedEvents(requests) {
    return requests.filter((r) => r.path === '/e/').flatMap((r) => r.body.batch)
}
