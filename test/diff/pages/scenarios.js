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
