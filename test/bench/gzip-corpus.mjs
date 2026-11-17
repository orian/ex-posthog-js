// Corpus for the sync gzip encoder (src/core/gzip.js gzipSync): the strings the SDK
// gzips synchronously, taken from a real session (the session benchmark's demo app,
// `node test/bench/session.mjs --runs 1 --variants ours --dump-logs DIR`).
//
// test/fixtures/gzip-corpus.json.gz holds the request bodies as sent (decoded JSON,
// re-serialised): every /e/ batch and every /s/ $snapshot batch (cv '2024-10' fields
// included). loadCorpus() derives the cases from them: single events and batches,
// $snapshot batches as sent and with their cv fields decoded ("raw", what replay
// gzips when compression is off or what a field holds before compression), from
// ~200 B to ~1 MB.
//
//   node test/bench/gzip-corpus.mjs --build /tmp/logs/ours-0.json   # rewrite the fixture
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/gzip-corpus.json.gz')

/** Decodes a cv '2024-10' field: a latin1 string of gzip bytes. */
function gunzipField(s) {
    return JSON.parse(zlib.gunzipSync(Buffer.from(s, 'latin1')).toString('utf8'))
}

const isGzipString = (v) => typeof v === 'string' && v.charCodeAt(0) === 0x1f && v.charCodeAt(1) === 0x8b

/** An rrweb event with its cv fields decoded, as recorded before compression. */
function decodeEvent(ev) {
    if (!ev || ev.cv !== '2024-10') return ev
    const out = { ...ev }
    delete out.cv
    if (isGzipString(ev.data)) out.data = gunzipField(ev.data)
    else if (ev.data && typeof ev.data === 'object') {
        out.data = { ...ev.data }
        for (const k in out.data) if (isGzipString(out.data[k])) out.data[k] = gunzipField(out.data[k])
    }
    return out
}

/** A $snapshot batch with every snapshot's cv fields decoded. */
function decodeSnapshotBatch(batch) {
    return batch.map((e) => ({
        ...e,
        properties: { ...e.properties, $snapshot_data: e.properties.$snapshot_data.map(decodeEvent) },
    }))
}

/** @return {{name: string, kind: string, text: string}[]} */
export function loadCorpus() {
    const { events, snapshots } = JSON.parse(zlib.gunzipSync(fs.readFileSync(FIXTURE)).toString('utf8'))
    const out = []
    const add = (name, kind, value) => out.push({ name, kind, text: typeof value === 'string' ? value : JSON.stringify(value) })
    const bySize = (a, b) => JSON.stringify(a).length - JSON.stringify(b).length

    // /e/ bodies
    const pageview = events[0].batch[0]
    const p = pageview.properties
    add('custom event', 'events', {
        api_key: events[0].api_key,
        batch: [{ uuid: pageview.uuid, event: 'plan_selected', properties: { token: p.token, distinct_id: p.distinct_id, $session_id: p.$session_id, plan: 'pro' }, timestamp: pageview.timestamp }],
    })
    add('$identify', 'events', {
        api_key: events[0].api_key,
        batch: [{ ...pageview, event: '$identify', properties: { ...p, distinct_id: 'user-42', $anon_distinct_id: p.distinct_id }, $set: { email: 'jane@example.com', name: 'Jane Doe' } }],
    })
    add('$pageview (send_instantly)', 'events', events[0])
    add('$pageleave', 'events', events[events.length - 1])
    const auto = events.filter((b) => b.batch.every((e) => e.event === '$autocapture'))
    add('$autocapture x1', 'events', auto.filter((b) => b.batch.length === 1).sort(bySize).pop())
    add('$autocapture x4', 'events', auto.sort((a, b) => b.batch.length - a.batch.length)[0])
    add('mixed batch x5', 'events', events.slice().sort((a, b) => b.batch.length - a.batch.length)[0])
    add('all 30 events', 'events', { api_key: events[0].api_key, batch: events.flatMap((b) => b.batch) })

    // /s/ bodies
    const sorted = snapshots.slice().sort(bySize)
    const full = snapshots.find((b) => b.some((e) => e.properties.$snapshot_data.some((s) => s.type === 2)))
    const mutations = sorted.filter((b) => b !== full)
    add('$snapshot small (cv)', 'replay', mutations[0])
    add('$snapshot medium (cv)', 'replay', mutations[Math.floor(mutations.length / 2)])
    add('$snapshot large (cv)', 'replay', mutations[mutations.length - 1])
    add('$snapshot full (cv)', 'replay', full)
    add('$snapshot all (cv)', 'replay', snapshots.flat())
    const withCv = mutations.filter((b) => JSON.stringify(b).includes('"cv":"2024-10"'))
    add('$snapshot medium (raw)', 'replay', decodeSnapshotBatch(withCv[Math.floor(withCv.length / 2)]))
    add('$snapshot large (raw)', 'replay', decodeSnapshotBatch(mutations[mutations.length - 1]))
    const fullSnap = decodeEvent(full.flatMap((e) => e.properties.$snapshot_data).find((s) => s.type === 2))
    add('full snapshot data (field)', 'replay', fullSnap.data)
    add('$snapshot full (raw)', 'replay', decodeSnapshotBatch(full))
    add('$snapshot all (raw)', 'replay', decodeSnapshotBatch(snapshots.flat()))
    return out
}

/** Rewrites the fixture from a session benchmark log dump (--dump-logs). */
function build(dumpFile) {
    const { log } = JSON.parse(fs.readFileSync(dumpFile, 'utf8'))
    const events = log.filter((e) => /\/e\/$/.test(e.path) && e.body && e.body.batch).map((e) => e.body)
    const snapshots = log.filter((e) => e.path === '/s/' && Array.isArray(e.body)).map((e) => e.body)
    fs.writeFileSync(FIXTURE, zlib.gzipSync(JSON.stringify({ events, snapshots }), { level: 9 }))
    console.log(`${FIXTURE}: ${events.length} event batches, ${snapshots.length} snapshot batches`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const i = process.argv.indexOf('--build')
    if (i > 0) build(process.argv[i + 1])
    for (const c of loadCorpus()) console.log(String(Buffer.byteLength(c.text)).padStart(8), c.kind.padEnd(7), c.name)
}
