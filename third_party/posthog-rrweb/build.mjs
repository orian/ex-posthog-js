// Builds recorder.js (PostHog's rrweb fork + its console and network plugins)
// from the vendored TypeScript sources with esbuild. Runs inside the pinned
// toolchain image (docker/recorder-build); see scripts/build-recorder.sh.
//
//   node build.mjs --root <dir with packages/> --out <file.js> [--no-minify] [--metafile <file.json>] [--equivalence]
//
// The entry is upstream's packages/browser/src/entrypoints/recorder.ts,
// unchanged. Package imports resolve to the vendored sources, the way
// upstream's builds resolve its pnpm workspace packages:
//   @posthog/rrweb-record    packages/rrweb/record/src/index.ts
//   @posthog/rrweb           packages/rrweb/rrweb/src/entries/record.ts (record side only,
//                            as in rrweb-record's own vite config)
//   @posthog/rrweb-snapshot  packages/rrweb/rrweb-snapshot/src/record.ts (idem)
//   @posthog/rrdom           packages/rrweb/rrdom/src/index.ts (idem)
//   base64-arraybuffer       deps/base64-arraybuffer-1.0.2 (npm, as pinned in upstream's lockfile)
//   @posthog/rrweb-types     packages/rrweb/types/src/index.ts
//   @posthog/rrweb-utils     packages/rrweb/utils/src/index.ts
//   @posthog/rrweb-plugin-console-record  packages/rrweb/plugins/rrweb-plugin-console-record/src/index.ts
//   @posthog/browser-common/utils/<x>     packages/browser-common/src/utils/<x>.ts
//   @posthog/core            packages/core/src/utils/index.ts (the recorder uses only these helpers)
// `<file>?worker&inline` imports are vite's inline workers: the worker is
// bundled on its own and embedded as a string with vite's blob-URL wrapper.
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const esbuild = createRequire(import.meta.url)('esbuild')

const args = process.argv.slice(2)
const opt = (name, def) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : def
}
const HERE = path.dirname(new URL(import.meta.url).pathname)
const ROOT = path.resolve(opt('--root', path.join(HERE, 'src')))
const OUT = path.resolve(opt('--out', 'dist/recorder.js'))
const MINIFY = !args.includes('--no-minify')
const METAFILE = opt('--metafile', '')
// Test builds only (test/bench/recorder-equivalence.mjs): rrweb's clock and timers come
// from the page's `__rrEquiv`, so two copies recording the same page see the same times.
const EQUIVALENCE = args.includes('--equivalence')

const P = (...p) => path.join(ROOT, 'packages', ...p)
const PACKAGES = {
    '@posthog/rrweb-record': P('rrweb/record/src/index.ts'),
    '@posthog/rrweb': P('rrweb/rrweb/src/entries/record.ts'),
    '@posthog/rrweb-snapshot': P('rrweb/rrweb-snapshot/src/record.ts'),
    '@posthog/rrdom': P('rrweb/rrdom/src/index.ts'),
    '@posthog/rrweb-types': P('rrweb/types/src/index.ts'),
    '@posthog/rrweb-utils': P('rrweb/utils/src/index.ts'),
    '@posthog/rrweb-plugin-console-record': P('rrweb/plugins/rrweb-plugin-console-record/src/index.ts'),
    // upstream bundles @posthog/core's dist, whose index re-exports ./utils among others;
    // the recorder only uses helpers from ./utils.
    '@posthog/core': P('core/src/utils/index.ts'),
}

// Browsers: upstream's recorder.js is Babel preset-env output for
// 'chrome > 62, firefox > 59, ios_saf >= 10.3, opera > 50, safari > 12'
// (esbuild has no ios10.3 const support, so ios11; Babel left const as is too)
// (plus '> 0.5%, last 2 versions, Firefox ESR, not dead').
const TARGET = ['chrome63', 'firefox60', 'safari12', 'ios11', 'opera50', 'edge79']

// npm dependencies of the record side (unmodified, under deps/).
const DEPS = {
    'base64-arraybuffer': path.join(HERE, 'deps/base64-arraybuffer-1.0.2/base64-arraybuffer.es5.js'),
}

// The fork's tsconfig.base.json (target ESNext, so define semantics for class
// fields). Set here so no tsconfig.json lookup can change the output.
const TSCONFIG = { compilerOptions: { useDefineForClassFields: true } }

const resolvePlugin = {
    name: 'posthog-workspace',
    setup(build) {
        build.onResolve({ filter: /^base64-arraybuffer$/ }, (a) => ({ path: DEPS[a.path] }))
        // @posthog/core is side-effect free; upstream's rollup build tree-shakes
        // its unused helpers (e.g. the user agent tables) away, so let esbuild too.
        build.onResolve({ filter: /^\./ }, (a) => {
            if (!a.importer.includes('/packages/core/src/')) return undefined
            const base = path.resolve(a.resolveDir, a.path)
            const file = [base + '.ts', path.join(base, 'index.ts')].find((f) => fs.existsSync(f))
            return file ? { path: file, sideEffects: false } : undefined
        })
        build.onResolve({ filter: /^@posthog\// }, (a) => {
            if (PACKAGES[a.path]) return { path: PACKAGES[a.path], sideEffects: a.path === '@posthog/core' ? false : undefined }
            const m = /^@posthog\/browser-common\/(utils\/[\w-]+)$/.exec(a.path)
            if (m) return { path: P('browser-common/src', m[1] + '.ts') }
            return { errors: [{ text: `unmapped workspace import ${a.path}` }] }
        })
        build.onResolve({ filter: /\?worker&inline$/ }, (a) => {
            const file = path.resolve(a.resolveDir, a.path.replace(/\?worker&inline$/, ''))
            const ts = [file + '.ts', file + '.js', file].find((f) => fs.existsSync(f))
            return { path: ts, namespace: 'inline-worker' }
        })
        build.onLoad({ filter: /.*/, namespace: 'inline-worker' }, async (a) => {
            const worker = await esbuild.build({
                entryPoints: [a.path],
                bundle: true,
                write: false,
                format: 'iife',
                target: TARGET,
                minify: MINIFY,
                legalComments: 'none',
                tsconfigRaw: TSCONFIG,
                plugins: [resolvePlugin],
            })
            const code = worker.outputFiles[0].text
            // vite's `?worker&inline` wrapper (as in upstream's recorder.js).
            return {
                loader: 'js',
                resolveDir: path.dirname(a.path),
                contents: `const encodedJs = ${JSON.stringify(code)};
const blob = typeof self !== "undefined" && self.Blob && new Blob(["(self.URL || self.webkitURL).revokeObjectURL(self.location.href);", encodedJs], { type: "text/javascript;charset=utf-8" });
export default function WorkerWrapper(options) {
  let objURL;
  try {
    objURL = blob && (self.URL || self.webkitURL).createObjectURL(blob);
    if (!objURL) throw "";
    const worker = new Worker(objURL, { name: options?.name });
    worker.addEventListener("error", () => { (self.URL || self.webkitURL).revokeObjectURL(objURL); });
    return worker;
  } catch (e) {
    return new Worker("data:text/javascript;charset=utf-8," + encodeURIComponent(encodedJs), { name: options?.name });
  }
}
`,
            }
        })
    },
}

const result = await esbuild.build({
    entryPoints: [P('browser/src/entrypoints/recorder.ts')],
    outfile: OUT,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: TARGET,
    minify: MINIFY,
    sourcemap: 'linked',
    sourceRoot: '',
    legalComments: 'none',
    metafile: !!METAFILE,
    tsconfigRaw: TSCONFIG,
    define: EQUIVALENCE
        ? { 'Date.now': 'window.__rrEquiv.now', setTimeout: 'window.__rrEquiv.setTimeout', clearTimeout: 'window.__rrEquiv.clearTimeout' }
        : undefined,
    logLevel: 'warning',
    banner: { js: `/* recorder.js: PostHog's rrweb fork (@posthog/rrweb-record 0.0.89, posthog-js 1.450.0), MIT; built from third_party/posthog-rrweb */` },
    plugins: [resolvePlugin],
})
if (METAFILE) fs.writeFileSync(METAFILE, JSON.stringify(result.metafile, null, 1))
for (const w of result.warnings) console.warn(w.text)
