/**
 * @fileoverview Browser/device context attached to every event.
 * A compact user-agent parser covering the common browsers/OSes; upstream has
 * a far longer table, extend BROWSERS/OSES as needed.
 */
import {doc, includes, nav, userAgent, win} from './utils.js';
import {LIB_NAME, LIB_VERSION} from './constants.js';

/** [name, detection regex, version regex] - order matters (first match wins). */
const BROWSERS = [
  ['Samsung Internet', /SamsungBrowser/, /SamsungBrowser\/(\d+(\.\d+)?)/],
  ['Opera', /OPR\/|Opera/, /(?:OPR|Version)\/(\d+(\.\d+)?)/],
  ['Microsoft Edge', /Edg(e|A|iOS)?\//, /Edg(?:e|A|iOS)?\/(\d+(\.\d+)?)/],
  ['Facebook Mobile', /FBIOS|FB_IAB|FBAN/, /FBAV\/(\d+(\.\d+)?)/],
  ['Chrome iOS', /CriOS/, /CriOS\/(\d+(\.\d+)?)/],
  ['Firefox iOS', /FxiOS/, /FxiOS\/(\d+(\.\d+)?)/],
  ['UC Browser', /UCBrowser/, /UCBrowser\/(\d+(\.\d+)?)/],
  ['Chrome', /Chrome|CrMo/, /(?:Chrome|CrMo)\/(\d+(\.\d+)?)/],
  ['Android Mobile', /Android.*Version\/[\d.]+.*Safari/, /Android (\d+(\.\d+)?)/],
  ['Mobile Safari', /(iPhone|iPad|iPod).*Version\/.*Safari|(iPhone|iPad|iPod).*AppleWebKit/, /Version\/(\d+(\.\d+)?)/],
  ['Safari', /Safari/, /Version\/(\d+(\.\d+)?)/],
  ['Firefox', /Firefox/, /Firefox\/(\d+(\.\d+)?)/],
  ['Internet Explorer', /MSIE|Trident\//, /(?:MSIE |rv:)(\d+(\.\d+)?)/],
];

/** [name, regex, version regex] */
const OSES = [
  ['Windows Phone', /Windows Phone/, /Windows Phone (?:OS )?(\d+(\.\d+)?)/],
  ['Windows', /Windows/, /Windows NT (\d+(\.\d+)?)/],
  ['iOS', /iPhone|iPad|iPod/, /OS (\d+(_\d+)?)/],
  ['Android', /Android/, /Android (\d+(\.\d+)?)/],
  ['Chrome OS', /CrOS/, /CrOS [^ ]+ (\d+(\.\d+)?)/],
  ['Mac OS X', /Mac OS X|Macintosh/, /Mac OS X (\d+([_.]\d+)?)/],
  ['Linux', /Linux/, null],
];

/**
 * @param {string} ua
 * @return {{browser: string, browserVersion: (number|undefined), os: string, osVersion: string}}
 */
export function parseUserAgent(ua) {
  let browser = '';
  let browserVersion = undefined;
  for (let i = 0; i < BROWSERS.length; i++) {
    const b = BROWSERS[i];
    if (/** @type {!RegExp} */ (b[1]).test(ua)) {
      browser = /** @type {string} */ (b[0]);
      const m = /** @type {!RegExp} */ (b[2]).exec(ua);
      if (m) browserVersion = parseFloat(m[1]);
      break;
    }
  }
  let os = '';
  let osVersion = '';
  for (let i = 0; i < OSES.length; i++) {
    const o = OSES[i];
    if (/** @type {!RegExp} */ (o[1]).test(ua)) {
      os = /** @type {string} */ (o[0]);
      const re = /** @type {?RegExp} */ (o[2]);
      const m = re ? re.exec(ua) : null;
      if (m) osVersion = m[1].replace(/_/g, '.');
      break;
    }
  }
  return {browser: browser, browserVersion: browserVersion, os: os, osVersion: osVersion};
}

/**
 * @param {string} ua
 * @return {string}
 */
export function deviceType(ua) {
  if (/iPad|Tablet|PlayBook|Silk|Android(?!.*Mobile)/i.test(ua)) return 'Tablet';
  if (/Mobi|iPhone|iPod|Android|Windows Phone|BlackBerry/i.test(ua)) return 'Mobile';
  if (/SMART-TV|SmartTV|GoogleTV|AppleTV|CrKey|Tizen|Web0S/i.test(ua)) return 'TV';
  return 'Desktop';
}

/** Substrings that identify crawlers / headless agents. */
const BOT_PATTERNS = [
  'bot', 'crawler', 'spider', 'headlesschrome', 'phantomjs', 'slurp', 'lighthouse',
  'prerender', 'facebookexternalhit', 'bingpreview', 'yandex', 'baidu', 'ahrefs',
  'semrush', 'mediapartners-google', 'adsbot-google', 'apis-google', 'pingdom',
  'gtmetrix', 'chrome-lighthouse', 'python-requests', 'curl/', 'wget/',
];

/**
 * @param {string} ua
 * @param {!Array<string>=} extra
 * @return {boolean}
 */
export function isLikelyBot(ua, extra) {
  const lower = ua.toLowerCase();
  const patterns = extra ? BOT_PATTERNS.concat(extra) : BOT_PATTERNS;
  for (let i = 0; i < patterns.length; i++) {
    if (lower.indexOf(String(patterns[i]).toLowerCase()) !== -1) return true;
  }
  return !!(nav && nav['webdriver']);
}

/** @return {string|undefined} */
function timezone() {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch (e) {
    return undefined;
  }
}

/**
 * Strips query params flagged as personal data from a URL.
 * @param {string} url
 * @param {!Array<string>} params
 * @return {string}
 */
export function maskQueryParams(url, params) {
  return url.replace(/([?&])([^=&#]+)=([^&#]*)/g, function(all, sep, key) {
    return includes(params, key.toLowerCase()) ? sep + key + '=<masked>' : all;
  });
}

/** @const {!Array<string>} */
const PERSONAL_DATA_PARAMS = ['gclid', 'gad_source', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'twclid', 'li_fat_id', 'igshid', 'ttclid', 'rdt_cid', 'epik', 'qclid', 'sccid', 'irclid', '_kx', 'email', 'token'];

/**
 * @param {!Object} config
 * @return {!Object}
 */
export function getEventProperties(config) {
  const ua = userAgent;
  const parsed = parseUserAgent(ua);
  const props = {
    '$os': parsed.os,
    '$os_version': parsed.osVersion,
    '$browser': parsed.browser,
    '$device_type': deviceType(ua),
    '$raw_user_agent': ua.length > 1000 ? ua.substring(0, 997) + '...' : ua,
    '$browser_version': parsed.browserVersion,
    '$lib': LIB_NAME,
    '$lib_version': LIB_VERSION,
    '$time': new Date().getTime() / 1000,
    '$timezone': timezone(),
    '$timezone_offset': new Date().getTimezoneOffset(),
  };
  if (nav) {
    const lang = nav.language || nav['userLanguage'];
    props['$browser_language'] = lang;
    props['$browser_language_prefix'] = lang ? String(lang).split('-')[0] : undefined;
  }
  if (win) {
    let url = win.location.href;
    if (config['disable_capture_url_hashes']) url = url.split('#')[0];
    if (config['mask_personal_data_properties']) {
      url = maskQueryParams(url, PERSONAL_DATA_PARAMS.concat(config['custom_personal_data_properties'] || []));
    }
    props['$current_url'] = url;
    props['$host'] = win.location.host;
    props['$pathname'] = win.location.pathname;
    if (win.screen) {
      props['$screen_height'] = win.screen.height;
      props['$screen_width'] = win.screen.width;
    }
    props['$viewport_height'] = win.innerHeight;
    props['$viewport_width'] = win.innerWidth;
  }
  return props;
}

/** @return {string} */
export function documentTitle() {
  return (doc && doc.title) || '';
}
