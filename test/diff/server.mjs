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

const TYPES = { '.js': 'application/javascript', '.html': 'text/html', '.json': 'application/json', '.map': 'application/json' }

/** Decodes a request body the way the PostHog ingestion server does. */
function decodeBody(buf, url, contentType) {
    if (!buf.length) return undefined
    let raw = buf
    if (buf[0] === 0x1f && buf[1] === 0x8b) raw = zlib.gunzipSync(buf)
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
    const state = { log: [], responses: {} }

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
            if (host.startsWith('ph.')) return api(req, res, url, Buffer.concat(chunks))
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
            const known = m && (!m[1] || m[1] === OFFICIAL_VERSION) && fs.existsSync(path.join(VENDOR, m[2]))
            state.log.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), status: known ? 200 : 404 })
            if (!known) return res.writeHead(404).end('not found')
            return sendFile(res, path.join(VENDOR, m[2]))
        }
        const entry = {
            method: req.method,
            path: url.pathname,
            query: Object.fromEntries(url.searchParams),
            contentType: req.headers['content-type'],
            body: decodeBody(body, url, req.headers['content-type']),
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
        let file
        if (url.pathname.startsWith('/sdk/official/')) file = path.join(VENDOR, path.basename(url.pathname))
        else if (url.pathname.startsWith('/sdk/ours/')) file = path.join(ROOT, 'dist', url.pathname.slice('/sdk/ours/'.length))
        else file = path.join(ROOT, 'test/diff/pages', path.basename(url.pathname))
        sendFile(res, file)
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
