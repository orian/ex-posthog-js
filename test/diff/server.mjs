// Fake PostHog + static file server for differential tests.
// - http://app.example.test:<port>/...  serves test pages and SDK files
// - http://ph.example.test:<port>/...   fake PostHog API (records every request)
// Chrome maps *.example.test to 127.0.0.1 (--host-resolver-rules).
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { ROOT } from '../harness.mjs'

export const OFFICIAL_VERSION = '1.450.0'
const VENDOR = path.join(ROOT, 'test/diff/vendor', `posthog-js-${OFFICIAL_VERSION}`, 'dist')

const TYPES = { '.js': 'application/javascript', '.html': 'text/html', '.json': 'application/json', '.map': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml' }

// Static directory mounts: URL prefix -> directory. Paths without a file extension that
// don't exist fall back to the mount's index.html (single page apps with pushState routes).
const MOUNTS = {
    '/site/': path.join(ROOT, 'test/bench/site'), // the session benchmark's demo app
}

/** Decodes a request body the way the PostHog ingestion server does. */
function decodeBody(buf, url, contentType) {
    if (!buf.length) return undefined
    let raw = buf
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
        // A corrupt gzip body (bad CRC, truncated) is what ingestion would reject: record it as such.
        try {
            raw = zlib.gunzipSync(buf)
        } catch (e) {
            return `<invalid gzip: ${e.code || e.message}>`
        }
    }
    let text = raw.toString('utf8')
    const compression = url.searchParams.get('compression')
    if ((contentType || '').includes('x-www-form-urlencoded') || text.startsWith('data=')) {
        const data = new URLSearchParams(text).get('data')
        text = compression === 'base64' || !data.trim().startsWith('{') && !data.trim().startsWith('[')
            ? Buffer.from(data, 'base64').toString('utf8') : data
    }
    try {
        return JSON.parse(text)
    } catch {
        return text
    }
}

export function startServer({ port = 0 } = {}) {
    // log: requests to the fake PostHog (compared); sdkLog: the SDK files pages load from
    // /sdk/ (not compared; the lazy-chunk order check reads it). `seq` orders both logs.
    const state = { log: [], sdkLog: [], responses: {}, seq: 0 }

    const server = http.createServer((req, res) => {
        const host = (req.headers.host || '').split(':')[0]
        const url = new URL(req.url, `http://${req.headers.host}`)
        const origin = req.headers.origin
        if (origin) {
            res.setHeader('Access-Control-Allow-Origin', origin)
            res.setHeader('Access-Control-Allow-Credentials', 'true')
            res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || '*')
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        }
        if (req.method === 'OPTIONS') return res.writeHead(204).end()

        const chunks = []
        req.on('data', (c) => chunks.push(c))
        req.on('end', () => {
            // SDK bundles are also served from the API host: the session benchmark loads them from
            // api_host when it injects an SDK into an arbitrary (possibly https) site.
            if (url.pathname.startsWith('/sdk/')) return statics(res, url)
            if (host.startsWith('ph.')) return api(req, res, url, Buffer.concat(chunks))
            if (url.pathname === '/__echo') return echo(req, res, url, host, Buffer.concat(chunks))
            return statics(res, url)
        })
    })

    function api(req, res, url, body) {
        // Lazy-loaded SDK assets (official only): /static/<file>.js
        if (url.pathname.startsWith('/static/')) {
            // Behave like PostHog's CDN: /static/<file> (latest) or /static/<version>/<file>
            // exist only for real upstream versions; anything else is a 404 (and is logged
            // as such, so the diff can flag SDKs requesting assets that don't exist).
            const m = /^\/static\/(?:([^/]+)\/)?([^/]+)$/.exec(url.pathname)
            const versionOk = !!m && (!m[1] || m[1] === OFFICIAL_VERSION)
            const entry = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), seq: state.seq++ }
            state.log.push(entry)
            if (versionOk && m[2] === 'toolbar.js') {
                // A scenario may 404 the versioned toolbar on purpose (to exercise the fallback).
                const forced = url.pathname !== '/static/toolbar.js' && state.responses.versionedToolbar
                entry.status = forced ? forced.status : 200
                if (forced) entry.expected404 = true
                return serveToolbarStub(res, url, state)
            }
            const known = versionOk && fs.existsSync(path.join(VENDOR, m[2]))
            entry.status = known ? 200 : 404
            if (!known) return res.writeHead(404).end('not found')
            return sendFile(res, path.join(VENDOR, m[2]))
        }
        const entry = {
            method: req.method,
            path: url.pathname,
            query: Object.fromEntries(url.searchParams),
            contentType: req.headers['content-type'],
            bytes: body.length, // on-the-wire request body size (benchmarks)
            at: Date.now(), // receive time (benchmarks)
            body: decodeBody(body, url, req.headers['content-type']),
            seq: state.seq++,
        }
        state.log.push(entry)
        const custom = state.responses[url.pathname] ?? matchPrefix(url.pathname)
        const reply = typeof custom === 'function' ? custom(entry) : custom
        if (reply && reply.script) {
            res.writeHead(200, { 'Content-Type': 'application/javascript' })
            return res.end(reply.script)
        }
        res.writeHead(reply?.status ?? 200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(reply?.body ?? { status: 1 }))
    }

    function matchPrefix(p) {
        for (const k of Object.keys(state.responses)) {
            if (k.endsWith('*') && p.startsWith(k.slice(0, -1))) return state.responses[k]
        }
        return undefined
    }

    function statics(res, url) {
        if (url.pathname.startsWith('/sdk/')) {
            state.sdkLog.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), seq: state.seq++ })
        }
        let file
        if (url.pathname.startsWith('/sdk/official/')) file = path.join(VENDOR, path.basename(url.pathname))
        else if (url.pathname.startsWith('/sdk/ours/')) file = path.join(ROOT, 'dist', url.pathname.slice('/sdk/ours/'.length))
        else if (mountFor(url.pathname)) file = mountFor(url.pathname)
        else file = path.join(ROOT, 'test/diff/pages', path.basename(url.pathname))
        sendFile(res, file)
    }

    // Any non-PostHog host: /__echo records the page's request (host, method,
    // query, every request header and the body) in the log, so scenarios can
    // compare what the SDKs added to the app's own requests (e.g. tracing headers).
    function echo(req, res, url, host, body) {
        const headers = {}
        for (const k of Object.keys(req.headers).sort()) headers[k] = req.headers[k]
        state.log.push({
            method: req.method,
            path: url.pathname,
            query: Object.fromEntries(url.searchParams),
            contentType: req.headers['content-type'],
            body: { host, headers, body: body.length ? body.toString('utf8') : undefined },
        })
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ ok: true }))
    }

    function mountFor(pathname) {
        const prefix = Object.keys(MOUNTS).find((p) => pathname === p.slice(0, -1) || pathname.startsWith(p))
        if (!prefix) return null
        const dir = MOUNTS[prefix]
        const file = path.join(dir, path.normalize('/' + pathname.slice(prefix.length)))
        if (!file.startsWith(dir)) return null
        if (fs.existsSync(file) && fs.statSync(file).isFile()) return file
        return path.extname(file) ? file : path.join(dir, 'index.html')
    }

    function sendFile(res, file) {
        if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end('not found')
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
        fs.createReadStream(file).pipe(res)
    }

    return new Promise((resolve) => {
        server.listen(port, '0.0.0.0', () => resolve({ server, state, port: server.address().port }))
    })
}

// ---- toolbar ---------------------------------------------------------------------
// The hosted toolbar bundle is not part of either SDK: this stub records each
// `ph_load_toolbar(params, posthog)` call so scenarios can compare them.
const TOOLBAR_STUB = `(function () {
  window.ph_load_toolbar = function (params, posthog) {
    (window.__toolbarCalls = window.__toolbarCalls || []).push({
      params: JSON.parse(JSON.stringify(params)),
      isGlobalInstance: posthog === window.posthog,
    })
  }
})()`

// With `responses.versionedToolbar = { status: 404 }`, `/static/<version>/toolbar.js` fails,
// so the SDK falls back to `/static/toolbar.js?v=...&t=...`.
function serveToolbarStub(res, url, state) {
    const versioned = url.pathname !== '/static/toolbar.js'
    if (versioned && state.responses.versionedToolbar) return res.writeHead(state.responses.versionedToolbar.status).end('not found')
    res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' })
    res.end(TOOLBAR_STUB)
}
