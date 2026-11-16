// Native (CompressionStream) gzip of replay event fields: the validated
// single-read path must make exactly the decisions upstream's validateNativeGzip
// makes (header and trailer read back as blob slices, then the whole blob
// read again), with the same output or the same error. Also checks crc32
// (slicing-by-8) against zlib.
import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'

globalThis.window = globalThis
const { crc32, gzipSync } = await import('../src/core/gzip.js')
const { gzipToStringAsync, gzipFieldAsync, isNativeAsyncGzipError } = await import('../src/replay/gzip-field.js')
const { circularReferenceReplacer } = await import('../src/replay/utils.js')

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

// ---- crc32 ---------------------------------------------------------------------------

test('crc32 matches zlib for every length up to 2 KB and for large buffers', () => {
    const r = rng(1)
    const buf = new Uint8Array(1 << 20)
    for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(r() * 256)
    for (let n = 0; n <= 2048; n++) assert.equal(crc32(buf.subarray(0, n)), zlib.crc32(buf.subarray(0, n)), `length ${n}`)
    for (let k = 0; k < 50; k++) {
        const start = Math.floor(r() * 1000)
        const n = Math.floor(r() * (buf.length - start))
        const s = buf.subarray(start, start + n) // unaligned views too
        assert.equal(crc32(s), zlib.crc32(s))
    }
    assert.equal(crc32(new Uint8Array(100000).fill(0xff)), zlib.crc32(new Uint8Array(100000).fill(0xff)))
})

test('gzipSync output still gunzips (its trailer uses crc32)', () => {
    const s = JSON.stringify({ a: 'x'.repeat(5000), b: [1, 2, 3], c: 'héllo ✓ 😀' })
    assert.equal(zlib.gunzipSync(Buffer.from(gzipSync(s))).toString('utf8'), s)
})

// ---- reference: upstream gzipCompress + validateNativeGzip + gzipToStringAsync ---------

function latin1(bytes) {
    let out = ''
    for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i])
    return out
}

function namedError(name, message) {
    const e = new Error(message)
    e.name = name
    return e
}

let refCrcTable
function refCrc32(bytes) {
    if (!refCrcTable) {
        refCrcTable = []
        for (let i = 0; i < 256; i++) {
            let c = i
            for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
            refCrcTable[i] = c >>> 0
        }
    }
    let crc = 0xffffffff
    for (let i = 0; i < bytes.length; i++) crc = refCrcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
    return (crc ^ 0xffffffff) >>> 0
}

async function refValidate(compressed, inputBytes) {
    const fail = (reason) => { throw namedError('NativeGzipValidationError', `Native gzip produced invalid output: ${reason}`) }
    if (compressed.size < 18) fail('too-short')
    const header = new Uint8Array(await compressed.slice(0, 10).arrayBuffer())
    if (!(header.length >= 2 && header[0] === 0x1f && header[1] === 0x8b) || header[2] !== 0x08) fail('invalid-header')
    const trailer = new DataView(await compressed.slice(compressed.size - 8).arrayBuffer())
    if (trailer.getUint32(0, true) !== refCrc32(inputBytes)) fail('invalid-crc')
    if (trailer.getUint32(4, true) !== inputBytes.length >>> 0) fail('invalid-size')
}

async function refGzipToStringAsync(data) {
    const serialized = JSON.stringify(data)
    const inputBytes = new TextEncoder().encode(serialized)
    const stream = new globalThis.CompressionStream('gzip')
    const writer = stream.writable.getWriter()
    const writePromise = writer.write(inputBytes).then(() => writer.close()).catch(async (err) => {
        try { await writer.abort(err) } catch {}
        throw err
    })
    const responsePromise = new globalThis.Response(stream.readable).blob()
    const [compressed] = await Promise.all([responsePromise, writePromise])
    await refValidate(compressed, inputBytes)
    return latin1(new Uint8Array(await compressed.arrayBuffer()))
}

async function outcome(p) {
    try {
        return { ok: await p }
    } catch (e) {
        return { error: e.name, message: e.message, native: isNativeAsyncGzipError(e) }
    }
}

// ---- fault injection ---------------------------------------------------------------------

const RealCS = globalThis.CompressionStream
const RealResponse = globalThis.Response

// A CompressionStream whose whole output goes through `mutate(bytes) -> bytes`.
function corruptingCS(mutate) {
    return class {
        constructor(format) {
            const real = new RealCS(format)
            const chunks = []
            this.writable = real.writable
            this.readable = real.readable.pipeThrough(new TransformStream({
                transform(chunk) { chunks.push(chunk) },
                flush(controller) {
                    const all = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0))
                    let o = 0
                    for (const c of chunks) { all.set(c, o); o += c.length }
                    const out = mutate(all)
                    if (out.length) controller.enqueue(out)
                },
            }))
        }
    }
}

const flip = (i) => (b) => { const c = b.slice(); const j = i < 0 ? c.length + i : i; c[j] ^= 0x01; return c }

const CASES = {
    'valid output': null,
    'too short (17 bytes)': (b) => b.slice(0, 17),
    'empty output': () => new Uint8Array(0),
    'bad magic byte 0': flip(0),
    'bad magic byte 1': flip(1),
    'bad method byte': flip(2),
    'header flags byte changed (not checked)': flip(3),
    'bad crc (first trailer byte)': flip(-8),
    'bad crc (last crc byte)': flip(-5),
    'bad size (first size byte)': flip(-4),
    'bad size (last byte)': flip(-1),
    'header and crc both bad': (b) => flip(-8)(flip(0)(b)),
    'crc and size both bad': (b) => flip(-1)(flip(-8)(b)),
    'deflate body changed (trailer intact)': (b) => (b.length > 20 ? flip(12)(b) : b),
    'truncated trailer': (b) => b.slice(0, b.length - 3),
}

const INPUTS = [
    [],
    { type: 2, data: 'x' },
    [{ parentId: 1, nextId: null, node: { type: 3, textContent: 'héllo ✓ 😀 \ud800' } }],
    { big: 'abc'.repeat(20000), n: Array.from({ length: 500 }, (_, i) => i) },
]

for (const [name, mutate] of Object.entries(CASES)) {
    test(`native gzip: ${name} -> same result as upstream's validation`, async () => {
        globalThis.CompressionStream = mutate ? corruptingCS(mutate) : RealCS
        try {
            for (const input of INPUTS) {
                const want = await outcome(refGzipToStringAsync(input))
                const got = await outcome(gzipToStringAsync(input, circularReferenceReplacer))
                assert.deepEqual(got, want)
                if (process.env.SHOW_OUTCOMES) console.log(name, got.error ? got.message : 'ok')
                if (!mutate)assert.equal(zlib.gunzipSync(Buffer.from(got.ok, 'latin1')).toString('utf8'), JSON.stringify(input))
            }
        } finally {
            globalThis.CompressionStream = RealCS
        }
    })
}

test('native gzip: a failing blob read (Safari 16 NotReadableError) still rejects with it', async () => {
    const notReadable = () => Promise.reject(namedError('NotReadableError', 'The I/O read operation failed.'))
    class FailingBlob {
        constructor(blob) { this.size = blob.size }
        slice() { return { arrayBuffer: notReadable } }
        arrayBuffer() { return notReadable() }
    }
    globalThis.Response = class extends RealResponse {
        blob() { return super.blob().then((b) => new FailingBlob(b)) }
    }
    try {
        const want = await outcome(refGzipToStringAsync({ a: 1 }))
        const got = await outcome(gzipToStringAsync({ a: 1 }, circularReferenceReplacer))
        assert.deepEqual(got, want)
        assert.equal(got.error, 'NotReadableError')
        assert.equal(got.native, true)
    } finally {
        globalThis.Response = RealResponse
    }
})

test('native gzip: a failing write rejects with the write error', async () => {
    globalThis.CompressionStream = class {
        constructor(format) {
            const real = new RealCS(format)
            this.readable = real.readable
            this.writable = new WritableStream({ write() { throw namedError('TypeError', 'boom') } })
        }
    }
    try {
        const got = await outcome(gzipToStringAsync({ a: 1 }, circularReferenceReplacer))
        assert.equal(got.error, 'TypeError')
        assert.equal(got.native, false)
    } finally {
        globalThis.CompressionStream = RealCS
    }
})

test('gzipFieldAsync([]) is cached and equals a fresh compression of []', async () => {
    const a = await gzipFieldAsync([], circularReferenceReplacer)
    const b = await gzipFieldAsync([], circularReferenceReplacer)
    assert.equal(a, b)
    assert.equal(a, await refGzipToStringAsync([]))
})
