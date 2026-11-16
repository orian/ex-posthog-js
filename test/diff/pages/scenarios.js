// Browser-side scenarios, run identically against the official SDK and ours.
// Each returns a promise; the runner then unloads the page and diffs traffic.
(function () {
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }

  window.DIFF_HELPERS = function (port) {
    return {
      sleep: sleep,
      token: 'phc_diff',
      config: function (extra) {
        var c = { api_host: 'http://ph.example.test:' + port, request_queue_config: { flush_interval_ms: 250 } }
        for (var k in extra || {}) c[k] = extra[k]
        return c
      },
    }
  }

  window.SCENARIOS = {
    basic: async function (ph, h) {
      ph.init(h.token, h.config({ autocapture: false }))
      ph.capture('signed_up', { plan: 'pro', nested: { a: [1, 2] } })
      await sleep(600)
    },

    identify: async function (ph, h) {
      ph.init(h.token, h.config({ autocapture: false }))
      ph.identify('user-1', { email: 'a@b.c' }, { first_seen: 'x' })
      ph.capture('after')
      ph.group('company', 'acme', { name: 'Acme' })
      ph.register({ app: 'web' })
      ph.register_once({ once: 1 })
      ph.capture('grouped')
      ph.setPersonProperties({ plan: 'pro' })
      ph.alias('alias-1')
      await sleep(600)
      ph.reset()
      ph.capture('after-reset')
      await sleep(600)
    },

    consent: async function (ph, h) {
      ph.init(h.token, h.config({ autocapture: false, opt_out_capturing_by_default: true }))
      ph.capture('dropped')
      await sleep(400)
      ph.opt_in_capturing()
      ph.capture('kept')
      await sleep(600)
      ph.opt_out_capturing()
      ph.capture('dropped-again')
      await sleep(400)
    },

    filters: async function (ph, h) {
      ph.init(h.token, h.config({
        autocapture: false,
        capture_pageview: false,
        property_denylist: ['$screen_width'],
        before_send: function (e) {
          if (e.event === 'secret') return null
          e.properties.edited = 1
          return e
        },
      }))
      ph.capture('secret')
      ph.capture('public', { long: new Array(70000).join('x') })
      ph.capture('after-filter')
      await sleep(600)
    },

    spa: async function (ph, h) {
      ph.init(h.token, h.config({ autocapture: false, capture_pageview: 'history_change' }))
      await sleep(100)
      history.pushState({}, '', '/docs?x=1')
      await sleep(100)
      history.pushState({}, '', '/docs?x=2')
      history.replaceState({}, '', '/other')
      await sleep(600)
    },

    flags: async function (ph, h) {
      var calls = []
      ph.init(h.token, h.config({ autocapture: false, capture_pageview: false }))
      ph.onFeatureFlags(function (flags, variants) { calls.push([flags.slice().sort(), variants]) })
      await sleep(600)
      window.__flagResults = {
        multi: ph.getFeatureFlag('multi'),
        off: ph.getFeatureFlag('off'),
        missing: ph.getFeatureFlag('missing'),
        bool: ph.isFeatureEnabled('bool'),
        payload: ph.getFeatureFlagPayload('multi'),
        calls: calls.length,
      }
      ph.capture('with-flags')
      ph.identify('flag-user')
      await sleep(800)
    },
    bootstrap: async function (ph, h) {
      ph.init(h.token, h.config({
        autocapture: false,
        bootstrap: { distinctID: 'boot-user', isIdentifiedID: true, featureFlags: { early: 'v1', multi: 'control' }, featureFlagPayloads: { early: { a: 1 } } },
      }))
      var early = { early: ph.getFeatureFlag('early'), payload: ph.getFeatureFlagPayload('early'), multi: ph.getFeatureFlag('multi') }
      ph.capture('booted')
      await sleep(700)
      window.__flagResults = { early: early, multi: ph.getFeatureFlag('multi'), id: ph.get_distinct_id() }
      ph.reset({ bootstrap: { distinctID: 'second-user' } })
      ph.capture('after-reset')
      await sleep(600)
    },

    person_profiles: async function (ph, h) {
      ph.init(h.token, h.config({ autocapture: false, capture_pageview: false, person_profiles: 'always' }))
      ph.capture('always-1')
      ph.setPersonProperties({ a: 1 }, { b: 2 })
      ph.setPersonProperties({ a: 1 }, { b: 2 })
      ph.unsetPersonProperties(['a'])
      ph.createPersonProfile()
      ph.group('team', 't1')
      await sleep(600)
    },

    person_profiles_never: async function (ph, h) {
      ph.init(h.token, h.config({ autocapture: false, capture_pageview: false, person_profiles: 'never' }))
      ph.identify('never-user', { x: 1 })
      ph.alias('alias-x')
      ph.group('team', 't1', { name: 'T' })
      ph.capture('never-1')
      await sleep(600)
      window.__flagResults = { id: ph.get_distinct_id() === 'never-user' }
    },

    capture_options: async function (ph, h) {
      // max length 40 keeps UUIDs (36 chars) intact so they can be normalised.
      var long = new Array(60).join('x')
      ph.init(h.token, h.config({ autocapture: false, capture_pageview: false, properties_string_max_length: 40 }))
      ph.capture('opts', { long: long, $set: { fromProps: 1 } }, {
        $set: { s: 1 }, $set_once: { so: 1 }, $unset: ['u'],
        timestamp: new Date('2024-01-02T03:04:05.000Z'), uuid: '0190f5b8-0000-7000-8000-000000000123',
      })
      // Unbatched sends race each other on the network: space them out.
      await sleep(80)
      ph.capture('instant', { long: long }, { send_instantly: true })
      await sleep(80)
      ph.capture('batched-key-with-a-very-long-event-name-that-gets-truncated', {}, { _batchKey: 'custom' })
      ph.capture('no-truncate', { long: long }, { _noTruncate: true })
      await sleep(80)
      ph.capture('xhr', {}, { transport: 'XHR' })
      await sleep(80)
      ph.capture('custom-url', {}, { _url: 'http://ph.example.test:' + location.port + '/custom/' })
      await sleep(80)
      ph.capture('skip-rl', {}, { skip_client_rate_limiting: true })
      ph.capture('plain')
      await sleep(700)
    },

    rate_limit: async function (ph, h) {
      ph.init(h.token, h.config({ autocapture: false, capture_pageview: false, rate_limiting: { events_per_second: 1, events_burst_limit: 3 } }))
      for (var i = 0; i < 7; i++) ph.capture('spam', { i: i })
      await sleep(700)
    },

    quota_limited: async function (ph, h) {
      ph.init(h.token, h.config({ autocapture: false, capture_pageview: false }))
      ph.capture('first')
      await sleep(700)
      ph.capture('second-dropped')
      await sleep(700)
    },

    remote_config_failure: async function (ph, h) {
      ph.init(h.token, h.config({ autocapture: false }))
      ph.capture('no-config')
      await sleep(900)
    },

    no_flags_config: async function (ph, h) {
      ph.init(h.token, h.config({ autocapture: false }))
      ph.capture('x')
      await sleep(700)
      window.__flagResults = { multi: ph.getFeatureFlag('multi') === undefined }
    },

    session_rotation: async function (ph, h) {
      // A persisted session idle for 2 hours: the first capture rotates it.
      var old = Date.now() - 2 * 3600 * 1000
      localStorage.setItem('ph_phc_diff_posthog', JSON.stringify({
        distinct_id: 'returning', $device_id: 'returning', $user_state: 'anonymous',
        $sesid: [old, '0190f5b8-0000-7000-8000-00000000aaaa', old - 1000],
        $client_session_props: { sessionId: '0190f5b8-0000-7000-8000-00000000aaaa', props: { r: 'https://old.example/', u: 'https://app.example.test/old?utm_source=old' } },
        kept: 'super',
      }))
      ph.init(h.token, h.config({ autocapture: false }))
      ph.register_for_session({ tab: 'one' })
      ph.capture('rotated')
      ph.unregister_for_session('tab')
      ph.capture('after-unregister')
      await sleep(700)
    },

    set_config: async function (ph, h) {
      ph.init(h.token, h.config({ autocapture: false, capture_pageview: false }))
      ph.capture('before')
      ph.set_config({ property_denylist: ['$browser'], save_campaign_params: false, persistence: 'memory' })
      ph.register({ mem: 1 })
      ph.capture('after')
      ph.set_config({ process_person: 'always' })
      ph.capture('renamed-config')
      await sleep(700)
      window.__flagResults = { ls: localStorage.getItem('ph_phc_diff_posthog') !== null }
    },

    flags_api: async function (ph, h) {
      ph.init(h.token, h.config({ autocapture: false, capture_pageview: false }))
      await sleep(600)
      var r = {
        result: ph.getFeatureFlagResult('multi'),
        all: ph.getAllFeatureFlags(),
        enabledDefault: ph.isFeatureEnabled('missing', { defaultValue: true }),
        flags: ph.featureFlags.getFlags().sort(),
        variants: ph.featureFlags.getFlagVariants(),
        loaded: ph.featureFlags.hasLoadedFlags,
      }
      ph.featureFlags.overrideFeatureFlags({ flags: { bool: 'over' }, payloads: { bool: { p: 1 } } })
      r.overridden = ph.getFeatureFlag('bool')
      ph.featureFlags.overrideFeatureFlags(false)
      ph.updateFlags({ injected: true }, { injected: { q: 1 } }, { merge: true })
      r.injected = ph.getFeatureFlagResult('injected')
      ph.setPersonPropertiesForFlags({ plan: 'pro' })
      ph.setGroupPropertiesForFlags({ team: { size: 3 } })
      ph.group('team', 't9')
      ph.capture('flags-done')
      window.__flagResults = r
      await sleep(800)
    },

    web_experiments: async function (ph, h) {
      ph.init(h.token, h.config({ autocapture: false, capture_pageview: false, disable_web_experiments: false }))
      await sleep(900)
      window.__flagResults = {
        hero: document.getElementById('hero').innerHTML,
        heroStyle: document.getElementById('hero').getAttribute('style'),
        link: document.getElementById('link').innerHTML,
        xss: !!window.__xss,
      }
    },

    opt_out_persistence: async function (ph, h) {
      ph.init(h.token, h.config({ autocapture: false, opt_out_capturing_by_default: true, opt_out_persistence_by_default: true, consent_persistence_name: 'diff_consent' }))
      ph.capture('dropped')
      await sleep(300)
      window.__flagResults = { before: localStorage.getItem('ph_phc_diff_posthog') !== null, status: ph.get_explicit_consent_status() }
      ph.opt_in_capturing({ captureEventName: 'custom_opt_in', captureProperties: { why: 'test' } })
      ph.capture('kept')
      await sleep(700)
      window.__flagResults.after = localStorage.getItem('ph_phc_diff_posthog') !== null
      window.__flagResults.consent = localStorage.getItem('diff_consent')
    },

    cookieless: async function (ph, h) {
      ph.init(h.token, h.config({ autocapture: false, cookieless_mode: 'always' }))
      ph.capture('cookieless-event')
      ph.identify('should-not-work')
      await sleep(700)
      window.__flagResults = { id: ph.get_distinct_id(), cookie: document.cookie.indexOf('ph_phc_diff') !== -1 }
    },

    snippet: async function (ph, h) {
      // Calls made through push() replay like the snippet queue.
      ph.init(h.token, h.config({ autocapture: false, capture_pageview: false }))
      ph.push(['register', { pushed: true }])
      ph.push(['capture', 'via-push', { a: 1 }])
      await sleep(600)
    },
  }
})()

// ---- Autocapture, rageclicks, heatmaps and dead clicks ------------------------
// Trusted input goes through CDP (Input.* via the __cdpInput binding set up by
// test/diff/chrome.mjs); clipboard and <select> changes use in-page events.
;(function () {
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }
  var nextId = 0
  var pending = {}
  window.__cdpInputDone = function (id, error) {
    var p = pending[id]
    delete pending[id]
    if (p) error ? p.reject(new Error(error)) : p.resolve()
  }
  function cdp(method, params) {
    return new Promise(function (resolve, reject) {
      var id = ++nextId
      pending[id] = { resolve: resolve, reject: reject }
      window.__cdpInput(JSON.stringify({ id: id, method: method, params: params }))
    })
  }
  function el(target) { return typeof target === 'string' ? document.querySelector(target) : target }
  function center(target, dx, dy) {
    var r = el(target).getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2 + (dx || 0)), y: Math.round(r.top + r.height / 2 + (dy || 0)) }
  }
  function mouse(type, p, extra) {
    var params = { type: type, x: p.x, y: p.y, button: 'left', clickCount: 1, pointerType: 'mouse' }
    for (var k in extra || {}) params[k] = extra[k]
    if (type === 'mouseMoved') { params.button = 'none'; delete params.clickCount }
    return cdp('Input.dispatchMouseEvent', params)
  }
  /** Trusted click at the centre of an element (or a {x, y} viewport point). */
  async function click(target, opts) {
    opts = opts || {}
    var p = target && target.x !== undefined ? target : center(target, opts.dx, opts.dy)
    await mouse('mouseMoved', p)
    await mouse('mousePressed', p, { clickCount: opts.clickCount || 1, modifiers: opts.modifiers || 0 })
    await mouse('mouseReleased', p, { clickCount: opts.clickCount || 1, modifiers: opts.modifiers || 0 })
  }
  async function move(x, y) { await mouse('mouseMoved', { x: x, y: y }) }
  async function type(text) { await cdp('Input.insertText', { text: text }) }
  function selectText(target) {
    var range = document.createRange()
    range.selectNodeContents(el(target))
    var sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
  }
  function clipboard(type, target) {
    el(target).dispatchEvent(new ClipboardEvent(type, { bubbles: true, cancelable: true }))
  }

  var baseHelpers = window.DIFF_HELPERS
  window.DIFF_HELPERS = function (port) {
    var h = baseHelpers(port)
    h.cdp = cdp
    h.click = click
    h.move = move
    h.type = type
    h.selectText = selectText
    h.clipboard = clipboard
    h.center = center
    return h
  }

  // Remote config arrives (and, for the official SDK, lazy scripts load) before interacting.
  var READY_MS = 700

  var S = {
    ac_clicks: async function (ph, h) {
      ph.init(h.token, h.config({ capture_pageview: false }))
      await sleep(READY_MS)
      await h.click('#ac-btn span span')
      await h.click('#ac-ext span')
      await h.click('#ac-int')
      await h.click('#ac-svg-icon')
      await h.click('#ac-div')
      await h.click('#ac-pointer b')
      await h.click('#ac-nocap')
      await h.click('#ac-nocap-child')
      await h.click('#ac-noauto')
      await h.click('#ac-sensitive')
      await h.click('#ac-label')
      await h.click(document.getElementById('ac-shadow-host').shadowRoot.querySelector('span'))
      await h.click('#ac-fixed-btn')
      document.getElementById('ac-vanish').scrollIntoView()
      await sleep(100)
      await h.click('#ac-vanish')
      window.scrollTo(0, 0)
      await sleep(600)
    },

    ac_forms: async function (ph, h) {
      ph.init(h.token, h.config({ capture_pageview: false }))
      await sleep(READY_MS)
      await h.click('#ac-name')
      await h.type('Jane Doe')
      await h.click('#ac-email')
      await h.type('jane@example.com')
      await h.click('#ac-pw')
      await h.type('hunter2')
      await h.click('#ac-ccnum')
      await h.type('4111111111111111')
      await h.click('#ac-plain')
      await h.type('jd')
      await h.click('#ac-ta')
      await h.type('Hello there')
      await h.click('#ac-check')
      var select = document.getElementById('ac-select')
      select.value = 'pro'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await h.click('#ac-submit span')
      await sleep(600)
    },

    ac_rageclick: async function (ph, h) {
      ph.init(h.token, h.config({ capture_pageview: false }))
      await sleep(READY_MS)
      for (var i = 0; i < 4; i++) await h.click('#ac-btn', { dx: i * 3 })
      await sleep(1100)
      // Default rageclick (no `defaults`) has no content filter: "Next" rageclicks too.
      for (var j = 0; j < 3; j++) await h.click('#ac-next')
      await sleep(1100)
      for (var k = 0; k < 3; k++) await h.click('#ac-nocap')
      await sleep(600)
    },

    ac_rageclick_defaults: async function (ph, h) {
      // 2026-05-30 defaults: content_ignorelist with steppers and ignore_text_selection.
      ph.init(h.token, h.config({ capture_pageview: false, defaults: '2026-05-30' }))
      await sleep(READY_MS)
      for (var i = 0; i < 3; i++) await h.click('#ac-next')
      await sleep(1100)
      for (var j = 0; j < 3; j++) await h.click('#ac-plus')
      await sleep(1100)
      for (var k = 0; k < 3; k++) await h.click('#ac-btn')
      await sleep(1100)
      for (var l = 0; l < 3; l++) await h.click('#ac-plain')
      await sleep(600)
    },

    ac_rageclick_config: async function (ph, h) {
      ph.init(h.token, h.config({ capture_pageview: false, defaults: '2025-11-30',
        rageclick: { click_count: 4, css_selector_ignorelist: ['#ac-svg'] } }))
      await sleep(READY_MS)
      for (var i = 0; i < 3; i++) await h.click('#ac-btn')
      await sleep(1100)
      for (var j = 0; j < 4; j++) await h.click('#ac-btn')
      await sleep(1100)
      for (var k = 0; k < 4; k++) await h.click('#ac-svg')
      await sleep(1100)
      for (var l = 0; l < 4; l++) await h.click('#ac-next')
      await sleep(600)
    },

    ac_copy: async function (ph, h) {
      ph.init(h.token, h.config({ capture_pageview: false, autocapture: { capture_copied_text: true } }))
      await sleep(READY_MS)
      h.selectText('#ac-copy')
      h.clipboard('copy', '#ac-copy-b')
      h.selectText('#ac-copy-b')
      h.clipboard('cut', '#ac-copy-b')
      h.clipboard('paste', '#ac-copy-b')
      window.getSelection().removeAllRanges()
      h.clipboard('copy', '#ac-copy-b')
      // A trusted copy through the browser's editing command.
      h.selectText('#ac-copy-b')
      await h.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers: 2, commands: ['copy'] })
      await h.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers: 2 })
      await sleep(600)
    },

    ac_opt_out: async function (ph, h) {
      ph.init(h.token, h.config({}))
      await sleep(READY_MS)
      await h.click('#ac-btn')
      ph.capture('after-click')
      await sleep(600)
      window.__flagResults = { enabled: ph.autocapture.isEnabled }
    },

    ac_remote_config_failure: async function (ph, h) {
      ph.init(h.token, h.config({}))
      await sleep(READY_MS)
      await h.click('#ac-btn')
      ph.capture('after-click')
      await sleep(600)
      window.__flagResults = { enabled: ph.autocapture.isEnabled }
    },

    ac_persisted_opt_out: async function (ph, h) {
      // Opted out earlier; this config has no autocapture_opt_out, so the persisted value wins.
      localStorage.setItem('ph_phc_diff_posthog', JSON.stringify({ distinct_id: 'ret', $device_id: 'ret', $autocapture_disabled_server_side: true }))
      ph.init(h.token, h.config({ capture_pageview: false }))
      await sleep(READY_MS)
      await h.click('#ac-btn')
      ph.capture('after-click')
      await sleep(600)
      window.__flagResults = { enabled: ph.autocapture.isEnabled }
    },

    ac_elements_chain_off: async function (ph, h) {
      ph.init(h.token, h.config({ capture_pageview: false }))
      await sleep(READY_MS)
      await h.click('#ac-btn span')
      await h.click('#ac-ext')
      await h.click('#ac-svg-icon')
      await sleep(600)
    },

    ac_config: async function (ph, h) {
      ph.init(h.token, h.config({
        capture_pageview: false, mask_all_text: true, disable_capture_url_hashes: true,
        autocapture: {
          dom_event_allowlist: ['click'], element_allowlist: ['button', 'a'],
          css_selector_ignorelist: ['#ac-next'], element_attribute_ignorelist: ['data-ph-capture-attribute-plan', 'id'],
        },
      }))
      await sleep(READY_MS)
      await h.click('#ac-btn span')
      await h.click('#ac-ext')
      await h.click('#ac-next')
      await h.click('#ac-pointer')
      await h.click('#ac-plain')
      await h.type('x')
      await h.click('#ac-submit')
      ph.set_config({ mask_all_text: false, mask_all_element_attributes: true })
      await h.click('#ac-btn')
      ph.set_config({ autocapture: false })
      await h.click('#ac-btn')
      ph.set_config({ autocapture: { url_ignorelist: ['page\\.html'] } })
      await h.click('#ac-btn')
      ph.set_config({ autocapture: { url_allowlist: ['page\\.html'], css_selector_allowlist: ['.cta'] } })
      await h.click('#ac-btn')
      await h.click('#ac-ext')
      await sleep(600)
    },

    heatmaps_config: async function (ph, h) {
      ph.init(h.token, h.config({ capture_pageview: false, autocapture: false, capture_heatmaps: true }))
      await sleep(READY_MS)
      await h.click('#ac-btn')
      await h.move(200, 150)
      await sleep(700)
      window.scrollTo(0, 300)
      await sleep(100)
      await h.click('#ac-fixed-btn')
      await h.click('#ac-dead')
      for (var i = 0; i < 3; i++) await h.click('#ac-fixed-btn')
      await sleep(700)
      window.scrollTo(0, 0)
      await sleep(100)
      window.__flagResults = { enabled: ph.heatmaps.isEnabled, interval: ph.heatmaps.flushIntervalMilliseconds }
    },

    heatmaps_remote: async function (ph, h) {
      ph.init(h.token, h.config({ capture_pageview: false, autocapture: false }))
      await sleep(READY_MS)
      for (var i = 0; i < 3; i++) await h.click('#ac-next')
      await h.move(300, 100)
      await sleep(700)
      window.__flagResults = { enabled: ph.heatmaps.isEnabled }
    },

    heatmaps_flush: async function (ph, h) {
      ph.init(h.token, h.config({ capture_pageview: false, autocapture: false, capture_heatmaps: { flush_interval_milliseconds: 1500 } }))
      await sleep(READY_MS)
      // Interval flushes (~1.6s and ~3.1s after init), nothing left for the unload flush.
      await h.click('#ac-btn')
      await sleep(1500)
      await h.click('#ac-ext')
      await sleep(1700)
    },

    dead_clicks: async function (ph, h) {
      ph.init(h.token, h.config({ capture_pageview: false, capture_dead_clicks: true }))
      await sleep(READY_MS)
      // Nothing mutates for 3s after these: #ac-dead and the plain div are dead; the link,
      // ph-no-deadclick, ph-no-capture and the ctrl-click are ignored.
      await h.click('#ac-dead')
      await h.click('#ac-div')
      await h.click('#ac-int')
      await h.click('#ac-nodead')
      await h.click('#ac-nocap')
      await h.click('#ac-pointer', { modifiers: 2 })
      // A dead swipe (touch drag over the plain div).
      var p = h.center('#ac-div')
      await h.cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x - 40, y: p.y }] })
      await h.cdp('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p.x + 40, y: p.y }] })
      await h.cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await sleep(3600)
      // Mutates the DOM: alive.
      await h.click('#ac-live')
      await sleep(1500)
      window.__flagResults = { started: !!ph.deadClicksAutocapture.lazyLoadedDeadClicksAutocapture }
    },

    dead_clicks_no_external: async function (ph, h) {
      // Upstream cannot lazy-load the detector, so dead clicks never start.
      ph.init(h.token, h.config({ capture_pageview: false, capture_dead_clicks: true, disable_external_dependency_loading: true }))
      await sleep(READY_MS)
      await h.click('#ac-dead')
      await sleep(3300)
      window.__flagResults = { started: !!ph.deadClicksAutocapture.lazyLoadedDeadClicksAutocapture }
    },

    dead_clicks_remote: async function (ph, h) {
      // Remote config enables dead clicks and heatmaps: deadclick points also land in $$heatmap.
      ph.init(h.token, h.config({ capture_pageview: false, autocapture: false,
        capture_heatmaps: { flush_interval_milliseconds: 30000 } }))
      await sleep(READY_MS)
      await h.click('#ac-dead')
      await sleep(3600)
    },
  }
  for (var name in S) window.SCENARIOS[name] = S[name]
})()
