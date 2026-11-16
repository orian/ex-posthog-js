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
