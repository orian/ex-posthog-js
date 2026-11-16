// Performance comparison: official posthog-js bundle vs ours, same page, real
// headless Chrome, 4x CPU throttling (≈ mid-range phone). Medians of N runs.
//   ./scripts/build.sh && node test/diff/bench.mjs [runs]
import { startServer } from './server.mjs'
import { launchChrome } from './chrome.mjs'
import { RESPONSES } from './fixtures.mjs'

const RUNS = Number(process.argv[2]) || 7
const VARIANTS = [
    { name: 'official array.js', sdk: 'official' },
    { name: 'ours posthog.full.js', sdk: 'ours', bundle: 'posthog.full.js' },
    { name: 'ours posthog.core.js', sdk: 'ours', bundle: 'posthog.core.js' },
]
const CONFIGS = [
    { name: 'default remote config', responses: RESPONSES.default },
    { name: 'session replay on', responses: { ...RESPONSES.default, ...RESPONSES.replay_recording } },
]
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }

const srv = await startServer()
const chrome = await launchChrome()
const rows = []
try {
    for (const cfg of CONFIGS) {
        for (const v of VARIANTS) {
            const samples = []
            for (let i = 0; i < RUNS; i++) {
                srv.state.log = []
                srv.state.responses = cfg.responses
                const page = await chrome.newPage()
                await page.cdp('Emulation.setCPUThrottlingRate', { rate: 4 })
                await page.goto(`http://app.example.test:${srv.port}/bench.html?sdk=${v.sdk}&bundle=${v.bundle || ''}`)
                await page.waitFor('window.__bench && window.__bench.done === true', 30000)
                const r = await page.evaluate('JSON.stringify(window.__bench)').then(JSON.parse)
                r.apiRequests = srv.state.log.filter((e) => !e.path.startsWith('/static/')).length
                samples.push(r)
                await page.close()
            }
            const m = (k) => median(samples.map((s) => s[k] ?? 0))
            rows.push({
                config: cfg.name, variant: v.name,
                'load+eval ms': m('loadEvalMs').toFixed(1), 'init ms': m('initMs').toFixed(1),
                '1000 captures ms': m('capture1000Ms').toFixed(1),
                'long tasks (ms)': `${m('longTasks')} (${m('longTaskMs').toFixed(0)})`,
                'SDK script KB (raw)': (m('scriptBytes') / 1024).toFixed(1),
                scripts: samples[0].scripts.join(' '),
            })
            console.error(`done: ${cfg.name} / ${v.name}`)
        }
    }
} finally {
    chrome.close()
    srv.server.close()
}
console.table(rows.map(({ scripts, ...r }) => r))
for (const r of rows) console.log(`${r.config} / ${r.variant}: ${r.scripts}`)
process.exit(0)
