// Port of upstream posthog-js user-agent and bot-detection specs:
//   packages/browser/src/__tests__/utils/user-agent-utils.test.ts
//   packages/browser/src/__tests__/utils.test.ts (_.info deviceType, isLikelyBot)
//   packages/core/src/utils/bot-detection.spec.ts
//   packages/core/src/utils/webview-app-utils.spec.ts
// Fixtures in test/fixtures/ua-parser-*.json are upstream's copies of the MIT
// licensed ua-parser-js v1 test cases.
// Run: node --test test/user-agent.test.mjs
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

globalThis.window = globalThis.window || { navigator: { userAgent: '' } }

const {
    detectBrowser,
    detectBrowserVersion,
    detectDeviceType,
    detectOS,
    detectWebviewApp,
    DEFAULT_BLOCKED_UA_STRS,
    isBlockedUA,
    isLikelyBot,
    resetBotDetectionCacheForTests,
} = await import('../src/core/user-agent.js')

const fixture = (name) => JSON.parse(readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8'))
const uaParserDeviceTestCases = fixture('ua-parser-device.json')
const uaParserOSTestCases = fixture('ua-parser-os.json')

describe('user-agent-utils', () => {
    // can use https://user-agents.net/ or $raw_user_agent property on events to get new test cases
    const browserTestcases = [
        {
            name: 'Chrome 91 on Windows',
            userAgent:
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            vendor: '',
            expectedVersion: 91.0,
            expectedBrowser: 'Chrome',
        },
        {
            name: 'Chrome 112 on mac',
            userAgent:
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36',
            expectedVersion: 112.0,
            expectedBrowser: 'Chrome',
        },
        {
            name: 'Claude desktop browser on mac',
            userAgent:
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_4) AppleWebKit/537.36 (KHTML, like Gecko) Claude/1.2.3 Chrome/140.0.0.0 Safari/537.36',
            expectedVersion: 1.2,
            expectedBrowser: 'Claude',
        },
        {
            name: 'Codex desktop browser on mac',
            userAgent:
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_4) AppleWebKit/537.36 (KHTML, like Gecko) Codex/2.3.4 Chrome/140.0.0.0 Safari/537.36',
            expectedVersion: 2.3,
            expectedBrowser: 'Codex',
        },
        {
            name: 'ChatGPT desktop browser on mac',
            userAgent:
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_4) AppleWebKit/537.36 (KHTML, like Gecko) ChatGPT/3.4.5 Chrome/140.0.0.0 Safari/537.36',
            expectedVersion: 3.4,
            expectedBrowser: 'ChatGPT',
        },
        {
            // ChatGPT on Windows uses a `1.YYYY.WW` scheme, unlike its other platforms
            name: 'ChatGPT desktop browser on windows',
            userAgent:
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ChatGPT/1.2026.190 Chrome/140.0.0.0 Safari/537.36',
            expectedVersion: 1.2026,
            expectedBrowser: 'ChatGPT',
        },
        {
            name: 'Chrome 111 on Linux',
            userAgent:
                'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36',

            expectedVersion: 111.0,
            expectedBrowser: 'Chrome',
        },
        {
            name: 'Chrome 16 on Android',
            userAgent:
                'Mozilla/5.0 (Linux; U; Android-4.0.3; en-us; Galaxy Nexus Build/IML74K) AppleWebKit/535.7 (KHTML, like Gecko) CrMo/16.0.912.75 Mobile Safari/535.7',
            expectedVersion: 16.0,
            expectedBrowser: 'Chrome',
        },
        {
            name: 'Chrome 21 iOS',
            userAgent:
                'Mozilla/5.0 (iPhone; U; CPU iPhone OS 5_1_1 like Mac OS X; en) AppleWebKit/534.46.0 (KHTML, like Gecko) CriOS/21.0.1180.82 Mobile/9B206 Safari/7534.48.3',
            vendor: '',
            expectedVersion: 21.0,
            expectedBrowser: 'Chrome iOS',
        },
        {
            name: 'Firefox 89',
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0',
            vendor: '',
            expectedVersion: 89.0,
            expectedBrowser: 'Firefox',
        },
        {
            name: 'unknown browser',
            userAgent: 'UnknownBrowser/5.0',
            vendor: '',
            expectedVersion: null,
            expectedBrowser: '',
        },
        {
            name: 'invalid chrome',
            userAgent:
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari/537.36',
            vendor: '',
            expectedVersion: null,
            expectedBrowser: 'Chrome',
        },
        {
            name: 'Internet Explorer Mobile',
            userAgent:
                'Mozilla/5.0 (Windows Phone 8.1; ARM; Trident/7.0; Touch; rv:11.0; IEMobile/11.0; NOKIA; 909) like Gecko',
            vendor: '',
            expectedVersion: 11.0,
            expectedBrowser: 'Internet Explorer Mobile',
        },
        {
            name: 'Microsoft Edge 44',
            userAgent:
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/44.17763.831.0',
            vendor: '',
            expectedVersion: 44.17763,
            expectedBrowser: 'Microsoft Edge',
        },
        {
            name: 'UC Browser',
            userAgent:
                'Mozilla/5.0 (Linux; U; Android 4.2.2; en-US; Micromax A116 Build/JDQ39) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 UCBrowser/10.7.5.658 U3/0.8.0 Mobile Safari/534.30',
            vendor: '',
            expectedVersion: 10.7,
            expectedBrowser: 'UC Browser',
        },
        {
            name: 'Safari',
            userAgent:
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
            vendor: 'Apple',
            expectedVersion: 17.1,
            expectedBrowser: 'Safari',
        },
        {
            name: 'Opera',
            userAgent:
                'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/47.0.2526.69 Safari/537.36 OPR/34.0.2036.25',
            vendor: '',
            expectedVersion: 34.0,
            expectedBrowser: 'Opera',
        },
        {
            name: 'Firefox iOS',
            userAgent:
                'Mozilla/5.0 (iPhone; CPU iPhone OS 10_3 like Mac OS X) AppleWebKit/602.1.50 (KHTML, like Gecko) FxiOS/8.3b5826 Mobile/14E5239e Safari/602.1.50',
            vendor: '',
            expectedVersion: 8.3,
            expectedBrowser: 'Firefox iOS',
        },
        {
            name: 'Konqueror (lowercase)',
            userAgent: 'Mozilla/5.0 (X11; U; U; DragonFly amd64) KIO/5.97 konqueror/22.08.0',
            vendor: '',
            expectedVersion: 22.08,
            expectedBrowser: 'Konqueror',
        },
        {
            name: 'Konqueror (uppercase)',
            userAgent: 'Mozilla/5.0 (X11; Linux i686) KHTML/5.20 (like Gecko) Konqueror/5.20',
            vendor: '',
            expectedVersion: 5.2,
            expectedBrowser: 'Konqueror',
        },
        {
            name: 'BlackBerry Bold 9790',
            userAgent:
                'Mozilla/5.0 (BlackBerry; U; BlackBerry 9790; es) AppleWebKit/534.11+ (KHTML, like Gecko) Version/7.1.0.569 Mobile Safari/534.11+',
            vendor: '',
            // TODO should we match 9790 the model and not 7.1 the browser version?
            expectedVersion: 9790,
            expectedBrowser: 'BlackBerry',
        },
        {
            name: 'BlackBerry BB10 version v10.1',
            userAgent:
                'Mozilla/5.0 (BB10; Kbd) AppleWebKit/537.10+ (KHTML, like Gecko) Version/10.1.0.1720 Mobile Safari/537.10+',
            vendor: '',
            expectedVersion: 10.1,
            expectedBrowser: 'BlackBerry',
        },
        {
            name: 'Samsung Internet',
            userAgent:
                'Mozilla/5.0 (Linux; Android 5.0.2; SAMSUNG SM-T550 Build/LRX22G) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/3.5 Chrome/38.0.2125.102 Safari/537.36',
            vendor: '',
            expectedVersion: 3.5,
            expectedBrowser: 'Samsung Internet',
        },
        {
            name: 'Internet Explorer',
            userAgent: 'Mozilla/5.0 (compatible; MSIE 10.0; Windows NT 6.2; Trident/6.0)',
            vendor: '',
            expectedVersion: 10.0,
            expectedBrowser: 'Internet Explorer',
        },
        {
            name: 'mobile safari (with vendor)',
            userAgent:
                'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
            vendor: 'Apple',
            expectedVersion: 16.6,
            expectedBrowser: 'Mobile Safari',
        },
        {
            name: 'mobile safari (without vendor)',
            userAgent:
                'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
            vendor: '', // vendor is deprecated, and we see this user agent not matching in the wild
            expectedVersion: 16.6,
            expectedBrowser: 'Mobile Safari',
        },
        {
            name: 'firefox for ios',
            userAgent:
                'Mozilla/5.0 (iPhone; CPU iPhone OS 15_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/106.0 Mobile/15E148 Safari/605.1.15',
            vendor: '',
            expectedVersion: 106.0,
            expectedBrowser: 'Firefox iOS',
        },
        {
            name: 'Android Browser on Galaxy Nexus',
            userAgent:
                'Mozilla/5.0 (Linux; U; Android 4.0.2; en-us; Galaxy Nexus Build/ICL53F) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30',
            expectedVersion: 4.0,
            expectedBrowser: 'Android Mobile',
        },
        {
            name: 'Chrome Browser on Galaxy S3',
            userAgent:
                'Mozilla/5.0 (Linux; Android 4.4.4; en-us; SAMSUNG GT-I9300I Build/KTU84P) AppleWebKit/537.36 (KHTML, like Gecko) Version/1.5 Chrome/28.0.1500.94 Mobile Safari/537.36',
            expectedVersion: 28.0,
            expectedBrowser: 'Chrome',
        },
        {
            // see https://github.com/PostHog/posthog-js/issues/3574
            // Oculus Browser is Chromium-based, so its UA includes both
            // `OculusBrowser` and `Chrome` (and on newer headsets also `SamsungBrowser`).
            name: 'Oculus Browser on Quest 2',
            userAgent:
                'Mozilla/5.0 (X11; Linux x86_64; Quest 2) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/27.0.0.4.7.391926553 SamsungBrowser/4.0 Chrome/100.0.4896.58 VR Safari/537.36',
            vendor: '',
            expectedVersion: 27.0,
            expectedBrowser: 'Oculus Browser',
        },
        {
            name: 'Oculus Browser on Quest 3 (no SamsungBrowser segment)',
            userAgent:
                'Mozilla/5.0 (Linux; Android 12; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/30.0.0.5.10 Chrome/119.0.6045.193 VR Safari/537.36',
            vendor: '',
            expectedVersion: 30.0,
            expectedBrowser: 'Oculus Browser',
        },
        {
            name: 'Vivaldi on macOS',
            userAgent:
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Vivaldi/6.5.3206.63',
            vendor: 'Google Inc.',
            expectedVersion: 6.5,
            expectedBrowser: 'Vivaldi',
        },
        {
            name: 'Vivaldi on Windows',
            userAgent:
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36 Vivaldi/6.4.3160.42',
            vendor: 'Google Inc.',
            expectedVersion: 6.4,
            expectedBrowser: 'Vivaldi',
        },
        {
            name: 'Yandex Browser on Windows',
            userAgent:
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 YaBrowser/23.5.0.2271 Yowser/2.5 Safari/537.36',
            vendor: 'Google Inc.',
            expectedVersion: 23.5,
            expectedBrowser: 'Yandex',
        },
        {
            name: 'Naver Whale on macOS',
            userAgent:
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Whale/3.21.192.18 Safari/537.36',
            vendor: 'Google Inc.',
            expectedVersion: 3.21,
            expectedBrowser: 'Whale',
        },
        {
            name: 'DuckDuckGo Browser on iOS (Ddg marker)',
            userAgent:
                'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Ddg/7.85.0 Mobile/15E148 Safari/605.1.15',
            vendor: 'Apple Computer, Inc.',
            expectedVersion: 7.85,
            expectedBrowser: 'DuckDuckGo',
        },
        {
            name: 'DuckDuckGo Browser on Android',
            userAgent:
                'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile DuckDuckGo/5 Safari/537.36',
            vendor: 'Google Inc.',
            expectedVersion: 5,
            expectedBrowser: 'DuckDuckGo',
        },
        {
            name: 'Pale Moon on Windows',
            userAgent:
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:102.0) Gecko/20100101 Goanna/6.5 Firefox/102.0 PaleMoon/33.0.1',
            vendor: '',
            expectedVersion: 33.0,
            expectedBrowser: 'Pale Moon',
        },
        {
            name: 'Waterfox on Linux (classic numeric version)',
            userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:78.0) Gecko/20100101 Firefox/78.0 Waterfox/56.2.14',
            vendor: '',
            expectedVersion: 56.2,
            expectedBrowser: 'Waterfox',
        },
        {
            name: 'Waterfox G on Windows (no version match, but browser still recognised)',
            userAgent:
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:115.0) Gecko/20100101 Firefox/115.0 Waterfox/G6.0.13',
            vendor: '',
            // Waterfox G stamps a non-numeric "G" prefix; we still identify the browser
            // but can't pull a major version from it.
            expectedVersion: null,
            expectedBrowser: 'Waterfox',
        },
        {
            // Brave on iOS is the only Brave build that stamps itself into the UA
            // (desktop / Android Brave deliberately hide). Must be detected without
            // hints because WebKit doesn't ship `navigator.brave`.
            name: 'Brave on iOS (UA marker, no hints)',
            userAgent:
                'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1 Brave/1.51',
            vendor: 'Apple Computer, Inc.',
            expectedVersion: 1.51,
            expectedBrowser: 'Brave',
        },
    ]

    for (const tc of browserTestcases) {
        test(`browser version ${tc.name}`, () => {
            assert.equal(detectBrowserVersion(tc.userAgent, tc.vendor), tc.expectedVersion)
        })
        test(`browser ${tc.name}`, () => {
            assert.equal(detectBrowser(tc.userAgent, tc.vendor), tc.expectedBrowser)
        })
    }

    // ua-parser-js v1 test cases (smarttv/wearable/embedded excluded, as upstream)
    for (const testCase of uaParserDeviceTestCases.filter(
        (tc) => !tc['//'] && !['smarttv', 'wearable', 'embedded'].includes(tc['expect']['type'])
    )) {
        test(`device - ${testCase['ua']}`, () => {
            const actual = detectDeviceType(testCase['ua']).toLowerCase()
            const expected =
                testCase['expect']['type'] === undefined || testCase['expect']['type'] === 'undefined'
                    ? 'desktop'
                    : testCase['expect']['type']
            assert.equal(actual, expected)
        })
    }

    for (const testCase of uaParserOSTestCases.filter((tc) => !tc['//'])) {
        test(`OS - ${testCase['ua']}`, () => {
            const expected = testCase['expect']
            assert.deepEqual(detectOS(testCase['ua']), [expected.os_name, expected.os_version])
        })
    }

    test('can rely on vendor string to detect safari', () => {
        const ua = 'Mozilla/5.0 (darwin) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/16.7.0'
        assert.equal(detectBrowser(ua, 'Apple Computer, Inc.'), 'Safari')
    })

    const chromeMacOsUA =
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    const braveIosUA =
        'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1 Brave/1.51'

    describe('detectBrowser with out-of-band hints', () => {
        const cases = [
            ['falls back to Chrome when no hints are provided', chromeMacOsUA, 'Google Inc.', undefined, 'Chrome'],
            ['falls back to Chrome when hints are empty', chromeMacOsUA, 'Google Inc.', {}, 'Chrome'],
            ['detects desktop / Android Brave via the `brave` hint', chromeMacOsUA, 'Google Inc.', { brave: true }, 'Brave'],
            ['hint takes precedence over UA sniffing', chromeMacOsUA, 'Google Inc.', { brave: true }, 'Brave'],
            ['does not affect Brave-on-iOS detection', braveIosUA, 'Apple Computer, Inc.', undefined, 'Brave'],
        ]
        for (const [name, ua, vendor, hints, expected] of cases) {
            test(name, () => assert.equal(detectBrowser(ua, vendor, hints), expected))
        }
    })

    describe('detectBrowserVersion with out-of-band hints', () => {
        const cases = [
            ['returns null for desktop / Android Brave', chromeMacOsUA, 'Google Inc.', { brave: true }, null],
            ['reads Brave-on-iOS version from the UA marker', braveIosUA, 'Apple Computer, Inc.', undefined, 1.51],
            ['preserves UA-based version when hints are absent', chromeMacOsUA, 'Google Inc.', undefined, 120.0],
        ]
        for (const [name, ua, vendor, hints, expected] of cases) {
            test(name, () => assert.equal(detectBrowserVersion(ua, vendor, hints), expected))
        }
    })

    describe('detectBrowser Google Search App (GSA)', () => {
        const gsaIosUA =
            'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/284.0.564099828 Mobile/15E148 Safari/604.1'
        const gsaAndroidUA =
            'Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36 GSA/14.21.20.28.arm64'
        const browserCases = [
            ['off by default, iOS GSA reads as Mobile Safari', gsaIosUA, 'Apple Computer, Inc.', undefined, 'Mobile Safari'],
            ['off by default, Android GSA reads as Chrome', gsaAndroidUA, 'Google Inc.', undefined, 'Chrome'],
            ['opted in, detects iOS GSA', gsaIosUA, 'Apple Computer, Inc.', { detectGoogleSearchApp: true }, 'Google Search App'],
            ['opted in, detects Android GSA', gsaAndroidUA, 'Google Inc.', { detectGoogleSearchApp: true }, 'Google Search App'],
            ['opted in, leaves non-GSA traffic untouched', chromeMacOsUA, 'Google Inc.', { detectGoogleSearchApp: true }, 'Chrome'],
        ]
        for (const [name, ua, vendor, options, expected] of browserCases) {
            test(`detectBrowser: ${name}`, () => assert.equal(detectBrowser(ua, vendor, {}, options), expected))
        }
        const versionCases = [
            ['iOS', gsaIosUA, 'Apple Computer, Inc.', 284.0],
            ['Android', gsaAndroidUA, 'Google Inc.', 14.21],
        ]
        for (const [platform, ua, vendor, expected] of versionCases) {
            test(`detectBrowserVersion: reads the GSA version from the ${platform} UA marker when opted in`, () => {
                assert.equal(detectBrowserVersion(ua, vendor, {}, { detectGoogleSearchApp: true }), expected)
            })
        }
    })

    describe('detectDeviceType with options', () => {
        const desktopUA =
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
        const cases = [
            ['Tablet: desktop UA + Android platform + touch + tablet screen',
                { userAgentDataPlatform: 'Android', maxTouchPoints: 5, screenWidth: 1280, screenHeight: 800 }, 'Tablet'],
            ['Mobile: desktop UA + Android platform + touch + phone screen',
                { userAgentDataPlatform: 'Android', maxTouchPoints: 5, screenWidth: 412, screenHeight: 915 }, 'Mobile'],
            ['Mobile: desktop UA + Android platform + touch + high DPR phone screen',
                { userAgentDataPlatform: 'Android', maxTouchPoints: 5, screenWidth: 1200, screenHeight: 800, devicePixelRatio: 2 }, 'Mobile'],
            ['Desktop: desktop UA + no options (backwards compat)', undefined, 'Desktop'],
            ['Desktop: desktop UA + Linux platform + touch', { userAgentDataPlatform: 'Linux', maxTouchPoints: 5 }, 'Desktop'],
        ]
        for (const [name, options, expected] of cases) {
            test(name, () => assert.equal(detectDeviceType(desktopUA, options), expected))
        }
    })

    describe('osVersion', () => {
        const osVersions = [
            ['Mozilla/5.0 (Mobile; Windows Phone 8.1; Android 4.0; ARM; Trident/7.0; Touch; rv:11.0; IEMobile/11.0; NOKIA; Lumia 635; BOOST) like iPhone OS 7_0_3 Mac OS X AppleWebKit/537 (KHTML, like Gecko) Mobile Safari/537', 'Windows Phone', ''],
            ['Mozilla/5.0 (Windows NT 6.3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/38.0.2125.122 Safari/537.36', 'Windows', '8.1'],
            ['Mozilla/5.0 (iPhone; CPU iPhone OS 8_2 like Mac OS X) AppleWebKit/600.1.4 (KHTML, like Gecko) CriOS/44.0.2403.67 Mobile/12D508 Safari/600.1.4', 'iOS', '8.2.0'],
            ['Mozilla/5.0 (iPad; CPU OS 8_4 like Mac OS X) AppleWebKit/600.1.4 (KHTML, like Gecko) Version/8.0 Mobile/12H143 Safari/600.1.4', 'iOS', '8.4.0'],
            ['Mozilla/5.0 (Linux; Android 4.4.2; Lenovo A7600-F Build/KOT49H) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/44.0.2403.133 Safari/537.36', 'Android', '4.4.2'],
            ['Mozilla/5.0 (BlackBerry; U; BlackBerry 9300; es) AppleWebKit/534.8+ (KHTML, like Gecko) Version/6.0.0.480 Mobile Safari/534.8+', 'BlackBerry', ''],
            ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_9_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/43.0.2357.130 Safari/537.36', 'Mac OS X', '10.9.5'],
            ['Opera/9.80 (Linux armv7l; InettvBrowser/2.2 (00014A;SonyDTV140;0001;0001) KDL40W600B; CC/MEX) Presto/2.12.407 Version/12.50', 'Linux', ''],
            ['Mozilla/5.0 (X11; CrOS armv7l 6680.81.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/41.0.2272.118 Safari/537.36', 'Chrome OS', ''],
        ]
        for (const [ua, osName, osVersion] of osVersions) {
            test(`osVersion ${osName} ${osVersion} - ${ua}`, () => assert.deepEqual(detectOS(ua), [osName, osVersion]))
        }
    })

    // from packages/browser/src/__tests__/utils.test.ts ('_.info deviceType')
    describe('_.info deviceType', () => {
        const deviceTypes = [
            ['iPad', 'Mozilla/5.0 (iPad; CPU OS 6_0 like Mac OS X) AppleWebKit/536.26 (KHTML, like Gecko) Version/6.0 Mobile/10A5355d Safari/8536.25', 'Tablet'],
            ['Samsung tablet', 'Mozilla/5.0 (Linux; Android 7.1.1; SM-T555 Build/NMF26X; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/83.0.4103.96 Safari/537.36', 'Tablet'],
            ['Windows Chrome', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/74.0.3729.157 Safari/537.36', 'Desktop'],
            ['Mac Safari', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_9_3) AppleWebKit/537.75.14 (KHTML, like Gecko) Version/7.0.3 Safari/7046A194A', 'Desktop'],
            ['iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 13_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.4 Mobile/15E148 Safari/604.1', 'Mobile'],
            ['LG Android', 'Mozilla/5.0 (Linux; Android 6.0; LG-H631 Build/MRA58K) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/38.0.2125.102 Mobile Safari/537.36', 'Mobile'],
        ]
        for (const [name, ua, expected] of deviceTypes) {
            test(`deviceType ${name}`, () => assert.equal(detectDeviceType(ua), expected))
        }
    })
})

// packages/core/src/utils/webview-app-utils.spec.ts
describe('detectWebviewApp', () => {
    const androidUA =
        'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230805.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.230 Mobile Safari/537.36'
    const iosUA =
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
    const detects = [
  ['Facebook iOS', iosUA + ' [FBIOS;FBAV/440.0.0.35.117;]', 'Facebook', '440.0.0.35.117'],
  ['Facebook Android', androidUA + ' [FBAN/FB4A;FBAV/440.0.0.35.117;]', 'Facebook', '440.0.0.35.117'],
  ['Facebook IAB', androidUA + ' [FB_IAB/FB4A;FBAV/440.0.0.35.117;]', 'Facebook', '440.0.0.35.117'],
  ['Instagram iOS', iosUA + ' Instagram 300.0.0.17.109 (iPhone14,5; iOS 17_1; en_US)', 'Instagram', '300.0.0.17.109'],
  [
    'Instagram Android',
    androidUA + ' Instagram 300.0.0.17.109 Android (33/13; 420dpi)',
    'Instagram',
    '300.0.0.17.109',
  ],
  ['LinkedIn iOS', iosUA + ' [LinkedInApp]', 'LinkedIn', ''],
  ['LinkedIn Android', androidUA + ' LinkedInApp/2.295.106', 'LinkedIn', '2.295.106'],
  ['LinkedIn bracketed version', iosUA + ' [LinkedInApp]/2.295.106', 'LinkedIn', '2.295.106'],
  ['Twitter', iosUA + ' Twitter for iPhone/10.1', 'Twitter', '10.1'],
  ['TikTok', iosUA + ' musical_ly_35.1.0', 'TikTok', '35.1.0'],
  ['WeChat', androidUA + ' MicroMessenger/8.0.40.2420', 'WeChat', '8.0.40.2420'],
  ['LINE', iosUA + ' Line/14.1.0', 'Line', '14.1.0'],
  ['Google iOS', iosUA + ' GSA/315.0.630435', 'Google', '315.0.630435'],
  ['Google Android', androidUA + ' GSA/15.1.2.28.arm64', 'Google', '15.1.2.28'],
  ['Pinterest iOS', iosUA + ' [Pinterest/iOS]', 'Pinterest', ''],
  ['Pinterest Android', androidUA + ' [Pinterest/Android]', 'Pinterest', ''],
  ['Facebook without version', iosUA + ' [FBIOS]', 'Facebook', ''],
  ['Instagram without version', iosUA + ' Instagram', 'Instagram', ''],
  [
    'Instagram with Facebook markers',
    iosUA + ' Instagram 300.0.0 [FBAN/Instagram;FBAV/1.0;]',
    'Instagram',
    '300.0.0',
  ],
  ['Facebook malformed version', iosUA + ' [FBIOS;FBAV/unknown;]', 'Facebook', ''],
    ]
    for (const [name, userAgent, app, version] of detects) {
        test(`detects ${name}`, () => assert.deepEqual(detectWebviewApp(userAgent), [app, version]))
    }
    // Marker/version combinations from upstream fixtures (ua-parser-js, matomo device-detector)
    const additional = [
  ['TikTok trill iOS', iosUA + ' trill_43.0.0 BytedanceWebview/d8a21c6', 'TikTok', '43.0.0'],
  [
    'TikTok build number',
    androidUA + ' musical_ly_2022803040 AppName/musical_ly app_version/28.3.4',
    'TikTok',
    '28.3.4',
  ],
  [
    'TikTok trill build number',
    androidUA + ' trill_2022109040 AppName/musical_ly app_version/21.9.4',
    'TikTok',
    '21.9.4',
  ],
  ['TikTok trill app name', androidUA + ' AppName/trill app_version/21.9.4', 'TikTok', '21.9.4'],
  ['TikTok explicit version wins', androidUA + ' musical_ly_28.0.0 app_version/28.3.4', 'TikTok', '28.3.4'],
  ['TikTok build only', androidUA + ' musical_ly_2022803040', 'TikTok', ''],
  ['TikTok malformed explicit version', iosUA + ' trill_43.0.0 app_version/unknown', 'TikTok', '43.0.0'],
  ['Twitter Android', androidUA + ' TwitterAndroid', 'Twitter', ''],
  ['Twitter Android version', androidUA + ' TwitterAndroid/10.34', 'Twitter', '10.34'],
  ['WhatsApp Android', androidUA + ' WA4A/2.26.30.97', 'WhatsApp', '2.26.30.97'],
  ['WhatsApp iOS', iosUA + ' [WAiOS/2.26.31]', 'WhatsApp', '2.26.31'],
  ['Snapchat', iosUA + ' Snapchat/12.33.0.36 (like Safari/8614.1.25.0.31, panda)', 'Snapchat', '12.33.0.36'],
  ['Bing iOS', iosUA + ' BingSapphire/31.8.430522001', 'Bing', '31.8.430522001'],
  ['Bing Android', androidUA + ' BingWeb/6.9.12', 'Bing', '6.9.12'],
  ['Messenger iOS', iosUA + ' [FBAN/MessengerForiOS;FBAV/132.0.0.41.90;]', 'Messenger', '132.0.0.41.90'],
  ['Messenger Android', androidUA + ' [FBAN/Orca-Android;FBAV/440.0.0;]', 'Messenger', '440.0.0'],
  ['Messenger Android IAB', androidUA + ' [FB_IAB/Orca-Android;FBAV/440.0.0;]', 'Messenger', '440.0.0'],
  ['Messenger before Facebook', iosUA + ' [FBIOS;FBAN/MessengerForiOS;FBAV/132.0.0;]', 'Messenger', '132.0.0'],
  ['Messenger without version', iosUA + ' [FBAN/MessengerForiOS;]', 'Messenger', ''],
  ['Facebook Lite', androidUA + ' [FBAN/EMA;FBAV/440.0.0;]', 'Facebook Lite', '440.0.0'],
  ['Threads', iosUA + ' Barcelona/300.0.0.17.109', 'Threads', '300.0.0.17.109'],
  ['WeChat alternative', iosUA + ' WeChat/8.0.40', 'WeChat', '8.0.40'],
  ['Pinterest iOS version', iosUA + ' Pinterest for iOS/7.11 (iPhone7,2; 12.1.4)', 'Pinterest', '7.11'],
  ['Pinterest Android version', androidUA + ' Pinterest for Android/9.0.4 (K83CA; 9)', 'Pinterest', '9.0.4'],
  ['Pinterest tablet version', androidUA + ' Pinterest for Android Tablet/9.0.4', 'Pinterest', '9.0.4'],
  ['Pinterest version', iosUA + ' Pinterest/9.0.4', 'Pinterest', '9.0.4'],
  ['Naver Android', androidUA + ' NAVER(inapp; search; 1010; 11.11.2)', 'Naver', '11.11.2'],
  ['Naver iOS', iosUA + ' NAVER(inapp; search; 720; 10.25.0; 11PRO)', 'Naver', '10.25.0'],
  ['KakaoTalk iOS', iosUA + ' BizWebView KAKAOTALK 9.7.6', 'KakaoTalk', '9.7.6'],
  ['KakaoTalk Android build only', androidUA + ';KAKAOTALK 2409760', 'KakaoTalk', ''],
  ['KakaoTalk slash version', iosUA + ' KakaoTalk/9.7.6', 'KakaoTalk', '9.7.6'],
    ]
    for (const [name, userAgent, app, version] of additional) {
        test(`detects additional marker: ${name}`, () => assert.deepEqual(detectWebviewApp(userAgent), [app, version]))
    }
    const negatives = [
  '',
  androidUA, // A generic WebView does not identify its host app.
  iosUA,
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  iosUA + ' Version/17.1 Safari/604.1',
  'Mozilla/5.0 (compatible; Pinterestbot/1.0; +http://www.pinterest.com/bot.html)',
  'LinkedInBot/1.0',
  'Twitterbot/1.0',
  'facebookexternalhit/1.1',
  'WhatsApp/2.26.31', // Generic WhatsApp UAs can be link-preview requests.
  'bingbot/2.0',
  androidUA + ' BytedanceWebview/d8a21c6', // Shared engine, not a TikTok app marker.
  androidUA + ' app_version/28.3.4',
  androidUA + ' NotSnapchat/1.0',
  androidUA + ' NotWA4A/1.0',
  androidUA + ' NotBingWeb/1.0',
  androidUA + ' NAVER(inapp; naverdicapp; 1; 2.0)', // A different Naver app.
  androidUA + ' WeChatShareExtensionNew/8.0.40',
  androidUA + ' NotInstagram/1.0',
  androidUA + ' NotLine/1.0',
    ]
    for (const userAgent of negatives) {
        test(`does not infer a host app from ${userAgent}`, () => assert.deepEqual(detectWebviewApp(userAgent), ['', '']))
    }
})

// packages/core/src/utils/bot-detection.spec.ts
describe('bot-detection', () => {
    beforeEach(() => {
        resetBotDetectionCacheForTests()
    })

    const REAL_CHROME_UAS = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.7499.193 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.199 Safari/537.36',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/123.0.6312.122 Mobile/15E148 Safari/604.1',
        'Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.162 Mobile Safari/537.36',
        // Chrome 154 and 155 stable — released 2026-09.
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.8037.58 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.8059.12 Safari/537.36',
    ]

    test('DEFAULT_BLOCKED_UA_STRS contains at least 50 entries', () => {
        assert.ok(DEFAULT_BLOCKED_UA_STRS.length > 50)
    })

    test('DEFAULT_BLOCKED_UA_STRS contains critical entries', () => {
        for (const s of ['googlebot', 'headlesschrome', 'bot/']) {
            assert.ok(DEFAULT_BLOCKED_UA_STRS.includes(s), s)
        }
    })

    test('isBlockedUA returns false for undefined ua', () => {
        assert.equal(isBlockedUA(undefined), false)
    })

    for (const ua of REAL_CHROME_UAS) {
        test(`isBlockedUA returns false for real Chrome UA ${ua}`, () => assert.equal(isBlockedUA(ua), false))
    }

    for (const ua of [
        'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Mozilla/5.0 bingbot/2.0',
        'headlessChrome/119.0',
    ]) {
        test(`isBlockedUA returns true for known bot substring ${ua}`, () => assert.equal(isBlockedUA(ua), true))
    }

    for (const ua of ['Lightpanda/1.0', 'lightpanda/2.3.4', 'LIGHTPANDA/10.0', 'Mozilla/5.0 (compatible; Lightpanda/1.0)']) {
        test(`blocks the self-declared headless browser ${ua}`, () => assert.equal(isBlockedUA(ua), true))
    }

    test('is case-insensitive on the UA input', () => {
        const bot = 'Mozilla/5.0 (compatible; Googlebot/2.1)'
        assert.equal(isBlockedUA(bot), true)
        assert.equal(isBlockedUA(bot.toLowerCase()), true)
        assert.equal(isBlockedUA(bot.toUpperCase()), true)
    })

    test('accepts customBlockedUserAgents', () => {
        assert.equal(isBlockedUA('custombot', ['custombot']), true)
        assert.equal(isBlockedUA('custombot', []), false)
    })

    test('memoization: same result on repeated calls with identical inputs', () => {
        const ua = REAL_CHROME_UAS[0]
        assert.equal(isBlockedUA(ua), isBlockedUA(ua))
    })

    test('memoization: cache is bucketed per customBlockedUserAgents list', () => {
        const ua = 'Mozilla/5.0 custombot'
        assert.equal(isBlockedUA(ua, []), false)
        assert.equal(isBlockedUA(ua, ['custombot']), true)
        assert.equal(isBlockedUA(ua, []), false)
    })

    test('memoization: reset wipes the cache', () => {
        isBlockedUA(REAL_CHROME_UAS[0])
        resetBotDetectionCacheForTests()
        assert.equal(isBlockedUA(REAL_CHROME_UAS[0]), false)
    })

    test('memoization: handles a burst of many distinct UAs without breaking correctness', () => {
        for (let i = 0; i < 500; i++) {
            assert.equal(isBlockedUA(`Mozilla/5.0 (burst-${i}) AppleWebKit/537.36`), false)
        }
        // still correct after the cache was dropped (size cap 256)
        assert.equal(isBlockedUA('Mozilla/5.0 (compatible; Googlebot/2.1)'), true)
    })

    test('cache-key delimiter injection does not collide', () => {
        const ua = 'MyAgent/1.0'
        assert.equal(isBlockedUA(ua, ['foo:1', 'bar']), false)
        assert.equal(isBlockedUA(ua, ['foo', '1:bar']), false)
    })
})

// packages/browser/src/__tests__/utils.test.ts ('isLikelyBot')
describe('isLikelyBot', () => {
    const userAgentFor = (botString) => `Mozilla/5.0 (compatible; ${botString}/1.0; +https://example.com/client)`

    test('only blocks a custom marker when configured', () => {
        const navigator = { userAgent: userAgentFor('testington') }
        assert.equal(isLikelyBot(navigator, undefined), false)
        assert.equal(isLikelyBot(navigator, ['unrelated-marker']), false)
        assert.equal(isLikelyBot(navigator, ['testington']), true)
        assert.equal(isLikelyBot({ userAgent: userAgentFor('ordinary-client') }, ['testington']), false)
    })

    for (const botString of DEFAULT_BLOCKED_UA_STRS.concat('testington')) {
        test(`blocks a bot based on the user agent ${botString}`, () => {
            assert.equal(isLikelyBot({ userAgent: userAgentFor(botString) }, ['testington']), true)
        })
    }

    const botUAs = [
        [
            'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/W.X.Y.Z Safari/537.36',
        ],
        ['AhrefsSiteAudit (Desktop) - Mozilla/5.0 (compatible; AhrefsSiteAudit/6.1; +http://ahrefs.com/robot/)'],
        ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.0; +https://openai.com/gptbot)'],
        [
            'Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)',
        ],
        [
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.6422.175 Safari/537.36 (compatible; Google-HotelAdsVerifier/2.0)',
        ],
        [
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/122.0.0.0 Safari/537.36',
        ],
        [
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Cypress/13.6.3 Chrome/114.0.5735.289 Electron/25.8.4 Safari/537.36',
        ],
        [
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4590.2 Safari/537.36 Chrome-Lighthouse',
        ],
        [
            'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
        ],
        ['Lightpanda/1.0'],
        ['Lightpanda/2.3.4'],
        ['Buck/2.4.2; (+https://app.hypefactors.com/media-monitoring/about.html)'],

        ['op3-fetcher/1.0 (bot; https://op3.dev)'],
        ['ZoomBot (Linkbot 1.0 http://suite.seozoom.it/bot.html)'],
        ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)'],
        [
            'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.6943.53 Mobile Safari/537.36 (compatible; AdsBot-Google-Mobile; +http://www.google.com/mobile/adsbot.html)',
        ],
        [
            'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexitybot-user)',
        ],
        ['Mozilla/5.0 (compatible; DotBot/1.2; +https://opensiteexplorer.org/dotbot; help@moz.com)'],
        [
            'Mozilla/5.0 (compatible; archive.org_bot +http://archive.org/details/archive.org_bot) Zeno/002a12a warc/v0.8.70',
        ],
        ['Mozilla/5.0 (compatible; DataForSeoBot/1.0; +https://dataforseo.com/dataforseo-bot)'],
        ['Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)'],
        ['Mozilla/5.0 +https://podfollow.com/crawling podfollowbot/1.0'],
        ['meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)'],
        ['Mozilla/5.0 +https://chartable.com/crawler Trackable/0.1'],
        ['Mozilla/5.0 (compatible; SnapchatAds/1.0; +https://businesshelp.snapchat.com/s/article/adsbot-crawler)'],
        [
            'Mozilla/5.0 (compatible; SeznamBot/4.0; +https://o-seznam.cz/napoveda/vyhledavani/en/seznambot-crawler/)',
        ],
        ['BrightEdge Crawler/1.0 (crawler@brightedge.com)'],
        ['Mozilla/5.0 (compatible; Pinterestbot/1.0; +http://www.pinterest.com/bot.html)'],
    ]
    for (const [botString] of botUAs) {
        test(`blocks based on user agent ${botString}`, () => {
            assert.equal(isBlockedUA(botString, []), true)
            assert.equal(isBlockedUA(botString.toLowerCase(), []), true)
            assert.equal(isBlockedUA(botString.toUpperCase(), []), true)
            assert.equal(isLikelyBot({ userAgent: botString }, []), true)
            assert.equal(isLikelyBot({ userAgent: botString.toLowerCase() }, []), true)
            assert.equal(isLikelyBot({ userAgent: botString.toUpperCase() }, []), true)
        })
    }

    const humanUAs = [
        ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:129.0) Gecko/20100101 Firefox/129.0'],
        [
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
        ],
        [
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
        ],
        [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) elec/1.0.0 Chrome/126.0.6478.127 Electron/31.2.1 Safari/537.36',
        ],
        [
            // Pinterest app's own in-app browser -- a real user, not the Pinterestbot crawler
            'Mozilla/5.0 (iPad; CPU OS 11_2_6 like Mac OS X) AppleWebKit/604.5.6 (KHTML, like Gecko) Mobile/15D100 [Pinterest/iOS]',
        ],
    ]
    for (const [userAgent] of humanUAs) {
        test(`does not block based on non-bot user agent ${userAgent}`, () => {
            assert.equal(isBlockedUA(userAgent, []), false)
            assert.equal(isBlockedUA(userAgent.toLowerCase(), []), false)
            assert.equal(isBlockedUA(userAgent.toUpperCase(), []), false)
            assert.equal(isLikelyBot({ userAgent }, []), false)
            assert.equal(isLikelyBot({ userAgent: userAgent.toLowerCase() }, []), false)
            assert.equal(isLikelyBot({ userAgent: userAgent.toUpperCase() }, []), false)
        })
    }

    test('blocks based on the webdriver property being set to true', () => {
        assert.equal(isLikelyBot({ webdriver: true }, []), true)
    })

    test('blocks based on userAgentData', () => {
        const userAgentData = {
            brands: [
                { brand: 'Not)A;Brand', version: '99' },
                { brand: 'HeadlessChrome', version: '127' },
                { brand: 'Chromium', version: '127' },
            ],
        }
        assert.equal(isLikelyBot({ userAgentData }, []), true)
    })

    test('does not block a normal browser based of userAgentData', () => {
        const userAgentData = {
            brands: [
                { brand: 'Not)A;Brand', version: '99' },
                { brand: 'Google Chrome', version: '127' },
                { brand: 'Chromium', version: '127' },
            ],
        }
        assert.equal(isLikelyBot({ userAgentData }, []), false)
    })

    test('does not crash if the type of navigatorUAData changes', () => {
        // only checking that these don't throw
        isLikelyBot({ userAgentData: { brands: ['HeadlessChrome'] } }, [])
        isLikelyBot({ userAgentData: { brands: [() => 'HeadlessChrome'] } }, [])
        isLikelyBot({ userAgentData: { brands: () => ['HeadlessChrome'] } }, [])
        isLikelyBot({ userAgentData: 'HeadlessChrome' }, [])
        isLikelyBot({ userAgentData: {} }, [])
        isLikelyBot({ userAgentData: null }, [])
        isLikelyBot({ userAgentData: () => ['HeadlessChrome'] }, [])
        isLikelyBot({ userAgentData: true }, [])
    })

    test('returns false for a missing navigator', () => {
        assert.equal(isLikelyBot(undefined, []), false)
    })
})
