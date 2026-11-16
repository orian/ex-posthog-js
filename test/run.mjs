// Test runner: node test/run.mjs [compiled|source|all]
// Compiled bundles run in isolated vm contexts in-process; raw ES module
// sources keep module-level state, so each source run gets its own process.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { scenarios, loaderFor } from './scenarios.mjs'

const self = fileURLToPath(import.meta.url)

async function runOne(mode, build, name) {
    const scenario = scenarios[name]
    await scenario.run(loaderFor(build, mode, scenario))
}

if (process.argv[2] === '--child') {
    const [, , , mode, build, name] = process.argv
    try {
        await runOne(mode, build, name)
        process.exit(0)
    } catch (e) {
        console.error(e)
        process.exit(1)
    }
}

const modes = process.argv[2] === 'source' ? ['source'] : process.argv[2] === 'compiled' ? ['compiled'] : ['source', 'compiled']
let failed = 0
let passed = 0
for (const mode of modes) {
    for (const [name, scenario] of Object.entries(scenarios)) {
        for (const build of scenario.builds) {
            if (mode === 'source' && build === 'chunks') continue
            if (mode === 'compiled' && scenario.sourceOnly) continue
            if (mode === 'source' && scenario.compiledOnly) continue
            const label = `[${mode}/${build}] ${name}`
            let error = null
            if (mode === 'source') {
                const r = spawnSync(process.execPath, [self, '--child', mode, build, name], { encoding: 'utf8' })
                if (r.status !== 0) error = (r.stderr || r.stdout).trim()
            } else {
                try {
                    await runOne(mode, build, name)
                } catch (e) {
                    error = e.stack || String(e)
                }
            }
            if (error) {
                failed++
                console.log(`FAIL ${label}\n${error.split('\n').slice(0, 12).join('\n')}\n`)
            } else {
                passed++
                console.log(`ok   ${label}`)
            }
        }
    }
}
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
