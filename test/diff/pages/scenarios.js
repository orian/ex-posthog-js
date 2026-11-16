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

// ---- exception capture (src/exceptions) -------------------------------------------------
// Errors thrown on purpose carry 'diff-expected' / 'diffExpected' in their message: the runner
// does not report them as page errors. Upstream lazy-loads its wrapping functions from
// /static/, so scenarios wait before firing anything autocapture should see.
;(function () {
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }
  function cfg(h, extra) {
    var c = { autocapture: false, capture_pageview: false }
    for (var k in extra || {}) c[k] = extra[k]
    return h.config(c)
  }
  function throwLater(err) { setTimeout(function throwFromTimeout() { throw err }, 0) }
  function rejectLater(reason) { setTimeout(function rejectFromTimeout() { Promise.reject(reason) }, 0) }
  // One of each autocapture source, so a scenario shows which ones are enabled.
  async function fireAll(tag) {
    throwLater(new Error('diff-expected onerror ' + tag))
    await sleep(60)
    rejectLater(new Error('diff-expected rejection ' + tag))
    await sleep(60)
    console.error('diff-expected console ' + tag)
    await sleep(60)
  }
  // A pre-existing handler that swallows errors, so they never reach the console.
  function swallowErrors() {
    window.__onerrorCalls = 0
    window.onerror = function () { window.__onerrorCalls++; return true }
    window.onunhandledrejection = function (ev) { ev.preventDefault() }
  }
  class MyError extends Error {
    constructor(message, options) { super(message, options); this.name = 'MyError' }
  }

  var S = {
    exc_capture_manual: async function (ph, h) {
      ph.init(h.token, cfg(h))
      ph.captureException(new Error('plain error'))
      ph.captureException(new MyError('outer', { cause: new TypeError('middle', { cause: 'root cause string' }) }))
      ph.captureException(new AggregateError([new Error('member one'), new RangeError('member two'), 'member three'], 'aggregate'))
      ph.captureException('TypeError: a string error')
      ph.captureException('Uncaught exception: just a string')
      ph.captureException({ foo: 1, bar: 'x', message: 'object message' })
      ph.captureException({ name: 'NamedObject', message: 'with a name' })
      ph.captureException({ alpha: 1, beta: 2, gamma: 3, delta: 4, epsilon: 5, zeta: 6 })
      ph.captureException({ wrapped: new SyntaxError('error held by an object') })
      ph.captureException(new DOMException('dom exception message', 'NotFoundError'))
      ph.captureException(42)
      ph.captureException(null)
      ph.captureException(new Event('plain-event'))
      ph.captureException(new CustomEvent('custom', { detail: { reason: new Error('reason inside detail') } }))
      var noStack = new Error('no stack')
      noStack.stack = undefined
      ph.captureException(noStack)
      ph.captureException(new Error('with extras'), { $exception_fingerprint: 'my-fingerprint', custom: 'extra', $exception_level: 'warning' })
      await sleep(700)
    },

    exc_steps_release: async function (ph, h) {
      window._posthogReleaseId = 'release-123'
      var key = 'Error\n    at chunk (' + location.origin + '/scenarios.js:1:1)'
      window._posthogChunkIds = {}
      window._posthogChunkIds[key] = 'chunk-abc'
      ph.addExceptionStep('before init step', { early: true })
      ph.init(h.token, cfg(h, { error_tracking: { exception_steps: { max_bytes: 400 } } }))
      ph.addExceptionStep('clicked buy', { button: 'buy', nested: { a: [1, 2] } })
      ph.addExceptionStep('   ')
      ph.addExceptionStep(123)
      ph.addExceptionStep('reserved fields', { $message: 'nope', $timestamp: 1, kept: 1 })
      ph.addExceptionStep('big step', { blob: new Array(500).join('x') })
      ph.captureException(new Error('first with steps'))
      ph.captureException(new Error('second without steps'))
      ph.addExceptionStep('step 3')
      ph.captureException(new Error('caller steps win'), { $exception_steps: [{ $message: 'mine' }] })
      ph.captureException(new Error('step 3 still buffered'))
      ph.set_config({ error_tracking: { exception_steps: { enabled: false } } })
      ph.addExceptionStep('disabled step')
      ph.captureException(new Error('steps disabled'))
      await sleep(700)
      delete window._posthogReleaseId
      delete window._posthogChunkIds
    },

    exc_onerror: async function (ph, h) {
      // No pre-existing handler: real uncaught errors from timers.
      ph.init(h.token, cfg(h, { capture_exceptions: true }))
      await sleep(800)
      throwLater(new Error('diff-expected thrown from a timeout'))
      await sleep(100)
      setTimeout(function callsUndefined() { window.diffExpectedMissing() }, 0)
      await sleep(100)
      throwLater(new MyError('diff-expected custom error'))
      await sleep(700)
      window.__flagResults = { instrumented: !!window.onerror.__POSTHOG_INSTRUMENTED__, enabled: ph.exceptionObserver.isEnabled }
    },

    exc_rejection: async function (ph, h) {
      ph.init(h.token, cfg(h, { capture_exceptions: true }))
      await sleep(800)
      rejectLater(new Error('diff-expected rejected with an error'))
      await sleep(100)
      rejectLater('diff-expected primitive reason')
      await sleep(100)
      rejectLater(42)
      await sleep(100)
      rejectLater({ diff: 'expected', reason: 'object' })
      await sleep(700)
    },

    exc_chained_handlers: async function (ph, h) {
      var calls = []
      window.onerror = function (message, source, lineno, colno, error) {
        calls.push(['onerror', String(message), !!error])
        return true
      }
      window.onunhandledrejection = function (ev) {
        calls.push(['onunhandledrejection', String(ev.reason && ev.reason.message || ev.reason)])
        ev.preventDefault()
      }
      ph.init(h.token, cfg(h, { capture_exceptions: true }))
      await sleep(800)
      throwLater(new Error('diff-expected chained onerror'))
      await sleep(100)
      rejectLater(new Error('diff-expected chained rejection'))
      await sleep(100)
      // onerror called without an Error object: an ErrorEvent keeps the location.
      var r1 = window.onerror('diff-expected string message', location.href, 12, 34)
      var r2 = window.onerror('diff-expected no location')
      await sleep(600)
      ph.stopExceptionAutocapture()
      var restored = !window.onerror.__POSTHOG_INSTRUMENTED__
      throwLater(new Error('diff-expected after stop'))
      await sleep(600)
      window.__flagResults = { calls: calls, restored: restored, returns: [r1, r2] }
    },

    exc_console: async function (ph, h) {
      swallowErrors()
      ph.init(h.token, cfg(h, { capture_exceptions: { capture_console_errors: true } }))
      await sleep(800)
      console.error('diff-expected plain console message')
      console.error('diff-expected', 'several', 3, 'args')
      console.error(new Error('diff-expected console error object'))
      console.error('diff-expected prefix', new TypeError('diff-expected error among args'))
      console.error('[PostHog.js] internal diagnostic', 'ignored')
      console.error({ diff: 'expected object' })
      // capture_console_errors only: onerror is not wrapped.
      throwLater(new Error('diff-expected not captured'))
      await sleep(700)
      window.__flagResults = { onerrorCalls: window.__onerrorCalls }
    },

    exc_rate_limit: async function (ph, h) {
      swallowErrors()
      ph.init(h.token, cfg(h, { capture_exceptions: true }))
      await sleep(800)
      for (var i = 0; i < 13; i++) throwLater(new Error('diff-expected burst ' + i))
      await sleep(100)
      throwLater(new TypeError('diff-expected other type'))
      await sleep(100)
      // captureException is not rate limited.
      for (var j = 0; j < 12; j++) ph.captureException(new Error('manual ' + j))
      await sleep(800)
      window.__flagResults = { onerrorCalls: window.__onerrorCalls }
    },

    exc_config_remote_off: async function (ph, h) {
      // capture_exceptions undefined, remote flag off: nothing is autocaptured.
      swallowErrors()
      ph.init(h.token, cfg(h))
      await sleep(1000)
      await fireAll('remote off, undefined')
      ph.startExceptionAutocapture({ capture_unhandled_rejections: true })
      await sleep(800)
      await fireAll('started with rejections only')
      ph.startExceptionAutocapture()
      await sleep(400)
      await fireAll('started with defaults')
      ph.stopExceptionAutocapture()
      await fireAll('stopped')
      await sleep(600)
    },

    exc_config_remote_on: async function (ph, h) {
      // capture_exceptions undefined, remote flag on: errors and rejections.
      swallowErrors()
      ph.init(h.token, cfg(h))
      await sleep(1200)
      await fireAll('remote on, undefined')
      await sleep(600)
      window.__flagResults = { enabled: ph.exceptionObserver.isEnabled }
    },

    exc_config_remote_on_false: async function (ph, h) {
      swallowErrors()
      ph.init(h.token, cfg(h, { capture_exceptions: false }))
      await sleep(1200)
      await fireAll('remote on, false')
      await sleep(600)
    },

    exc_config_remote_on_object: async function (ph, h) {
      // An object is merged over all-false defaults: only console errors.
      swallowErrors()
      ph.init(h.token, cfg(h, { capture_exceptions: { capture_console_errors: true } }))
      await sleep(1200)
      await fireAll('remote on, object')
      await sleep(600)
    },

    exc_config_remote_off_object: async function (ph, h) {
      swallowErrors()
      ph.init(h.token, cfg(h, { capture_exceptions: { capture_unhandled_errors: true, capture_unhandled_rejections: false } }))
      await sleep(1000)
      await fireAll('remote off, object')
      await sleep(600)
    },

    exc_suppression: async function (ph, h) {
      swallowErrors()
      ph.init(h.token, cfg(h, { capture_exceptions: true }))
      await sleep(1000)
      ph.captureException(new MyError('suppressed by type'))
      ph.captureException(new TypeError('please IGNORE ME now'))
      ph.captureException(new RangeError('please ignore me too'))
      ph.captureException(new Error('ignore me, but not a matching type'))
      ph.captureException(new Error('outer', { cause: new MyError('a suppressed cause drops the whole list') }))
      ph.captureException('503')
      ph.captureException('code 500 is not a number')
      ph.captureException(new Error('kept: carries the dropped steps'))
      throwLater(new MyError('diff-expected autocaptured but suppressed'))
      await sleep(100)
      throwLater(new Error('diff-expected autocaptured and kept'))
      await sleep(700)
    },

    exc_extension_frames: async function (ph, h) {
      swallowErrors()
      ph.init(h.token, cfg(h, { capture_exceptions: true }))
      await sleep(800)
      var ext = new Error('diff-expected from an extension')
      ext.stack = 'Error: diff-expected from an extension\n' +
        '    at injected (chrome-extension://abcdefghijklmnop/content.js:10:5)\n' +
        '    at HTMLDocument.<anonymous> (' + location.origin + '/page.html:20:3)'
      throwLater(ext)
      await sleep(100)
      var moz = new Error('firefox extension')
      moz.stack = 'injected@moz-extension://1234-5678/content.js:1:2\n@' + location.origin + '/page.html:2:3'
      ph.captureException(moz)
      var safari = new Error('safari extension')
      safari.stack = 'Error: safari extension\n    at safari-extension://ext/abc/content.js:3:4'
      ph.captureException(safari)
      var safariFn = new Error('safari web extension fn')
      safariFn.stack = 'run@safari-web-extension://ext/content.js:3:4'
      ph.captureException(safariFn)
      var masked = new Error('masked but no known signature')
      masked.stack = 'Error: masked\n    at fn (webkit-masked-url://hidden/:1:2)'
      ph.captureException(masked)
      var maskedKnown = new Error('No response from target')
      maskedKnown.stack = 'Error: x\n    at fn (webkit-masked-url://hidden/:1:2)'
      ph.captureException(maskedKnown)
      ph.captureException(new ReferenceError('__gCrWeb is not defined'))
      ph.captureException(new TypeError("undefined is not an object (evaluating 'window.__firefox__.reader')"))
      var sdk = new Error('posthog sdk error')
      sdk.stack = 'Error: posthog sdk error\n    at fn (https://us-assets.i.posthog.com/static/array.js:1:2)'
      ph.captureException(sdk)
      var native = new Error('native and eval frames')
      native.stack = 'Error: native\n    at eval (eval at run (' + location.origin + '/page.html:5:6), <anonymous>:1:2)\n' +
        '    at Array.map (<anonymous>)\n    at ' + location.origin + '/page.html:7:8\n    at async load (' + location.origin + '/x.js:9:10)'
      ph.captureException(native)
      await sleep(700)
      ph.set_config({ error_tracking: { captureExtensionExceptions: true } })
      ph.captureException(moz)
      ph.captureException(new ReferenceError('__gCrWeb is not defined'))
      await sleep(700)
    },

    exc_recursion: async function (ph, h) {
      ph.init(h.token, cfg(h))
      function a(n) { return n <= 0 ? b(n) : a(n - 1) }
      function b(n) { if (n > -30) return c(n - 1); throw new RangeError('deep') }
      function c(n) { return b(n) }
      try { a(80) } catch (e) { ph.captureException(e) }
      function overflow() { return overflow() + 1 }
      try { overflow() } catch (e) { ph.captureException(e, { which: 'overflow' }) }
      var long = new Error('long stack')
      var lines = ['Error: long stack']
      for (var i = 0; i < 70; i++) lines.push('    at f' + i + ' (' + location.origin + '/f.js:' + (i + 1) + ':1)')
      long.stack = lines.join('\n')
      ph.captureException(long)
      await sleep(700)
    },
  }
  for (var name in S) window.SCENARIOS[name] = S[name]
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
      // disable_surveys: upstream inserts surveys.js (not ported) after its detector started, a
      // DOM mutation ours can't mirror (it would show up as $dead_click_last_mutation_timestamp).
      ph.init(h.token, h.config({ capture_pageview: false, capture_dead_clicks: true, disable_surveys: true }))
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

// ---- session replay -----------------------------------------------------------
// The remote config for each scenario (fixtures.mjs) enables recording. Both
// SDKs record the same page with the same rrweb build; the runner decodes and
// compares the $snapshot payloads.
;(function () {
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }
  async function waitFor(fn, ms) {
    var end = Date.now() + (ms || 6000)
    while (Date.now() < end) {
      try { if (fn()) return true } catch (e) {}
      await sleep(25)
    }
    return false
  }
  // Recording starts after the remote config and the recorder script loaded.
  async function started(ph) {
    var ok = await waitFor(function () { return ph.sessionRecordingStarted() })
    await sleep(300) // full snapshot compression (CompressionStream) settles
    return ok
  }
  var counter = 0
  // A user interaction (releases the "no interaction yet" hold), a DOM
  // mutation and masked input.
  function interact() {
    counter++
    document.getElementById('buy').click()
    var p = document.createElement('p')
    p.className = 'added'
    p.textContent = 'added ' + counter
    document.body.insertBefore(p, document.getElementById('form'))
    var input = document.getElementById('email')
    input.value = 'person' + counter + '@example.com'
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  function status(ph) {
    var sr = ph.sessionRecording
    return { started: ph.sessionRecordingStarted(), status: sr ? sr.status : null }
  }
  function seedPersistence(extra) {
    var now = Date.now()
    var props = {
      distinct_id: 'returning', $device_id: 'returning', $user_state: 'anonymous',
      $sesid: [now - 1000, '0190f5b8-0000-7000-8000-00000000bbbb', now - 5000],
    }
    for (var k in extra) props[k] = extra[k]
    localStorage.setItem('ph_phc_diff_posthog', JSON.stringify(props))
  }
  var CACHED_CONFIG = {
    enabled: true, endpoint: '/s/', consoleLogRecordingEnabled: true, recorderVersion: 'v2', sampleRate: null,
    minimumDurationMilliseconds: null, linkedFlag: null, networkPayloadCapture: { capturePerformance: false },
    canvasRecording: {}, masking: null, urlTriggers: [], urlBlocklist: [], eventTriggers: [], triggerMatchType: null,
    scriptConfig: null,
  }

  // Surveys are not ported, and upstream injects surveys.js whenever the remote
  // config has a `surveys` key, which would add a <script> to the recorded DOM.
  function cfg(h, extra) {
    var c = { autocapture: false, disable_surveys: true }
    for (var k in extra || {}) c[k] = extra[k]
    return h.config(c)
  }

  Object.assign(window.SCENARIOS, {
    replay_recording: async function (ph, h) {
      ph.init(h.token, cfg(h, { capture_pageview: 'history_change' }))
      var ok = await started(ph)
      interact()
      console.log('hello from the page', { n: 1 })
      await sleep(2500)
      history.pushState({}, '', '/docs/next?x=1')
      interact()
      ph.capture('after-navigation')
      await sleep(2500)
      window.__flagResults = { ok: ok, s: status(ph), url: ph.get_session_replay_url().replace(ph.get_session_id(), '<sid>') }
    },

    replay_server_disabled: async function (ph, h) {
      ph.init(h.token, cfg(h))
      await sleep(1500)
      interact()
      ph.capture('no-recording')
      await sleep(800)
      window.__flagResults = status(ph)
    },

    replay_client_disabled: async function (ph, h) {
      ph.init(h.token, cfg(h, { disable_session_recording: true }))
      await sleep(1500)
      interact()
      ph.capture('no-recording')
      await sleep(800)
      window.__flagResults = status(ph)
    },

    replay_sample_rate_0: async function (ph, h) {
      ph.init(h.token, cfg(h))
      var ok = await started(ph)
      interact()
      ph.capture('sampled-out')
      await sleep(2500)
      window.__flagResults = { ok: ok, s: status(ph) }
    },

    replay_sample_rate_1: async function (ph, h) {
      ph.init(h.token, cfg(h))
      var ok = await started(ph)
      interact()
      ph.capture('sampled-in')
      await sleep(2500)
      window.__flagResults = { ok: ok, s: status(ph) }
    },

    replay_linked_flag_match: async function (ph, h) {
      ph.init(h.token, cfg(h))
      var ok = await started(ph)
      await sleep(500) // flags
      interact()
      await sleep(2500)
      window.__flagResults = { ok: ok, s: status(ph) }
    },

    replay_linked_flag_miss: async function (ph, h) {
      ph.init(h.token, cfg(h))
      var ok = await started(ph)
      await sleep(500)
      interact()
      ph.capture('flag-missed')
      await sleep(2500)
      window.__flagResults = { ok: ok, s: status(ph) }
    },

    replay_url_trigger: async function (ph, h) {
      ph.init(h.token, cfg(h, { capture_pageview: 'history_change' }))
      var ok = await started(ph)
      interact()
      await sleep(2500)
      var before = status(ph)
      history.pushState({}, '', '/checkout/step-1')
      await sleep(100)
      interact()
      await sleep(2500)
      window.__flagResults = { ok: ok, before: before, after: status(ph) }
    },

    replay_url_blocklist: async function (ph, h) {
      ph.init(h.token, cfg(h, { capture_pageview: 'history_change' }))
      var ok = await started(ph)
      interact()
      await sleep(2500)
      history.pushState({}, '', '/private/account')
      await sleep(100)
      interact()
      await sleep(600)
      var paused = status(ph)
      history.pushState({}, '', '/public')
      await sleep(100)
      interact()
      await sleep(2500)
      window.__flagResults = { ok: ok, paused: paused, after: status(ph) }
    },

    replay_event_trigger: async function (ph, h) {
      ph.init(h.token, cfg(h))
      var ok = await started(ph)
      interact()
      await sleep(2500)
      var before = status(ph)
      ph.capture('purchase', { plan: 'pro' })
      interact()
      await sleep(2500)
      window.__flagResults = { ok: ok, before: before, after: status(ph) }
    },

    replay_minimum_duration: async function (ph, h) {
      ph.init(h.token, cfg(h))
      var ok = await started(ph)
      interact()
      await sleep(2300) // flush held: session shorter than 4s
      interact()
      await sleep(2500) // the rescheduled flush ships once the session is long enough
      window.__flagResults = { ok: ok, s: status(ph) }
    },

    replay_minimum_duration_strict: async function (ph, h) {
      ph.init(h.token, cfg(h, { session_recording: { strictMinimumDuration: true } }))
      var ok = await started(ph)
      interact()
      await sleep(2300) // buffer spans less than 1.5s
      interact()
      await sleep(2500)
      window.__flagResults = { ok: ok, s: status(ph) }
    },

    replay_idle_rotation: async function (ph, h) {
      ph.init(h.token, cfg(h))
      var ok = await started(ph)
      interact()
      await sleep(2500)
      // An event timestamped two hours later finds the session idle: it rotates
      // (activityTimeout), and the recorder links and restarts.
      ph.capture('much-later', {}, { timestamp: new Date(Date.now() + 2 * 3600 * 1000) })
      await sleep(300)
      interact()
      await sleep(2500)
      window.__flagResults = { ok: ok, s: status(ph) }
    },

    replay_forced_rotation: async function (ph, h) {
      ph.init(h.token, cfg(h))
      var ok = await started(ph)
      interact()
      await sleep(400)
      ph.reset() // flushes the old identity's buffer, new session on the next event
      ph.capture('after-reset')
      await sleep(300)
      interact()
      await sleep(2500)
      window.__flagResults = { ok: ok, s: status(ph) }
    },

    replay_start_stop_api: async function (ph, h) {
      ph.init(h.token, cfg(h, { disable_session_recording: true }))
      await sleep(1200)
      var before = status(ph)
      ph.startSessionRecording({ sampling: true })
      var ok = await started(ph)
      interact()
      await sleep(2500)
      ph.stopSessionRecording()
      var stopped = status(ph)
      interact()
      ph.capture('after-stop')
      await sleep(600)
      ph.startSessionRecording()
      await started(ph)
      interact()
      await sleep(2500)
      window.__flagResults = { ok: ok, before: before, stopped: stopped, after: status(ph) }
    },

    replay_unload_flush: async function (ph, h) {
      // No interaction: the fresh-start hold is released by the (visible)
      // page's unload, which flushes and parks nothing.
      ph.init(h.token, cfg(h))
      var ok = await started(ph)
      var p = document.createElement('p')
      p.textContent = 'just before leaving'
      document.body.appendChild(p)
      await sleep(100)
      window.__flagResults = { ok: ok, s: status(ph) }
    },

    replay_cached_config: async function (ph, h) {
      // A second page load: recording starts from the persisted (fresh) remote
      // config, before the new remote config arrives.
      seedPersistence({ $session_recording_remote_config: Object.assign({ cache_timestamp: Date.now() }, CACHED_CONFIG) })
      ph.init(h.token, cfg(h))
      var early = status(ph)
      var ok = await started(ph)
      interact()
      await sleep(2500)
      window.__flagResults = { ok: ok, early: early, s: status(ph) }
    },

    replay_stale_cached_config: async function (ph, h) {
      // A persisted config older than 1h is not trusted: recording waits for a
      // fresh remote config.
      seedPersistence({ $session_recording_remote_config: Object.assign({ cache_timestamp: Date.now() - 2 * 3600 * 1000 }, CACHED_CONFIG) })
      ph.init(h.token, cfg(h))
      var early = status(ph)
      var ok = await started(ph)
      interact()
      await sleep(2500)
      window.__flagResults = { ok: ok, early: early, s: status(ph) }
    },

    replay_masking_network: async function (ph, h) {
      var secret = document.createElement('div')
      secret.className = 'secret'
      secret.textContent = 'masked text'
      document.body.appendChild(secret)
      // No /flags request: whether it finishes before the recorder starts (and so
      // appears in the initial network entries) is a race.
      ph.init(h.token, cfg(h, { advanced_disable_feature_flags_on_first_load: true, session_recording: { maskInputOptions: { email: true } } }))
      var ok = await started(ph)
      interact()
      var res = await fetch('/scenarios.js?probe=1', { method: 'POST', headers: { 'X-Probe': 'yes', 'X-Api-Key': 'k' }, body: '{"q":1}' })
      await res.text()
      await sleep(2500)
      window.__flagResults = { ok: ok, s: status(ph) }
    },

    replay_idle_detection: async function (ph, h) {
      // A 1s replay idle threshold: a mutation 1.5s after the last interaction
      // marks the recording idle (sessionIdle, flushed), the next interaction
      // wakes it (sessionNoLongerIdle).
      ph.init(h.token, cfg(h, { session_recording: { session_idle_threshold_ms: 1000 } }))
      var ok = await started(ph)
      interact()
      await sleep(1500)
      var p = document.createElement('p')
      p.textContent = 'while idle'
      document.body.appendChild(p)
      await sleep(400)
      var idle = status(ph)
      interact()
      await sleep(2500)
      window.__flagResults = { ok: ok, idle: idle, s: status(ph) }
    },

    replay_full_snapshot_interval: async function (ph, h) {
      // Periodic full snapshots every second; recording is stopped well
      // between two ticks so both SDKs take the same number.
      ph.init(h.token, cfg(h, { session_recording: { full_snapshot_interval_millis: 1000 } }))
      var ok = await started(ph)
      interact()
      await sleep(2000)
      ph.stopSessionRecording()
      await sleep(300)
      window.__flagResults = { ok: ok, s: status(ph) }
    },

    replay_v2_trigger_groups: async function (ph, h) {
      ph.init(h.token, cfg(h))
      var ok = await started(ph)
      interact()
      await sleep(2500)
      ph.capture('purchase', { plan: 'pro' })
      interact()
      await sleep(2500)
      window.__flagResults = { ok: ok, s: status(ph) }
    },
  })
})()

// ---- web vitals and tracing headers ---------------------------------------------------
// Web vitals: the remote config (fixtures.mjs) or `capture_performance` turns
// them on. Metric values and timings are browser-measured (normalised by the
// runner); which metrics are buffered together, the event shape, flush timing
// and URLs are compared. Trusted input (CDP) finalises LCP and produces INP.
// Tracing headers: the page calls the fake server's /__echo on other hosts,
// which records the request headers.
;(function () {
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }
  var READY_MS = 700

  function cfg(h, extra) {
    var c = { autocapture: false, capture_pageview: false, disable_surveys: true }
    for (var k in extra || {}) c[k] = extra[k]
    return h.config(c)
  }
  // A button whose click handler blocks the main thread: a > 40ms interaction (INP).
  function slowButton() {
    var b = document.createElement('button')
    b.id = 'wv-slow'
    b.textContent = 'Slow'
    b.addEventListener('click', function () {
      var end = performance.now() + 150
      while (performance.now() < end) { /* busy */ }
    })
    document.body.insertBefore(b, document.body.firstChild)
    return b
  }
  // An empty block inserted above the content: a layout shift (CLS) without recent input.
  function shiftLayout() {
    var d = document.createElement('div')
    d.id = 'wv-shift'
    d.style.height = '240px'
    document.body.insertBefore(d, document.getElementById('hero'))
  }
  function state(ph) {
    var w = ph.webVitalsAutocapture
    return w ? { enabled: w.isEnabled, allowed: w.allowedMetrics, attribution: w.attributionMetrics,
      flushMs: w.flushToCaptureTimeoutMs, softNavs: w.useSoftNavs } : null
  }

  function echoUrl(host, n) { return 'http://' + host + ':' + location.port + '/__echo?n=' + n }
  function xhr(method, url, headers) {
    return new Promise(function (resolve) {
      var x = new XMLHttpRequest()
      x.open(method, url)
      for (var k in headers || {}) x.setRequestHeader(k, headers[k])
      x.onloadend = function () { resolve(x.status) }
      x.send(method === 'POST' ? '{"x":1}' : null)
    })
  }
  // fetch(url), fetch(url, init with headers), fetch(Request) and XHR, to `host`.
  async function requests(host, n) {
    await (await fetch(echoUrl(host, n + '-get'))).text()
    await (await fetch(echoUrl(host, n + '-post'), { method: 'POST', headers: { 'X-App': 'kept' }, body: '{"q":1}' })).text()
    await (await fetch(new Request(echoUrl(host, n + '-request'), { headers: { 'X-App': 'req' } }))).text()
    await xhr('GET', echoUrl(host, n + '-xhr'))
    await xhr('POST', echoUrl(host, n + '-xhr-post'), { 'X-App': 'xhr', traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' })
  }

  Object.assign(window.SCENARIOS, {
    wv_remote_on: async function (ph, h) {
      ph.init(h.token, cfg(h))
      await sleep(READY_MS)
      await h.click('#buy') // finalises LCP
      await sleep(400)
      ph.capture('after-click')
      await sleep(600)
      window.__flagResults = state(ph)
    },

    wv_remote_off: async function (ph, h) {
      ph.init(h.token, cfg(h))
      await sleep(READY_MS)
      await h.click('#buy')
      await sleep(400)
      ph.capture('no-web-vitals')
      await sleep(600)
      window.__flagResults = state(ph)
    },

    wv_allowed_metrics: async function (ph, h) {
      // Remote allow list FCP + LCP: the buffer is complete (and sent) once LCP is finalised.
      ph.init(h.token, cfg(h))
      await sleep(READY_MS)
      await h.click('#buy')
      await sleep(600)
      ph.capture('after-flush')
      await sleep(600)
      window.__flagResults = state(ph)
    },

    wv_client_config: async function (ph, h) {
      // Enabled by the client config alone: FCP only, no attribution. The remote
      // config fails and first-load flags are off, so whether FCP arrives before
      // them (an async script load upstream) cannot change the traffic.
      ph.init(h.token, cfg(h, { advanced_disable_feature_flags_on_first_load: true, capture_performance: { web_vitals: true, web_vitals_allowed_metrics: ['FCP'], web_vitals_attribution: false, __web_vitals_max_value: 30000 } }))
      await sleep(READY_MS)
      ph.capture('after-fcp')
      await sleep(600)
      window.__flagResults = state(ph)
    },

    wv_real_metrics: async function (ph, h) {
      // LCP (finalised by the first click), CLS (a layout shift without recent
      // input), INP (a slow click handler) and FCP, every metric attributed,
      // with personal data masked in the URLs. LCP/FCP are buffered first; CLS
      // and INP arrive when the page is hidden on unload, completing the buffer.
      var b = slowButton()
      ph.init(h.token, cfg(h, { mask_personal_data_properties: true, custom_personal_data_properties: ['utm_source'], capture_performance: { web_vitals_attribution: true } }))
      await sleep(READY_MS)
      shiftLayout()
      await sleep(700)
      await h.click(b)
      await sleep(300)
      await h.click(b)
      await sleep(500)
      window.__flagResults = state(ph)
    },

    wv_flush_unload: async function (ph, h) {
      // No input: LCP and CLS are only reported when the page is hidden on
      // unload, and the incomplete buffer (no INP) is sent by beacon. The URL is
      // the navigation's (the hard navigation entry), not the pushState one.
      ph.init(h.token, cfg(h))
      await sleep(1200)
      history.pushState({}, '', '/wv/other?step=2#hash')
      window.__flagResults = state(ph)
    },

    wv_flush_timer: async function (ph, h) {
      // A 1s delayed flush: FCP alone is sent by the timer, the rest on unload.
      ph.init(h.token, cfg(h, { capture_performance: { web_vitals_delayed_flush_ms: 1000 } }))
      await sleep(2200)
      ph.capture('after-timer')
      await sleep(400)
      window.__flagResults = state(ph)
    },

    wv_external_loading_disabled: async function (ph, h) {
      // Upstream cannot load its web-vitals script: nothing is captured. Ours
      // refuses to start the same way.
      ph.init(h.token, cfg(h, { disable_external_dependency_loading: true }))
      await sleep(READY_MS)
      await h.click('#buy')
      await sleep(600)
      ph.capture('no-web-vitals')
      await sleep(400)
      window.__flagResults = state(ph)
    },

    th_fetch_xhr: async function (ph, h) {
      ph.init(h.token, cfg(h, { tracing_headers: ['api.example.test'], trace_propagation_targets: ['api.example.test', 'http://other.example.test:' + location.port] }))
      await sleep(READY_MS)
      await requests('api.example.test', 'allowed')
      await requests('other.example.test', 'other')
      await requests('third.example.test', 'none')
      ph.identify('traced-user')
      // Let identify's $identify batch and flags reload go out first: otherwise their place
      // among the concurrent requests below is a race (in both SDKs).
      await sleep(300)
      await requests('api.example.test', 'identified')
      ph.capture('after-requests')
      await sleep(600)
      window.__flagResults = { patched: !!window.fetch.__posthog_wrapped__ }
    },

    th_not_configured: async function (ph, h) {
      ph.init(h.token, cfg(h))
      await sleep(READY_MS)
      await requests('api.example.test', 'plain')
      ph.capture('after-requests')
      await sleep(600)
      window.__flagResults = { patched: !!window.fetch.__posthog_wrapped__ }
    },

    th_alias_add_tracing_headers: async function (ph, h) {
      ph.init(h.token, cfg(h, { addTracingHeaders: ['api.example.test'] }))
      await sleep(READY_MS)
      await requests('api.example.test', 'alias')
      await requests('other.example.test', 'other')
      ph.capture('after-requests')
      await sleep(600)
    },

    th_alias_legacy_true: async function (ph, h) {
      // The earliest preview option: `true` adds the headers to every host.
      ph.init(h.token, cfg(h, { __add_tracing_headers: true }))
      await sleep(READY_MS)
      await requests('api.example.test', 'legacy')
      await requests('other.example.test', 'legacy-other')
      ph.capture('after-requests')
      await sleep(600)
    },

    th_set_config: async function (ph, h) {
      // tracing_headers wins over the aliases; set_config re-checks: hostnames
      // change in place, then the headers stop while traceparent continues,
      // then everything stops (patches removed).
      ph.init(h.token, cfg(h, { tracing_headers: ['api.example.test'], addTracingHeaders: ['other.example.test'], trace_propagation_targets: ['api.example.test'] }))
      await sleep(READY_MS)
      await requests('api.example.test', 'first')
      await requests('other.example.test', 'first-other')
      ph.set_config({ tracing_headers: ['other.example.test'] })
      await requests('api.example.test', 'moved')
      await requests('other.example.test', 'moved-other')
      ph.set_config({ tracing_headers: [], addTracingHeaders: [] })
      await requests('api.example.test', 'traceparent-only')
      var stillPatched = !!window.fetch.__posthog_wrapped__
      ph.set_config({ trace_propagation_targets: [] })
      await requests('api.example.test', 'stopped')
      ph.capture('after-requests')
      await sleep(600)
      window.__flagResults = { stillPatched: stillPatched, patched: !!window.fetch.__posthog_wrapped__ }
    },
  })
})()

// ---- Logs, metrics and the toolbar loader (src/logs, src/metrics, src/toolbar) ----------
;(function () {
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }
  var scenario = new URLSearchParams(location.search).get('scenario')
  var LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal']

  function cfg(h, extra) {
    var c = { autocapture: false, capture_pageview: false, disable_surveys: true }
    for (var k in extra || {}) c[k] = extra[k]
    return h.config(c)
  }

  function toolbarState() {
    var stored = localStorage.getItem('_postHogToolbarParams')
    return {
      state: window.ph_toolbar_state,
      stored: stored ? JSON.parse(stored) : null,
      calls: window.__toolbarCalls || [],
      hash: location.hash,
    }
  }

  // Parse-time setup, before the SDK script is added: upstream reads the
  // toolbar hash param when the SDK is parsed.
  if (scenario === 'toolbar_hash') {
    var state = { action: 'ph_authorize', token: 'phc_diff', userIntent: 'add-action', temporaryToken: 'tmp-1', desiredHash: '#keep' }
    history.replaceState(null, '', location.pathname + location.search + '#__posthog=' + encodeURIComponent(btoa(JSON.stringify(state))))
  }
  if (scenario === 'toolbar_hash_legacy') {
    // Legacy `state=` param, urlencoded JSON, without desiredHash: the hash is removed.
    var legacy = { action: 'ph_authorize', token: 'phc_diff', userIntent: 'heatmaps', temporaryToken: 'tmp-2' }
    history.replaceState(null, '', location.pathname + location.search + '#state=' + encodeURIComponent(JSON.stringify(legacy)))
  }
  if (scenario === 'logs_console_persisted' || scenario === 'logs_console_remote_off') {
    // A previous page load saw `logs.captureConsoleLogs: true` in the remote config.
    localStorage.setItem('ph_phc_diff_posthog', JSON.stringify({ distinct_id: 'ret', $device_id: 'ret', $logs_capture_enabled_server_side: true }))
  }

  Object.assign(window.SCENARIOS, {
    logs_api: async function (ph, h) {
      ph.init(h.token, cfg(h, { logs: { serviceName: 'shop', environment: 'test', serviceVersion: '1.2.3', resourceAttributes: { team: 'web' } } }))
      await sleep(600)
      ph.captureLog({ body: 'checkout completed', level: 'info', attributes: {
        order_id: 'ord_789', amount_cents: 4999, ok: true, ratio: 0.5, big: 9007199254740993, tags: ['a', null, 2],
        nested: { x: 1, deep: { y: 'z' } }, nil: null, undef: undefined, when: new Date(0), fn: function () {},
      } })
      ph.captureLog({ body: 'with trace', trace_id: '4bf92f3577b34da6a3ce929d0e0e4736', span_id: '00f067aa0ba902b7', trace_flags: 1 })
      ph.captureLog({ body: 'unknown level', level: 'verbose' })
      ph.captureLog({ body: '' }) // dropped: no body
      ph.captureLog({ body: 'override auto attributes', attributes: { 'url.full': 'custom', posthogDistinctId: 'me' } })
      LEVELS.forEach(function (l) { ph.logger[l]('logger ' + l, { level_attr: l }) })
      ph.logs.logger.info('via posthog.logs.logger')
      window.__flagResults = { hasLogs: !!ph.logs, loggerKeys: Object.keys(ph.logger).sort() }
      await sleep(3600) // default 3 s flush interval
    },

    logs_before_send: async function (ph, h) {
      ph.init(h.token, cfg(h, { logs: { beforeSend: [
        function (log) { return log.body === 'drop me' ? null : log },
        function (log) { log.attributes = Object.assign({}, log.attributes, { edited: true }); log.body = log.body.toUpperCase(); return log },
      ] } }))
      await sleep(600)
      ph.captureLog({ body: 'keep me', attributes: { a: 1 } })
      ph.captureLog({ body: 'drop me' })
      await sleep(3600)
    },

    logs_batching: async function (ph, h) {
      // Flush at 10 queued records, at most 20 records per 1 s window.
      ph.init(h.token, cfg(h, { logs: { maxBufferSize: 10, maxLogsPerInterval: 20, flushIntervalMs: 1000 } }))
      await sleep(600)
      for (var i = 0; i < 25; i++) ph.captureLog({ body: 'burst ' + i, attributes: { i: i } })
      await sleep(1500)
      ph.captureLog({ body: 'next window' })
      await sleep(1500)
    },

    logs_batch_limit: async function (ph, h) {
      // 250 records: the size trigger sends 100, the timer drains the rest in
      // slices of 100 (maxBatchRecordsPerPost).
      ph.init(h.token, cfg(h))
      await sleep(600)
      for (var i = 0; i < 250; i++) ph.captureLog({ body: 'record ' + i })
      await sleep(3800)
    },

    logs_flush_unload: async function (ph, h) {
      ph.init(h.token, cfg(h, { logs: { captureConsoleLogs: true } }))
      await sleep(600)
      ph.captureLog({ body: 'flushed explicitly' })
      await ph.logs.flush()
      await sleep(300)
      ph.captureLog({ body: 'dropped by reset' })
      ph.reset()
      await sleep(300)
      ph.captureLog({ body: 'sent on unload', level: 'warn' })
      console.log('console record sent on unload')
      // Left in the queues: the runner unloads the page, which drains both with sendBeacon.
    },

    logs_opt_out: async function (ph, h) {
      ph.init(h.token, cfg(h, { logs: { captureConsoleLogs: true } }))
      await sleep(600)
      ph.opt_out_capturing()
      ph.captureLog({ body: 'while opted out' })
      console.log('console while opted out')
      ph.opt_in_capturing()
      ph.captureLog({ body: 'after opt in' })
      console.log('console after opt in')
      await sleep(3600)
    },

    logs_console_config: async function (ph, h) {
      ph.init(h.token, cfg(h, { logs: { captureConsoleLogs: true } }))
      console.log('right after init', 1, true, null)
      await sleep(600)
      console.log('hello', { user: { id: 7, name: 'ann' }, list: [1, 2], skip: undefined, f: function () {} })
      console.info('info line')
      console.warn('warn line', { code: 'W1' })
      console.error(new Error('diff-expected boom'))
      console.debug('debug line')
      console.log({ only: 'object', n: 1 })
      console.log('x'.repeat(12000)) // body truncated at 10000
      var circular = { name: 'loop' }
      circular.self = circular
      console.log('circular', circular)
      console.log() // no arguments: not captured
      ph.captureLog({ body: 'programmatic next to console' })
      await sleep(3600)
    },

    logs_console_remote: async function (ph, h) {
      // Console capture enabled by the remote config only (first visit: no recorder before it arrives).
      ph.init(h.token, cfg(h))
      console.log('before remote config')
      await sleep(800)
      console.log('after remote config', { n: 2 })
      console.warn('warn after remote config')
      window.__flagResults = { persisted: ph.get_property('$logs_capture_enabled_server_side') }
      await sleep(3600)
    },

    logs_console_persisted: async function (ph, h) {
      // The persisted hint starts the recorder: console calls before the remote
      // config arrives are buffered and replayed once it enables capture.
      ph.init(h.token, cfg(h))
      console.log('buffered before remote config', { early: true })
      console.error('buffered error')
      await sleep(800)
      console.log('live after remote config')
      await sleep(3600)
    },

    logs_console_remote_off: async function (ph, h) {
      // Persisted hint, but the remote config now says false: the recorder's buffer is dropped.
      ph.init(h.token, cfg(h))
      console.log('buffered then dropped')
      await sleep(800)
      console.log('not captured')
      ph.captureLog({ body: 'programmatic still works' })
      window.__flagResults = { persisted: ph.get_property('$logs_capture_enabled_server_side') }
      await sleep(3600)
    },

    metrics_api: async function (ph, h) {
      ph.init(h.token, cfg(h, { metrics: { serviceName: 'shop', environment: 'test', resourceAttributes: { team: 'web' } } }))
      await sleep(600)
      var m = ph.metrics
      m.count('orders_created')
      m.count('orders_created', 2)
      m.count('orders_created', 1, { attributes: { plan: 'pro', region: 'eu' } })
      m.count('orders_created', 1, { attributes: { region: 'eu', plan: 'pro' } }) // same series
      m.count('bad_count', -1) // dropped: counters are monotonic
      m.count('', 1) // dropped: no name
      m.gauge('active_connections', 42)
      m.gauge('active_connections', 40)
      m.gauge('nan_gauge', NaN) // dropped
      m.histogram('api_latency', 187, { unit: 'ms' })
      m.histogram('api_latency', 12, { unit: 'ms' })
      m.histogram('api_latency', 20000, { unit: 'ms' })
      m.histogram('payload', 3, { bounds: [1, 2, 4] })
      m.histogram('payload', 9, { bounds: [1, 2, 8] }) // bounds fixed by the first sample
      m.histogram('bad_bounds', 1, { bounds: [3, 2] }) // dropped
      await m.flush()
      await sleep(400)
      m.count('after_flush', 5, { unit: 'items' })
      m.histogram('api_latency', 50, { unit: 'ms' })
      // Left aggregated: the runner unloads the page, which drains the window with sendBeacon.
    },

    metrics_batching: async function (ph, h) {
      ph.init(h.token, cfg(h, { metrics: { flushIntervalMs: 800, maxSeriesPerFlush: 3, beforeSend: function (s) {
        if (s.name === 'secret') return null
        s.attributes = Object.assign({}, s.attributes, { tagged: true })
        return s
      } } }))
      await sleep(600)
      ph.metrics.count('a')
      ph.metrics.count('b')
      ph.metrics.count('secret')
      ph.metrics.gauge('c', 1)
      ph.metrics.gauge('d', 1) // over the series cap: dropped
      await sleep(1200) // timer flush
      ph.metrics.count('a', 3)
      ph.metrics.count('d')
      await sleep(1200)
      ph.metrics.count('dropped_by_reset')
      ph.reset()
      await sleep(300)
    },

    toolbar_hash: async function (ph, h) {
      ph.init(h.token, cfg(h))
      await sleep(800)
      window.__flagResults = toolbarState()
    },

    toolbar_hash_legacy: async function (ph, h) {
      ph.init(h.token, cfg(h))
      await sleep(800)
      window.__flagResults = toolbarState()
    },

    toolbar_load: async function (ph, h) {
      ph.init(h.token, cfg(h, { advanced_disable_toolbar_metrics: true }))
      await sleep(300)
      var results = { first: ph.loadToolbar({ userIntent: 'add-action', temporaryToken: 'tok', source: 'manual' }) }
      results.whileLoading = ph.loadToolbar({ userIntent: 'heatmaps' })
      await sleep(600)
      results.loaded = toolbarState()
      results.again = ph.toolbar.loadToolbar({ userIntent: 'heatmaps', token: 'other' })
      var el = document.createElement('div')
      el.id = '__POSTHOG_TOOLBAR__'
      document.body.appendChild(el)
      results.running = ph.loadToolbar({ userIntent: 'x' })
      el.remove()
      results.deprecated = typeof ph.toolbar._loadEditor + '/' + typeof ph.toolbar.maybeLoadEditor
      results.after = toolbarState()
      window.__flagResults = results
    },

    toolbar_persisted: async function (ph, h) {
      if (sessionStorage.getItem('toolbar_phase') !== '2') {
        ph.init(h.token, cfg(h))
        await sleep(300)
        ph.loadToolbar({ userIntent: 'add-action', temporaryToken: 'persist-me' })
        await sleep(600)
        sessionStorage.setItem('toolbar_phase', '2')
        location.reload()
        return new Promise(function () {}) // the reloaded page finishes the scenario
      }
      // Next page load: the params saved in localStorage launch the toolbar (without userIntent).
      ph.init(h.token, cfg(h))
      await sleep(800)
      window.__flagResults = toolbarState()
    },

    toolbar_fallback: async function (ph, h) {
      // The versioned /static/<version>/toolbar.js fails (fixture): the legacy URL with v and t is loaded.
      ph.init(h.token, cfg(h))
      await sleep(300)
      var first = ph.loadToolbar({ userIntent: 'add-action' })
      await sleep(800)
      window.__flagResults = { first: first, s: toolbarState() }
    },

    toolbar_none: async function (ph, h) {
      // Saved params for another project do not launch the toolbar.
      localStorage.setItem('_postHogToolbarParams', JSON.stringify({ token: 'phc_other', temporaryToken: 'x' }))
      ph.init(h.token, cfg(h))
      await sleep(800)
      window.__flagResults = { maybe: ph.toolbar.maybeLoadToolbar(), s: toolbarState() }
    },
  })
})()

// ---- Every lazily loaded part at once ----------------------------------------------------
// Upstream requests its /static/ scripts in the order its extensions start; the lazy build
// must request its chunks in the same order (checked by the runner for DIFF_BUNDLE=lazy/...).
;(function () {
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }
  window.SCENARIOS.lazy_all_features = async function (ph, h) {
    ph.init(h.token, h.config({ autocapture: false, capture_pageview: false, disable_surveys: true,
      capture_exceptions: true, capture_dead_clicks: true, capture_performance: { web_vitals: true },
      tracing_headers: ['api.example.test'], logs: { captureConsoleLogs: true } }))
    await sleep(800)
    console.log('all features on')
    ph.capture('after-start')
    await sleep(600)
    window.__flagResults = {
      wrapped: !!(window.onerror && window.onerror.__POSTHOG_INSTRUMENTED__),
      detector: !!ph.deadClicksAutocapture.lazyLoadedDeadClicksAutocapture,
      patched: !!window.fetch.__posthog_wrapped__,
    }
  }
})()
