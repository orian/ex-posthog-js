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
      ph.time_event('timed')
      await sleep(100)
      ph.capture('timed')
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
  }
})()
