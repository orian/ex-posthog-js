// Web vitals unit tests (node --test), ported from upstream's
// src/__tests__/extensions/web-vitals.test.ts, plus checks of the web-vitals
// 6.2.1 port in third_party/web-vitals. Run against the raw sources.
//
// Upstream's tests inject fake observers through
// `__PosthogExtensions__.postHogWebVitalsCallbacksByFlavor` (what its lazily
// loaded script defines); our module uses callbacks found there before its
// built-in ones, so the same injection works.
import test, { describe, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'

const windowEvents = new EventTarget()
const documentEvents = new EventTarget()
globalThis.window = globalThis
globalThis.addEventListener = windowEvents.addEventListener.bind(windowEvents)
globalThis.removeEventListener = windowEvents.removeEventListener.bind(windowEvents)
globalThis.dispatchEvent = windowEvents.dispatchEvent.bind(windowEvents)
globalThis.document = {
    visibilityState: 'visible',
    readyState: 'complete',
    addEventListener: documentEvents.addEventListener.bind(documentEvents),
    removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
    dispatchEvent: documentEvents.dispatchEvent.bind(documentEvents),
    querySelectorAll() { return [] },
}
const setLocation = (href) => { globalThis.location = new URL(href) }
setLocation('http://localhost/')

const {
    WebVitalsAutocapture, DEFAULT_FLUSH_TO_CAPTURE_TIMEOUT_MILLISECONDS, FIFTEEN_MINUTES_IN_MILLIS,
    WEB_VITALS_ENABLED_SERVER_SIDE, WEB_VITALS_ALLOWED_METRICS,
} = await import('../src/web-vitals/web-vitals.js')
await import('../src/web-vitals/index.js') // public getters (isEnabled, allowedMetrics, ...)
const lib = await import('../third_party/web-vitals/lib.js')

const FLAVORS = ['web-vitals', 'web-vitals-with-attribution', 'web-vitals-soft-navs', 'web-vitals-with-attribution-soft-navs']

/** Fake observers for every flavor; `emit.LCP(metric)` reports through the registered callback. */
function injectCallbacks({ flavors = FLAVORS, withoutAttribution } = {}) {
    const emit = {}
    const calls = []
    const observer = (name) => (cb, opts) => { calls.push([name, opts]); emit[name] = cb }
    const callbacks = { onLCP: observer('LCP'), onCLS: observer('CLS'), onFCP: observer('FCP'), onINP: observer('INP') }
    if (withoutAttribution) callbacks.withoutAttribution = withoutAttribution
    window.__PosthogExtensions__ = { postHogWebVitalsCallbacksByFlavor: Object.fromEntries(flavors.map((f) => [f, callbacks])) }
    return { emit, calls, callbacks }
}

/** The PostHog surface the module uses. */
function fakePostHog(config = {}, { cookieless = false, persisted = {} } = {}) {
    const captured = []
    const props = { ...persisted }
    return {
        config: { ...config },
        captured,
        persistence: { props, register(o) { for (const k in o) props[k] = o[k] } },
        sessionManager: cookieless ? null : { checkAndGetSessionAndWindowId(readOnly) { assert.equal(readOnly, true); return { sessionId: 'session-id', windowId: 'window-id' } } },
        capture(event, properties, options) { captured.push({ event, properties, options }) },
    }
}

function start(config, opts) {
    const ph = fakePostHog(config, opts)
    const wv = new WebVitalsAutocapture(ph)
    wv.onInit()
    return { ph, wv }
}
const webVitalsEvents = (ph) => ph.captured.filter((c) => c.event === '$web_vitals')

const metric = (name, extra = {}) => ({ name, value: 123.45, extra: 'property', ...extra })
const expectedEmitted = (name, url = 'http://localhost/') => ({
    $current_url: url, $session_id: 'session-id', $window_id: 'window-id', name, value: 123.45, extra: 'property',
})
const withoutTimestamp = (m) => { const { timestamp, ...rest } = m; assert.equal(typeof timestamp, 'number'); return rest }

beforeEach(() => {
    setLocation('http://localhost/')
    document.visibilityState = 'visible'
    mock.timers.enable({ apis: ['setTimeout'] })
})
afterEach(() => {
    mock.timers.reset()
    delete window.__PosthogExtensions__
})

const allowListCases = [
    [undefined, ['CLS', 'FCP', 'INP', 'LCP']],
    [null, ['CLS', 'FCP', 'INP', 'LCP']],
    [['CLS', 'FCP', 'INP', 'LCP'], ['CLS', 'FCP', 'INP', 'LCP']],
    [['CLS', 'FCP'], ['CLS', 'FCP']],
]
for (const [clientConfig, expectedAllowed] of allowListCases) {
    describe(`the behaviour when client config is ${JSON.stringify(clientConfig)}`, () => {
        let ph, wv, emit
        beforeEach(() => {
            ({ emit } = injectCallbacks())
            ;({ ph, wv } = start({ capture_performance: { web_vitals: true, web_vitals_allowed_metrics: clientConfig } }))
            wv.onRemoteConfig({ capturePerformance: { web_vitals: true } })
            assert.deepEqual(wv.allowedMetrics, expectedAllowed)
        })

        test('should emit when all allowed metrics are captured', () => {
            for (const name of ['LCP', 'CLS', 'FCP', 'INP']) emit[name] && expectedAllowed.includes(name) && emit[name](metric(name))
            const events = webVitalsEvents(ph)
            assert.equal(events.length, 1)
            const p = events[0].properties
            assert.equal(p.$current_url, 'http://localhost/')
            for (const name of expectedAllowed) {
                assert.deepEqual(withoutTimestamp(p[`$web_vitals_${name}_event`]), expectedEmitted(name))
                assert.equal(p[`$web_vitals_${name}_value`], 123.45)
            }
            assert.equal(events[0].options, undefined) // batched
        })

        test('should emit after 5 seconds even when only 1 to 3 metrics captured', () => {
            emit.CLS(metric('CLS'))
            assert.equal(webVitalsEvents(ph).length, 0)
            mock.timers.tick(4999)
            assert.equal(webVitalsEvents(ph).length, 0)
            mock.timers.tick(1)
            const events = webVitalsEvents(ph)
            assert.equal(events.length, 1)
            assert.deepEqual(withoutTimestamp(events[0].properties.$web_vitals_CLS_event), expectedEmitted('CLS'))
            assert.equal(events[0].properties.$web_vitals_CLS_value, 123.45)
        })

        test('should emit after configured timeout even when only 1 to 3 metrics captured', () => {
            ph.config.capture_performance.web_vitals_delayed_flush_ms = 1000
            emit.CLS(metric('CLS'))
            mock.timers.tick(999)
            assert.equal(webVitalsEvents(ph).length, 0)
            mock.timers.tick(1)
            assert.equal(webVitalsEvents(ph).length, 1)
        })

        test('flushes a pending web vital immediately on pagehide without resending on the timer (#5318)', () => {
            emit.CLS(metric('CLS'))
            assert.equal(webVitalsEvents(ph).length, 0)
            window.dispatchEvent(new Event('pagehide'))
            const events = webVitalsEvents(ph)
            assert.equal(events.length, 1)
            assert.equal(events[0].properties.$web_vitals_CLS_value, 123.45)
            assert.deepEqual(events[0].options, { transport: 'sendBeacon', send_instantly: true })
            mock.timers.tick(DEFAULT_FLUSH_TO_CAPTURE_TIMEOUT_MILLISECONDS + 1)
            assert.equal(webVitalsEvents(ph).length, 1)
        })

        test('flushes on visibilitychange to hidden, but not on visible (#5318)', () => {
            emit.CLS(metric('CLS'))
            document.visibilityState = 'visible'
            document.dispatchEvent(new Event('visibilitychange'))
            assert.equal(webVitalsEvents(ph).length, 0)
            document.visibilityState = 'hidden'
            document.dispatchEvent(new Event('visibilitychange'))
            const events = webVitalsEvents(ph)
            assert.equal(events.length, 1)
            assert.deepEqual(events[0].options, { transport: 'sendBeacon', send_instantly: true })
            window.dispatchEvent(new Event('pagehide'))
            assert.equal(webVitalsEvents(ph).length, 1)
        })

        test('should ignore a ridiculous value', () => {
            emit.CLS(metric('CLS', { value: FIFTEEN_MINUTES_IN_MILLIS }))
            mock.timers.tick(DEFAULT_FLUSH_TO_CAPTURE_TIMEOUT_MILLISECONDS + 1)
            assert.equal(ph.captured.length, 0)
        })

        test('can be configured not to ignore a ridiculous value', () => {
            ph.config.capture_performance = { __web_vitals_max_value: 0 }
            emit.CLS(metric('CLS', { value: FIFTEEN_MINUTES_IN_MILLIS }))
            mock.timers.tick(DEFAULT_FLUSH_TO_CAPTURE_TIMEOUT_MILLISECONDS + 1)
            assert.equal(ph.captured.length, 1)
        })
    })
}

test('max value: 1 ms to 1 minute means 15 minutes, 0 disables, larger values are used', () => {
    const { wv } = start({ capture_performance: { web_vitals: false } })
    for (const [configured, expected] of [[undefined, FIFTEEN_MINUTES_IN_MILLIS], [0, 0], [1, FIFTEEN_MINUTES_IN_MILLIS],
        [60000, FIFTEEN_MINUTES_IN_MILLIS], [60001, 60001], ['10', FIFTEEN_MINUTES_IN_MILLIS]]) {
        wv.instance.config.capture_performance = { __web_vitals_max_value: configured }
        assert.equal(wv.maxAllowedValue(), expected, String(configured))
    }
})

test('invalid metrics are dropped', () => {
    const { emit } = injectCallbacks()
    const { ph } = start({ capture_performance: { web_vitals: true, web_vitals_allowed_metrics: ['LCP'] } })
    emit.LCP({ value: 1 })
    emit.LCP({ name: 'LCP' })
    emit.LCP(undefined)
    mock.timers.tick(DEFAULT_FLUSH_TO_CAPTURE_TIMEOUT_MILLISECONDS + 1)
    assert.equal(ph.captured.length, 0)
})

describe('cookieless_mode (no session manager)', () => {
    test('emits web vitals without nested $session_id or $window_id', () => {
        const { emit } = injectCallbacks()
        const { ph, wv } = start({ capture_performance: { web_vitals: true, web_vitals_allowed_metrics: ['CLS', 'FCP'] } }, { cookieless: true })
        wv.onRemoteConfig({ capturePerformance: { web_vitals: true } })
        emit.CLS(metric('CLS'))
        emit.FCP(metric('FCP'))
        const events = webVitalsEvents(ph)
        assert.equal(events.length, 1)
        for (const name of ['CLS', 'FCP']) {
            const e = events[0].properties[`$web_vitals_${name}_event`]
            assert.ok(!('$session_id' in e) && !('$window_id' in e))
            assert.deepEqual(withoutTimestamp(e), { $current_url: 'http://localhost/', name, value: 123.45, extra: 'property' })
        }
    })

    test('emits on delayed flush without nested session ids when only one metric is captured', () => {
        const { emit } = injectCallbacks()
        const { ph } = start({ capture_performance: { web_vitals: true, web_vitals_allowed_metrics: ['CLS', 'FCP'] } }, { cookieless: true })
        emit.CLS(metric('CLS'))
        mock.timers.tick(DEFAULT_FLUSH_TO_CAPTURE_TIMEOUT_MILLISECONDS + 1)
        const events = webVitalsEvents(ph)
        assert.equal(events.length, 1)
        assert.ok(!('$session_id' in events[0].properties.$web_vitals_CLS_event))
    })
})

describe('web_vitals_attribution config', () => {
    for (const [attribution, expected] of [[undefined, true], [true, true], [false, false], [[], false], [['INP'], true]]) {
        test(`when web_vitals_attribution is ${JSON.stringify(attribution)}, useAttribution should be ${expected}`, () => {
            const { wv } = start({ capture_performance: { web_vitals: true, web_vitals_attribution: attribution } })
            assert.equal(wv.useAttribution, expected)
        })
    }

    for (const [attribution, bundle] of [[undefined, 'web-vitals-with-attribution'], [false, 'web-vitals'], [true, 'web-vitals-with-attribution']]) {
        test(`when web_vitals_attribution is ${attribution}, selects the ${bundle} callbacks`, () => {
            const { calls } = injectCallbacks({ flavors: [bundle] })
            const { wv } = start({ capture_performance: { web_vitals: true, web_vitals_attribution: attribution } })
            assert.equal(wv.callbackFlavor(), bundle)
            assert.equal(calls.length, 4)
            assert.equal(wv.initialized, true)
        })
    }

    const observers = () => {
        const calls = []
        const make = (tag) => Object.fromEntries(['LCP', 'CLS', 'FCP', 'INP'].map((n) => [`on${n}`, (cb, opts) => calls.push([tag, n, opts])]))
        return { calls, attributed: make('attributed'), withoutAttribution: make('plain') }
    }

    test('uses unattributed observers for metrics excluded from the default attribution list', () => {
        const { calls, attributed, withoutAttribution } = observers()
        window.__PosthogExtensions__ = { postHogWebVitalsCallbacksByFlavor: { 'web-vitals-with-attribution': { ...attributed, withoutAttribution } } }
        start({ capture_performance: { web_vitals: true } })
        assert.deepEqual(calls.map(([tag, n]) => `${tag}:${n}`), ['attributed:LCP', 'plain:CLS', 'plain:FCP', 'attributed:INP'])
    })

    test('opts out of processedEventEntries on the attributed onINP only', () => {
        const { calls, attributed, withoutAttribution } = observers()
        window.__PosthogExtensions__ = { postHogWebVitalsCallbacksByFlavor: { 'web-vitals-with-attribution': { ...attributed, withoutAttribution } } }
        start({ capture_performance: { web_vitals: true } })
        const byName = Object.fromEntries(calls.map(([, n, opts]) => [n, opts]))
        assert.deepEqual(byName.INP, { reportSoftNavs: false, includeProcessedEventEntries: false })
        for (const n of ['LCP', 'CLS', 'FCP']) assert.deepEqual(byName[n], { reportSoftNavs: false })
    })

    test('does not pass attribution-only opts to the default bundle', () => {
        const { calls } = injectCallbacks({ flavors: ['web-vitals'] })
        start({ capture_performance: { web_vitals: true, web_vitals_attribution: false } })
        assert.deepEqual(calls.find(([n]) => n === 'INP')[1], { reportSoftNavs: false })
    })

    test('uses the legacy postHogWebVitalsCallbacks slot only for the default flavor', () => {
        const calls = []
        const cb = Object.fromEntries(['LCP', 'CLS', 'FCP', 'INP'].map((n) => [`on${n}`, () => calls.push(n)]))
        window.__PosthogExtensions__ = { postHogWebVitalsCallbacks: cb }
        start({ capture_performance: { web_vitals: true, web_vitals_attribution: false } })
        assert.equal(calls.length, 4)
    })
})

describe('captured metric payload', () => {
    const setupAndEmit = (config, emitFn, posthogConfig = {}) => {
        const { emit } = injectCallbacks()
        const { ph, wv } = start({ ...posthogConfig, capture_performance: { web_vitals: true, ...config } })
        wv.onRemoteConfig({ capturePerformance: { web_vitals: true } })
        emitFn(emit)
        mock.timers.tick(DEFAULT_FLUSH_TO_CAPTURE_TIMEOUT_MILLISECONDS + 1)
        return webVitalsEvents(ph)[0].properties
    }

    test('drops the useless entries array from the captured metric', () => {
        const p = setupAndEmit({}, (emit) => emit.INP({ name: 'INP', value: 100, entries: [{}] }))
        assert.ok(!('entries' in p.$web_vitals_INP_event))
    })

    test('keeps only whitelisted attribution fields for an attributed metric', () => {
        const p = setupAndEmit({}, (emit) => emit.INP({
            name: 'INP', value: 100,
            attribution: {
                interactionTarget: 'button#pay', inputDelay: 10, processingDuration: 20, presentationDelay: 30,
                interactionTargetElement: { huge: 'node' }, longAnimationFrameEntries: [{ scripts: [{ duration: 1 }] }],
            },
        }))
        assert.deepEqual(p.$web_vitals_INP_event.attribution, { interactionTarget: 'button#pay', inputDelay: 10, processingDuration: 20, presentationDelay: 30 })
    })

    test('keeps the LCP target in attribution', () => {
        const p = setupAndEmit({}, (emit) => emit.LCP({ name: 'LCP', value: 100, attribution: { target: 'img#hero', elementRenderDelay: 20 } }))
        assert.deepEqual(p.$web_vitals_LCP_event.attribution, { target: 'img#hero', elementRenderDelay: 20 })
    })

    test('masks personal data and removes hashes from LCP resource URLs', () => {
        const p = setupAndEmit({}, (emit) => emit.LCP({ name: 'LCP', value: 100, attribution: { url: 'https://cdn.example.com/hero.jpg?token=secret&size=large#private' } }),
            { mask_personal_data_properties: true, custom_personal_data_properties: ['token'], disable_capture_url_hashes: true })
        assert.equal(p.$web_vitals_LCP_event.attribution.url, 'https://cdn.example.com/hero.jpg?token=<masked>&size=large')
    })

    test('drops attribution for CLS by default', () => {
        const p = setupAndEmit({}, (emit) => emit.CLS({ name: 'CLS', value: 0.1, attribution: { largestShiftTarget: 'div#banner', largestShiftValue: 0.1 } }))
        assert.ok(!('attribution' in p.$web_vitals_CLS_event))
    })
})

describe('__preview_web_vitals_soft_navs config', () => {
    for (const [softNavs, expected] of [[undefined, false], [true, true], [false, false]]) {
        test(`when __preview_web_vitals_soft_navs is ${softNavs}, useSoftNavs should be ${expected}`, () => {
            const { wv } = start({ capture_performance: { web_vitals: true, __preview_web_vitals_soft_navs: softNavs } })
            assert.equal(wv.useSoftNavs, expected)
        })
    }
    for (const [softNavs, attribution, bundle] of [
        [undefined, undefined, 'web-vitals-with-attribution'], [false, false, 'web-vitals'],
        [true, undefined, 'web-vitals-with-attribution-soft-navs'], [true, false, 'web-vitals-soft-navs'],
        [true, true, 'web-vitals-with-attribution-soft-navs'], [false, true, 'web-vitals-with-attribution'],
    ]) {
        test(`soft navs ${softNavs} and attribution ${attribution} select ${bundle}, passing reportSoftNavs`, () => {
            const { calls } = injectCallbacks({ flavors: [bundle] })
            const { wv } = start({ capture_performance: { web_vitals: true, __preview_web_vitals_soft_navs: softNavs, web_vitals_attribution: attribution } })
            assert.equal(wv.callbackFlavor(), bundle)
            assert.equal(calls[0][1].reportSoftNavs, !!softNavs)
        })
    }
})

describe('onRemoteConfig', () => {
    test('does not overwrite persistence when called with empty config or a failed load', () => {
        const persisted = { [WEB_VITALS_ENABLED_SERVER_SIDE]: true, [WEB_VITALS_ALLOWED_METRICS]: ['LCP', 'FCP'] }
        const { ph, wv } = start({}, { persisted })
        wv.onRemoteConfig({})
        wv.onRemoteConfig(null)
        assert.equal(ph.persistence.props[WEB_VITALS_ENABLED_SERVER_SIDE], true)
        assert.deepEqual(ph.persistence.props[WEB_VITALS_ALLOWED_METRICS], ['LCP', 'FCP'])
    })

    test('updates persistence when capturePerformance key is present', () => {
        const persisted = { [WEB_VITALS_ENABLED_SERVER_SIDE]: true, [WEB_VITALS_ALLOWED_METRICS]: ['LCP', 'FCP'] }
        const { ph, wv } = start({}, { persisted })
        wv.onRemoteConfig({ capturePerformance: { web_vitals: false, web_vitals_allowed_metrics: ['CLS'] } })
        assert.equal(ph.persistence.props[WEB_VITALS_ENABLED_SERVER_SIDE], false)
        assert.deepEqual(ph.persistence.props[WEB_VITALS_ALLOWED_METRICS], ['CLS'])
        wv.onRemoteConfig({ capturePerformance: false })
        assert.equal(ph.persistence.props[WEB_VITALS_ENABLED_SERVER_SIDE], false)
        assert.equal(ph.persistence.props[WEB_VITALS_ALLOWED_METRICS], undefined)
    })

    test('the persisted server-side switch and allow list are used on the next page load', () => {
        const persisted = { [WEB_VITALS_ENABLED_SERVER_SIDE]: true, [WEB_VITALS_ALLOWED_METRICS]: ['LCP'] }
        injectCallbacks()
        const { wv } = start({}, { persisted })
        assert.equal(wv.isEnabled, true)
        assert.equal(wv.initialized, true)
        assert.deepEqual(wv.allowedMetrics, ['LCP'])
    })
})

describe('enabled', () => {
    test('should not be enabled before the remote config', () => {
        const { wv } = start({})
        assert.equal(wv.isEnabled, false)
    })

    test('should be enabled if client config option is enabled', () => {
        const { wv } = start({})
        wv.instance.config.capture_performance = { web_vitals: true }
        assert.equal(wv.isEnabled, true)
    })

    for (const [client, server, expected] of [[undefined, false, false], [undefined, true, true], [false, false, false],
        [false, true, false], [true, false, true], [true, true, true]]) {
        test(`client ${client} and remote ${server}: enabled ${expected}`, () => {
            const { wv } = start({ capture_performance: { web_vitals: client } })
            wv.onRemoteConfig({ capturePerformance: { web_vitals: server } })
            assert.equal(wv.isEnabled, expected)
        })
    }

    test('capture_performance: false disables it even if enabled server-side; true enables it', () => {
        const { wv } = start({ capture_performance: false })
        wv.onRemoteConfig({ capturePerformance: { web_vitals: true } })
        assert.equal(wv.isEnabled, false)
        wv.instance.config.capture_performance = true
        assert.equal(wv.isEnabled, true)
    })

    for (const protocol of ['file', 'chrome-extension', 'capacitor', 'about', 'ws', 'unknown']) {
        test(`should not run on ${protocol}: protocol`, () => {
            setLocation(`${protocol}://localhost/`)
            const { wv } = start({ capture_performance: { web_vitals: true } })
            wv.onRemoteConfig({ capturePerformance: { web_vitals: true } })
            assert.equal(wv.isEnabled, false)
            assert.equal(wv.initialized, false)
        })
    }
    for (const protocol of ['http', 'https']) {
        test(`should run on ${protocol}: protocol`, () => {
            setLocation(`${protocol}://localhost/`)
            const { wv } = start({ capture_performance: { web_vitals: true } })
            assert.equal(wv.isEnabled, true)
        })
    }

    test('does not start while disable_external_dependency_loading is set (upstream cannot load its script)', () => {
        const { wv } = start({ capture_performance: { web_vitals: true }, disable_external_dependency_loading: true })
        assert.equal(wv.isEnabled, true)
        assert.equal(wv.initialized, false)
    })

    test('starts the built-in web-vitals observers when no callbacks are on window', () => {
        const { wv } = start({ capture_performance: { web_vitals: true } })
        assert.equal(wv.initialized, true)
    })
})

describe('soft-navigation metric attribution', () => {
    const initialize = () => {
        const { emit } = injectCallbacks({ flavors: ['web-vitals-soft-navs'] })
        const { ph } = start({ capture_performance: { web_vitals: true, web_vitals_allowed_metrics: ['LCP', 'CLS'], __preview_web_vitals_soft_navs: true, web_vitals_attribution: false }, mask_personal_data_properties: true })
        return { ph, emit }
    }

    test('attributes a delayed metric to its masked navigation URL after the live URL changes', () => {
        setLocation('http://localhost/new')
        const { ph, emit } = initialize()
        emit.LCP({ name: 'LCP', value: 123.45, navigationId: 1, navigationURL: 'http://localhost/old?gclid=secret' })
        emit.CLS({ name: 'CLS', value: 0.1, navigationId: 2, navigationURL: 'http://localhost/new?gclid=secret' })
        mock.timers.tick(DEFAULT_FLUSH_TO_CAPTURE_TIMEOUT_MILLISECONDS + 1)
        const events = webVitalsEvents(ph)
        assert.equal(events.length, 2)
        assert.equal(events[0].properties.$current_url, 'http://localhost/old?gclid=<masked>')
        assert.equal(events[0].properties.$web_vitals_LCP_event.navigationURL, 'http://localhost/old?gclid=<masked>')
        assert.equal(events[0].properties.$web_vitals_LCP_event.$current_url, 'http://localhost/old?gclid=<masked>')
        assert.equal(events[0].properties.$web_vitals_LCP_event.navigationId, 1)
        assert.equal(events[1].properties.$current_url, 'http://localhost/new?gclid=<masked>')
        assert.equal(events[1].properties.$web_vitals_CLS_event.navigationId, 2)
    })

    test('separates buffers by navigation identity even when the navigation URL is unchanged', () => {
        const { ph, emit } = initialize()
        emit.LCP({ name: 'LCP', value: 100, navigationId: 'soft-navigation-10', navigationURL: 'http://localhost/route' })
        emit.CLS({ name: 'CLS', value: 0.1, navigationId: 'soft-navigation-11', navigationURL: 'http://localhost/route' })
        mock.timers.tick(DEFAULT_FLUSH_TO_CAPTURE_TIMEOUT_MILLISECONDS + 1)
        const events = webVitalsEvents(ph)
        assert.equal(events.length, 2)
        assert.equal(events[0].properties.$web_vitals_LCP_event.navigationId, 'soft-navigation-10')
        assert.equal(events[1].properties.$web_vitals_CLS_event.navigationId, 'soft-navigation-11')
    })
})

for (const [mask, custom, maskedUrl] of [
    [false, undefined, 'http://localhost/?gclid=12345&other=true'],
    [true, undefined, 'http://localhost/?gclid=<masked>&other=true'],
    [true, ['other'], 'http://localhost/?gclid=<masked>&other=<masked>'],
]) {
    test(`masks URLs when mask_personal_data_properties is ${mask} and custom_personal_data_properties is ${custom}`, () => {
        setLocation('http://localhost/?gclid=12345&other=true')
        const { emit } = injectCallbacks()
        const { ph, wv } = start({ capture_performance: { web_vitals: true }, mask_personal_data_properties: mask, custom_personal_data_properties: custom })
        wv.onRemoteConfig({ capturePerformance: { web_vitals: true } })
        for (const name of ['LCP', 'CLS', 'FCP', 'INP']) emit[name](metric(name))
        const p = webVitalsEvents(ph)[0].properties
        assert.equal(p.$current_url, maskedUrl)
        for (const name of ['LCP', 'CLS', 'FCP', 'INP']) assert.equal(p[`$web_vitals_${name}_event`].$current_url, maskedUrl)
    })
}

// ---- the web-vitals 6.2.1 port ------------------------------------------------------------
describe('web-vitals port (third_party/web-vitals)', () => {
    test('bindReporter reports on force or reportAllChanges, with delta and rating', () => {
        const reports = []
        const m = { value: -1, delta: 0, rating: 'good' }
        const report = lib.bindReporter((x) => reports.push({ ...x }), m, [2500, 4000])
        report(true)
        assert.equal(reports.length, 0) // negative value: nothing yet
        m.value = 3000
        report()
        assert.equal(reports.length, 0) // not forced
        report(true)
        assert.deepEqual(reports[0], { value: 3000, delta: 3000, rating: 'needs-improvement' })
        report(true)
        assert.equal(reports.length, 1) // no change
        m.value = 4500
        const all = lib.bindReporter((x) => reports.push({ ...x }), m, [2500, 4000], true)
        all()
        assert.deepEqual(reports[1], { value: 4500, delta: 4500, rating: 'poor' })
        const zero = { value: 0, delta: 0, rating: 'good' }
        lib.bindReporter((x) => reports.push({ ...x }), zero, [0.1, 0.25])(true)
        assert.deepEqual(reports[2], { value: 0, delta: 0, rating: 'good' }) // first report even at 0
    })

    test('initMetric shape and the v6 id format', () => {
        const m = lib.initMetric('LCP')
        assert.deepEqual(Object.keys(m), ['name', 'value', 'rating', 'delta', 'entries', 'id', 'navigationType', 'navigationId',
            'navigationInteractionId', 'navigationURL', 'navigationStartTime'])
        assert.equal(m.value, -1)
        assert.equal(m.navigationType, 'navigate')
        assert.equal(m.navigationId, 0)
        assert.equal(m.navigationStartTime, 0)
        assert.match(m.id, /^v6-\d{13}-\d{13}$/)
        const soft = lib.initMetric('CLS', 0, 'soft-navigation', 7, 3, 'http://x/', 12)
        assert.equal(soft.navigationType, 'soft-navigation')
        assert.equal(soft.navigationId, 7)
        assert.equal(soft.navigationInteractionId, 3)
        assert.equal(soft.navigationURL, 'http://x/')
        assert.equal(soft.navigationStartTime, 12)
    })

    test('LayoutShiftManager groups shifts into 1s/5s session windows and ignores input', () => {
        const m = new lib.LayoutShiftManager()
        m.processEntry({ startTime: 0, value: 0.1, hadRecentInput: false })
        m.processEntry({ startTime: 500, value: 0.2, hadRecentInput: false })
        m.processEntry({ startTime: 600, value: 5, hadRecentInput: true })
        assert.ok(Math.abs(m.sessionValue - 0.3) < 1e-9)
        m.processEntry({ startTime: 2000, value: 0.05, hadRecentInput: false }) // > 1s gap: new window
        assert.equal(m.sessionValue, 0.05)
        assert.equal(m.sessionEntries.length, 1)
    })

    test('InteractionManager keeps the 10 longest interactions and merges entries', () => {
        const im = new lib.InteractionManager()
        for (let i = 1; i <= 12; i++) im.processEntry({ interactionId: i, duration: i * 10, startTime: i })
        assert.equal(im.longestInteractionList.length, 10)
        assert.equal(im.longestInteractionList[0].latency, 120)
        assert.equal(im.longestInteractionList[9].latency, 30)
        im.processEntry({ interactionId: 12, duration: 120, startTime: 12 }) // same latency and start: merged
        assert.equal(im.longestInteractionMap.get(12).entries.length, 2)
        im.processEntry({ interactionId: 0, duration: 999, startTime: 0 }) // no interactionId: not a candidate
        assert.equal(im.longestInteractionList[0].latency, 120)
        assert.equal(im.estimateP98LongestInteraction('navigate').latency, 120)
    })

    test('getSelector builds the CSS path up to an id, sorted classes, 100 chars max', () => {
        const node = (nodeName, { id = '', classes = [], parent = null, nodeType = 1 } = {}) => ({ nodeName, id, classList: classes, parentNode: parent, nodeType })
        const doc = { nodeType: 9, nodeName: '#document' }
        const html = node('HTML', { parent: doc })
        const body = node('BODY', { parent: html })
        const main = node('MAIN', { id: 'app', parent: body })
        const btn = node('BUTTON', { classes: ['z', 'a'], parent: main })
        assert.equal(lib.getSelector(btn), '#app>button.a.z')
        assert.equal(lib.getSelector(node('P', { parent: body })), 'html>body>p')
        assert.equal(lib.getSelector(node('#text', { nodeType: 3, parent: main })), '#app>TEXT')
        assert.equal(lib.getSelector(null), '')
        const long = node('DIV', { classes: ['x'.repeat(120)], parent: body })
        assert.equal(lib.getSelector(long), 'div.' + 'x'.repeat(120))
    })

    test('runOnce, storeSoftNavEntry and the ES5 replacements', () => {
        let n = 0
        const once = lib.runOnce(() => n++)
        once(); once()
        assert.equal(n, 1)
        const map = new Map()
        for (let i = 1; i <= 3; i++) lib.storeSoftNavEntry(map, { navigationId: i })
        assert.deepEqual([...map.keys()], [2, 3])
        assert.equal(lib.last([1, 2, 3]), 3)
        assert.equal(lib.last([]), undefined)
        assert.equal(lib.findLast([1, 2, 3, 4], (x) => x % 2), 3)
        assert.equal(lib.find([1, 2, 3, 4], (x) => x > 1), 2)
        assert.equal(lib.checkSoftNavsEnabled({ reportSoftNavs: true }), false) // no soft-navigation support in Node
    })
})
