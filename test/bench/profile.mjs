// CPU attribution for the session benchmark (`--profile`): runs the CDP sampling profiler
// over the measured window and attributes the self time of every sample to a bucket
// (page, SDK bundle, PostHog replay logic, rrweb, other lazy PostHog scripts, browser)
// and to an original source file + function, through the bundles' source maps
// (node:module SourceMap, no dependencies).
//
// rrweb is one pre-built file inside PostHog's bundles (`rrweb/record/dist/rrweb-record.js`,
// whose own source map isn't published), so to get from there to rrweb's TypeScript
// files (mutation.ts, snapshot.ts, observer.ts, ...) we index the function names declared
// in the upstream rrweb sources (upstream/packages/rrweb, same version as 1.450.0) and
// use the names the bundle's source map gives for rrweb-record.js positions: a named
// function is looked up directly, an anonymous one takes the file of the closest named
// function before it in rrweb-record.js (modules are concatenated, so that is the
// enclosing or a sibling function in the same module).
import fs from 'node:fs'
import path from 'node:path'
import { SourceMap } from 'node:module'
import { fileURLToPath } from 'node:url'

// ---- recording -------------------------------------------------------------------------
export async function startProfile(page, intervalUs) {
    await page.cdp('Profiler.enable')
    await page.cdp('Profiler.setSamplingInterval', { interval: intervalUs })
    await page.cdp('Profiler.start')
}
export async function stopProfile(page) {
    const { profile } = await page.cdp('Profiler.stop')
    await page.cdp('Profiler.disable')
    return profile
}

// ---- buckets ----------------------------------------------------------------------------
export const BUCKETS = {
    page: 'page / app code',
    sdk: 'SDK bundle (excl. replay logic)',
    replay: 'PostHog replay logic',
    rrweb: 'rrweb + recorder plugins',
    lazy: 'other PostHog lazy scripts',
    browser: 'browser / native (no JS caller)',
    other: 'other (bench harness, evaluate)',
    gc: '(garbage collector)',
    program: '(program)',
    idle: '(idle)',
}
/** Buckets that are SDK cost (SDK-only = sdk + replay; rrweb separately). */
export const SDK_BUCKETS = ['sdk', 'replay', 'rrweb', 'lazy']

// ---- source maps ---------------------------------------------------------------------------
/** Shortens a source map path: '../src/x.ts' -> 'browser/src/x.ts', '../../core/dist/..' -> 'core/dist/..'. */
function cleanSource(s, ours) {
    if (ours) return s
    if (/fflate/.test(s)) return 'fflate/esm/browser.js'
    const nm = s.lastIndexOf('node_modules/')
    if (nm >= 0) return s.slice(nm)
    if (s.startsWith('../src/')) return 'browser/' + s.slice(3)
    return s.replace(/^(\.\.\/)+/, '')
}

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'typeof', 'new', 'await', 'super', 'else', 'do', 'try', 'with'])

class Bundle {
    /** @param {(rawSource: string) => string|null} [sourceFile] local path of an original source, if available */
    constructor(jsFile, ours, sourceFile) {
        this.ours = ours
        this.sourceFile = sourceFile || (() => null)
        this.lines = fs.readFileSync(jsFile, 'utf8').split('\n')
        const mapFile = jsFile + '.map'
        this.map = fs.existsSync(mapFile) ? new SourceMap(JSON.parse(fs.readFileSync(mapFile, 'utf8'))) : null
        this.cache = new Map()
        this.sources = new Map()
    }
    /**
     * Original {source, line (1-based), name} of the function starting at the profile's
     * 0-based (line, column) (findEntry is 0-based too). V8 reports the start of the
     * parameter list, so the name comes from the map's `names` entry on the name token
     * (terser: `function cr(`, `x.foo=function(`, `foo:(a)=>`) or on the `function` keyword
     * (Closure), else from the original source line when we have it, else null.
     */
    resolve(line, col) {
        const k = line + ':' + col
        if (this.cache.has(k)) return this.cache.get(k)
        let r = null
        if (this.map) {
            const e = this.map.findEntry(line, col)
            if (e && e.originalSource) {
                r = { source: cleanSource(e.originalSource, this.ours), line: e.originalLine + 1, name: null }
                for (const tok of nameTokens(this.lines[line] || '', col)) {
                    const n = this.map.findEntry(line, tok)
                    if (n && n.generatedColumn === tok && n.name) { r.name = n.name; break }
                }
                if (!r.name) r.name = this.nameFromSource(e.originalSource, e.originalLine, e.originalColumn)
            }
        }
        this.cache.set(k, r)
        return r
    }
    /** The definition on the original source line closest to (at or before) the column. */
    nameFromSource(raw, line, col) {
        if (!this.sources.has(raw)) {
            const f = this.sourceFile(raw)
            this.sources.set(raw, f && fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n') : null)
        }
        const text = this.sources.get(raw)?.[line]
        if (!text) return null
        const re = /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(|([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)|^\s*(?:(?:static|async|get|set|private|public|protected)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{/g
        let best = null
        for (let m; (m = re.exec(text)); ) {
            const name = m[1] || m[2] || m[3]
            if (KEYWORDS.has(name)) continue
            if (m.index > col && best !== null) break
            best = name
        }
        return best
    }
}

const ID = /[\w$]/
/** Generated columns that may carry the function's name: the name token, then the `function` keyword. */
function nameTokens(text, col) {
    const out = []
    let p = col - 1
    const skip = () => { while (p >= 0 && /\s/.test(text[p])) p-- }
    const ident = () => {
        const end = p
        while (p >= 0 && ID.test(text[p])) p--
        return { start: p + 1, word: text.slice(p + 1, end + 1) }
    }
    skip()
    if (p >= 0 && ID.test(text[p])) {
        let t = ident()
        if (t.word !== 'function' && t.word !== 'async') {
            out.push(t.start) // function foo( / foo(){ / get foo(
            skip()
            if (text[p] === '*') { p--; skip() }
            if (p >= 0 && ID.test(text[p]) && (t = ident()).word === 'function') out.push(t.start)
            return out
        }
        out.push(t.start) // `function` keyword of a function expression
        skip()
    }
    // function expression or arrow: `x.foo=function(`, `foo:function(`, `foo=(a)=>`
    if (p >= 0 && (text[p] === ':' || (text[p] === '=' && !/[=!<>]/.test(text[p - 1] || '')))) {
        p--
        skip()
        if (p >= 0 && ID.test(text[p])) out.unshift(ident().start)
    }
    return out
}

// ---- rrweb-record.js -> rrweb TypeScript file ----------------------------------------------
// The console plugin is a separate source in the maps, so it isn't indexed.
const RRWEB_DIRS = ['rrweb/src', 'rrweb-snapshot/src', 'utils/src', 'types/src', 'record/src']

/** name -> Set of rrweb source files that declare a function/method/class of that name. */
function indexRrweb(rrwebDir) {
    const index = new Map()
    const add = (name, file) => { if (!KEYWORDS.has(name)) (index.get(name) || index.set(name, new Set()).get(name)).add(file) }
    const walk = (dir) => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, ent.name)
            // record-side code only: rrweb-record.js has no replayer / rebuild code
            if (ent.isDirectory()) { if (!/test|__|^replay$/.test(ent.name)) walk(p) } else if (/\.ts$/.test(ent.name) && !/\.d\.ts$|test|^(rebuild|replay)\.ts$/.test(ent.name)) {
                const file = path.relative(rrwebDir, p)
                for (const l of fs.readFileSync(p, 'utf8').split('\n')) {
                    let m
                    if ((m = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(l))) add(m[1], file)
                    else if ((m = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function|\(|[A-Za-z_$][\w$]*\s*=>|throttle|callbackWrapper)/.exec(l))) add(m[1], file)
                    else if ((m = /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(l))) add(m[1], file)
                    else if ((m = /^\s+(?:(?:public|private|protected|static|async|readonly|get|set|override)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^;]*\)\s*(?::[^{;]+)?\{\s*$/.exec(l))) add(m[1], file)
                    else if ((m = /^\s+(?:(?:public|private|protected|static|readonly)\s+)*([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?\(/.exec(l))) add(m[1], file)
                }
            }
        }
    }
    for (const d of RRWEB_DIRS) if (fs.existsSync(path.join(rrwebDir, d))) walk(path.join(rrwebDir, d))
    return index
}

/** Anchors: [rrweb-record.js line, name, file] for named functions declared in exactly one file. */
function rrwebAnchors(rawMap, index) {
    const sm = new SourceMap(rawMap)
    const srcIdx = rawMap.sources.findIndex((s) => /rrweb-record\.js$/.test(s))
    if (srcIdx < 0) return []
    const seen = new Map()
    // Decode every segment through the public API: walk generated positions of names.
    // (SourceMap has no iterator, so decode `mappings` lines and use findEntry per segment.)
    const lines = rawMap.mappings.split(';')
    for (let gl = 0; gl < lines.length; gl++) {
        let gc = 0
        for (const seg of lines[gl].split(',')) {
            if (!seg) continue
            gc += vlq(seg)[0]
            const e = sm.findEntry(gl, gc)
            if (!e || !e.name || !/rrweb-record\.js$/.test(e.originalSource || '')) continue
            const files = index.get(e.name)
            if (!files || files.size !== 1) continue
            const key = e.originalLine + ':' + e.name
            if (!seen.has(key)) seen.set(key, [e.originalLine + 1, e.name, [...files][0]])
        }
    }
    return [...seen.values()].sort((a, b) => a[0] - b[0])
}
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function vlq(s) {
    const out = []
    let v = 0, shift = 0
    for (const ch of s) {
        const d = B64.indexOf(ch)
        v += (d & 31) << shift
        if (d & 32) shift += 5
        else { out.push(v & 1 ? -(v >>> 1) : v >>> 1); v = 0; shift = 0 }
    }
    return out
}

/**
 * Maps the benchmark's script URL paths to local bundles: /sdk/official/X and
 * /static/[<version>/]X -> the official dist, /sdk/ours/P -> dist/P. Original sources
 * (for names the maps don't carry): ours under the repo root, upstream's under
 * upstream/packages/browser (the official maps are relative to packages/browser/dist).
 */
export function makeLocator(root, vendorDist, upstream) {
    const official = (raw) => (upstream ? path.resolve(upstream, 'packages/browser/dist', raw) : null)
    return (p) => {
        if (p.startsWith('/sdk/ours/')) return { file: path.join(root, 'dist', p.slice('/sdk/ours/'.length)), ours: true, sourceFile: (raw) => path.join(root, raw) }
        if (p.startsWith('/sdk/official/') || p.startsWith('/static/')) return { file: path.join(vendorDist, path.basename(p)), ours: false, sourceFile: official }
        return null
    }
}

/** Finds upstream/ (git-ignored, so in a worktree it lives in the main checkout). */
export function findUpstream(root) {
    const cands = [process.env.PH_UPSTREAM, path.join(root, 'upstream')]
    const m = /^(.*)\/\.claude\/worktrees\/[^/]+$/.exec(root)
    if (m) cands.push(path.join(m[1], 'upstream'))
    return cands.find((c) => c && fs.existsSync(path.join(c, 'packages/rrweb'))) || null
}

// ---- activities ---------------------------------------------------------------------------
// By code: which rrweb file the sampled function lives in.
function codeActivity(file, fn) {
    if (!file) return 'rrweb-record.js (unattributed)'
    if (/rrweb-snapshot\/src\/(snapshot|snapshot-cost)\.ts$/.test(file)) return 'serialisation (rrweb-snapshot snapshot.ts)'
    if (/rrweb-snapshot\/src\/(css|stylesheet-source)\.ts$|stylesheet-(manager|source-observer)\.ts$/.test(file)) return 'stylesheets'
    if (/rrweb-snapshot\/src\/utils\.ts$/.test(file)) return 'rrweb-snapshot utils (Mirror, masking, attributes)'
    if (/record\/(mutation|processed-node-manager)\.ts$/.test(file)) return 'mutation processing (mutation.ts)'
    if (/record\/observer\.ts$/.test(file)) return 'observers (observer.ts)'
    if (/record\/(shadow-dom-manager|iframe-manager|cross-origin-iframe-mirror)\.ts$|observers\/canvas/.test(file)) return 'shadow DOM / iframes / canvas'
    if (/record\/index\.ts$/.test(file)) return 'record core: emit / buffering / checkout'
    if (/console-record|network-plugin|denylist/.test(file)) return 'console / network plugins'
    if (/rrweb\/src\/utils\.ts$|utils\/src\/index\.ts$|error-handler\.ts$|idle\.ts$/.test(file)) return 'rrweb utils (isBlocked, throttle, patch, getWindow...)'
    return 'other rrweb: ' + file
}
// By context: the innermost rrweb frame on the sample's stack that says what rrweb is
// doing (e.g. serializeNodeWithId under pushAdd is mutation processing, under
// takeFullSnapshot a full snapshot); generic helpers (utils, serialisation) defer to
// their callers. Anonymous functions use the closest named function before them (`near`).
function contextActivity(frame) {
    const { file, fn, near } = frame
    if (!file) return null
    const n = fn || near || ''
    if (/takeFullSnapshot/.test(n) || (/rrweb-snapshot\/src\/snapshot\.ts$/.test(file) && n === 'snapshot')) return 'full snapshot'
    if (/record\/(mutation|processed-node-manager)\.ts$/.test(file) || /mutation(Emit|Observer|Cb)/i.test(n)) return 'mutations'
    if (/record\/(observer|index)\.ts$/.test(file)) {
        // init*Observer functions, their inner handlers and record()'s *Cb / wrapped*Emit callbacks
        if (/styleSheet|styleDeclaration|font/i.test(n)) return 'stylesheets'
        if (/scroll/i.test(n)) return 'observer: scroll'
        if (/move|wrappedCb|updatePosition/i.test(n)) return 'observer: mouse move'
        if (/mouseInteraction|getHandler/i.test(n)) return 'observer: mouse interaction'
        if (/input|eventHandler|cbWithDedup|hookSetter/i.test(n)) return 'observer: input'
        if (/viewport|updateDimension/i.test(n)) return 'observer: viewport resize'
        if (/selection/i.test(n)) return 'observer: selection'
        if (/record\/index\.ts$/.test(file)) return 'emit / buffering (record/index.ts)'
        return null // helpers such as getEventTarget: decided by a caller
    }
    if (/stylesheet|css\.ts/.test(file)) return 'stylesheets'
    if (/console-record|network-plugin|denylist/.test(file)) return 'console / network plugins'
    if (/shadow-dom|iframe|canvas/.test(file)) return 'shadow DOM / iframes / canvas'
    return null
}

// ---- attribution ---------------------------------------------------------------------------
export class Attributor {
    /**
     * @param {(urlPath: string) => {file: string, ours: boolean} | null} locate local file for a script URL path
     * @param {string|null} upstream upstream/ checkout (for rrweb file attribution)
     */
    constructor(locate, upstream) {
        this.locate = locate
        this.bundles = new Map()
        this.rrwebIndex = upstream ? indexRrweb(path.join(upstream, 'packages/rrweb')) : null
        this.anchors = new Map() // bundle file -> anchors
    }
    bundle(urlPath) {
        if (this.bundles.has(urlPath)) return this.bundles.get(urlPath)
        const loc = this.locate(urlPath)
        let b = null
        if (loc && fs.existsSync(loc.file)) {
            b = new Bundle(loc.file, loc.ours, loc.sourceFile)
            if (this.rrwebIndex && fs.existsSync(loc.file + '.map')) {
                const raw = JSON.parse(fs.readFileSync(loc.file + '.map', 'utf8'))
                if (raw.sources.some((s) => /rrweb-record\.js$/.test(s))) b.anchors = rrwebAnchors(raw, this.rrwebIndex)
            }
        }
        this.bundles.set(urlPath, b)
        return b
    }
    /** rrweb-record.js line + name -> {file, near} using the upstream index and anchors. */
    rrwebFile(b, line, name) {
        if (!this.rrwebIndex) return { file: null, near: null }
        const files = name && this.rrwebIndex.get(name)
        const a = b.anchors || []
        // closest named function at or before `line` (binary search)
        let lo = 0, hi = a.length - 1, best = -1
        while (lo <= hi) { const mid = (lo + hi) >> 1; if (a[mid][0] <= line) { best = mid; lo = mid + 1 } else hi = mid - 1 }
        const near = best >= 0 ? a[best] : null
        if (files && files.size === 1) return { file: [...files][0], near: near && near[1] }
        if (files && near && files.has(near[2])) return { file: near[2], near: near[1] }
        return { file: near ? near[2] : null, near: near && near[1] }
    }
    /** Classifies one profile call frame -> {bucket, file, fn, rrweb?: {file, fn, near}}. */
    frame(cf) {
        let url
        try { url = new URL(cf.url) } catch { return null }
        const p = url.pathname
        if (/^\/site\//.test(p) || (url.hostname.startsWith('app.') && !p.startsWith('/sdk/'))) {
            return { bucket: 'page', file: p.replace(/^\//, ''), fn: (cf.functionName || '(anonymous)') }
        }
        let bucket
        if (p.startsWith('/sdk/')) bucket = 'sdk'
        else if (/^\/static\/(?:[^/]+\/)?(lazy-recorder|recorder)\.js$/.test(p)) bucket = 'replay'
        else if (p.startsWith('/static/')) bucket = 'lazy'
        else return { bucket: 'other', file: cf.url, fn: cf.functionName || '(anonymous)' }
        const b = this.bundle(p)
        const r = b && b.resolve(cf.lineNumber, cf.columnNumber)
        const base = path.basename(p)
        if (!r) return { bucket: /\/recorder\.js$/.test(p) ? 'rrweb' : bucket, file: base, fn: (cf.functionName || '(anonymous)') + ' [unmapped]' }
        let file = r.source
        let fn = r.name || `(anonymous) ${path.basename(file)}:${r.line}`
        let rr = null
        if (/rrweb-record\.js$/.test(file)) {
            bucket = 'rrweb'
            const t = this.rrwebFile(b, r.line, r.name)
            rr = { file: t.file, fn: r.name, near: t.near }
            if (!r.name && t.near) fn = `(anonymous, after ${t.near}) rrweb-record.js:${r.line}`
            file = t.file ? 'rrweb/' + t.file : file
        } else if (/rrweb-plugin-console-record|replay\/external\/(network-plugin|denylist)\.ts$/.test(file)) {
            bucket = 'rrweb'
            rr = { file, fn: r.name, near: null }
        } else if (bucket === 'replay' && /\/recorder\.js$/.test(p)) {
            bucket = 'rrweb' // recorder.js is rrweb + its plugins; the rest are the plugins' helpers
            rr = { file, fn: r.name, near: null }
        } else if (bucket === 'sdk' && /^src\/replay\//.test(file)) {
            bucket = 'replay'
        }
        // Everything else in lazy-recorder.js (incl. shared helpers: logger, storage, fflate)
        // is upstream's replay logic.
        return { bucket, file, fn, rr }
    }

    /**
     * Self time per bucket / function / rrweb activity for one profile.
     * Native frames (no URL, e.g. getComputedStyle, JSON.stringify) are charged to their
     * closest JS caller, and also listed as `[native] name` under that caller's bucket.
     */
    attribute(profile) {
        const nodes = new Map(profile.nodes.map((n) => [n.id, n]))
        const parent = new Map()
        for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id)
        const self = new Map()
        const { samples, timeDeltas } = profile
        let t = profile.startTime
        const times = new Array(samples.length)
        for (let i = 0; i < samples.length; i++) { t += timeDeltas[i]; times[i] = t }
        for (let i = 0; i < samples.length; i++) {
            const dt = (i + 1 < samples.length ? times[i + 1] : profile.endTime) - times[i]
            if (dt > 0) self.set(samples[i], (self.get(samples[i]) || 0) + dt)
        }
        const frameCache = new Map()
        const frameOf = (id) => {
            if (!frameCache.has(id)) {
                const cf = nodes.get(id).callFrame
                frameCache.set(id, cf.url ? this.frame(cf) : null)
            }
            return frameCache.get(id)
        }
        const buckets = Object.fromEntries(Object.keys(BUCKETS).map((k) => [k, 0]))
        const fns = new Map()
        const nativeIn = {} // bucket -> µs of native callee time charged to it
        const rrCode = {}, rrContext = {}, rrFiles = {}
        const addFn = (key, rec, us) => {
            const f = fns.get(key) || fns.set(key, { ...rec, us: 0 }).get(key)
            f.us += us
        }
        for (const [id, us] of self) {
            const cf = nodes.get(id).callFrame
            const name = cf.functionName
            if (!cf.url && (name === '(idle)' || name === '(program)' || name === '(garbage collector)' || name === '(root)')) {
                buckets[name === '(idle)' ? 'idle' : name === '(garbage collector)' ? 'gc' : 'program'] += us
                continue
            }
            let fr = frameOf(id)
            let native = null
            if (!cf.url) {
                if (cf.scriptId && cf.scriptId !== '0') fr = { bucket: 'other', file: '(no url)', fn: name || '(anonymous)' }
                else {
                    native = name || '(native)'
                    let p = parent.get(id)
                    while (p !== undefined && !nodes.get(p).callFrame.url) p = parent.get(p)
                    fr = p === undefined ? null : frameOf(p)
                    if (fr) nativeIn[fr.bucket] = (nativeIn[fr.bucket] || 0) + us
                }
            }
            if (!fr) { buckets.browser += us; addFn('browser|' + native, { bucket: 'browser', file: '(native)', fn: native }, us); continue }
            buckets[fr.bucket] += us
            const fnName = native ? `[native] ${native} <- ${fr.fn}` : fr.fn
            addFn(fr.bucket + '|' + fr.file + '|' + fnName, { bucket: fr.bucket, file: fr.file, fn: fnName }, us)
            if (fr.bucket === 'rrweb') {
                const leaf = fr.rr || { file: fr.file }
                const code = codeActivity(leaf.file, leaf.fn)
                rrCode[code] = (rrCode[code] || 0) + us
                rrFiles[fr.file] = (rrFiles[fr.file] || 0) + us
                // context: innermost rrweb frame with a specific activity
                let ctx = null
                for (let p = native ? parent.get(id) : id; p !== undefined && !ctx; p = parent.get(p)) {
                    const f = nodes.get(p).callFrame.url ? frameOf(p) : null
                    if (f && f.rr) ctx = contextActivity(f.rr)
                }
                ctx = ctx || (codeActivity(leaf.file, leaf.fn).startsWith('serialisation') ? 'serialisation (no specific caller)' : 'other: ' + codeActivity(leaf.file, leaf.fn))
                rrContext[ctx] = (rrContext[ctx] || 0) + us
            }
        }
        const ms = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v / 1000]))
        return {
            windowMs: (profile.endTime - profile.startTime) / 1000,
            samples: samples.length,
            buckets: ms(buckets),
            nativeInBucket: ms(nativeIn),
            functions: [...fns.values()].map((f) => ({ bucket: f.bucket, file: f.file, fn: f.fn, ms: f.us / 1000 })).filter((f) => f.ms >= 0.05).sort((a, b) => b.ms - a.ms),
            rrwebByCode: ms(rrCode),
            rrwebByContext: ms(rrContext),
            rrwebByFile: ms(rrFiles),
        }
    }
}

// ---- summaries -----------------------------------------------------------------------------
const median = (xs) => {
    const s = xs.slice().sort((a, b) => a - b)
    if (!s.length) return 0
    const m = Math.floor(s.length / 2)
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const medianOfMaps = (maps) => {
    const keys = new Set(maps.flatMap((m) => Object.keys(m)))
    return Object.fromEntries([...keys].map((k) => [k, median(maps.map((m) => m[k] || 0))]))
}

/** Medians over runs of one variant's attributions. */
export function summarise(runs) {
    const fnMaps = runs.map((r) => Object.fromEntries(r.functions.map((f) => [f.bucket + '|' + f.file + '|' + f.fn, f.ms])))
    const fnMed = medianOfMaps(fnMaps)
    const functions = Object.entries(fnMed).map(([k, ms]) => {
        const [bucket, file, ...fn] = k.split('|')
        return { bucket, file, fn: fn.join('|'), ms }
    }).filter((f) => f.ms > 0).sort((a, b) => b.ms - a.ms)
    return {
        runs: runs.length,
        buckets: medianOfMaps(runs.map((r) => r.buckets)),
        sdkOnly: median(runs.map((r) => r.buckets.sdk + r.buckets.replay)),
        sdkTotal: median(runs.map((r) => SDK_BUCKETS.reduce((a, k) => a + r.buckets[k], 0))),
        nativeInBucket: medianOfMaps(runs.map((r) => r.nativeInBucket)),
        rrwebByCode: medianOfMaps(runs.map((r) => r.rrwebByCode)),
        rrwebByContext: medianOfMaps(runs.map((r) => r.rrwebByContext)),
        rrwebByFile: medianOfMaps(runs.map((r) => r.rrwebByFile)),
        functions,
    }
}

/** Prints the profile tables. `prof` = {variantKey: summary}. */
export function printProfile(prof, variants, opts) {
    const f = (x, d = 0) => (x === null || x === undefined ? '-' : x.toFixed(d))
    const keys = variants.map((v) => v.key).filter((k) => prof[k])
    const base = prof.none
    console.log(`\nCPU profile (sampling every ${opts.profileInterval} µs over ${opts.profileWindow === 'load' ? 'the page from navigation to the end of the journeys' : 'the measured window'}, separate profiled runs; self time, medians of ${opts.runs} runs).`)
    console.log('Native callees (getComputedStyle, JSON.stringify, ...) are charged to their JS caller. % = share of the variant\'s SDK total (SDK + replay + rrweb + lazy).\n')
    const rows = {}
    for (const b of Object.keys(BUCKETS)) {
        rows[BUCKETS[b]] = Object.fromEntries(keys.map((k) => {
            const ms = prof[k].buckets[b]
            const pct = SDK_BUCKETS.includes(b) && prof[k].sdkTotal ? ` (${f((100 * ms) / prof[k].sdkTotal)}%)` : ''
            const d = base && k !== 'none' && !SDK_BUCKETS.includes(b) && b !== 'idle' ? ` (Δ ${ms - base.buckets[b] >= 0 ? '+' : ''}${f(ms - base.buckets[b])})` : ''
            return [k, f(ms) + pct + d]
        }))
    }
    rows['SDK-only (SDK + replay logic)'] = Object.fromEntries(keys.map((k) => [k, f(prof[k].sdkOnly)]))
    rows['SDK total (incl. rrweb)'] = Object.fromEntries(keys.map((k) => [k, f(prof[k].sdkTotal)]))
    console.table(rows)
    for (const k of keys.filter((k) => k !== 'none')) {
        const p = prof[k]
        const rr = p.buckets.rrweb
        console.log(`\n[${k}] rrweb by activity (code location) - ${f(rr)} ms`)
        console.table(Object.fromEntries(Object.entries(p.rrwebByCode).sort((a, b) => b[1] - a[1]).map(([a, ms]) => [a, { ms: f(ms, 1), '%': f((100 * ms) / rr, 1) }])))
        console.log(`[${k}] rrweb by context (innermost rrweb frame on the stack that says what rrweb is doing)`)
        console.table(Object.fromEntries(Object.entries(p.rrwebByContext).sort((a, b) => b[1] - a[1]).map(([a, ms]) => [a, { ms: f(ms, 1), '%': f((100 * ms) / rr, 1) }])))
        console.log(`[${k}] top 25 rrweb functions (self time)`)
        console.table(p.functions.filter((x) => x.bucket === 'rrweb').slice(0, 25).map((x) => ({ ms: f(x.ms, 1), file: x.file, function: x.fn })))
        console.log(`[${k}] top 15 SDK functions (SDK bundle + replay logic + other lazy, self time)`)
        console.table(p.functions.filter((x) => x.bucket === 'sdk' || x.bucket === 'replay' || x.bucket === 'lazy').slice(0, 15).map((x) => ({ ms: f(x.ms, 1), bucket: x.bucket, file: x.file, function: x.fn })))
    }
}

// ---- CLI: re-attribute saved profiles ------------------------------------------------------
//   node test/bench/profile.mjs DIR   (DIR from `bench:session --profile --save-profiles DIR`,
//   files named <variant>-<run>.cpuprofile)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
    const { OFFICIAL_VERSION } = await import('../diff/server.mjs')
    const dir = process.argv[2]
    const upstream = findUpstream(root)
    const a = new Attributor(makeLocator(root, path.join(root, 'test/diff/vendor', `posthog-js-${OFFICIAL_VERSION}`, 'dist'), upstream), upstream)
    const byVariant = {}
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.cpuprofile')).sort()) {
        const key = f.replace(/-\d+\.cpuprofile$/, '')
        ;(byVariant[key] = byVariant[key] || []).push(a.attribute(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))))
    }
    const prof = Object.fromEntries(Object.entries(byVariant).map(([k, runs]) => [k, summarise(runs)]))
    const known = ['none', 'official', 'ours', 'lazy']
    const order = known.filter((k) => prof[k]).concat(Object.keys(prof).filter((k) => !known.includes(k)))
    printProfile(prof, order.map((key) => ({ key })), { profileInterval: '?', runs: Math.max(...Object.values(byVariant).map((r) => r.length)) })
}
