// utf8ByteLength must equal `new Blob([s]).size` (what upstream sizes payloads
// and replay events with) for every string, lone surrogates included.
import test from 'node:test'
import assert from 'node:assert/strict'

globalThis.window = globalThis
const { utf8ByteLength, utf8ByteLengthSlow } = await import('../src/core/utils.js')

const blobSize = (s) => new Blob([s]).size

// Small PRNG so failures are reproducible.
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

// One UTF-16 code unit (or pair) from a class chosen to hit every branch.
function randomPiece(r) {
    const k = Math.floor(r() * 10)
    const between = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1))
    switch (k) {
        case 0: return String.fromCharCode(between(0, 0x7f)) // ASCII incl. NUL
        case 1: return String.fromCharCode(between(0x80, 0x7ff)) // 2 bytes
        case 2: return String.fromCharCode(between(0x800, 0xd7ff)) // 3 bytes
        case 3: return String.fromCharCode(between(0xe000, 0xffff)) // 3 bytes, above surrogates
        case 4: return String.fromCodePoint(between(0x10000, 0x10ffff)) // astral: pair, 4 bytes
        case 5: return String.fromCharCode(between(0xd800, 0xdbff)) // lone high (unless a low follows)
        case 6: return String.fromCharCode(between(0xdc00, 0xdfff)) // lone low (unless after a high)
        case 7: return '\u0000'
        default: return 'abcdefghij'.slice(0, between(1, 10))
    }
}

function randomString(r, maxPieces) {
    const n = Math.floor(r() * maxPieces)
    let s = ''
    for (let i = 0; i < n; i++) s += randomPiece(r)
    return s
}

const EDGE_CASES = [
    '',
    'a',
    '\u0000',
    '\u0000\u0000abc\u0000',
    '\u007f', '\u0080', '߿', 'ࠀ', '￿', '�', '﻿',
    '퟿', '',
    '\ud800', '\udbff', '\udc00', '\udfff', // lone surrogates
    '😀', // 😀 (pair)
    '\ude00\ud83d', // reversed: two lone surrogates
    '\ud83d😀', // lone high then a pair
    '😀\ude00', // pair then lone low
    'x\ud800', '\ud800x', 'x\udc00y',
    '\ud800\ud800', '\udc00\udc00',
    String.fromCodePoint(0x10000), String.fromCodePoint(0x10ffff),
    'héllo wörld — ✓ 日本語 😀🎉 \ud800 end',
    JSON.stringify({ type: 3, data: { source: 0, texts: [{ id: 1, value: 'naïve café \ud83d' }] } }),
]

test('edge cases match Blob', () => {
    for (const s of EDGE_CASES) {
        assert.equal(utf8ByteLength(s), blobSize(s), JSON.stringify(s))
        assert.equal(utf8ByteLengthSlow(s), blobSize(s), JSON.stringify(s))
    }
})

test('lone surrogates count as U+FFFD (3 bytes)', () => {
    assert.equal(utf8ByteLength('\ud800'), 3)
    assert.equal(utf8ByteLength('\udfff'), 3)
    assert.equal(utf8ByteLength('😀'), 4)
    assert.equal(utf8ByteLength('\ude00\ud83d'), 6)
})

test('fuzz: random short strings match Blob', () => {
    const r = rng(12345)
    for (let i = 0; i < 20000; i++) {
        const s = randomString(r, 40)
        const want = blobSize(s)
        assert.equal(utf8ByteLength(s), want, JSON.stringify(s))
        assert.equal(utf8ByteLengthSlow(s), want, JSON.stringify(s))
    }
})

test('fuzz: long strings (several scratch-buffer slices) match Blob', () => {
    const r = rng(777)
    for (let i = 0; i < 60; i++) {
        // up to ~200k code units: longer than the 64 KB scratch buffer holds at 3 bytes per unit
        const s = randomString(r, 40000)
        const want = blobSize(s)
        assert.equal(utf8ByteLength(s), want, `length ${s.length}`)
        assert.equal(utf8ByteLengthSlow(s), want, `length ${s.length}`)
    }
})

test('surrogate pairs and lone surrogates at every slice boundary', () => {
    // 21845 = floor(65536 / 3): the longest string encoded in one go at 3 bytes per unit.
    for (const fill of ['a', 'é', '✓', '😀']) {
        for (const len of [21843, 21844, 21845, 21846, 32767, 32768, 65535, 65536, 65537]) {
            for (const tail of ['😀', '\ud800', '\udc00', '\ud800😀', 'x']) {
                const s = fill.repeat(Math.ceil(len / fill.length)).slice(0, len) + tail + fill.repeat(30000)
                assert.equal(utf8ByteLength(s), blobSize(s), `${JSON.stringify(fill)} ${len} ${JSON.stringify(tail)}`)
            }
        }
    }
})

test('without TextEncoder.encodeInto the counting loop gives the same sizes', async () => {
    // utf8ByteLength picks its implementation on first use; a fresh module copy sees no encodeInto.
    const saved = globalThis.TextEncoder
    globalThis.TextEncoder = undefined
    try {
        const fresh = await import('../src/core/utils.js?no-encoder')
        const r = rng(4242)
        for (let i = 0; i < 2000; i++) {
            const s = randomString(r, 200)
            assert.equal(fresh.utf8ByteLength(s), blobSize(s), JSON.stringify(s))
        }
    } finally {
        globalThis.TextEncoder = saved
    }
})
