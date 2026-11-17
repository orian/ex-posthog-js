// strToU8 (src/core/gzip.js), the UTF-8 step of the sync gzip encoder (beacons,
// send_instantly, no CompressionStream, replay's unload drain), must produce correct
// WHATWG UTF-8, byte for byte what TextEncoder produces, on both paths: with TextEncoder,
// and with our fallback loop when TextEncoder is missing. With TextEncoder this equals
// upstream's fflate strToU8 (checked against outputs recorded from fflate 0.4.9). Without
// it, fflate mis-encodes surrogates; we deliberately send correct UTF-8 instead (the
// recorded fflate outputs document that difference).
import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'

globalThis.window = globalThis
const { strToU8, gzipSync } = await import('../src/core/gzip.js')
const { gzipToString } = await import('../src/replay/gzip-field.js')
const { circularReferenceReplacer } = await import('../src/replay/utils.js')

const hex = (u) => Buffer.from(u).toString('hex')
const fromUnits = (units) => String.fromCharCode(...units.map((u) => parseInt(u, 16)))

/** Runs fn with globalThis.TextEncoder removed (fflate checks `typeof TextEncoder`). */
function withoutTextEncoder(fn) {
    const TE = globalThis.TextEncoder
    delete globalThis.TextEncoder
    try {
        return fn()
    } finally {
        globalThis.TextEncoder = TE
    }
}

// fflate 0.4.9 strToU8 (esm/browser.js), verbatim apart from formatting. MIT, (c) Arjun Barrett.
function fflateStrToU8(str, latin1) {
    var l = str.length
    if (!latin1 && typeof TextEncoder != 'undefined') return new TextEncoder().encode(str)
    var ar = new Uint8Array(str.length + (str.length >>> 1))
    var ai = 0
    var w = function (v) { ar[ai++] = v }
    for (var i = 0; i < l; ++i) {
        if (ai + 5 > ar.length) {
            var n = new Uint8Array(ai + 8 + ((l - i) << 1))
            n.set(ar)
            ar = n
        }
        var c = str.charCodeAt(i)
        if (c < 128 || latin1) w(c)
        else if (c < 2048) w(192 | (c >>> 6)), w(128 | (c & 63))
        else if (c > 55295 && c < 57344)
            c = 65536 + (c & 1023 << 10) | (str.charCodeAt(++i) & 1023),
            w(240 | (c >>> 18)), w(128 | ((c >>> 12) & 63)), w(128 | ((c >>> 6) & 63)), w(128 | (c & 63))
        else w(224 | (c >>> 12)), w(128 | ((c >>> 6) & 63)), w(128 | (c & 63))
    }
    return ar.slice(0, ai)
}

// Recorded from fflate 0.4.9's strToU8 in Node, with and without globalThis.TextEncoder.
const VECTORS = [
    { units: [], withTE: '', withoutTE: '' },
    { units: ['70', '6c', '61', '69', '6e'], withTE: '706c61696e', withoutTE: '706c61696e' },
    { units: ['68', 'e9', '6c', '6c', '6f', '20', '2713', '20', '800', '7ff', 'ffff'],
        withTE: '68c3a96c6c6f20e29c9320e0a080dfbfefbfbf', withoutTE: '68c3a96c6c6f20e29c9320e0a080dfbfefbfbf' },
    { units: ['d83d', 'de00'], withTE: 'f09f9880', withoutTE: 'f09da880' },
    { units: ['61', 'd800', '62'], withTE: '61efbfbd62', withoutTE: '61f09da1a2' },
    { units: ['61', 'dc00', '62'], withTE: '61efbfbd62', withoutTE: '61f09db1a2' },
    { units: ['78', 'd83d'], withTE: '78efbfbd', withoutTE: '78f09da080' },
    { units: ['de00', 'd83d'], withTE: 'efbfbdefbfbd', withoutTE: 'f09db0bd' },
    { units: ['d800', 'd800'], withTE: 'efbfbdefbfbd', withoutTE: 'f09da080' },
    { units: ['dbff', 'dfff'], withTE: 'f48fbfbf', withoutTE: 'f09dafbf' },
    { units: ['d800', 'dc00'], withTE: 'f0908080', withoutTE: 'f09da080' },
    { units: ['7b', '22', '6b', '22', '3a', '22', 'd83d', 'de00', 'd800', '22', '7d'],
        withTE: '7b226b223a22f09f9880efbfbd227d', withoutTE: '7b226b223a22f09da880f09da0a27d' },
]

test('strToU8 gives TextEncoder bytes on both paths; fflate matches only with TextEncoder', () => {
    for (const v of VECTORS) {
        const s = fromUnits(v.units)
        assert.equal(hex(strToU8(s)), v.withTE, `with TextEncoder: ${v.units}`)
        assert.equal(hex(fflateStrToU8(s)), v.withTE, `reference, with TextEncoder: ${v.units}`)
        withoutTextEncoder(() => {
            // Ours: correct UTF-8, identical to the TextEncoder path.
            assert.equal(hex(strToU8(s)), v.withTE, `without TextEncoder: ${v.units}`)
            // fflate's loop (what upstream sends there) still matches the recorded quirky bytes.
            assert.equal(hex(fflateStrToU8(s)), v.withoutTE, `reference, without TextEncoder: ${v.units}`)
        })
    }
})

function rng(seed) {
    let a = seed >>> 0
    return () => {
        a = (a + 0x6d2b79f5) >>> 0
        let t = a
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

// Code units weighted towards the interesting ranges: ASCII, 2-byte, 3-byte, surrogates.
function randomString(r, n) {
    const units = []
    for (let i = 0; i < n; i++) {
        const k = r()
        if (k < 0.4) units.push(Math.floor(r() * 128))
        else if (k < 0.55) units.push(128 + Math.floor(r() * (2048 - 128)))
        else if (k < 0.7) units.push(2048 + Math.floor(r() * (0xd800 - 2048)))
        else if (k < 0.8) units.push(0xe000 + Math.floor(r() * 0x2000))
        else if (k < 0.9) units.push(0xd800 + Math.floor(r() * 0x400)) // high
        else units.push(0xdc00 + Math.floor(r() * 0x400)) // low
    }
    return String.fromCharCode(...units)
}

test('fallback loop: same size as fflate on well-formed text; lone surrogates keep the next character', () => {
    const r = rng(11)
    // Well-formed text from random code points (ASCII, 2-byte, 3-byte, astral).
    const point = () => {
        const k = r()
        if (k < 0.4) return Math.floor(r() * 128)
        if (k < 0.55) return 128 + Math.floor(r() * (2048 - 128))
        if (k < 0.75) return 2048 + Math.floor(r() * (0xd800 - 2048))
        return 0x10000 + Math.floor(r() * 0x100000)
    }
    for (let k = 0; k < 2000; k++) {
        const s = String.fromCodePoint(...Array.from({ length: Math.floor(r() * 200) }, point))
        // fflate's surrogate path is only wrong in the code point it produces, not its length.
        withoutTextEncoder(() => assert.equal(strToU8(s).length, fflateStrToU8(s).length))
    }
    // A lone surrogate costs U+FFFD (3 bytes) but no longer swallows what follows it:
    // fflate turns '\ud800"' into one 4-byte sequence (the quote is lost), we keep the quote.
    withoutTextEncoder(() => {
        assert.equal(hex(strToU8('\ud800"')), 'efbfbd22')
        assert.equal(fflateStrToU8('\ud800"').length, 4)
    })
})

test('strToU8 equals TextEncoder on random strings (both paths), including buffer growth', () => {
    const r = rng(7)
    const te = new TextEncoder()
    for (let k = 0; k < 3000; k++) {
        const s = randomString(r, Math.floor(r() * (k < 2900 ? 64 : 5000)))
        const expected = hex(te.encode(s))
        assert.equal(hex(strToU8(s)), expected)
        assert.equal(hex(fflateStrToU8(s)), expected) // upstream, with TextEncoder
        withoutTextEncoder(() => assert.equal(hex(strToU8(s)), expected))
    }
})

test('gzipSync never throws on lone surrogates and gunzips to strToU8 bytes', () => {
    const s = JSON.stringify({ a: 'x'.repeat(300) }).slice(0, -1) + ',"b":"a\ud800b\udc00😀\ud83d"}'
    assert.equal(hex(zlib.gunzipSync(Buffer.from(gzipSync(s)))), hex(new TextEncoder().encode(s)))
    const expected = hex(new TextEncoder().encode(s))
    withoutTextEncoder(() => {
        const gz = gzipSync(s)
        assert.equal(hex(zlib.gunzipSync(Buffer.from(gz))), expected)
    })
})

test("replay's sync field compression (gzipToString) encodes lone surrogates as correct UTF-8", () => {
    // Pre-ES2019 engines leave lone surrogates raw in JSON.stringify's output.
    const nativeStringify = JSON.stringify
    JSON.stringify = function () {
        return nativeStringify.apply(JSON, arguments).replace(/\\u(d[89a-f][0-9a-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))
    }
    try {
        const data = [{ text: 'lone \ud800 high', other: '\udc00' }]
        const serialized = JSON.stringify(data)
        assert.ok(serialized.includes('\ud800'))
        const out = gzipToString(data, circularReferenceReplacer)
        assert.equal(hex(zlib.gunzipSync(Buffer.from(out, 'latin1'))), hex(new TextEncoder().encode(serialized)))
    } finally {
        JSON.stringify = nativeStringify
    }
})
