// SDK-side time by activity (size estimates, compression, persistence, ...) from saved
// session-benchmark profiles, for both SDKs.
//
//   node test/bench/activities.mjs DIR [--root ROOT] [--json OUT]
//
// DIR holds <variant>-<run>.cpuprofile from `bench:session --profile --save-profiles DIR`.
// ROOT is the checkout whose dist/ was profiled (default: this one).
//
// Every sample whose self time profile.mjs charges to the SDK (the SDK bundle or the
// replay logic, natives included via their closest JS caller) goes to the innermost
// frame on its stack that belongs to an activity below; the rest is "other SDK".
// Unlike the function lists, this is inclusive: `[native] Blob <- estimateSize` and the
// JSON.stringify under it both count as size estimates.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Attributor, makeLocator, findUpstream } from './profile.mjs'

const ACTIVITIES = [
    // [name, test({file, fn}) -> boolean]
    ['size estimate', ({ file, fn }) => /^(estimateSize|estimateStringBytes|stringifyForSize|utf8ByteLength(Slow)?|byteSize)\b/.test(fn) ||
        (/sessionrecording-utils\.ts$/.test(file) && /estimate/i.test(fn))],
    ['compression', ({ file, fn }) => /(^|\/)(gzip-field\.js|core\/gzip\.js|gzip\.(ts|mjs)|fflate[^/]*)$/.test(file) || /node_modules\/fflate/.test(file) ||
        /^(compressEvent|gzip|latin1FromBytes|serializeForCompression|crc32|deflate|strFromU8|strToU8)/i.test(fn)],
    ['persistence', ({ file, fn }) => /(^|\/)(storage\.(js|ts)|persistence\.js|posthog-persistence\.ts|cookie-utils\.mjs)$/.test(file) ||
        /^(getCookieValue|cookieStore|localStore|sessionStore)/.test(fn)],
    ['session id / activity', ({ file }) => /(^|\/)(session\.js|sessionid\.ts)$/.test(file)],
    ['autocapture / heatmaps / dead clicks', ({ file }) => /(autocapture|heatmaps|dead-clicks|rageclick)/.test(file)],
    ['scroll manager', ({ file }) => /scroll-manager\.(js|ts)$/.test(file)],
    ['request / batching', ({ file }) => /(^|\/)(request|request-queue|request-router|retry-queue)\.(js|ts)$/.test(file)],
]

function median(xs) {
    const s = xs.slice().sort((a, b) => a - b)
    if (!s.length) return 0
    const m = Math.floor(s.length / 2)
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export function activitiesOf(attributor, profile) {
    const nodes = new Map(profile.nodes.map((n) => [n.id, n]))
    const parent = new Map()
    for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id)
    const self = new Map()
    let t = profile.startTime
    const times = profile.samples.map((_, i) => (t += profile.timeDeltas[i]))
    for (let i = 0; i < profile.samples.length; i++) {
        const dt = (i + 1 < times.length ? times[i + 1] : profile.endTime) - times[i]
        if (dt > 0) self.set(profile.samples[i], (self.get(profile.samples[i]) || 0) + dt)
    }
    const frameCache = new Map()
    const frameOf = (id) => {
        if (!frameCache.has(id)) {
            const cf = nodes.get(id).callFrame
            frameCache.set(id, cf.url ? attributor.frame(cf) : null)
        }
        return frameCache.get(id)
    }
    const out = { 'SDK-only total': 0 }
    for (const [name] of ACTIVITIES) out[name] = 0
    out['other SDK'] = 0
    for (const [id, us] of self) {
        // the frame the sample is charged to: itself, or its closest JS caller for natives
        let p = id
        while (p !== undefined && !(nodes.get(p).callFrame.url && frameOf(p) && !frameOf(p).unmapped)) p = parent.get(p)
        const charged = p === undefined ? null : frameOf(p)
        if (!charged || (charged.bucket !== 'sdk' && charged.bucket !== 'replay')) continue
        out['SDK-only total'] += us
        let act = null
        for (let q = p; q !== undefined && !act; q = parent.get(q)) {
            const f = nodes.get(q).callFrame.url ? frameOf(q) : null
            if (!f || (f.bucket !== 'sdk' && f.bucket !== 'replay')) continue
            const hit = ACTIVITIES.find(([, test]) => test(f))
            if (hit) act = hit[0]
        }
        out[act || 'other SDK'] += us
        if (detail) {
            const leaf = nodes.get(id).callFrame
            const k = `${act || 'other SDK'} | ${leaf.url ? '' : '[native] ' + (leaf.functionName || '?') + ' <- '}${charged.fn} (${path.basename(charged.file)})`
            detail.set(k, (detail.get(k) || 0) + us)
        }
    }
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v / 1000]))
}

/** @type {Map<string, number>|null} µs per "activity | function", with --detail */
let detail = null

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2)
    const dir = args[0]
    const opt = (name) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : null)
    const root = path.resolve(opt('--root') || path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
    const { OFFICIAL_VERSION } = await import('../diff/server.mjs')
    const upstream = findUpstream(root) || findUpstream(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'))
    const vendor = path.join(root, 'test/diff/vendor', `posthog-js-${OFFICIAL_VERSION}`, 'dist')
    const a = new Attributor(makeLocator(root, vendor, upstream), null)
    const byVariant = {}
    const details = {}
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.cpuprofile')).sort()) {
        const [, key] = /^(.*)-(\d+)\.cpuprofile$/.exec(f)
        if (key === 'none') continue
        if (args.includes('--detail')) detail = details[key] = details[key] || new Map()
        ;(byVariant[key] = byVariant[key] || []).push(activitiesOf(a, JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))))
    }
    for (const [k, m] of Object.entries(details)) {
        const n = byVariant[k].length
        console.log(`\n[${k}] top functions per activity (mean ms over ${n} runs)`)
        for (const [name, us] of [...m].sort((x, y) => y[1] - x[1]).slice(0, Number(opt('--detail')) || 40)) console.log(`  ${(us / 1000 / n).toFixed(1).padStart(7)}  ${name}`)
    }
    const keys = ['official', 'ours', 'lazy'].filter((k) => byVariant[k]).concat(Object.keys(byVariant).filter((k) => !['official', 'ours', 'lazy'].includes(k)))
    const rows = {}
    for (const act of Object.keys(byVariant[keys[0]][0])) {
        rows[act] = Object.fromEntries(keys.map((k) => [k, Math.round(median(byVariant[k].map((r) => r[act])))]))
    }
    console.log(`SDK-only self time by activity, ms (median of ${keys.map((k) => `${byVariant[k].length} ${k}`).join(', ')} runs)`)
    console.table(rows)
    if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify({ medians: rows, runs: byVariant }, null, 2))
}
