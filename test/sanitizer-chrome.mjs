// Equivalence test for src/experiments/sanitizer.js against the real
// DOMPurify 3.4.13 running upstream's WebExperiments._applyTransforms html
// algorithm, side by side in headless Chrome (needs Docker).
//
// Usage:
//   node test/sanitizer-chrome.mjs [--compiled path/to/compiled.js]
//   SANITIZER_SHOW=<substring> also prints upstream's output for matching inputs.
//
// DOMPurify is not vendored. The test looks for dist/purify.js in $DOMPURIFY_JS,
// /tmp/dp/package/dist/purify.js, or node_modules/dompurify/dist/purify.js and
// skips (exit 0) when none is found. To fetch it:
//   mkdir -p /tmp/dp && cd /tmp/dp && curl -sSfLO https://registry.npmjs.org/dompurify/-/dompurify-3.4.13.tgz && tar xzf dompurify-3.4.13.tgz
// --compiled runs the same corpus against a Closure build that assigns the
// function to window.sanitizeExperimentHtml.
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { join, normalize, resolve } from 'node:path'
import { launchChrome } from './diff/chrome.mjs'

const ROOT = resolve(new URL('..', import.meta.url).pathname)
const DOMPURIFY_VERSION = '3.4.13'

const purifyPath = [
    process.env.DOMPURIFY_JS,
    '/tmp/dp/package/dist/purify.js',
    join(ROOT, 'node_modules/dompurify/dist/purify.js'),
].find((p) => p && existsSync(p))
if (!purifyPath) {
    console.log(`SKIP: DOMPurify ${DOMPURIFY_VERSION} dist/purify.js not found (set DOMPURIFY_JS; see header of this file)`)
    process.exit(0)
}
const purifySrc = readFileSync(purifyPath, 'utf8')
if (!purifySrc.includes(`DOMPurify ${DOMPURIFY_VERSION} `)) {
    console.log(`SKIP: ${purifyPath} is not DOMPurify ${DOMPURIFY_VERSION}`)
    process.exit(0)
}
const ci = process.argv.indexOf('--compiled')
const compiledPath = ci > 0 ? resolve(process.argv[ci + 1]) : null

// Target elements, created in the live page (markup appended to a host <div>).
const CONTEXTS = {
    div: '<div id="t"></div>',
    p: '<p id="t"></p>',
    a: '<a id="t" href="#"></a>',
    button: '<button id="t"></button>',
    template: '<template id="t"></template>',
    tbody: '<table><tbody id="t"></tbody></table>',
    tr: '<table><tbody><tr id="t"></tr></tbody></table>',
    select: '<select id="t"></select>',
    textarea: '<textarea id="t"></textarea>',
    style: '<style id="t"></style>',
    svg: '<svg id="t"></svg>',
    'svg g': '<svg><g id="t"></g></svg>',
    'svg title': '<svg><title id="t"></title></svg>',
    'svg desc': '<svg><desc id="t"></desc></svg>',
    'svg foreignObject': '<svg><foreignObject id="t"></foreignObject></svg>',
    'svg a': '<svg><a id="t"></a></svg>',
    'svg text': '<svg><text id="t"></text></svg>',
    math: '<math id="t"></math>',
    'math mrow': '<math><mrow id="t"></mrow></math>',
    'math mi': '<math><mi id="t"></mi></math>',
    'math mo': '<math><mo id="t"></mo></math>',
    'math mtext': '<math><mtext id="t"></mtext></math>',
    'math annotation-xml text/html': '<math><semantics><annotation-xml id="t" encoding="Text/HTML"></annotation-xml></semantics></math>',
    'math annotation-xml xhtml': '<math><semantics><annotation-xml id="t" encoding="application/xhtml+xml"></annotation-xml></semantics></math>',
    'math annotation-xml svg': '<math><semantics><annotation-xml id="t" encoding="image/svg+xml"></annotation-xml></semantics></math>',
    'math annotation-xml': '<math><semantics><annotation-xml id="t"></annotation-xml></semantics></math>',
}

const CORPUS = [
    // plain markup
    'Hello world',
    '<b>bold</b> and <i>italic</i>',
    '  leading whitespace <span>x</span>',
    '<h1 class="title" id="hero">New</h1><p>para</p>',
    '<ul><li>one<li>two</ul><ol start="3"><li>3</li></ol>',
    '<img src="https://example.com/a.png" alt="a" width="10" srcset="a.png 1x, b.png 2x">',
    '<a href="https://example.com/" title="x">link</a>',
    '<a href="/relative?x=1#y">rel</a><a href="mailto:a@b.c">m</a><a href="tel:+1">t</a>',
    '<input type="text" value="  keep spaces  " placeholder=" trimmed ">',
    '<div  class="  padded  " data-x="  y  ">padded attrs</div>',
    // event handlers / style / URIs
    '<img src=x onerror="alert(1)">',
    '<div onclick="alert(1)" onmouseover=alert(2) style="color:red">styled</div>',
    '<a href="javascript:alert(1)">js</a>',
    '<a href=" JaVa&#x09;ScRiPt:alert(1)">js2</a>',
    '<a href="jav&#x0A;ascript:alert(1)">js3</a>',
    '<a href="vbscript:msgbox(1)">vb</a><a href="foo:bar">foo</a><a href="ftp://x">ftp</a>',
    '<img src="data:image/png;base64,AAAA"><a href="data:text/html,<script>alert(1)</script>">d</a>',
    '<img src=" data:image/png;base64,AAAA"><video src="data:video/mp4,xx"></video><source src="data:x">',
    '<div style="background:url(javascript:alert(1))">css</div>',
    '<form action="javascript:alert(1)"><button formaction="javascript:alert(1)">b</button></form>',
    '<iframe src="https://example.com"></iframe><object data="x"></object><embed src="x">',
    '<a href="https://x" xlink:href="javascript:1">dual</a>',
    // target / rel / form attributes
    '<a href="https://x" target="_blank">blank</a>',
    '<a href="https://x" target="_BLANK" rel="noopener opener nofollow  NoOpener external">rel</a>',
    '<a href="https://x" target="_self">self</a><a target="foo">named</a>',
    '<div target="_blank">div target</div><area target="_blank" href="x">',
    '<template><a href="x" target="_blank">in template</a><template><a target="_top">nested</a></template></template>',
    '<input form="f1" name="q"><button form="f1">go</button><select form="f1"></select><textarea form="f1"></textarea>',
    '<div form="f1">div form</div><output form="f1" for="a b">o</output><fieldset form="f1"></fieldset>',
    '<input form="javascript:alert(1)">',
    '<label for="x">label</label><div for="x">no</div><template for="x">t</template>',
    '<div patchsrc="https://x">patch</div>',
    // scripts and styles
    '<script>alert(1)</script>after',
    '<style>body{color:red}</style><p>after style</p>',
    '<style><img src=x onerror=alert(1)></style>',
    '<svg><script>alert(1)</script></svg>',
    // svg
    '<svg width="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="red"/></svg>',
    '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
    '<svg><a href="https://x" target="_blank"><text>svg link</text></a></svg>',
    '<svg><foreignObject><img src=x onerror=alert(1)><b>fo</b></foreignObject></svg>',
    '<svg><desc><b>desc</b></desc><title><i>t</i></title></svg>',
    '<svg><animate attributeName="href" values="javascript:alert(1)"/><set attributeName="onload" to="alert(1)"/></svg>',
    '<svg><use href="data:image/svg+xml,<svg id=x></svg>#x"/></svg>',
    '<svg><image href="data:image/png;base64,AA" xlink:href="data:image/png;base64,AA"/></svg>',
    '<svg><feBlend in="SourceGraphic"/><filter id="f"><feGaussianBlur stdDeviation="2"/></filter></svg>',
    '<svg><style>&lt;img src=x onerror=alert(1)&gt;</style></svg>',
    '<svg><p>html in svg</p></svg>',
    '<svg><math><mi>x</mi></math></svg>',
    // mathml
    '<math><mi>x</mi><mo>+</mo><mn>1</mn></math>',
    '<math><mtext><b>html in mtext</b></mtext></math>',
    '<math><semantics><annotation-xml encoding="text/html"><img src=x onerror=alert(1)><b>b</b></annotation-xml></semantics></math>',
    '<math><annotation-xml encoding="application/xhtml+xml"><svg><circle/></svg></annotation-xml></math>',
    '<math><mi><mglyph><style><img src=x onerror=alert(1)></style></mglyph></mi></math>',
    '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=alert(1)&gt;">',
    '<b>mi text</b><mi>x</mi><svg><circle/></svg>plain',
    'a&lt;b c&gt;d',
    'a&lt;b<!--x-->',
    'a&lt;b<!--<i>-->',
    '<mi>x</mi><mo>y</mo><math>z</math>',
    // templates, fallback content
    '<template><img src=x onerror=alert(1)><p>tpl</p></template>',
    '<template><svg><circle/></svg><foo-bar>c</foo-bar></template>',
    '<div><template shadowrootmode="open"><img src=x onerror=alert(1)><b>shadow</b></template></div>',
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>',
    '<noembed><img src=x onerror=alert(1)></noembed><noframes>nf</noframes>',
    '<xmp><b>xmp</b></xmp><plaintext><b>pt',
    // comments / processing instructions
    '<!-- plain comment -->text<!--<img src=x>-->',
    '<?xml-stylesheet href="x"?>after pi',
    '<![CDATA[<img src=x onerror=alert(1)>]]>',
    '<svg><![CDATA[<img src=x onerror=alert(1)>]]></svg>',
    '<svg><![CDATA[ok text]]></svg>',
    // mXSS-style payloads
    '<p title="</style><img src=x onerror=alert(1)>">t</p>',
    '<p title="--><img src=x>">c</p><p title="]]>x">d</p>',
    '<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">',
    '<math><mi><table><mi><svg><style><img src=x onerror=alert(1)>',
    '<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>',
    '<svg><foreignobject><p><style><p title="</style><iframe onload&#x3d;alert(1)>">',
    '<listing>&lt;img src=x onerror=alert(1)&gt;</listing>',
    '<textarea>&lt;/textarea&gt;&lt;img src=x onerror=alert(1)&gt;</textarea>',
    '<select><option><img src=x onerror=alert(1)>opt</option></select>',
    '<title>&lt;/title&gt;&lt;img src=x&gt;</title>',
    '<a title="a/>b">self close in attr</a>',
    // DOM clobbering
    '<img id="cookie" name="getElementById"><a id="location">x</a>',
    '<form id="test"><input name="attributes"><input name="x"></form>',
    '<form><input name="parentNode"><input name="ok"></form>',
    '<form><input name="firstElementChild"><input name="firstElementChild">&lt;b&gt;</form>',
    '<form><input name="nodeName"></form><form><input name="childNodes"></form>',
    '<img name="body"><img name="forms"><div id="defaultView"></div><div id="safe-id"></div>',
    '<form action="/x" method="post"><input name="q"><input name="action"></form>',
    // custom elements / is
    '<foo-bar class="c" onclick="x">custom content</foo-bar>',
    '<div is="foo-bar">customized builtin</div>',
    '<p is="x-y" class="a">is attr</p><span>after</span>',
    '<annotation-xml>reserved name</annotation-xml><font-face>ff</font-face>',
    // unknown tags (content kept), nested forms/tables
    '<blah>unknown <b>kept</b></blah><foo><bar>deep</bar></foo>',
    '<form><form><input name="n"></form></form>',
    '<table><tr><td>cell<table><td>nested</td></table></td></tr></table>',
    '<table><caption>c</caption><colgroup><col span="2"></colgroup><thead><tr><th>h</th></tr></thead><tbody><tr><td>d</td></tr></tbody></table>',
    '<tr><td>orphan cell</td></tr><td>x</td>',
    '<option>o1</option><optgroup label="g"><option>o2</option></optgroup>',
    '<details open><summary>s</summary>body</details><dialog open>d</dialog>',
    '<audio controls src="https://x/a.mp3"><track src="data:text/vtt,x"></audio>',
    '<html><head><title>t</title></head><body onload="x"><p>body</p></body></html>',
    '<body><p>stray body</p>',
    '<meta http-equiv="refresh" content="0;url=javascript:alert(1)"><link rel="import" href="x"><base href="javascript:/">',
    '<p aria-label="ok" data-foo="bar" data-="x" aria-="y" role="note">aria data</p>',
    '<div xmlns="http://www.w3.org/2000/svg" lang="en" dir="rtl" hidden>attrs</div>',
    '<svg><g xml:space="preserve" xlink:title="t"><text xml:id="x">t</text></g></svg>',
    '',
    '   ',
]

const UPSTREAM = `
const EXPERIMENT_HTML_CONFIG = {
  ADD_ATTR: (attribute, tag) => (attribute === 'target' && tag === 'a') || (attribute === 'form' && /^(button|fieldset|input|output|select|textarea)$/.test(tag)),
  ADD_URI_SAFE_ATTR: ['form'],
}
let experimentSanitizer
function sanitizeLinkTargets(context) {
  const root = context.namespaceURI === 'http://www.w3.org/1999/xhtml' && context.localName === 'template' ? context.content : context
  root.querySelectorAll('a[target], template').forEach((element) => {
    if (element.localName === 'template') {
      if (element.namespaceURI === 'http://www.w3.org/1999/xhtml') sanitizeLinkTargets(element)
      return
    }
    if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml' || element.getAttribute('target')?.toLowerCase() !== '_blank') {
      element.removeAttribute('target')
      return
    }
    const rel = (element.getAttribute('rel') || '').split(/\\s+/).filter((token) => token && !/^(opener|noopener)$/i.test(token))
    rel.push('noopener')
    element.setAttribute('rel', rel.join(' '))
  })
}
window.upstreamSanitize = function (element, html) {
  const encoding = element.namespaceURI === 'http://www.w3.org/1998/Math/MathML' && element.localName === 'annotation-xml'
    ? element.getAttribute('encoding')?.toLowerCase() || '' : ''
  const sanitizer = (experimentSanitizer ??= window.DOMPurify())
  const inertDocument = element.ownerDocument.implementation.createHTMLDocument('')
  const context = inertDocument.createElementNS(element.namespaceURI, element.localName)
  if (encoding) context.setAttribute('encoding', encoding)
  const range = inertDocument.createRange()
  range.selectNodeContents(context)
  const namespace = (element.namespaceURI === 'http://www.w3.org/2000/svg' && /^(foreignObject|desc|title)$/.test(element.localName)) ||
    /^(text\\/html|application\\/xhtml\\+xml)$/.test(encoding) ? 'http://www.w3.org/1999/xhtml' : element.namespaceURI
  const fragment = range.createContextualFragment(html)
  if (element.namespaceURI === 'http://www.w3.org/1998/Math/MathML' && /^(mi|mo|mn|ms|mtext)$/.test(element.localName)) {
    context.appendChild(fragment)
    sanitizer.sanitize(context, { ...EXPERIMENT_HTML_CONFIG, NAMESPACE: namespace || undefined, IN_PLACE: true })
  } else {
    const container = context.namespaceURI === 'http://www.w3.org/1999/xhtml' && context.localName === 'template' ? context.content : context
    container.appendChild(sanitizer.sanitize(fragment, { ...EXPERIMENT_HTML_CONFIG, NAMESPACE: namespace || undefined, RETURN_DOM_FRAGMENT: true }))
  }
  sanitizeLinkTargets(context)
  return context.innerHTML
}
`

const page = (impl) => `<!doctype html><meta charset="utf-8"><title>sanitizer</title>
<script src="/purify.js"></script>
<script>${UPSTREAM}</script>
${impl === 'compiled'
        ? '<script src="/compiled.js"></script><script>window.portSanitize = window.sanitizeExperimentHtml; window.ready = true</script>'
        : '<script type="module">import {sanitizeExperimentHtml} from "/src/experiments/sanitizer.js"; window.portSanitize = sanitizeExperimentHtml; window.ready = true</script>'}
<div id="hosts"></div>`

const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname
    const send = (type, body) => { res.writeHead(200, { 'content-type': type }); res.end(body) }
    if (path === '/source' || path === '/compiled') return send('text/html', page(path.slice(1)))
    if (path === '/purify.js') return send('text/javascript', purifySrc)
    if (path === '/compiled.js' && compiledPath) return send('text/javascript', readFileSync(compiledPath))
    const file = normalize(join(ROOT, path))
    if (file.startsWith(join(ROOT, 'src') + '/') && existsSync(file)) return send('text/javascript', readFileSync(file))
    res.writeHead(404); res.end()
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://sanitizer.example.test:${server.address().port}`

// Runs in the page: every corpus entry in every context through both implementations.
function runAll(contexts, corpus) {
    const hosts = document.getElementById('hosts')
    const run = (fn, el, html) => {
        try {
            return 'OK ' + fn(el, html)
        } catch (e) {
            return 'THROW ' + e.name + ': ' + e.message
        }
    }
    const out = []
    for (const [name, markup] of Object.entries(contexts)) {
        hosts.innerHTML = markup
        const el = hosts.querySelector('#t')
        if (!el) throw new Error('context not created: ' + name)
        for (const html of corpus) {
            out.push({ context: name, html, expected: run(window.upstreamSanitize, el, html), actual: run(window.portSanitize, el, html) })
        }
    }
    return { version: window.DOMPurify.version, out }
}

const chrome = await launchChrome()
let failed = false
try {
    for (const impl of compiledPath ? ['source', 'compiled'] : ['source']) {
        const p = await chrome.newPage()
        await p.goto(`${base}/${impl}`)
        await p.waitFor('window.ready === true')
        const { version, out } = await p.evaluate(`(${runAll})(${JSON.stringify(CONTEXTS)}, ${JSON.stringify(CORPUS)})`)
        if (version !== DOMPURIFY_VERSION) throw new Error('page loaded DOMPurify ' + version)
        const mismatches = out.filter((r) => r.expected !== r.actual)
        const show = process.env.SANITIZER_SHOW // print cases whose input contains this substring
        if (show) for (const r of out.filter((r) => r.html.includes(show))) console.log(`[${impl}] ${r.context} ${JSON.stringify(r.html)}\n  ${r.expected}`)
        const throws = out.filter((r) => r.expected.startsWith('THROW')).length
        for (const m of mismatches.slice(0, 30)) {
            console.log(`MISMATCH [${impl}] context=${m.context} html=${JSON.stringify(m.html)}\n  expected: ${m.expected}\n  actual:   ${m.actual}`)
        }
        console.log(`[${impl}] DOMPurify ${version}: ${CORPUS.length} inputs x ${Object.keys(CONTEXTS).length} contexts = ` +
            `${out.length} cases, ${out.length - mismatches.length} identical, ${mismatches.length} mismatches ` +
            `(${throws} cases where upstream throws)`)
        if (p.consoleErrors.length) console.log(`[${impl}] page errors:`, p.consoleErrors)
        failed ||= mismatches.length > 0 || p.consoleErrors.length > 0
        await p.close()
    }
} finally {
    chrome.close()
    server.close()
}
console.log(failed ? 'SANITIZER EQUIVALENCE FAILED' : 'SANITIZER EQUIVALENCE OK')
process.exitCode = failed ? 1 : 0
