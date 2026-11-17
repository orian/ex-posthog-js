// Per-call cost of the two gzip paths in headless Chrome (4x CPU throttling by default):
// native CompressionStream (gzipCompress: TextEncoder, the stream, Response.blob(), the
// validation read and CRC-32) against the sync encoder (gzipSync), both followed by the
// latin1 conversion replay's cv '2024-10' fields go through. Inputs are real: every
// field replay gzips and every /e/ body, from a session benchmark log dump
// (--dump-logs) or the gzip corpus fixture.
//
//   node test/bench/gzip-chrome.mjs [--log DUMP.json] [--throttle R] [--ours src/core/gzip.js]
//                                   [--rounds N]
//
// Two native measurements per bucket:
// - "native cpu": a burst of calls started together (replay starts four per mutation
//   event), total time / calls. The main thread stays busy, so this is its CPU cost.
// - "native latency": one call at a time, start to resolve, idle waits included.
// "sync" is gzipSync + latin1 per call (what the drain path does).
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { ROOT } from '../harness.mjs'
import { startServer } from '../diff/server.mjs'
import { launchChrome } from '../diff/chrome.mjs'

const args = process.argv.slice(2)
const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def)
const THROTTLE = Number(opt('--throttle', 4))
const ROUNDS = Number(opt('--rounds', 5))
const OURS = path.resolve(ROOT, opt('--ours', 'src/core/gzip.js'))
const BUCKETS = [[0, 64], [64, 256], [256, 1024], [1024, 4096], [4096, 16384], [16384, 65536], [65536, Infinity]]
const label = ([lo, hi]) => (hi === Infinity ? `>= ${lo / 1024} KB` : hi <= 1024 ? `< ${hi} B` : `< ${hi / 1024} KB`)

const isGzipString = (v) => typeof v === 'string' && v.charCodeAt(0) === 0x1f && v.charCodeAt(1) === 0x8b
const gunzipText = (s) => zlib.gunzipSync(Buffer.from(s, 'latin1')).toString('utf8')

/** Every string the SDK gzips in one session: replay fields and /e/ bodies. */
export function sessionInputs(logFile) {
    let events, snapshots
    if (logFile) {
        const { log } = JSON.parse(fs.readFileSync(logFile, 'utf8'))
        events = log.filter((e) => /\/e\/$/.test(e.path) && e.body && e.body.batch).map((e) => e.body)
        snapshots = log.filter((e) => e.path === '/s/' && Array.isArray(e.body)).map((e) => e.body)
    } else {
        ;({ events, snapshots } = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'test/fixtures/gzip-corpus.json.gz'))).toString('utf8')))
    }
    const fields = []
    let emptyArrays = 0
    for (const batch of snapshots) {
        for (const e of batch) {
            for (const s of e.properties.$snapshot_data) {
                if (s.cv !== '2024-10') continue
                // An empty array is gzipped once per page and cached (gzipField): not a call.
                const add = (v) => { const t = gunzipText(v); if (t === '[]') emptyArrays++; else fields.push(t) }
                if (isGzipString(s.data)) add(s.data)
                else for (const k in s.data) if (isGzipString(s.data[k])) add(s.data[k])
            }
        }
    }
    return { fields, emptyArrays, bodies: events.map((b) => JSON.stringify(b)), replayBodies: snapshots.map((b) => JSON.stringify(b)) }
}

/** src/core/gzip.js as a classic script defining window.__gz. */
function gzipScript(file) {
    let src = fs.readFileSync(file, 'utf8')
    src = src.replace(/^import \{win\} from '\.\/utils\.js';$/m, 'const win = window;')
    if (/^import /m.test(src)) throw new Error('unexpected import in ' + file)
    const names = [...src.matchAll(/^export (?:function|const|let) (\w+)/gm)].map((m) => m[1])
    src = src.replace(/^export /gm, '')
    return `(function(){${src}\nwindow.__gz = {${names.join(',')}};})()`
}

/** Runs in the page: per-bucket timings. */
function pageBench(cases, rounds) {
    const gz = window.__gz
    const latin1 = (bytes) => {
        let out = ''
        for (let i = 0; i < bytes.length; i += 16384) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 16384))
        return out
    }
    const median = (xs) => xs.slice().sort((a, b) => a - b)[xs.length >> 1]
    const sync = (s) => latin1(gz.gzipSync(s))
    const native = (s) => gz.gzipCompress(s).then(latin1)
    // Stages of one native call, timed sequentially (latency per stage).
    const stages = async (s) => {
        const t0 = performance.now()
        const inputBytes = new TextEncoder().encode(s)
        const t1 = performance.now()
        const stream = new CompressionStream('gzip')
        const writer = stream.writable.getWriter()
        const w = writer.write(inputBytes).then(() => writer.close())
        const blobP = new Response(stream.readable).blob()
        const t2 = performance.now()
        const [blob] = await Promise.all([blobP, w])
        const t3 = performance.now()
        const buf = await blob.arrayBuffer()
        const t4 = performance.now()
        gz.crc32(inputBytes)
        const t5 = performance.now()
        latin1(new Uint8Array(buf))
        const t6 = performance.now()
        return [t1 - t0, t2 - t1, t3 - t2, t4 - t3, t5 - t4, t6 - t5]
    }
    return (async () => {
        const out = []
        for (const c of cases) {
            const xs = c.inputs
            if (!xs.length) continue
            // warm up
            for (let i = 0; i < Math.min(xs.length, 20); i++) { sync(xs[i]); await native(xs[i]) }
            const n = Math.max(xs.length, Math.min(400, Math.ceil(400000 / c.avg)))
            const pick = (i) => xs[i % xs.length]
            const r = { syncMs: [], cpuMs: [], latMs: [], stages: [] }
            for (let round = 0; round < rounds; round++) {
                let t = performance.now()
                for (let i = 0; i < n; i++) sync(pick(i))
                r.syncMs.push((performance.now() - t) / n)
                // bursts of 4 concurrent calls (a mutation event's four fields), back to back
                t = performance.now()
                for (let i = 0; i < n; i += 4) await Promise.all([0, 1, 2, 3].map((k) => native(pick(i + k))))
                r.cpuMs.push((performance.now() - t) / (Math.ceil(n / 4) * 4))
                const m = Math.min(n, 60)
                t = performance.now()
                for (let i = 0; i < m; i++) await native(pick(i))
                r.latMs.push((performance.now() - t) / m)
                const st = [0, 0, 0, 0, 0, 0]
                for (let i = 0; i < m; i++) (await stages(pick(i))).forEach((v, k) => (st[k] += v / m))
                r.stages.push(st)
            }
            out.push({ name: c.name, count: c.count, avg: c.avg, sync: median(r.syncMs), cpu: median(r.cpuMs), lat: median(r.latMs),
                stages: [0, 1, 2, 3, 4, 5].map((k) => median(r.stages.map((s) => s[k]))) })
        }
        return out
    })()
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
if (isMain) {
    const { fields, emptyArrays, bodies: eBodies, replayBodies } = sessionInputs(opt('--log'))
    const bodies = eBodies.concat(replayBodies)
    const all = [...fields.map((s) => ['field', s]), ...bodies.map((s) => ['body', s])]
    const cases = BUCKETS.map((b) => {
        const xs = all.filter(([, s]) => { const n = Buffer.byteLength(s); return n >= b[0] && n < b[1] }).map(([, s]) => s)
        const nF = fields.filter((s) => { const n = Buffer.byteLength(s); return n >= b[0] && n < b[1] }).length
        return { name: label(b), inputs: xs, count: { fields: nF, bodies: xs.length - nF },
            avg: xs.length ? xs.reduce((a, s) => a + Buffer.byteLength(s), 0) / xs.length : 0 }
    })
    console.error(`${fields.length} replay fields (+${emptyArrays} cached empty arrays), ${eBodies.length} /e/ + ${replayBodies.length} /s/ bodies · CPU ${THROTTLE}x · ${ROUNDS} rounds · ${path.relative(ROOT, OURS)}`)
    const srv = await startServer()
    const chrome = await launchChrome()
    let res
    try {
        const page = await chrome.newPage()
        await page.cdp('Emulation.setCPUThrottlingRate', { rate: THROTTLE })
        await page.goto(`http://app.example.test:${srv.port}/gzip-bench-blank`)
        await page.waitFor('document.readyState === "complete"')
        await page.evaluate(gzipScript(OURS))
        res = await page.evaluate(`(${pageBench})(${JSON.stringify(cases.map((c) => ({ name: c.name, inputs: c.inputs.slice(0, 400), count: c.count, avg: c.avg })))}, ${ROUNDS})`)
        await page.close()
    } finally {
        chrome.close()
        srv.server.close()
    }
    const f = (x, d = 3) => (x === undefined ? '-' : x < 0.1 ? x.toFixed(d) : x < 10 ? x.toFixed(2) : x.toFixed(1))
    console.table(res.map((r) => ({
        bucket: r.name, 'fields': r.count.fields, 'bodies': r.count.bodies, 'avg B': Math.round(r.avg),
        'sync ms': f(r.sync), 'native cpu ms': f(r.cpu), 'native latency ms': f(r.lat), 'native/sync (cpu)': (r.cpu / r.sync).toFixed(1),
        'session ms sync': f((r.count.fields + r.count.bodies) * r.sync, 1), 'session ms native': f((r.count.fields + r.count.bodies) * r.cpu, 1),
    })))
    console.log('Native stages, sequential (ms per call): TextEncoder, CS setup+write+Response(), blob() resolve, arrayBuffer(), crc32, latin1')
    console.table(res.map((r) => Object.fromEntries([['bucket', r.name], ...['encode', 'setup', 'blob()', 'arrayBuffer()', 'crc32', 'latin1'].map((k, i) => [k, f(r.stages[i])])])))
    if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify(res, null, 2))
    process.exit(0)
}
