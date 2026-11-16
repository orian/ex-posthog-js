/**
 * @fileoverview User-agent parsing and bot detection.
 *
 * Faithful port of upstream posthog-js:
 *   - packages/core/src/utils/user-agent-utils.ts  (detectBrowser, detectBrowserVersion, detectOS,
 *     detectDevice, detectDeviceType)
 *   - packages/core/src/utils/webview-app-utils.ts (detectWebviewApp)
 *   - packages/core/src/utils/bot-detection.ts     (DEFAULT_BLOCKED_UA_STRS, isBlockedUA)
 *   - packages/browser-common/src/utils/blocked-uas.ts (isLikelyBot)
 *
 * Every regex, table entry and check order matches upstream. Tuples are plain
 * arrays. Upstream's Map-based isBlockedUA cache is a prototype-less object
 * here (no ES2015 built-ins at runtime); keys always start with a digit.
 *
 * Closure notes: the option bags are @record types so call sites written in
 * this codebase are renamed consistently. Navigator fields that are not in
 * Closure's default externs (webdriver, userAgentData) and the userAgentData
 * payload are read with quoted keys.
 */

/**
 * @param {string} str
 * @param {string} needle
 * @return {boolean}
 */
function strIncludes(str, needle) {
  return str.indexOf(needle) !== -1;
}

/**
 * @param {*} x
 * @return {boolean}
 */
function isUndefined(x) {
  return x === void 0;
}

const FACEBOOK = 'Facebook';
const MOBILE = 'Mobile';
const IOS = 'iOS';
const ANDROID = 'Android';
const TABLET = 'Tablet';
const ANDROID_TABLET = ANDROID + ' ' + TABLET;
const IPAD = 'iPad';
const APPLE = 'Apple';
const APPLE_WATCH = APPLE + ' Watch';
const SAFARI = 'Safari';
const BLACKBERRY = 'BlackBerry';
const SAMSUNG = 'Samsung';
const SAMSUNG_BROWSER = SAMSUNG + 'Browser';
const SAMSUNG_INTERNET = SAMSUNG + ' Internet';
const CHROME = 'Chrome';
const CHROME_OS = CHROME + ' OS';
const CHROME_IOS = CHROME + ' ' + IOS;
const INTERNET_EXPLORER = 'Internet Explorer';
const INTERNET_EXPLORER_MOBILE = INTERNET_EXPLORER + ' ' + MOBILE;
const OPERA = 'Opera';
const OPERA_MINI = OPERA + ' Mini';
const EDGE = 'Edge';
const MICROSOFT_EDGE = 'Microsoft ' + EDGE;
const FIREFOX = 'Firefox';
const FIREFOX_IOS = FIREFOX + ' ' + IOS;
const NINTENDO = 'Nintendo';
const PLAYSTATION = 'PlayStation';
const XBOX = 'Xbox';
const ANDROID_MOBILE = ANDROID + ' ' + MOBILE;
const MOBILE_SAFARI = MOBILE + ' ' + SAFARI;
const WINDOWS = 'Windows';
const WINDOWS_PHONE = WINDOWS + ' Phone';
const NOKIA = 'Nokia';
const OUYA = 'Ouya';
const GENERIC = 'Generic';
const GENERIC_MOBILE = GENERIC + ' mobile';
const GENERIC_TABLET = GENERIC + ' tablet';
const KONQUEROR = 'Konqueror';
const OCULUS_BROWSER = 'Oculus Browser';
const VIVALDI = 'Vivaldi';
const YANDEX = 'Yandex';
const WHALE = 'Whale';
const DUCKDUCKGO = 'DuckDuckGo';
const PALE_MOON = 'Pale Moon';
const WATERFOX = 'Waterfox';
const BRAVE = 'Brave';
const CLAUDE = 'Claude';
const CODEX = 'Codex';
const CHATGPT = 'ChatGPT';
const GOOGLE_SEARCH_APP = 'Google Search App';

const BROWSER_VERSION_REGEX_SUFFIX = '(\\d+(\\.\\d+)?)';
const DEFAULT_BROWSER_VERSION_REGEX = new RegExp('Version/' + BROWSER_VERSION_REGEX_SUFFIX);
const AI_APP_VERSION_REGEX = new RegExp(
  '(' + CLAUDE + '|' + CODEX + '|' + CHATGPT + ')\\/' + BROWSER_VERSION_REGEX_SUFFIX
);

/**
 * Hints from sources outside the User-Agent string. `brave` is `true` when
 * `navigator.brave` exists (desktop / Android Brave hide from the UA).
 * @record
 */
export function BrowserDetectionHints() {}
/** @type {boolean|undefined} */
BrowserDetectionHints.prototype.brave;

/**
 * Opt-in tweaks to UA-string detection. `detectGoogleSearchApp` surfaces the
 * Google Search App via its `GSA/` marker instead of the underlying webview.
 * @record
 */
export function BrowserDetectionOptions() {}
/** @type {boolean|undefined} */
BrowserDetectionOptions.prototype.detectGoogleSearchApp;

/**
 * Extra signals for detectDeviceType (Client Hints platform, touch, screen).
 * @record
 */
export function DeviceTypeOptions() {}
/** @type {string|undefined} */
DeviceTypeOptions.prototype.userAgentDataPlatform;
/** @type {number|undefined} */
DeviceTypeOptions.prototype.maxTouchPoints;
/** @type {number|undefined} */
DeviceTypeOptions.prototype.screenWidth;
/** @type {number|undefined} */
DeviceTypeOptions.prototype.screenHeight;
/** @type {number|undefined} */
DeviceTypeOptions.prototype.devicePixelRatio;

/**
 * @param {?BrowserDetectionHints|undefined} hints
 * @return {?string}
 */
function browserFromHints(hints) {
  if (hints?.brave) {
    return BRAVE;
  }
  return null;
}

const XBOX_REGEX = new RegExp(XBOX, 'i');
const PLAYSTATION_REGEX = new RegExp(PLAYSTATION + ' \\w+', 'i');
const NINTENDO_REGEX = new RegExp(NINTENDO + ' \\w+', 'i');
const BLACKBERRY_REGEX = new RegExp(BLACKBERRY + '|PlayBook|BB10', 'i');

/** @const {!Object<string, string>} */
const windowsVersionMap = {
  'NT3.51': 'NT 3.11',
  'NT4.0': 'NT 4.0',
  '5.0': '2000',
  '5.1': 'XP',
  '5.2': 'XP',
  '6.0': 'Vista',
  '6.1': '7',
  '6.2': '8',
  '6.3': '8.1',
  '6.4': '10',
  '10.0': '10',
};

/**
 * @param {string} userAgent
 * @return {boolean}
 */
function isSafari(userAgent) {
  return strIncludes(userAgent, SAFARI) && !strIncludes(userAgent, CHROME) && !strIncludes(userAgent, ANDROID);
}

/**
 * @param {string} ua
 * @param {string|undefined} vendor
 * @return {boolean}
 */
function safariCheck(ua, vendor) {
  return !!(vendor && strIncludes(vendor, APPLE)) || isSafari(ua);
}

/**
 * Detects which browser is running. Order of checks matters.
 * @param {string} user_agent
 * @param {string|undefined} vendor
 * @param {?BrowserDetectionHints=} hints
 * @param {?BrowserDetectionOptions=} options
 * @return {string}
 */
export function detectBrowser(user_agent, vendor, hints, options) {
  vendor = vendor || ''; // vendor is undefined for at least IE9

  const fromHints = browserFromHints(hints);
  if (fromHints) {
    return fromHints;
  }

  if (options?.detectGoogleSearchApp && strIncludes(user_agent, 'GSA/')) {
    return GOOGLE_SEARCH_APP;
  }

  if (strIncludes(user_agent, ' OPR/') && strIncludes(user_agent, 'Mini')) {
    return OPERA_MINI;
  } else if (strIncludes(user_agent, ' OPR/')) {
    return OPERA;
  } else if (BLACKBERRY_REGEX.test(user_agent)) {
    return BLACKBERRY;
  } else if (strIncludes(user_agent, 'IE' + MOBILE) || strIncludes(user_agent, 'WPDesktop')) {
    return INTERNET_EXPLORER_MOBILE;
  } else if (strIncludes(user_agent, 'OculusBrowser')) {
    return OCULUS_BROWSER;
  } else if (strIncludes(user_agent, SAMSUNG_BROWSER)) {
    return SAMSUNG_INTERNET;
  } else if (strIncludes(user_agent, EDGE) || strIncludes(user_agent, 'Edg/')) {
    return MICROSOFT_EDGE;
  } else if (strIncludes(user_agent, VIVALDI + '/')) {
    return VIVALDI;
  } else if (strIncludes(user_agent, 'YaBrowser/')) {
    return YANDEX;
  } else if (strIncludes(user_agent, WHALE + '/')) {
    return WHALE;
  } else if (strIncludes(user_agent, DUCKDUCKGO + '/') || strIncludes(user_agent, 'Ddg/')) {
    return DUCKDUCKGO;
  } else if (strIncludes(user_agent, CLAUDE + '/')) {
    return CLAUDE;
  } else if (strIncludes(user_agent, CODEX + '/')) {
    return CODEX;
  } else if (strIncludes(user_agent, CHATGPT + '/')) {
    return CHATGPT;
  } else if (strIncludes(user_agent, 'FBIOS')) {
    return FACEBOOK + ' ' + MOBILE;
  } else if (strIncludes(user_agent, 'UCWEB') || strIncludes(user_agent, 'UCBrowser')) {
    return 'UC Browser';
  } else if (strIncludes(user_agent, 'CriOS')) {
    return CHROME_IOS;
  } else if (strIncludes(user_agent, 'CrMo')) {
    return CHROME;
  } else if (strIncludes(user_agent, CHROME)) {
    return CHROME;
  } else if (strIncludes(user_agent, ANDROID) && strIncludes(user_agent, SAFARI)) {
    return ANDROID_MOBILE;
  } else if (strIncludes(user_agent, 'FxiOS')) {
    return FIREFOX_IOS;
  } else if (strIncludes(user_agent.toLowerCase(), KONQUEROR.toLowerCase())) {
    return KONQUEROR;
  } else if (strIncludes(user_agent, BRAVE + '/')) {
    return BRAVE;
  } else if (safariCheck(user_agent, vendor)) {
    return strIncludes(user_agent, MOBILE) ? MOBILE_SAFARI : SAFARI;
  } else if (strIncludes(user_agent, 'PaleMoon/')) {
    return PALE_MOON;
  } else if (strIncludes(user_agent, WATERFOX + '/')) {
    return WATERFOX;
  } else if (strIncludes(user_agent, FIREFOX)) {
    return FIREFOX;
  } else if (strIncludes(user_agent, 'MSIE') || strIncludes(user_agent, 'Trident/')) {
    return INTERNET_EXPLORER;
  } else if (strIncludes(user_agent, 'Gecko')) {
    return FIREFOX;
  }

  return '';
}

/** @const {!Object<string, !Array<!RegExp>>} */
const versionRegexes = {
  [INTERNET_EXPLORER_MOBILE]: [new RegExp('rv:' + BROWSER_VERSION_REGEX_SUFFIX)],
  [MICROSOFT_EDGE]: [new RegExp(EDGE + '?\\/' + BROWSER_VERSION_REGEX_SUFFIX)],
  [CHROME]: [new RegExp('(' + CHROME + '|CrMo)\\/' + BROWSER_VERSION_REGEX_SUFFIX)],
  [CHROME_IOS]: [new RegExp('CriOS\\/' + BROWSER_VERSION_REGEX_SUFFIX)],
  'UC Browser': [new RegExp('(UCBrowser|UCWEB)\\/' + BROWSER_VERSION_REGEX_SUFFIX)],
  [SAFARI]: [DEFAULT_BROWSER_VERSION_REGEX],
  [MOBILE_SAFARI]: [DEFAULT_BROWSER_VERSION_REGEX],
  [OPERA]: [new RegExp('(' + OPERA + '|OPR)\\/' + BROWSER_VERSION_REGEX_SUFFIX)],
  [FIREFOX]: [new RegExp(FIREFOX + '\\/' + BROWSER_VERSION_REGEX_SUFFIX)],
  [FIREFOX_IOS]: [new RegExp('FxiOS\\/' + BROWSER_VERSION_REGEX_SUFFIX)],
  [KONQUEROR]: [new RegExp('Konqueror[:/]?' + BROWSER_VERSION_REGEX_SUFFIX, 'i')],
  // not every blackberry user agent has the version after the name
  [BLACKBERRY]: [new RegExp(BLACKBERRY + ' ' + BROWSER_VERSION_REGEX_SUFFIX), DEFAULT_BROWSER_VERSION_REGEX],
  [ANDROID_MOBILE]: [new RegExp('android\\s' + BROWSER_VERSION_REGEX_SUFFIX, 'i')],
  [SAMSUNG_INTERNET]: [new RegExp(SAMSUNG_BROWSER + '\\/' + BROWSER_VERSION_REGEX_SUFFIX)],
  [OCULUS_BROWSER]: [new RegExp('OculusBrowser\\/' + BROWSER_VERSION_REGEX_SUFFIX)],
  [VIVALDI]: [new RegExp(VIVALDI + '\\/' + BROWSER_VERSION_REGEX_SUFFIX)],
  [YANDEX]: [new RegExp('YaBrowser\\/' + BROWSER_VERSION_REGEX_SUFFIX)],
  [WHALE]: [new RegExp(WHALE + '\\/' + BROWSER_VERSION_REGEX_SUFFIX)],
  // Only matches the iOS `Brave/` marker; hint-detected Brave has no UA version.
  [BRAVE]: [new RegExp(BRAVE + '\\/' + BROWSER_VERSION_REGEX_SUFFIX)],
  [CLAUDE]: [AI_APP_VERSION_REGEX],
  [CODEX]: [AI_APP_VERSION_REGEX],
  [CHATGPT]: [AI_APP_VERSION_REGEX],
  // DuckDuckGo on iOS uses `Ddg/`, on Android/desktop preview it uses `DuckDuckGo/`.
  [DUCKDUCKGO]: [new RegExp('(DuckDuckGo|Ddg)\\/' + BROWSER_VERSION_REGEX_SUFFIX)],
  [PALE_MOON]: [new RegExp('PaleMoon\\/' + BROWSER_VERSION_REGEX_SUFFIX)],
  [WATERFOX]: [new RegExp(WATERFOX + '\\/' + BROWSER_VERSION_REGEX_SUFFIX)],
  [GOOGLE_SEARCH_APP]: [new RegExp('GSA\\/' + BROWSER_VERSION_REGEX_SUFFIX)],
  [INTERNET_EXPLORER]: [new RegExp('(rv:|MSIE )' + BROWSER_VERSION_REGEX_SUFFIX)],
  'Mozilla': [new RegExp('rv:' + BROWSER_VERSION_REGEX_SUFFIX)],
};

/**
 * Detects the browser's major.minor version (e.g. 42.1).
 * @param {string} userAgent
 * @param {string|undefined} vendor
 * @param {?BrowserDetectionHints=} hints
 * @param {?BrowserDetectionOptions=} options
 * @return {?number}
 */
export function detectBrowserVersion(userAgent, vendor, hints, options) {
  const browser = detectBrowser(userAgent, vendor, hints, options);

  const regexes = versionRegexes[browser];
  if (isUndefined(regexes)) {
    return null;
  }

  for (let i = 0; i < regexes.length; i++) {
    const regex = regexes[i];
    const matches = userAgent.match(regex);
    if (matches) {
      return parseFloat(matches[matches.length - 2]);
    }
  }
  return null;
}

/** @typedef {function(?Array<string>, string): !Array<string>} */
let OsMatcherFn;

/**
 * Each entry is [regex, result-or-function]; the first regex that matches
 * returns the constant result or the function's result.
 * @const {!Array<!Array<?>>}
 */
const osMatchers = [
  [
    new RegExp(XBOX + '; ' + XBOX + ' (.*?)[);]', 'i'),
    /** @type {OsMatcherFn} */ (function (match) {
      return [XBOX, (match && match[1]) || ''];
    }),
  ],
  [new RegExp(NINTENDO, 'i'), [NINTENDO, '']],
  [new RegExp(PLAYSTATION, 'i'), [PLAYSTATION, '']],
  [BLACKBERRY_REGEX, [BLACKBERRY, '']],
  [
    new RegExp(WINDOWS, 'i'),
    /** @type {OsMatcherFn} */ (function (_, user_agent) {
      if (/Phone/.test(user_agent) || /WPDesktop/.test(user_agent)) {
        return [WINDOWS_PHONE, ''];
      }
      // not all JS versions support negative lookbehind, so we need two checks here
      if (new RegExp(MOBILE).test(user_agent) && !/IEMobile\b/.test(user_agent)) {
        return [WINDOWS + ' ' + MOBILE, ''];
      }
      const match = /Windows NT ([0-9.]+)/i.exec(user_agent);
      if (match && match[1]) {
        const version = match[1];
        let osVersion = windowsVersionMap[version] || '';
        if (/arm/i.test(user_agent)) {
          osVersion = 'RT';
        }
        return [WINDOWS, osVersion];
      }
      return [WINDOWS, ''];
    }),
  ],
  [
    /((iPhone|iPad|iPod).*?OS (\d+)_(\d+)_?(\d+)?|iPhone)/,
    /** @type {OsMatcherFn} */ (function (match) {
      if (match && match[3]) {
        const versionParts = [match[3], match[4], match[5] || '0'];
        return [IOS, versionParts.join('.')];
      }
      return [IOS, ''];
    }),
  ],
  [
    /(watch.*\/(\d+\.\d+\.\d+)|watch os,(\d+\.\d+),)/i,
    /** @type {OsMatcherFn} */ (function (match) {
      // e.g. Watch4,3/5.3.8 (16U680)
      let version = '';
      if (match && match.length >= 3) {
        version = isUndefined(match[2]) ? match[3] : match[2];
      }
      return ['watchOS', version];
    }),
  ],
  [
    new RegExp('(' + ANDROID + ' (\\d+)\\.(\\d+)\\.?(\\d+)?|' + ANDROID + ')', 'i'),
    /** @type {OsMatcherFn} */ (function (match) {
      if (match && match[2]) {
        const versionParts = [match[2], match[3], match[4] || '0'];
        return [ANDROID, versionParts.join('.')];
      }
      return [ANDROID, ''];
    }),
  ],
  [
    /Mac OS X (\d+)[_.](\d+)[_.]?(\d+)?/i,
    /** @type {OsMatcherFn} */ (function (match) {
      const result = ['Mac OS X', ''];
      if (match && match[1]) {
        const versionParts = [match[1], match[2], match[3] || '0'];
        result[1] = versionParts.join('.');
      }
      return result;
    }),
  ],
  [
    /Mac/i,
    // mop up a few non-standard UAs that should match mac
    ['Mac OS X', ''],
  ],
  [/CrOS/, [CHROME_OS, '']],
  [/Linux|debian/i, ['Linux', '']],
];

/**
 * Returns [os name, os version]. Like upstream, constant results are shared
 * array instances.
 * @param {string} user_agent
 * @return {!Array<string>}
 */
export function detectOS(user_agent) {
  for (let i = 0; i < osMatchers.length; i++) {
    const rgex = /** @type {!RegExp} */ (osMatchers[i][0]);
    const resultOrFn = osMatchers[i][1];
    const match = rgex.exec(user_agent);
    const result =
      match &&
      (typeof resultOrFn === 'function'
        ? /** @type {OsMatcherFn} */ (resultOrFn)(match, user_agent)
        : /** @type {!Array<string>} */ (resultOrFn));
    if (result) {
      return result;
    }
  }
  return ['', ''];
}

/**
 * @param {string} user_agent
 * @return {string}
 */
export function detectDevice(user_agent) {
  if (NINTENDO_REGEX.test(user_agent)) {
    return NINTENDO;
  } else if (PLAYSTATION_REGEX.test(user_agent)) {
    return PLAYSTATION;
  } else if (XBOX_REGEX.test(user_agent)) {
    return XBOX;
  } else if (new RegExp(OUYA, 'i').test(user_agent)) {
    return OUYA;
  } else if (new RegExp('(' + WINDOWS_PHONE + '|WPDesktop)', 'i').test(user_agent)) {
    return WINDOWS_PHONE;
  } else if (/iPad/.test(user_agent)) {
    return IPAD;
  } else if (/iPod/.test(user_agent)) {
    return 'iPod Touch';
  } else if (/iPhone/.test(user_agent)) {
    return 'iPhone';
  } else if (/(watch)(?: ?os[,/]|\d,\d\/)[\d.]+/i.test(user_agent)) {
    return APPLE_WATCH;
  } else if (BLACKBERRY_REGEX.test(user_agent)) {
    return BLACKBERRY;
  } else if (/(kobo)\s(ereader|touch)/i.test(user_agent)) {
    return 'Kobo';
  } else if (new RegExp(NOKIA, 'i').test(user_agent)) {
    return NOKIA;
  } else if (
    // Kindle Fire without Silk / Echo Show
    /(kf[a-z]{2}wi|aeo[c-r]{2})( bui|\))/i.test(user_agent) ||
    // Kindle Fire HD
    /(kf[a-z]+)( bui|\)).+silk\//i.test(user_agent)
  ) {
    return 'Kindle Fire';
  } else if (/(Android|ZTE)/i.test(user_agent)) {
    if (
      !new RegExp(MOBILE).test(user_agent) ||
      /(9138B|TB782B|Nexus [97]|pixel c|HUAWEISHT|BTV|noble nook|smart ultra 6)/i.test(user_agent)
    ) {
      if (
        (/pixel[\daxl ]{1,6}/i.test(user_agent) && !/pixel c/i.test(user_agent)) ||
        /(huaweimed-al00|tah-|APA|SM-G92|i980|zte|U304AA)/i.test(user_agent) ||
        (/lmy47v/i.test(user_agent) && !/QTAQZ3/i.test(user_agent))
      ) {
        return ANDROID;
      }
      return ANDROID_TABLET;
    } else {
      return ANDROID;
    }
  } else if (new RegExp('(pda|' + MOBILE + ')', 'i').test(user_agent)) {
    return GENERIC_MOBILE;
  } else if (new RegExp(TABLET, 'i').test(user_agent) && !new RegExp(TABLET + ' pc', 'i').test(user_agent)) {
    return GENERIC_TABLET;
  } else {
    return '';
  }
}

/**
 * @param {string} user_agent
 * @param {?DeviceTypeOptions=} options
 * @return {string}
 */
export function detectDeviceType(user_agent, options) {
  const device = detectDevice(user_agent);
  if (
    device === IPAD ||
    device === ANDROID_TABLET ||
    device === 'Kobo' ||
    device === 'Kindle Fire' ||
    device === GENERIC_TABLET
  ) {
    return TABLET;
  } else if (device === NINTENDO || device === XBOX || device === PLAYSTATION || device === OUYA) {
    return 'Console';
  } else if (device === APPLE_WATCH) {
    return 'Wearable';
  } else if (device) {
    return MOBILE;
  }

  // Chrome on Android tablets defaults to "request desktop site" mode, sending
  // a desktop-like UA. The Client Hints API reports the true platform.
  if (options?.userAgentDataPlatform === 'Android' && (options?.maxTouchPoints ?? 0) > 0) {
    const shortSide = Math.min(options?.screenWidth ?? 0, options?.screenHeight ?? 0);
    const shortSideDp = shortSide / (options?.devicePixelRatio ?? 1);
    return shortSideDp >= 600 ? TABLET : MOBILE;
  }

  return 'Desktop';
}

// --- webview-app-utils.ts ---------------------------------------------------

// App markers must be checked independently of browser detection: the host app
// and the browser rendering its webview are separate dimensions.
const facebookAppVersion = /\bFBAV\/(\d+(?:\.\d+)*)/i;

/**
 * [regex, app name, optional version regex]
 * @const {!Array<!Array<?>>}
 */
const webviewAppMatchers = [
  [/\bInstagram(?:[ /](\d+(?:\.\d+)*))?\b/i, 'Instagram'],
  [/\bBarcelona[ /](\d+(?:\.\d+)*)?/i, 'Threads'],
  // Specific Meta apps must precede Facebook, which can share their markers.
  [/\b(?:MessengerForiOS|(?:FBAN|FB_IAB)\/Orca-Android)\b/i, 'Messenger', facebookAppVersion],
  [/\bFBAN\/EMA\b/i, 'Facebook Lite', facebookAppVersion],
  [/\b(?:FBIOS|(?:FBAN|FB_IAB)\/(?:FB4A|FBIOS))\b/i, 'Facebook', facebookAppVersion],
  [/\bLinkedInApp(?:\]?\/(\d+(?:\.\d+)*))?\b/i, 'LinkedIn'],
  [/\bTwitter(?:Android| for (?:iPhone|iPad|Android))(?:\/(\d+(?:\.\d+)*))?\b/i, 'Twitter'],
  // Android's musical_ly_/trill_ suffix can be a build number. Prefer the
  // explicit app_version token, and only use a dotted suffix as a fallback.
  [/\b(?:musical_ly|trill)(?:[_/](\d+\.\d+(?:\.\d+)*))?(?=\b|_)/i, 'TikTok', /\bapp_version\/(\d+(?:\.\d+)*)/i],
  [/\b(?:MicroMessenger|WeChat)\/(\d+(?:\.\d+)*)?/i, 'WeChat'],
  [/\bLine\/(\d+(?:\.\d+)*)?/i, 'Line'],
  [/\bGSA\/(\d+(?:\.\d+)*)?/i, 'Google'],
  [/\[Pinterest\/(?:iOS|Android)\b|\bPinterest(?: for (?:Android(?: Tablet)?|iOS))?\/(\d+(?:\.\d+)*)/i, 'Pinterest'],
  // Generic WhatsApp/ UAs can be link previews, not an embedded browser.
  [/\b(?:WA4A|WAiOS)\/(\d+(?:\.\d+)*)?/i, 'WhatsApp'],
  [/\bSnapchat[ /](\d+(?:\.\d+)*)?/i, 'Snapchat'],
  [/\bBing(?:Web|Sapphire)\/(\d+(?:\.\d+)*)?/i, 'Bing'],
  [/\bNAVER\(inapp; search;/i, 'Naver', /\bNAVER\(inapp; search;[^;)]*; (\d+(?:\.\d+)*)/i],
  // KakaoTalk also emits integer build identifiers, not dotted app versions.
  [/\bKAKAOTALK[ /](\d+\.\d+(?:\.\d+)*)?/i, 'KakaoTalk'],
];

/**
 * Best-effort detection of the app hosting a webview from explicit UA markers.
 * No match means unknown, not "definitely not an in-app browser".
 * Returns [app name, app version], empty strings for unknown values.
 * @param {string} userAgent
 * @return {!Array<string>}
 */
export function detectWebviewApp(userAgent) {
  for (let i = 0; i < webviewAppMatchers.length; i++) {
    const regex = /** @type {!RegExp} */ (webviewAppMatchers[i][0]);
    const name = /** @type {string} */ (webviewAppMatchers[i][1]);
    const versionRegex = /** @type {!RegExp|undefined} */ (webviewAppMatchers[i][2]);
    const match = userAgent.match(regex);
    if (match) {
      const versionMatch = (versionRegex && userAgent.match(versionRegex)) || match;
      return [name, versionMatch?.[1] || ''];
    }
  }
  return ['', ''];
}

// --- bot-detection.ts -------------------------------------------------------

/**
 * List of blocked user agent strings that identify bots.
 * @const {!Array<string>}
 */
export const DEFAULT_BLOCKED_UA_STRS = [
  // Random assortment of bots
  'amazonbot',
  'amazonproductbot',
  'app.hypefactors.com', // Buck, but "buck" is too short to be safe to block
  'applebot',
  'archive.org_bot',
  'awariobot',
  'backlinksextendedbot',
  'baiduspider',
  'bingbot',
  'bingpreview',
  'chrome-lighthouse',
  'dataforseobot',
  'deepscan',
  'duckduckbot',
  'facebookexternal',
  'facebookcatalog',
  'http://yandex.com/bots',
  'hubspot',
  'ia_archiver',
  'leikibot',
  'linkedinbot',
  'meta-externalagent',
  'mj12bot',
  'msnbot',
  'nessus',
  'petalbot',
  // not the bare 'pinterest' -- that also matches the Pinterest app's in-app browser
  'pinterestbot',
  'prerender',
  'rogerbot',
  'screaming frog',
  'sebot-wa',
  'sitebulb',
  'slackbot',
  'slurp',
  'trendictionbot',
  'turnitin',
  'twitterbot',
  'vercel-screenshot',
  'vercelbot',
  'yahoo! slurp',
  'yandexbot',
  'zoombot',

  // Bot-like words, maybe we should block `bot` entirely?
  'bot.htm',
  'bot.php',
  '(bot;',
  'bot/',
  'crawler',

  // Ahrefs
  'ahrefsbot',
  'ahrefssiteaudit',

  // Semrush bots
  'semrushbot',
  'siteauditbot',
  'splitsignalbot',

  // AI Crawlers
  'gptbot',
  'oai-searchbot',
  'chatgpt-user',
  'perplexitybot',

  // Uptime-like stuff
  'better uptime bot',
  'sentryuptimebot',
  'uptimerobot',

  // headless browsers
  'headlesschrome',
  'lightpanda',
  'cypress',
  // we don't block electron here, as many customers use posthog-js in electron apps

  // a whole bunch of goog-specific crawlers
  'google-hoteladsverifier',
  'adsbot-google',
  'apis-google',
  'duplexweb-google',
  'feedfetcher-google',
  'google favicon',
  'google web preview',
  'google-read-aloud',
  'googlebot',
  'googleother',
  'google-cloudvertexbot',
  'googleweblight',
  'mediapartners-google',
  'storebot-google',
  'google-inspectiontool',
  'bytespider',
];

/**
 * Session-level memoization for isBlockedUA (upstream uses a Map). Keys are
 * length-prefixed so they always start with a digit and can never be
 * "__proto__"; the object has no prototype anyway.
 * @type {!Object<string, boolean>}
 */
let uaCache = /** @type {!Object<string, boolean>} */ (Object.create(null));
let uaCacheSize = 0;
const MAX_CACHE_ENTRIES = 256;

/** Exposed for tests only. Not part of the public API. */
export function resetBotDetectionCacheForTests() {
  uaCache = /** @type {!Object<string, boolean>} */ (Object.create(null));
  uaCacheSize = 0;
}

/**
 * @param {string} ua
 * @param {!Array<string>} custom
 * @return {string}
 */
function buildCacheKey(ua, custom) {
  // Length-prefixed encoding is collision-free regardless of contents.
  let customEncoded = '';
  for (let i = 0; i < custom.length; i++) {
    const c = custom[i];
    customEncoded += c.length + ':' + c;
  }
  return ua.length + ':' + ua + '|' + custom.length + ':' + customEncoded;
}

/**
 * Block various web spiders from executing our JS and sending false capturing data.
 * @param {string|undefined} ua User agent string to check
 * @param {!Array<string>=} customBlockedUserAgents Additional UA substrings to block
 * @return {boolean} true if the UA matches a known-bot substring
 */
export function isBlockedUA(ua, customBlockedUserAgents = []) {
  if (!ua) {
    return false;
  }

  const key = buildCacheKey(ua, customBlockedUserAgents);
  const cached = uaCache[key];
  if (cached !== undefined) {
    return cached;
  }

  const uaLower = ua.toLowerCase();
  const result = DEFAULT_BLOCKED_UA_STRS.concat(customBlockedUserAgents).some(function (blockedUA) {
    return uaLower.indexOf(blockedUA.toLowerCase()) !== -1;
  });

  if (uaCacheSize >= MAX_CACHE_ENTRIES) {
    resetBotDetectionCacheForTests();
  }
  uaCache[key] = result;
  uaCacheSize++;
  return result;
}

// --- blocked-uas.ts (browser-common) ----------------------------------------

/**
 * @param {?Navigator|undefined} navigator
 * @param {!Array<string>|undefined} customBlockedUserAgents
 * @return {boolean}
 */
export function isLikelyBot(navigator, customBlockedUserAgents) {
  if (!navigator) {
    return false;
  }
  const ua = navigator.userAgent;
  if (ua) {
    if (isBlockedUA(ua, customBlockedUserAgents)) {
      return true;
    }
  }
  try {
    // navigator.userAgentData is experimental; be defensive about its shape.
    const uaData = /** @type {?} */ (navigator['userAgentData']);
    const brands = uaData == null ? undefined : uaData['brands'];
    if (
      brands &&
      /** @type {!Array<?>} */ (brands).some(function (brandObj) {
        const brand = brandObj == null ? undefined : brandObj['brand'];
        return isBlockedUA(/** @type {string|undefined} */ (brand), customBlockedUserAgents);
      })
    ) {
      return true;
    }
  } catch (e) {
    // ignore the error, we were using experimental browser features
  }

  return !!navigator['webdriver'];
}
