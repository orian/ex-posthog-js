// Lumen AI demo app: a deterministic plain-JS single page app used as the
// session benchmark's workload (test/bench/session.mjs). Every piece of
// content and every timer delay comes from a seeded PRNG, so all variants
// (no SDK, official, ours) render and stream exactly the same thing.
(function () {
  'use strict'

  // ---- seeded randomness -------------------------------------------------------
  function prng(seed) {
    var a = seed >>> 0
    var next = function () {
      a = (a + 0x6d2b79f5) >>> 0
      var t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    return {
      next: next,
      int: function (lo, hi) { return lo + Math.floor(next() * (hi - lo + 1)) },
      pick: function (arr) { return arr[Math.floor(next() * arr.length)] },
      chance: function (p) { return next() < p },
    }
  }
  function hash(s) {
    var h = 2166136261
    for (var i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
    return h >>> 0
  }

  var WORDS = ('model context window latency tokens embeddings retrieval vector index agent workflow pipeline prompt ' +
    'evaluation dataset fine-tuning inference throughput cache streaming guardrails schema function tool memory ' +
    'workspace team deploy monitor accuracy reasoning summary insight document search answer customer support').split(' ')
  function words(r, n) { var o = []; for (var i = 0; i < n; i++) o.push(r.pick(WORDS)); return o.join(' ') }
  function sentence(r, n) { var s = words(r, n); return s.charAt(0).toUpperCase() + s.slice(1) + '.' }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] }) }
  function $(sel, root) { return (root || document).querySelector(sel) }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)) }

  var PALETTE = ['#7c5cff', '#5b8cff', '#29d3a3', '#ffb648', '#ff5c7a', '#38bdf8', '#a78bfa', '#f472b6', '#34d399', '#facc15']

  // ---- generated artwork (inline SVG, no external assets) --------------------------
  function thumb(seed, w, h) {
    var r = prng(seed)
    var id = 'g' + seed
    var c1 = r.pick(PALETTE)
    var c2 = r.pick(PALETTE)
    var s = '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="xMidYMid slice" role="img" aria-label="illustration">' +
      '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="' + c1 + '" stop-opacity=".9"/>' +
      '<stop offset="1" stop-color="' + c2 + '" stop-opacity=".35"/></linearGradient></defs>' +
      '<rect width="' + w + '" height="' + h + '" fill="#141823"/><rect width="' + w + '" height="' + h + '" fill="url(#' + id + ')" opacity=".55"/>'
    var n = r.int(5, 9)
    for (var i = 0; i < n; i++) {
      var col = r.pick(PALETTE)
      var kind = r.int(0, 2)
      if (kind === 0) s += '<circle cx="' + r.int(0, w) + '" cy="' + r.int(0, h) + '" r="' + r.int(8, h / 3) + '" fill="' + col + '" opacity="' + (0.2 + r.next() * 0.5).toFixed(2) + '"/>'
      else if (kind === 1) s += '<rect x="' + r.int(0, w - 40) + '" y="' + r.int(0, h - 30) + '" width="' + r.int(30, w / 2) + '" height="' + r.int(12, h / 3) + '" rx="6" fill="' + col + '" opacity="' + (0.2 + r.next() * 0.4).toFixed(2) + '"/>'
      else s += '<path d="M0 ' + r.int(h / 2, h) + ' Q ' + r.int(0, w) + ' ' + r.int(0, h) + ' ' + w + ' ' + r.int(h / 3, h) + '" stroke="' + col + '" stroke-width="' + r.int(2, 6) + '" fill="none" opacity=".7"/>'
    }
    return s + '</svg>'
  }
  var ICONS = {
    bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    chat: '<path d="M4 4h16v12H8l-4 4z"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
    code: '<path d="m8 6-6 6 6 6M16 6l6 6-6 6"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
    users: '<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6M17 4a4 4 0 0 1 0 8M22 21c0-3-1.5-5-4-5.6"/>',
    card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
  }
  function icon(name, size) {
    return '<svg width="' + (size || 20) + '" height="' + (size || 20) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + ICONS[name] + '</svg>'
  }

  // ---- tiny markdown renderer (headings, lists, tables, code fences, inline) ---------
  var KW = /\b(const|let|var|function|return|await|async|import|from|export|if|else|for|while|new|class|def|in|None|True|False|with|as)\b/g
  function highlight(code) {
    var out = ''
    var re = /(\/\/.*|#.*)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`[^`]*`?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)(?=\()|([{}()[\];,.=<>+\-*/:])/g
    var last = 0
    var m
    while ((m = re.exec(code))) {
      out += esc(code.slice(last, m.index)).replace(KW, '<span class="tok-k">$1</span>')
      var cls = m[1] ? 'c' : m[2] ? 's' : m[3] ? 'n' : m[4] ? 'f' : 'p'
      out += '<span class="tok-' + cls + '">' + esc(m[0]) + '</span>'
      last = re.lastIndex
    }
    return out + esc(code.slice(last)).replace(KW, '<span class="tok-k">$1</span>')
  }
  function inline(s) {
    return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>')
  }
  function markdown(src) {
    var lines = src.split('\n')
    var html = ''
    var i = 0
    while (i < lines.length) {
      var line = lines[i]
      var fence = /^```(\w*)/.exec(line)
      if (fence) {
        var code = []
        i++
        while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++])
        i++
        html += '<div class="code"><div class="code-head"><span>' + (fence[1] || 'text') + '</span><button class="copy" type="button">Copy</button></div><pre><code>' + highlight(code.join('\n')) + '</code></pre></div>'
        continue
      }
      if (/^\|/.test(line)) {
        var rows = []
        while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++])
        html += '<table>'
        rows.forEach(function (row, n) {
          if (/^\|[\s:-]+\|/.test(row) && n === 1) return
          var cells = row.replace(/^\||\|$/g, '').split('|')
          var tag = n === 0 ? 'th' : 'td'
          html += '<tr>' + cells.map(function (c) { return '<' + tag + '>' + inline(c.trim()) + '</' + tag + '>' }).join('') + '</tr>'
        })
        html += '</table>'
        continue
      }
      var h = /^(#{1,4}) (.*)/.exec(line)
      if (h) { html += '<h3>' + inline(h[2]) + '</h3>'; i++; continue }
      if (/^(\d+\.|-) /.test(line)) {
        var ordered = /^\d/.test(line)
        html += ordered ? '<ol>' : '<ul>'
        while (i < lines.length && /^(\d+\.|-) /.test(lines[i])) html += '<li>' + inline(lines[i++].replace(/^(\d+\.|-) /, '')) + '</li>'
        html += ordered ? '</ol>' : '</ul>'
        continue
      }
      if (line.trim()) {
        var para = [line]
        i++
        while (i < lines.length && lines[i].trim() && !/^(```|\||#|\d+\.|- )/.test(lines[i])) para.push(lines[i++])
        html += '<p>' + inline(para.join(' ')) + '</p>'
        continue
      }
      i++
    }
    return html
  }

  // ---- shell: router, toasts, dropdowns, modal ----------------------------------
  var app = $('#app')
  var routes = {}
  var cleanup = []
  function navigate(url) {
    history.pushState({}, '', url)
    render()
  }
  function render() {
    cleanup.splice(0).forEach(function (f) { f() })
    var path = location.pathname.replace(/\/+$/, '') || '/site'
    var view = routes[path] || routes['/site']
    $all('#nav [data-route]').forEach(function (a) { a.classList.toggle('active', a.getAttribute('href').replace(/\/$/, '') === path) })
    document.title = view.title + ' · Lumen AI'
    $('#footer').style.display = view.app ? 'none' : ''
    app.innerHTML = ''
    view.render(app)
    window.scrollTo(0, 0)
  }
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[data-link]')
    if (a) { e.preventDefault(); navigate(a.getAttribute('href')); return }
    var t = e.target.closest && e.target.closest('.dropdown-toggle')
    $all('.dropdown.open').forEach(function (d) { if (!t || d !== t.parentNode) d.classList.remove('open') })
    if (t) t.parentNode.classList.toggle('open')
    var opt = e.target.closest && e.target.closest('.dropdown [role=option]')
    if (opt) {
      var dd = opt.closest('.dropdown')
      $all('[role=option]', dd).forEach(function (o) { o.setAttribute('aria-selected', String(o === opt)) })
      $('.dropdown-toggle span', dd).textContent = opt.textContent
      dd.classList.remove('open')
      dd.dispatchEvent(new CustomEvent('select', { detail: opt.getAttribute('data-value') }))
    }
    var copy = e.target.closest && e.target.closest('.code .copy')
    if (copy) { copy.textContent = 'Copied'; toast('Code copied to clipboard') }
  })
  window.addEventListener('popstate', render)
  function toast(msg) {
    var t = document.createElement('div')
    t.className = 'toast'
    t.textContent = msg
    $('#toasts').appendChild(t)
    setTimeout(function () { t.remove() }, 2600)
  }
  function dropdown(id, label, options, selected) {
    return '<div class="dropdown" id="' + id + '"><button type="button" class="dropdown-toggle" aria-haspopup="listbox"><span>' + esc(label) + '</span></button>' +
      '<div class="dropdown-list" role="listbox">' + options.map(function (o) {
        return '<div role="option" data-value="' + esc(o) + '" aria-selected="' + (o === selected) + '">' + esc(o) + '</div>'
      }).join('') + '</div></div>'
  }
  function modal(html) {
    var root = $('#modal-root')
    root.innerHTML = '<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true">' + html + '</div></div>'
    var close = function () { root.innerHTML = ''; document.removeEventListener('keydown', onKey) }
    var onKey = function (e) { if (e.key === 'Escape') close() }
    document.addEventListener('keydown', onKey)
    root.firstChild.addEventListener('click', function (e) { if (e.target === root.firstChild || e.target.closest('.close')) close() })
    cleanup.push(close)
    return { el: root.firstChild, close: close }
  }

  // Header resources menu and footer (static, rendered once).
  var RES = [['code', 'Documentation', 'Guides and API reference'], ['layers', 'Templates', 'Starter prompts and workflows'], ['chart', 'Benchmarks', 'Accuracy and latency reports'],
    ['users', 'Community', 'Forum, Discord and events'], ['globe', 'Status', 'All systems operational'], ['bolt', 'Changelog', 'What shipped this week']]
  $('#resources-list').innerHTML = RES.map(function (x) {
    return '<a href="/site/pricing" data-link class="res-item"><span class="menu-icon">' + icon(x[0], 18) + '</span><span>' + x[1] + '<small>' + x[2] + '</small></span></a>'
  }).join('')
  ;(function footer() {
    var r = prng(7)
    var cols = ['Product', 'Solutions', 'Resources', 'Company']
    $('#footer').innerHTML = '<div class="container"><div class="footer-grid"><div><a class="logo" href="/site/" data-link>Lumen AI</a><p class="mt-3">' + sentence(r, 14) +
      '</p><form class="newsletter" onsubmit="return false"><input class="input" id="newsletter-email" type="email" placeholder="you@company.com" aria-label="Email"><button class="btn btn-secondary" type="submit">Subscribe</button></form></div>' +
      cols.map(function (c) {
        var items = ''
        for (var i = 0; i < 8; i++) items += '<li><a href="/site/" data-link>' + words(r, 2).replace(/^./, function (x) { return x.toUpperCase() }) + '</a></li>'
        return '<div><h6>' + c + '</h6><ul>' + items + '</ul></div>'
      }).join('') + '</div><div class="legal"><span>© 2026 Lumen Labs, Inc.</span><span><a href="/site/" data-link>Privacy</a> · <a href="/site/" data-link>Terms</a> · <a href="/site/" data-link>Cookies</a></span></div></div>'
  })()

  // ---- landing ------------------------------------------------------------------
  var CATS_LANDING = ['Support', 'Sales', 'Engineering', 'Marketing', 'Ops']
  routes['/site'] = {
    title: 'Home',
    render: function (el) {
      var r = prng(1)
      var feats = [['bolt', 'Streaming answers'], ['search', 'Grounded retrieval'], ['lock', 'Enterprise security'], ['chart', 'Usage analytics'], ['layers', 'Workflow builder'],
        ['code', 'API and SDKs'], ['globe', 'Multilingual'], ['users', 'Team workspaces'], ['chat', 'Slack and Teams'], ['card', 'Usage-based billing'],
        ['bolt', 'Batch inference'], ['lock', 'Audit logs']]
      var integrations = ['Slack', 'Teams', 'Zendesk', 'Intercom', 'Notion', 'Confluence', 'Jira', 'Linear', 'GitHub', 'GitLab', 'Salesforce', 'HubSpot', 'Snowflake', 'BigQuery', 'Postgres',
        'S3', 'Drive', 'Dropbox', 'Gmail', 'Outlook', 'Figma', 'Asana', 'Trello', 'Airtable', 'Stripe', 'Shopify', 'Segment', 'Datadog', 'Sentry', 'PagerDuty']
      var heroArt = '<svg viewBox="0 0 520 380"><rect width="520" height="380" fill="#11141b"/><rect width="520" height="34" fill="#181c25"/>' +
        [0, 1, 2].map(function (i) { return '<circle cx="' + (18 + i * 16) + '" cy="17" r="5" fill="' + ['#ff5c7a', '#ffb648', '#29d3a3'][i] + '"/>' }).join('') +
        '<rect x="0" y="34" width="130" height="346" fill="#0e1117"/>' +
        [0, 1, 2, 3, 4, 5, 6].map(function (i) { return '<rect x="14" y="' + (52 + i * 26) + '" width="' + r.int(60, 100) + '" height="10" rx="5" fill="#2a3142"/>' }).join('') +
        [0, 1, 2, 3].map(function (i) {
          var y = 56 + i * 76
          var user = i % 2 === 0
          return '<rect x="' + (user ? 300 : 150) + '" y="' + y + '" width="' + (user ? 200 : 300) + '" height="' + (user ? 40 : 60) + '" rx="10" fill="' + (user ? '#232a3a' : '#1b2030') + '"/>' +
            '<rect x="' + (user ? 314 : 166) + '" y="' + (y + 14) + '" width="' + r.int(80, user ? 160 : 250) + '" height="8" rx="4" fill="#3b4459"/>' +
            (user ? '' : '<rect x="166" y="' + (y + 32) + '" width="' + r.int(80, 200) + '" height="8" rx="4" fill="#7c5cff" opacity=".7"/>')
        }).join('') + '<rect x="150" y="330" width="350" height="34" rx="10" fill="#181c25" stroke="#2a3142"/></svg>'
      var html = '<section class="hero"><div class="container hero-grid"><div><span class="badge badge-brand">New · Lumen 4 with 1M token context</span>' +
        '<h1 class="mt-4">The AI assistant for <span>your whole team</span></h1><p class="lead">' + sentence(r, 22) + '</p>' +
        '<div class="hero-ctas"><a class="btn btn-primary btn-lg" href="/site/signup" data-link id="hero-cta">Start free trial</a><a class="btn btn-secondary btn-lg" href="/site/chat" data-link id="hero-demo">Try the demo</a></div>' +
        '<p class="hero-note">No credit card required · SOC 2 Type II · GDPR</p></div><div class="hero-art">' + heroArt + '</div></div>' +
        '<div class="container logos">' + ['Northwind', 'Acme', 'Globex', 'Initech', 'Umbrella', 'Hooli', 'Vandelay', 'Stark'].map(function (n) {
          return '<svg viewBox="0 0 120 26"><text x="0" y="19" fill="#9aa3b5" font-family="sans-serif" font-weight="800" font-size="18">' + n + '</text></svg>'
        }).join('') + '</div></section>' +
        '<section class="section section-alt" id="features"><div class="container"><div class="section-head"><span class="eyebrow">Platform</span><h2>Everything you need to ship AI features</h2><p>' + sentence(r, 18) + '</p></div><div class="grid grid-3">' +
        feats.map(function (f) { return '<div class="feature"><div class="icon">' + icon(f[0], 22) + '</div><h3>' + f[1] + '</h3><p>' + sentence(r, 18) + '</p></div>' }).join('') + '</div></div></section>' +
        '<section class="section"><div class="container grid grid-2" style="align-items:center"><div class="steps"><span class="eyebrow">How it works</span><h2>From prompt to production in minutes</h2>' +
        [0, 1, 2].map(function () { return '<div class="step"><h4>' + sentence(r, 4) + '</h4><p class="text-muted">' + sentence(r, 16) + '</p></div>' }).join('') + '</div><div>' +
        markdown('```js\nimport { Lumen } from "@lumen/sdk"\n\nconst lumen = new Lumen({ apiKey: process.env.LUMEN_KEY })\nconst stream = await lumen.chat.stream({\n  model: "lumen-4",\n  messages: [{ role: "user", content: "Summarise this ticket" }],\n})\nfor await (const chunk of stream) process.stdout.write(chunk.text)\n```') + '</div></div></section>' +
        '<section class="section section-alt"><div class="container stats">' + [['12B', 'tokens a day'], ['99.99%', 'uptime'], ['180ms', 'median first token'], ['40k', 'teams']].map(function (s) {
          return '<div class="stat"><strong>' + s[0] + '</strong><span>' + s[1] + '</span></div>' }).join('') + '</div></section>' +
        '<section class="section" id="integrations"><div class="container"><div class="section-head"><span class="eyebrow">Integrations</span><h2>Works with the tools you already use</h2></div><div class="grid grid-4">' +
        integrations.map(function (n, k) {
          return '<a class="feature row" href="/site/pricing" data-link><span class="icon m-0" style="background:' + PALETTE[k % PALETTE.length] + '33">' + icon(Object.keys(ICONS)[k % 10], 18) + '</span><span><strong>' + n + '</strong><br><small class="text-muted">' + words(r, 2) + '</small></span></a>'
        }).join('') + '</div></div></section>' +
        '<section class="section section-alt" id="templates"><div class="container"><div class="section-head"><span class="eyebrow">Templates</span><h2>Start from a proven workflow</h2></div><div class="cards">' +
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23].map(function (k) {
          return '<article class="card"><div class="thumb">' + thumb(700 + k, 320, 120) + '</div><div class="content"><div class="row-between"><h4 class="m-0">' + sentence(r, 3).replace(/\.$/, '') + '</h4><span class="badge">' + CATS_LANDING[k % 5] + '</span></div>' +
            '<p class="desc">' + sentence(r, 12) + '</p><div class="foot"><span class="text-xs text-faint">' + r.int(2, 90) + 'k uses</span><a class="btn btn-ghost btn-sm" href="/site/chat" data-link>Use template</a></div></div></article>'
        }).join('') + '</div></div></section>' +
        '<section class="section section-alt" id="blog"><div class="container"><div class="section-head"><span class="eyebrow">From the blog</span><h2>Latest updates</h2></div><div class="cards">' +
        [0, 1, 2, 3, 4, 5].map(function (k) {
          return '<article class="card"><div class="thumb">' + thumb(500 + k, 320, 180) + '</div><div class="content"><span class="text-xs text-faint">2026-1' + (k % 2) + '-' + (10 + k) + ' · ' + r.int(3, 12) + ' min read</span><h4 class="mt-2">' + sentence(r, 6).replace(/\.$/, '') + '</h4><p class="desc">' + sentence(r, 18) + '</p></div></article>'
        }).join('') + '</div></div></section>' +
        '<section class="section"><div class="container"><div class="section-head"><span class="eyebrow">Loved by teams</span><h2>What our customers say</h2></div><div class="grid grid-3">' +
        [0, 1, 2, 3, 4, 5].map(function (i) {
          return '<figure class="testimonial m-0"><blockquote>“' + sentence(r, 20) + '”</blockquote><div class="who"><div class="avatar">' + 'ABCDEFGH'[i] + 'K</div><div><strong>' + words(r, 2) + '</strong><br>' + words(r, 1) + ' at ' + ['Acme', 'Globex', 'Hooli', 'Initech', 'Stark', 'Wayne'][i] + '</div></div></figure>'
        }).join('') + '</div></div></section>' +
        '<section class="section section-alt"><div class="container" style="max-width:820px"><div class="section-head"><h2>Frequently asked questions</h2></div><div class="faq">' +
        [0, 1, 2, 3, 4, 5, 6, 7].map(function (i) { return '<details id="faq-' + i + '"><summary>' + sentence(r, 7).replace(/\.$/, '?') + '</summary><p>' + sentence(r, 30) + '</p></details>' }).join('') + '</div></div></section>' +
        '<section class="section"><div class="container"><div class="cta-band"><h2>Ready to put AI to work?</h2><p class="text-muted">' + sentence(r, 14) + '</p><div class="row" style="justify-content:center">' +
        '<a class="btn btn-primary btn-lg" href="/site/pricing" data-link id="cta-pricing">See pricing</a><a class="btn btn-ghost btn-lg" href="/site/chat" data-link>Talk to Lumen</a></div></div></div></section>'
      el.innerHTML = html
    },
  }

  // ---- chat with streaming answers ---------------------------------------------------
  var CODE = [
    'js\nasync function embed(texts) {\n  const res = await fetch("/v1/embeddings", {\n    method: "POST",\n    headers: { "Content-Type": "application/json" },\n    body: JSON.stringify({ model: "lumen-embed-3", input: texts }),\n  })\n  const { data } = await res.json()\n  return data.map((d) => d.embedding) // one vector per input\n}',
    'python\nfrom lumen import Lumen\n\nclient = Lumen()\ndef summarise(doc, max_tokens=400):\n    # chunk long documents first\n    chunks = [doc[i:i + 8000] for i in range(0, len(doc), 8000)]\n    parts = [client.complete(f"Summarise: {c}", max_tokens=200) for c in chunks]\n    return client.complete("Merge these summaries: " + "\\n".join(parts), max_tokens=max_tokens)',
    'js\nconst cache = new Map()\nexport async function cachedAnswer(question) {\n  const key = question.trim().toLowerCase()\n  if (cache.has(key)) return cache.get(key)\n  const answer = await lumen.chat({ model: "lumen-4-mini", messages: [{ role: "user", content: question }] })\n  cache.set(key, answer)\n  return answer\n}',
    'sql\nSELECT date_trunc(\'day\', created_at) AS day,\n       count(*) AS requests,\n       percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95\nFROM completions\nWHERE created_at > now() - interval \'30 days\'\nGROUP BY 1 ORDER BY 1',
  ]
  function answerFor(question, turn) {
    var r = prng(hash(question) + turn * 101)
    var md = sentence(r, 16) + ' ' + sentence(r, 12) + '\n\n### ' + sentence(r, 4).replace(/\.$/, '') + '\n\n'
    for (var i = 1; i <= r.int(3, 5); i++) md += i + '. **' + words(r, 2) + '**: ' + sentence(r, r.int(8, 16)) + '\n'
    md += '\n' + sentence(r, 14) + ' Use `' + r.pick(WORDS) + '_' + r.pick(WORDS) + '` to keep it simple.\n\n```' + CODE[(turn + hash(question)) % CODE.length] + '\n```\n\n'
    md += '| Option | Latency | Cost per 1M tokens |\n|---|---|---|\n'
    for (var j = 0; j < 4; j++) md += '| ' + words(r, 2) + ' | ' + r.int(80, 900) + ' ms | $' + (r.next() * 12).toFixed(2) + ' |\n'
    md += '\n**Tip:** ' + sentence(r, 18)
    return md
  }
  function tokenize(text) {
    // LLM-like chunks: words split into pieces of at most 4 characters.
    var out = []
    ;(text.match(/\s+|[^\s]+/g) || []).forEach(function (w) {
      for (var i = 0; i < w.length; i += 4) out.push(w.slice(i, i + 4))
    })
    return out
  }
  var chatState = { turn: 0, model: 'Lumen 4', streaming: false }
  routes['/site/chat'] = {
    title: 'Chat', app: true,
    render: function (el) {
      var r = prng(3)
      var convs = ''
      for (var i = 0; i < 40; i++) convs += (i === 0 ? '<h5>Today</h5>' : i === 5 ? '<h5>Previous 7 days</h5>' : i === 18 ? '<h5>Older</h5>' : '') + '<a class="conv' + (i === 0 ? ' active' : '') + '" data-conv="' + i + '">' + sentence(r, r.int(3, 6)).replace(/\.$/, '') + '</a>'
      el.innerHTML = '<div class="chat"><aside class="chat-side"><button class="btn btn-secondary new" id="new-chat" type="button">' + icon('chat', 16) + ' New chat</button><div class="conv-list">' + convs + '</div></aside>' +
        '<section class="chat-main"><div class="chat-top">' + dropdown('model-select', chatState.model, ['Lumen 4', 'Lumen 4 mini', 'Lumen 4 vision', 'Lumen reasoning'], chatState.model) +
        '<span class="badge badge-green">Online</span><span class="spacer"></span><button class="btn btn-ghost btn-sm" type="button" id="share">Share</button></div>' +
        '<div class="transcript" id="transcript"></div>' +
        '<div class="composer"><form class="composer-box" id="composer"><textarea id="prompt" rows="1" placeholder="Message Lumen…" aria-label="Message"></textarea>' +
        '<button class="btn btn-primary btn-icon" id="send" type="submit" aria-label="Send">' + icon('bolt', 16) + '</button></form>' +
        '<div class="hint">Lumen can make mistakes. Check important info. Press Enter to send, Shift+Enter for a new line.</div></div></section></div>'
      var transcript = $('#transcript')
      var prompt = $('#prompt')
      var suggestionsHtml = '<div class="suggestions" id="suggestions">' + ['Summarise a support ticket', 'Write a SQL query for p95 latency', 'Compare embedding models', 'Draft a launch email'].map(function (s, k) {
        return '<button class="suggestion" type="button" data-suggestion="' + k + '">' + s + '<small>' + sentence(r, 6) + '</small></button>' }).join('') + '</div>'
      // The active conversation's history (rendered markdown with highlighted code).
      ;['How do I index our help center for retrieval?', 'Can you show the embedding call?', 'What latency should we expect?',
        'How do we evaluate answer quality?', 'Write the nightly re-index job', 'Which model for the classifier?'].forEach(function (q, k) {
        bubble('user', '<p>' + esc(q) + '</p>')
        bubble('assistant', markdown(answerFor(q, 100 + k)))
      })
      transcript.scrollTop = transcript.scrollHeight
      var timer = null
      cleanup.push(function () { clearTimeout(timer); chatState.streaming = false })
      $('#model-select').addEventListener('select', function (e) { chatState.model = e.detail })
      prompt.addEventListener('input', function () { prompt.style.height = 'auto'; prompt.style.height = Math.min(prompt.scrollHeight, 160) + 'px' })
      prompt.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } })
      $('#composer').addEventListener('submit', function (e) { e.preventDefault(); send() })
      $all('.conv').forEach(function (c) { c.addEventListener('click', function () { $all('.conv.active').forEach(function (x) { x.classList.remove('active') }); c.classList.add('active') }) })
      $('#new-chat').addEventListener('click', function () {
        if (chatState.streaming) return
        transcript.innerHTML = suggestionsHtml
        chatState.turn = 0
        $all('.suggestion').forEach(function (b) { b.addEventListener('click', function () { prompt.value = b.firstChild.textContent; prompt.focus() }) })
      })

      function bubble(role, html) {
        var m = document.createElement('div')
        m.className = 'msg ' + role
        m.innerHTML = '<div class="who">' + (role === 'user' ? 'AL' : 'L') + '</div><div class="body">' + html + '</div>'
        transcript.appendChild(m)
        return m
      }
      function send() {
        var q = prompt.value.trim()
        if (!q || chatState.streaming) return
        var sugg = $('#suggestions')
        if (sugg) sugg.remove()
        bubble('user', '<p>' + esc(q) + '</p>')
        prompt.value = ''
        prompt.style.height = 'auto'
        transcript.scrollTop = transcript.scrollHeight
        var answer = answerFor(q, chatState.turn++)
        var tokens = tokenize(answer)
        var rr = prng(hash(answer))
        var msg = bubble('assistant', '<div class="skeleton" style="width:60%"></div>')
        var body = $('.body', msg)
        var text = ''
        var k = 0
        chatState.streaming = true
        $('#send').disabled = true
        function step() {
          // Re-render the whole answer per token, like React markdown renderers do.
          text += tokens[k++]
          var stick = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80
          body.innerHTML = markdown(text) + (k < tokens.length ? '<span class="cursor"></span>' : '')
          if (stick) transcript.scrollTop = transcript.scrollHeight
          if (k < tokens.length) { timer = setTimeout(step, rr.int(12, 38) + (rr.chance(0.03) ? rr.int(150, 400) : 0)); return }
          chatState.streaming = false
          $('#send').disabled = false
          var actions = document.createElement('div')
          actions.className = 'actions'
          actions.innerHTML = '<button type="button" class="act-copy">Copy</button><button type="button" class="act-up">Good</button><button type="button" class="act-down">Bad</button><button type="button" class="act-retry">Regenerate</button>'
          msg.querySelector('.body').appendChild(actions)
          $('.act-up', actions).addEventListener('click', function () { toast('Thanks for the feedback') })
        }
        timer = setTimeout(step, 420) // time to first token
      }
    },
  }

  // ---- pricing / catalogue -------------------------------------------------------------
  var CATS = ['Text', 'Vision', 'Audio', 'Agents', 'Enterprise']
  var CATALOGUE = (function () {
    var r = prng(11)
    var a = ['Nova', 'Atlas', 'Orion', 'Echo', 'Pulse', 'Quill', 'Vega', 'Iris', 'Flux', 'Sage', 'Helix', 'Lyra']
    var out = []
    for (var i = 0; i < 24; i++) {
      out.push({ id: i, name: a[i % a.length] + ' ' + ['Lite', 'Pro', 'Max', 'Mini', 'Turbo'][r.int(0, 4)] + ' ' + r.int(2, 5), cat: CATS[i % CATS.length],
        price: +(r.next() * 18 + 0.2).toFixed(2), rating: r.int(3, 5), ctx: [32, 128, 200, 1000][r.int(0, 3)] + 'k', desc: sentence(r, r.int(12, 20)),
        tags: [r.pick(WORDS), r.pick(WORDS)], isNew: r.chance(0.25) })
    }
    return out
  })()
  routes['/site/pricing'] = {
    title: 'Pricing',
    render: function (el) {
      var r = prng(5)
      var state = { yearly: false, cat: 'All', q: '', sort: 'Popular' }
      var tiers = [['Free', 0, 'For individuals exploring AI', 6], ['Pro', 24, 'For professionals who ship daily', 9], ['Team', 49, 'For teams that collaborate on AI', 12]]
      var compareRows = ''
      for (var i = 0; i < 30; i++) compareRows += '<tr><td>' + sentence(r, 3).replace(/\.$/, '') + '</td>' + [0, 1, 2].map(function (t) { return t >= i % 3 ? '<td class="yes">✓</td>' : '<td class="no">—</td>' }).join('') + '</tr>'
      el.innerHTML = '<section class="section"><div class="container"><div class="section-head"><span class="eyebrow">Pricing</span><h2>Simple plans, powerful models</h2><p>' + sentence(r, 16) + '</p>' +
        '<div class="billing-toggle" id="billing"><button type="button" class="on" data-billing="monthly">Monthly</button><button type="button" data-billing="yearly">Yearly · save 20%</button></div></div>' +
        '<div class="tiers" id="tiers"></div><div class="section-head"><h2>Model catalogue</h2><p>' + sentence(r, 12) + '</p></div>' +
        '<div class="toolbar"><div class="chips" id="chips">' + ['All'].concat(CATS).map(function (c) { return '<button type="button" class="chip' + (c === 'All' ? ' on' : '') + '" data-cat="' + c + '">' + c + '</button>' }).join('') + '</div>' +
        dropdown('sort', 'Popular', ['Popular', 'Price: low to high', 'Price: high to low', 'Newest'], 'Popular') +
        '<label class="search">' + icon('search', 16) + '<input id="catalogue-search" type="search" placeholder="Search models" aria-label="Search models"></label></div>' +
        '<div class="cards" id="cards"></div><table class="compare"><thead><tr><th>Compare plans</th><th>Free</th><th>Pro</th><th>Team</th></tr></thead><tbody>' + compareRows + '</tbody></table></div></section>'
      function drawTiers() {
        $('#tiers').innerHTML = tiers.map(function (t, k) {
          var price = state.yearly ? Math.round(t[1] * 0.8) : t[1]
          var items = ''
          for (var j = 0; j < t[3]; j++) items += '<li>' + sentence(prng(k * 31 + j), 4).replace(/\.$/, '') + '</li>'
          return '<div class="tier' + (k === 1 ? ' featured' : '') + '"><div class="row-between"><h3 class="m-0">' + t[0] + '</h3>' + (k === 1 ? '<span class="badge badge-brand">Most popular</span>' : '') + '</div>' +
            '<div class="price">$' + price + '<small> / user / month</small></div><p class="text-muted">' + t[2] + '</p><ul>' + items + '</ul>' +
            '<a class="btn ' + (k === 1 ? 'btn-primary' : 'btn-secondary') + '" href="/site/signup?plan=' + t[0].toLowerCase() + '" data-link id="tier-' + t[0].toLowerCase() + '">' + (k === 0 ? 'Start free' : 'Choose ' + t[0]) + '</a></div>'
        }).join('')
      }
      function drawCards() {
        var list = CATALOGUE.filter(function (m) { return (state.cat === 'All' || m.cat === state.cat) && (!state.q || (m.name + ' ' + m.desc).toLowerCase().indexOf(state.q) !== -1) })
        if (state.sort === 'Price: low to high') list.sort(function (a, b) { return a.price - b.price })
        if (state.sort === 'Price: high to low') list.sort(function (a, b) { return b.price - a.price })
        if (state.sort === 'Newest') list.sort(function (a, b) { return b.id - a.id })
        $('#cards').innerHTML = list.length ? list.map(function (m) {
          return '<article class="card" data-model="' + m.id + '"><div class="thumb">' + thumb(1000 + m.id, 320, 180) + '</div><div class="content"><div class="row-between"><h4 class="m-0">' + esc(m.name) + '</h4>' +
            (m.isNew ? '<span class="badge badge-green">New</span>' : '') + '</div><div class="meta"><span class="badge">' + m.cat + '</span><span class="badge">' + m.ctx + ' context</span>' +
            m.tags.map(function (t) { return '<span class="badge">' + t + '</span>' }).join('') + '</div><p class="desc">' + esc(m.desc) + '</p><div class="stars">' + '★★★★★'.slice(0, m.rating) + '<span class="text-faint">' + '★★★★★'.slice(m.rating) + '</span></div>' +
            '<div class="foot"><span class="cost">$' + m.price.toFixed(2) + ' <small>/ 1M tokens</small></span><button type="button" class="btn btn-secondary btn-sm details" data-id="' + m.id + '">Details</button></div></div></article>'
        }).join('') : '<div class="empty">No models match your filters.</div>'
      }
      drawTiers()
      drawCards()
      $('#billing').addEventListener('click', function (e) {
        var b = e.target.closest('button')
        if (!b) return
        state.yearly = b.getAttribute('data-billing') === 'yearly'
        $all('#billing button').forEach(function (x) { x.classList.toggle('on', x === b) })
        drawTiers()
      })
      $('#chips').addEventListener('click', function (e) {
        var c = e.target.closest('.chip')
        if (!c) return
        state.cat = c.getAttribute('data-cat')
        $all('#chips .chip').forEach(function (x) { x.classList.toggle('on', x === c) })
        drawCards()
      })
      $('#sort').addEventListener('select', function (e) { state.sort = e.detail; drawCards() })
      $('#catalogue-search').addEventListener('input', function (e) { state.q = e.target.value.trim().toLowerCase(); drawCards() })
      $('#cards').addEventListener('click', function (e) {
        var d = e.target.closest('.details')
        if (!d) return
        var m = CATALOGUE[+d.getAttribute('data-id')]
        var rr = prng(2000 + m.id)
        var spec = [['Context window', m.ctx], ['Category', m.cat], ['Input', '$' + m.price.toFixed(2) + ' / 1M'], ['Output', '$' + (m.price * 3).toFixed(2) + ' / 1M'],
          ['Median latency', rr.int(120, 900) + ' ms'], ['Rate limit', rr.int(1, 50) * 100 + ' RPM'], ['Regions', 'US, EU'], ['Fine-tuning', rr.chance(0.5) ? 'Yes' : 'No']]
        modal('<div class="modal-head"><h3 class="m-0">' + esc(m.name) + '</h3><button class="close" type="button" aria-label="Close" id="modal-close">×</button></div>' +
          '<div class="modal-body"><div><div class="thumb">' + thumb(1000 + m.id, 400, 300) + '</div></div><div><p>' + esc(m.desc) + ' ' + sentence(rr, 20) + '</p><table class="spec">' +
          spec.map(function (s) { return '<tr><td>' + s[0] + '</td><td>' + s[1] + '</td></tr>' }).join('') + '</table></div></div>' +
          '<div class="modal-foot"><button class="btn btn-ghost close" type="button">Cancel</button><a class="btn btn-primary" id="modal-choose" href="/site/signup?plan=pro&model=' + m.id + '" data-link>Start with ' + esc(m.name) + '</a></div>')
      })
    },
  }

  // ---- signup -----------------------------------------------------------------------
  routes['/site/signup'] = {
    title: 'Create your account',
    render: function (el) {
      var plan = new URLSearchParams(location.search).get('plan') || 'free'
      el.innerHTML = '<div class="auth"><aside class="auth-side"><span class="eyebrow">' + esc(plan) + ' plan</span><h2>Start building with Lumen</h2><ul>' +
        ['Unlimited chats with Lumen 4', 'Connect your docs and data', 'Invite your whole team', 'Cancel any time'].map(function (x) { return '<li>✓ ' + x + '</li>' }).join('') + '</ul>' +
        '<p class="mt-6">Already have a workspace? <a href="/site/checkout" data-link id="upgrade-now">Upgrade it now →</a></p></aside>' +
        '<div class="auth-main"><h2>Create your account</h2><p class="text-muted">Already have one? <a href="/site/signup" data-link>Sign in</a></p>' +
        '<div class="oauth mb-5"><button class="btn btn-secondary" type="button">Continue with Google</button><button class="btn btn-secondary" type="button">Continue with GitHub</button></div><div class="divider mb-5">or with email</div>' +
        '<form class="form" id="signup-form" novalidate>' +
        '<div class="form-row"><div class="field"><label for="su-name">Full name</label><input class="input" id="su-name" name="name" autocomplete="name" placeholder="Ada Lovelace"><span class="error">Please enter your name</span></div>' +
        '<div class="field"><label for="su-email">Work email</label><input class="input" id="su-email" name="email" type="email" autocomplete="email" placeholder="ada@company.com"><span class="error">Enter a valid email</span></div></div>' +
        '<div class="field"><label for="su-password">Password</label><input class="input" id="su-password" name="password" type="password" autocomplete="new-password"><div class="strength" id="strength"><i></i></div><span class="help" id="strength-label">At least 10 characters</span></div>' +
        '<div class="field"><label for="su-size">Company size</label><select class="select" id="su-size" name="company_size"><option value="">Select…</option><option>1-10</option><option>11-50</option><option>51-200</option><option>201-1000</option><option>1000+</option></select></div>' +
        '<div class="field"><span class="label">Your role</span><div class="radios">' + ['Engineering', 'Product', 'Support'].map(function (x, k) {
          return '<label class="radio"><input type="radio" name="role" value="' + x.toLowerCase() + '"' + (k === 0 ? ' checked' : '') + '>' + x + '</label>' }).join('') + '</div></div>' +
        '<div class="field"><label for="su-usecase">What will you use Lumen for?</label><textarea class="textarea" id="su-usecase" name="use_case" placeholder="Tell us a bit about your project"></textarea></div>' +
        '<label class="check"><input type="checkbox" id="su-terms" name="terms"> I agree to the Terms of Service and Privacy Policy</label>' +
        '<label class="check"><input type="checkbox" id="su-news" name="newsletter"> Send me product updates (about once a month)</label>' +
        '<button class="btn btn-primary btn-lg" type="submit" id="su-submit">Create account</button></form></div></div>'
      var pw = $('#su-password')
      pw.addEventListener('input', function () {
        var v = pw.value
        var s = (v.length >= 10) + /[A-Z]/.test(v) + /\d/.test(v) + /[^\w]/.test(v)
        $('#strength').className = 'strength s' + s
        $('#strength-label').textContent = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'][s]
      })
      $('#signup-form').addEventListener('submit', function (e) {
        e.preventDefault()
        var okName = $('#su-name').value.trim().length > 1
        var okEmail = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test($('#su-email').value)
        $('#su-name').parentNode.classList.toggle('invalid', !okName)
        $('#su-email').parentNode.classList.toggle('invalid', !okEmail)
        if (!okName || !okEmail || !$('#su-terms').checked) { toast('Please fix the highlighted fields'); return }
        var b = $('#su-submit')
        b.disabled = true
        b.innerHTML = '<span class="spinner"></span> Creating account…'
        var t = setTimeout(function () {
          $('.auth-main').innerHTML = '<div class="success"><div class="tick">✓</div><h2>Welcome aboard, ' + esc($('#su-name') ? $('#su-name').value : 'friend') + '</h2><p class="text-muted">Your workspace is ready.</p>' +
            '<a class="btn btn-primary" href="/site/checkout" data-link id="to-checkout">Continue to checkout</a></div>'
        }, 900)
        cleanup.push(function () { clearTimeout(t) })
      })
    },
  }

  // ---- checkout -------------------------------------------------------------------------
  routes['/site/checkout'] = {
    title: 'Checkout',
    render: function (el) {
      el.innerHTML = '<div class="container checkout"><div><h2>Checkout</h2><form class="form panel" id="checkout-form" novalidate>' +
        '<div class="field"><label for="co-email">Email</label><input class="input" id="co-email" type="email" autocomplete="email"></div>' +
        '<div class="field"><label for="co-name">Name on card</label><input class="input" id="co-name" autocomplete="cc-name"></div>' +
        '<div class="field"><label for="co-card">Card number</label><div class="input-group"><span class="prefix">' + icon('card', 20) + '</span>' +
        '<input class="input" id="co-card" name="cardnumber" inputmode="numeric" autocomplete="cc-number" placeholder="1234 1234 1234 1234" maxlength="19">' +
        '<div class="card-brands"><span data-brand="visa">VISA</span><span data-brand="mc">MC</span><span data-brand="amex">AMEX</span></div></div></div>' +
        '<div class="form-row-3"><div class="field"><label for="co-country">Country</label><select class="select" id="co-country">' + ['United States', 'United Kingdom', 'Germany', 'France', 'Poland', 'Japan', 'Brazil', 'Canada'].map(function (c) { return '<option>' + c + '</option>' }).join('') + '</select></div>' +
        '<div class="field"><label for="co-exp">Expiry</label><input class="input" id="co-exp" autocomplete="cc-exp" placeholder="MM / YY" maxlength="7"></div>' +
        '<div class="field"><label for="co-cvc">CVC</label><input class="input" id="co-cvc" autocomplete="cc-csc" inputmode="numeric" maxlength="4" placeholder="123"></div></div>' +
        '<div class="field"><label for="co-address">Billing address</label><textarea class="textarea" id="co-address" rows="2"></textarea></div>' +
        '<label class="check"><input type="checkbox" id="co-save" checked> Save this card for future payments</label>' +
        '<button class="btn btn-primary btn-lg" type="submit" id="co-pay">Pay $24.00</button><p class="secure">' + icon('lock', 14) + ' Payments are encrypted and processed securely.</p></form></div>' +
        '<aside><div class="panel"><h3>Order summary</h3><div class="summary-line"><span>Lumen Pro (monthly)</span><span>$24.00</span></div><div class="summary-line"><span>Seats</span><span>1</span></div>' +
        ['Unlimited chats with Lumen 4', '1M token context', 'Team workspaces', 'Priority support', 'SSO and audit logs', 'Usage analytics', 'API access (100k requests)', 'Custom templates'].map(function (x) {
          return '<div class="summary-line text-sm"><span>' + icon('bolt', 14) + ' ' + x + '</span><span class="yes">Included</span></div>' }).join('') +
        '<div class="row mt-4">' + ['SOC 2', 'GDPR', 'ISO 27001', 'HIPAA'].map(function (b) { return '<span class="badge">' + icon('lock', 12) + ' ' + b + '</span>' }).join('') + '</div>' +
        '<div class="row mt-4 mb-4"><input class="input" id="co-promo" placeholder="Promo code"><button class="btn btn-secondary" type="button" id="co-apply">Apply</button></div>' +
        '<div class="summary-line"><span>Tax</span><span>$0.00</span></div><div class="summary-line total"><span>Total due today</span><span id="co-total">$24.00</span></div></div></aside></div>'
      var card = $('#co-card')
      card.addEventListener('input', function () {
        var d = card.value.replace(/\D/g, '').slice(0, 16)
        card.value = d.replace(/(\d{4})(?=\d)/g, '$1 ')
        var brand = /^4/.test(d) ? 'visa' : /^5/.test(d) ? 'mc' : /^3/.test(d) ? 'amex' : ''
        $all('.card-brands span').forEach(function (s) { s.classList.toggle('on', s.getAttribute('data-brand') === brand) })
      })
      var exp = $('#co-exp')
      exp.addEventListener('input', function () { var d = exp.value.replace(/\D/g, '').slice(0, 4); exp.value = d.length > 2 ? d.slice(0, 2) + ' / ' + d.slice(2) : d })
      $('#co-apply').addEventListener('click', function () { toast($('#co-promo').value ? 'Promo code applied' : 'Enter a promo code') })
      $('#checkout-form').addEventListener('submit', function (e) {
        e.preventDefault()
        var b = $('#co-pay')
        b.disabled = true
        b.innerHTML = '<span class="spinner"></span> Processing…'
        var t = setTimeout(function () {
          $('#checkout-form').outerHTML = '<div class="success"><div class="tick">✓</div><h2>Payment successful</h2><p class="text-muted">A receipt was sent to your inbox.</p><a class="btn btn-primary" href="/site/chat" data-link id="to-app">Open Lumen</a></div>'
        }, 1500)
        cleanup.push(function () { clearTimeout(t) })
      })
    },
  }

  // ---- settings -----------------------------------------------------------------------
  routes['/site/settings'] = {
    title: 'Settings',
    render: function (el) {
      var TABS = ['Profile', 'Notifications', 'API keys', 'Billing', 'Team']
      el.innerHTML = '<div class="container settings"><nav class="tabs" role="tablist">' + TABS.map(function (t, k) {
        return '<button class="tab" role="tab" type="button" id="tab-' + k + '" aria-selected="' + (k === 0) + '">' + t + '</button>' }).join('') + '</nav><div id="tabpanel"></div></div>'
      var keyCount = 0
      function show(k) {
        $all('.tab').forEach(function (t, i) { t.setAttribute('aria-selected', String(i === k)) })
        var r = prng(40 + k)
        var p = $('#tabpanel')
        var html = '<div class="tabpanel"><h2>' + TABS[k] + '</h2>'
        if (k === 0) {
          html += '<form class="form" id="profile-form" style="max-width:560px"><div class="row"><div class="avatar" style="width:64px;height:64px;font-size:22px">AL</div><button class="btn btn-secondary btn-sm" type="button">Upload photo</button></div>' +
            '<div class="field"><label for="st-name">Display name</label><input class="input" id="st-name" value="Ada Lovelace"></div>' +
            '<div class="field"><label for="st-bio">Bio</label><textarea class="textarea" id="st-bio">' + sentence(r, 12) + '</textarea></div>' +
            '<div class="field"><label for="st-tz">Time zone</label><select class="select" id="st-tz"><option>UTC</option><option>Europe/London</option><option>Europe/Warsaw</option><option>America/New_York</option><option>Asia/Tokyo</option></select></div>' +
            '<div><button class="btn btn-primary" type="submit" id="st-save">Save changes</button></div></form>'
        } else if (k === 1) {
          for (var i = 0; i < 20; i++) html += '<div class="setting"><div><strong>' + sentence(r, 3).replace(/\.$/, '') + '</strong><p>' + sentence(r, 12) + '</p></div><label class="switch"><input type="checkbox" id="toggle-' + i + '"' + (r.chance(0.5) ? ' checked' : '') + ' aria-label="toggle"><span class="track"></span></label></div>'
        } else if (k === 2) {
          html += '<p class="text-muted">' + sentence(r, 14) + '</p><button class="btn btn-primary mb-5" type="button" id="create-key">Create new key</button><table class="table"><thead><tr><th>Name</th><th>Key</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody id="keys">'
          for (var j = 0; j < 10; j++) html += keyRow(r, j)
          html += '</tbody></table>'
        } else if (k === 3) {
          html += '<div class="usage">' + [['Tokens this month', '18.4M'], ['Spend', '$212.40'], ['Seats', '12 / 15']].map(function (u) { return '<div class="panel"><span class="text-muted text-sm">' + u[0] + '</span><strong>' + u[1] + '</strong></div>' }).join('') + '</div><div class="chart" id="usage-chart">'
          for (var b = 0; b < 30; b++) html += '<i style="height:' + r.int(8, 100) + '%" title="Day ' + (b + 1) + '"></i>'
          html += '</div><h3 class="mt-7">Invoices</h3><table class="table"><thead><tr><th>Invoice</th><th>Date</th><th>Amount</th><th>Status</th></tr></thead><tbody>'
          for (var n = 0; n < 12; n++) html += '<tr><td class="mono">INV-' + (2026100 + n) + '</td><td>2026-' + String(12 - n % 12).padStart(2, '0') + '-01</td><td>$' + r.int(90, 400) + '.00</td><td><span class="badge badge-green">Paid</span></td></tr>'
          html += '</tbody></table>'
        } else {
          html += '<table class="table"><thead><tr><th>Member</th><th>Role</th><th>Last active</th></tr></thead><tbody>'
          for (var m = 0; m < 20; m++) {
            var nm = words(r, 2)
            html += '<tr><td><div class="member"><div class="avatar">' + nm.charAt(0).toUpperCase() + '</div><div>' + nm + '<small>' + nm.replace(' ', '.') + '@lumen.dev</small></div></div></td><td>' +
              dropdown('role-' + m, m === 0 ? 'Owner' : 'Member', ['Owner', 'Admin', 'Member', 'Viewer'], m === 0 ? 'Owner' : 'Member') + '</td><td class="text-muted">' + r.int(1, 30) + ' days ago</td></tr>'
          }
          html += '</tbody></table>'
        }
        html += '<h3 class="mt-8">Recent activity</h3><table class="table"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>IP</th></tr></thead><tbody>'
        var ra = prng(77)
        for (var a = 0; a < 40; a++) html += '<tr><td class="text-muted">' + (a + 1) * 7 + ' min ago</td><td>' + words(ra, 1) + '</td><td>' + sentence(ra, 4) + '</td><td class="mono">10.' + ra.int(0, 255) + '.' + ra.int(0, 255) + '.' + ra.int(1, 254) + '</td></tr>'
        p.innerHTML = html + '</tbody></table></div>'
        if (k === 0) $('#profile-form').addEventListener('submit', function (e) { e.preventDefault(); toast('Profile saved') })
        if (k === 1) $all('.switch input').forEach(function (s) { s.addEventListener('change', function () { toast('Preference updated') }) })
        if (k === 2) $('#create-key').addEventListener('click', function () { $('#keys').insertAdjacentHTML('afterbegin', keyRow(prng(900 + keyCount), 100 + keyCount++)); toast('API key created') })
      }
      function keyRow(r, j) {
        var key = ''
        for (var i = 0; i < 8; i++) key += 'abcdef0123456789'[r.int(0, 15)]
        return '<tr><td>' + words(r, 2) + '</td><td class="mono">lum_live_••••' + key + '</td><td>2026-' + String(r.int(1, 11)).padStart(2, '0') + '-' + String(r.int(1, 28)).padStart(2, '0') + '</td><td>' + (j < 100 ? r.int(1, 59) + ' min ago' : 'Never') + '</td><td><button class="btn btn-danger btn-sm" type="button">Revoke</button></td></tr>'
      }
      $all('.tab').forEach(function (t, k) { t.addEventListener('click', function () { show(k) }) })
      show(0)
    },
  }

  render()
})()
