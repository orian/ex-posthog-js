// The sync gzip encoder (src/core/gzip.js gzipSync / gzipBytes): every output must
// gunzip (Node's zlib) to the input, with a correct header, CRC-32 and ISIZE trailer.
// Covers the real-payload corpus (test/bench/gzip-corpus.mjs, also checked to stay at
// least as small as fflate 0.4.9, which upstream uses), fuzzed inputs, block and window
// boundaries, and large inputs. test/bench/gzip.mjs measures size and speed.
import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { loadCorpus } from './bench/gzip-corpus.mjs'
import * as fflate from './third_party/fflate-0.4.9/browser.js'

globalThis.window = globalThis
const { gzipSync, gzipBytes, encoderStateForTest } = await import('../src/core/gzip.js')

/** Seeded PRNG (mulberry32) so failures reproduce. */
function rng(seed) {
    return () => {
        seed = (seed + 0x6d2b79f5) | 0
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

/** BTYPE of the first deflate block (0 stored, 1 fixed, 2 dynamic). */
const firstBlockType = (gz) => (gz[10] >>> 1) & 3

/** Checks the gzip container and that it decodes to `bytes`; returns the output. */
function check(gz, bytes, what = '') {
    const out = Buffer.from(gz.buffer, gz.byteOffset, gz.byteLength)
    // ID1 ID2 CM=8 FLG=0 MTIME=0 XFL=0 OS=3, like fflate's gzipSync(..., {mtime: 0}).
    assert.deepEqual([...out.subarray(0, 10)], [0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3], `header ${what}`)
    assert.equal(out.readUInt32LE(out.length - 8), zlib.crc32(bytes), `CRC-32 ${what}`)
    assert.equal(out.readUInt32LE(out.length - 4), bytes.length >>> 0, `ISIZE ${what}`)
    const back = zlib.gunzipSync(out)
    assert.ok(back.equals(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)), `round trip ${what}`)
    // Nothing after the trailer: the raw deflate stream ends exactly at it.
    assert.equal(zlib.inflateRawSync(out.subarray(10, out.length - 8)).length, bytes.length, `stream end ${what}`)
    return out
}

const roundTrip = (bytes, what) => check(gzipBytes(bytes), bytes, what)
const enc = (s) => new TextEncoder().encode(s)

function randomBytes(r, n) {
    const b = new Uint8Array(n)
    for (let i = 0; i < n; i++) b[i] = (r() * 256) | 0
    return b
}

test('empty input and one byte', () => {
    const empty = check(gzipSync(''), new Uint8Array(0), 'empty')
    assert.equal(empty.length, 20) // header, an empty fixed block, trailer: like fflate
    assert.equal(firstBlockType(empty), 1)
    check(gzipSync('a'), enc('a'), '1 byte')
    check(gzipBytes(new Uint8Array([0])), new Uint8Array([0]), '1 zero byte')
    check(gzipBytes(new Uint8Array([255])), new Uint8Array([255]), '1 0xff byte')
    for (let n = 2; n < 300; n++) roundTrip(randomBytes(rng(n), n), `random ${n}`)
})

test('corpus round trips, at least as small as fflate 0.4.9', () => {
    const totals = {}
    for (const c of loadCorpus()) {
        const bytes = enc(c.text)
        const gz = check(gzipSync(c.text), bytes, c.name)
        if (bytes.length > 2000) assert.equal(firstBlockType(gz), 2, `${c.name}: dynamic Huffman`)
        const t = (totals[c.kind] ||= { ours: 0, fflate: 0 })
        t.ours += gz.length
        t.fflate += fflate.gzipSync(fflate.strToU8(c.text), { mtime: 0 }).length
    }
    for (const kind in totals) {
        assert.ok(totals[kind].ours <= totals[kind].fflate, `${kind}: ${totals[kind].ours} > fflate ${totals[kind].fflate}`)
    }
})

test('fuzz: random, small-alphabet, repetitive and text inputs', () => {
    const r = rng(12345)
    const gens = {
        random: (n) => randomBytes(r, n),
        alphabet4: (n) => {
            const b = new Uint8Array(n)
            for (let i = 0; i < n; i++) b[i] = 97 + ((r() * 4) | 0)
            return b
        },
        // A repeated phrase with occasional edits: long matches at many distances.
        repetitive: (n) => {
            const phrase = randomBytes(r, 1 + ((r() * 300) | 0))
            const b = new Uint8Array(n)
            for (let i = 0; i < n; i++) b[i] = r() < 0.002 ? (r() * 256) | 0 : phrase[i % phrase.length]
            return b
        },
        runs: (n) => {
            const b = new Uint8Array(n)
            for (let i = 0; i < n;) {
                const len = 1 + ((r() * 600) | 0)
                b.fill((r() * 3) | 0, i, i + len)
                i += len
            }
            return b
        },
        // Mixed blocks: text, then noise, then text again (block type choice per block).
        mixed: (n) => {
            const b = new Uint8Array(n)
            for (let i = 0; i < n; i++) b[i] = (i / 20000) & 1 ? (r() * 256) | 0 : 97 + ((i * 7) % 13)
            return b
        },
    }
    for (let k = 0; k < 150; k++) {
        const n = Math.floor(Math.exp(r() * Math.log(300000)))
        for (const name in gens) roundTrip(gens[name](n), `${name} ${n} (case ${k})`)
    }
    // Strings through gzipSync, including multi-byte UTF-8 and lone surrogates.
    const pick = 'aé€😀𐀀 {}":,0123456789xyz\n'
    for (let k = 0; k < 200; k++) {
        const n = Math.floor(Math.exp(r() * Math.log(50000)))
        let s = ''
        for (let i = 0; i < n; i++) s += pick[(r() * pick.length) | 0]
        check(gzipSync(s), enc(s), `string ${n} (case ${k})`)
    }
})

test('incompressible data goes out as stored blocks, never much larger than the input', () => {
    const r = rng(7)
    for (const n of [100, 4096, 8191, 8192, 8193, 65534, 65535, 65536, 65537, 131070, 131071, 200000, 1 << 20]) {
        const bytes = randomBytes(r, n)
        const gz = roundTrip(bytes, `random ${n}`)
        assert.equal(firstBlockType(gz), 0, `random ${n}: stored`)
        // Header, trailer, and per block 5 bytes (+1 alignment) per 65535-byte chunk.
        const blocks = Math.ceil(n / 8192) + Math.ceil(n / 65535)
        assert.ok(gz.length <= n + 18 + 6 * blocks, `random ${n}: ${gz.length} bytes`)
    }
})

test('block, match length and window boundaries', () => {
    const r = rng(99)
    // One literal per symbol: blocks end exactly at 8192 symbols.
    for (const n of [8191, 8192, 8193, 16383, 16384, 16385, 24576]) {
        const b = new Uint8Array(n)
        for (let i = 0; i < n; i++) b[i] = 97 + ((r() * 26) | 0)
        roundTrip(b, `letters ${n}`)
    }
    // Runs around the maximum match length (258) and the stored chunk size.
    for (const n of [3, 4, 257, 258, 259, 260, 516, 517, 65535, 65536, 1 << 20]) {
        roundTrip(new Uint8Array(n).fill(120), `run ${n}`)
    }
    // A random block repeated at distances around the window limit.
    for (const gap of [32500, 32506, 32507, 32767, 32768, 32769, 40000]) {
        const head = randomBytes(r, 300)
        const b = new Uint8Array(gap + 600)
        b.set(head, 0)
        b.set(randomBytes(r, gap - 300), 300)
        b.set(head, gap)
        b.set(randomBytes(r, 300), gap + 300)
        const gz = roundTrip(b, `gap ${gap}`)
        if (gap <= 32506) assert.ok(gz.length < b.length - 200, `gap ${gap}: repeat found (${gz.length})`)
    }
})

test('highly repetitive input compresses like zlib', () => {
    const a = new Uint8Array(1 << 20).fill(97)
    const gz = roundTrip(a, '1 MiB of a')
    assert.ok(gz.length < 1100, `1 MiB of a: ${gz.length} bytes`)
    const s = '{"event":"$pageview","properties":{"$current_url":"https://example.com/"}},'.repeat(20000)
    const gz2 = check(gzipSync(s), enc(s), 'repeated JSON')
    assert.ok(gz2.length <= zlib.gzipSync(s, { level: 6 }).length * 1.1, `repeated JSON: ${gz2.length} bytes`)
})

test('large inputs', () => {
    const corpus = loadCorpus()
    let s = ''
    for (const c of corpus) s += c.text
    while (s.length < 8e6) s += s
    check(gzipSync(s), enc(s), `${s.length} chars of corpus`)
    roundTrip(randomBytes(rng(3), 3e6), '3 MB random')
})

test('output is deterministic and independent of earlier calls', () => {
    const c = loadCorpus().find((x) => x.name === '$snapshot full (cv)')
    const first = Buffer.from(gzipSync(c.text))
    gzipSync('x'.repeat(100000))
    gzipBytes(randomBytes(rng(5), 70000))
    assert.ok(first.equals(Buffer.from(gzipSync(c.text))))
})

// ---- reused encoder state (hash tables, symbol and output buffers kept between calls) ----

// A second copy of the module: its own state, so its outputs come from a different history.
const other = await import('../src/core/gzip.js?second-instance')

/** Inputs of every size class, from the corpus, random and repetitive. */
function mixedInputs() {
    const r = rng(2024)
    const xs = loadCorpus().map((c) => enc(c.text))
    for (const n of [0, 1, 2, 3, 50, 300, 4095, 4096, 4097, 8192, 8193, 32768, 70000]) {
        xs.push(randomBytes(r, n))
        xs.push(enc('{"a":[1,2,3],"b":"text"}'.repeat(Math.ceil(n / 24)).slice(0, n)))
    }
    return xs
}

test('reuse: interleaved calls give the same bytes whatever came before', () => {
    const xs = mixedInputs()
    const forward = xs.map((b) => Buffer.from(gzipBytes(b)))
    const backward = xs.slice().reverse().map((b) => Buffer.from(other.gzipBytes(b))).reverse()
    xs.forEach((b, i) => {
        assert.ok(forward[i].equals(backward[i]), `input ${i} (${b.length} bytes)`)
        check(forward[i], b, `input ${i}`)
    })
    // Shuffled, the same input several times in a row and again later.
    const r = rng(77)
    for (let k = 0; k < 200; k++) {
        const i = (r() * xs.length) | 0
        assert.ok(Buffer.from(gzipBytes(xs[i])).equals(forward[i]), `shuffled ${k}: input ${i}`)
    }
})

test('reuse: a large call followed by small ones', () => {
    const small = [enc('[]'), enc('[{"id":12,"value":"hello"}]'), randomBytes(rng(1), 700), enc('x'.repeat(5000))]
    const fresh = small.map((b) => Buffer.from(other.gzipBytes(b)))
    for (const big of [enc('y'.repeat(2e6)), randomBytes(rng(9), 300000), enc(loadCorpus().pop().text)]) {
        check(gzipBytes(big), big, `big ${big.length}`)
        small.forEach((b, i) => assert.ok(Buffer.from(gzipBytes(b)).equals(fresh[i]), `small ${i} after ${big.length}`))
    }
})

test('reuse: results never alias the kept output buffer', () => {
    const a = gzipSync('first '.repeat(50))
    const copy = Buffer.from(a)
    const b = gzipSync('second, different and longer '.repeat(80))
    assert.ok(Buffer.from(a).equals(copy), 'first result unchanged by the second call')
    assert.notEqual(a.buffer, b.buffer)
    check(a, enc('first '.repeat(50)))
})

test('reuse: an error midway through a call does not affect later calls', () => {
    const xs = mixedInputs()
    const expected = xs.map((b) => Buffer.from(other.gzipBytes(b)))
    for (const failAt of [10, 3000, 40000, 900000]) {
        const real = enc(loadCorpus().pop().text) // > 1 MB
        let reads = 0
        // Indexed reads throw after `failAt` of them: the encoder stops in the middle.
        const failing = new Proxy(real, {
            get(target, key) {
                if (typeof key === 'string' && /^\d+$/.test(key) && ++reads > failAt) throw new Error('read failed')
                const v = Reflect.get(target, key)
                return typeof v === 'function' ? v.bind(target) : v
            },
        })
        assert.throws(() => gzipBytes(failing), /read failed/)
        xs.forEach((b, i) => assert.ok(Buffer.from(gzipBytes(b)).equals(expected[i]), `input ${i} after failing at ${failAt}`))
    }
})

test('reuse: position offsets wrap without stale matches', () => {
    const b = enc(loadCorpus().find((x) => x.name === '$snapshot medium (raw)').text)
    const expected = Buffer.from(other.gzipBytes(b))
    gzipBytes(b)
    const st = encoderStateForTest()
    st.base = 0x3fffffff - 10 // the next call must start from cleared tables
    assert.ok(Buffer.from(gzipBytes(b)).equals(expected))
    assert.equal(encoderStateForTest().base, b.length)
    assert.ok(Buffer.from(gzipBytes(b)).equals(expected))
})

test('reuse: large buffers are released after an idle period', () => {
    const realNow = Date.now
    let now = realNow()
    Date.now = () => now
    try {
        const st = () => encoderStateForTest()
        gzipBytes(randomBytes(rng(4), 50000))
        assert.equal(st().bits, 15)
        now += 5000
        gzipSync('{"small":true}')
        assert.equal(st().bits, 15, 'kept while large calls are recent')
        now += 11000
        const small = gzipSync('{"small":true}')
        assert.equal(st().bits, 12, 'hash tables back to 4096 entries')
        assert.equal(st().head.length, 4096)
        assert.ok(!st().out || st().out.length <= 4096, 'output buffer released')
        check(small, enc('{"small":true}'))
        // Kept: two 4096-entry tables, 8192 symbols and at most a 4 KB output buffer.
        const kept = st().head.byteLength + st().prev.byteLength + st().syms.byteLength + (st().out ? st().out.byteLength : 0)
        assert.ok(kept <= 72 * 1024, `${kept} bytes kept`)
    } finally {
        Date.now = realNow
    }
})
