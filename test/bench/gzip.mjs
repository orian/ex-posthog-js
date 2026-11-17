// Sync gzip benchmark: output size and encode time of our encoder (src/core/gzip.js
// gzipSync) against fflate 0.4.9's gzipSync(strToU8(s), {mtime: 0}) at its default
// level, which upstream uses, and Node's zlib at levels 1, 6 and 9 for reference, on
// the corpus in gzip-corpus.mjs. Every output is checked with zlib.gunzipSync.
//
//   node test/bench/gzip.mjs [--rounds N] [--ours path/to/gzip.js] [--markdown]
//
// test/third_party/fflate-0.4.9/ is esm/browser.js and LICENSE from the npm tarball
// fflate-0.4.9.tgz (sha1 b5d1fd9776e4d3cbcd1a83a1f163b984a0972e21), a dev-only copy;
// upstream's lockfile has 0.4.8, whose deflate is the same (0.4.9 only fixed Zip64).
//
// Times are per call (median of N rounds; each round repeats small inputs to ~2 ms),
// UTF-8 encoding included for ours and fflate (zlib gets the bytes). Node's zlib is
// native code, so its times are only a reference.
import path from 'node:path'
import zlib from 'node:zlib'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { ROOT } from '../harness.mjs'
import { loadCorpus } from './gzip-corpus.mjs'
import * as fflate from '../third_party/fflate-0.4.9/browser.js'

const args = process.argv.slice(2)
const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def)
const ROUNDS = Number(opt('--rounds', 15))
const MARKDOWN = args.includes('--markdown')
globalThis.window = globalThis
const ours = await import(pathToFileURL(path.resolve(ROOT, opt('--ours', 'src/core/gzip.js'))).href)

const IMPLS = [
    ['ours', (s) => ours.gzipSync(s)],
    ['fflate', (s) => fflate.gzipSync(fflate.strToU8(s), { mtime: 0 })],
    ['zlib-1', (s, b) => zlib.gzipSync(b, { level: 1 })],
    ['zlib-6', (s, b) => zlib.gzipSync(b, { level: 6 })],
    ['zlib-9', (s, b) => zlib.gzipSync(b, { level: 9 })],
]

const median = (xs) => xs.slice().sort((a, b) => a - b)[xs.length >> 1]
const rows = []
for (const c of loadCorpus()) {
    const bytes = Buffer.from(c.text, 'utf8')
    const reps = Math.max(1, Math.round(200000 / bytes.length))
    const sizes = {}
    const times = {}
    for (const [name, fn] of IMPLS) {
        const out = fn(c.text, bytes)
        const back = zlib.gunzipSync(out)
        if (!back.equals(bytes)) throw new Error(`${name} round trip failed on ${c.name}`)
        sizes[name] = out.length
        times[name] = []
        for (let i = 0; i < 3; i++) fn(c.text, bytes) // warm up
    }
    for (let r = 0; r < ROUNDS; r++) {
        for (const [name, fn] of IMPLS) {
            const t0 = performance.now()
            for (let i = 0; i < reps; i++) fn(c.text, bytes)
            times[name].push((performance.now() - t0) / reps)
        }
    }
    for (const k in times) times[k] = median(times[k])
    rows.push({ name: c.name, kind: c.kind, bytes: bytes.length, sizes, times })
}

const names = IMPLS.map((i) => i[0])
const total = (list, key) => {
    const t = { name: '', bytes: 0, sizes: {}, times: {} }
    for (const n of names) t.sizes[n] = t.times[n] = 0
    for (const r of list) {
        t.bytes += r.bytes
        for (const n of names) {
            t.sizes[n] += r.sizes[n]
            t.times[n] += r.times[n]
        }
    }
    t.name = key
    return t
}
const all = [...rows, total(rows.filter((r) => r.kind === 'events'), 'total events'),
    total(rows.filter((r) => r.kind === 'replay'), 'total replay'), total(rows, 'total')]

const ms = (x) => (x < 1 ? x.toFixed(3) : x < 10 ? x.toFixed(2) : x.toFixed(1))
const pct = (a, b) => (a / b * 100 - 100).toFixed(1).replace(/^(?!-)/, '+') + '%'
function print(title, head, line) {
    console.log(`\n${title}`)
    if (MARKDOWN) {
        console.log('| ' + head.join(' | ') + ' |')
        console.log('|' + head.map((h, i) => (i ? '---:' : '---')).join('|') + '|')
        for (const r of all) console.log('| ' + line(r).join(' | ') + ' |')
    } else {
        const w = head.map((h, i) => Math.max(h.length, ...all.map((r) => String(line(r)[i]).length)))
        console.log(head.map((h, i) => (i ? h.padStart(w[i]) : h.padEnd(w[i]))).join('  '))
        for (const r of all) console.log(line(r).map((v, i) => (i ? String(v).padStart(w[i]) : String(v).padEnd(w[i]))).join('  '))
    }
}
print('gzip size (bytes)', ['input', 'bytes', ...names, 'ours vs fflate'],
    (r) => [r.name, r.bytes, ...names.map((n) => r.sizes[n]), pct(r.sizes.ours, r.sizes.fflate)])
print('encode time (ms per call)', ['input', 'bytes', ...names, 'ours / fflate'],
    (r) => [r.name, r.bytes, ...names.map((n) => ms(r.times[n])), (r.times.ours / r.times.fflate).toFixed(2) + 'x'])
