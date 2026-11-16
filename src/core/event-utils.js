/**
 * @fileoverview Event context properties. Port of upstream
 * browser-common/src/utils/event-utils.ts (campaign params, referrer, person
 * info, device/browser properties), using the faithful UA port in
 * user-agent.js.
 */
import {
  detectBrowser, detectBrowserVersion, detectDevice, detectDeviceType, detectOS, detectWebviewApp,
  BrowserDetectionHints, BrowserDetectionOptions, DeviceTypeOptions,
} from './user-agent.js';
import {
  convertToURL, doc, each, extend, getCookieValue, getQueryParam, isNull, isString, isUndefined, loc,
  maskQueryParams, nav, stripEmptyProperties, stripLeadingDollar, stripUrlHash, userAgent, win,
} from './utils.js';
import {
  CAMPAIGN_PARAMS, COOKIE_CAMPAIGN_PARAMS, Config, PERSONAL_DATA_CAMPAIGN_PARAMS, SDK_DIST_CHANNEL_KEY,
} from './constants.js';

/** @const {string} */
export const MASKED = '<masked>';
/** @const {string} */
const DIRECT = '$direct';
/** @const {string} */
const URL_REGEX_PREFIX = 'https?://(.*)';

/**
 * @param {boolean|undefined} mask
 * @param {!Array<string>|undefined} custom
 * @return {!Array<string>}
 */
function paramsToMask(mask, custom) {
  return mask ? PERSONAL_DATA_CAMPAIGN_PARAMS.concat(custom || []) : [];
}

/**
 * @param {!Array<string>|undefined} customTrackedParams
 * @param {boolean=} maskPersonalData
 * @param {!Array<string>=} customPersonalData
 * @return {!Object<string, ?string>}
 */
export function getCampaignParams(customTrackedParams, maskPersonalData, customPersonalData) {
  if (!doc) return {};
  const urlParams = getCampaignParamsFromUrl(
      /** @type {string} */ (maskQueryParams(doc.URL, paramsToMask(maskPersonalData, customPersonalData), MASKED)),
      customTrackedParams);
  const cookieParams = {};
  COOKIE_CAMPAIGN_PARAMS.forEach(function(k) {
    const v = getCookieValue(k);
    cookieParams[k] = v ? v : null;
  });
  return /** @type {!Object<string, ?string>} */ (extend(cookieParams, urlParams));
}

/**
 * @param {string} url
 * @param {!Array<string>=} customParams
 * @return {!Object<string, ?string>}
 */
function getCampaignParamsFromUrl(url, customParams) {
  const params = {};
  CAMPAIGN_PARAMS.concat(customParams || []).forEach(function(k) {
    const v = getQueryParam(url, k);
    params[k] = v ? v : null;
  });
  return params;
}

/**
 * @param {string} referrer
 * @return {?string}
 */
function getSearchEngine(referrer) {
  if (!referrer) return null;
  if (referrer.search(URL_REGEX_PREFIX + 'google.([^/?]*)') === 0) return 'google';
  if (referrer.search(URL_REGEX_PREFIX + 'bing.com') === 0) return 'bing';
  if (referrer.search(URL_REGEX_PREFIX + 'yahoo.com') === 0) return 'yahoo';
  if (referrer.search(URL_REGEX_PREFIX + 'duckduckgo.com') === 0) return 'duckduckgo';
  return null;
}

/**
 * @param {string} referrer
 * @return {!Object}
 */
function getSearchInfoFromReferrer(referrer) {
  const search = getSearchEngine(referrer);
  const param = search != 'yahoo' ? 'q' : 'p';
  const ret = {};
  if (!isNull(search)) {
    ret['$search_engine'] = search;
    const keyword = doc ? getQueryParam(doc.referrer, param) : '';
    if (keyword.length) ret['ph_keyword'] = keyword;
  }
  return ret;
}

/** @return {!Object} */
export function getSearchInfo() {
  const referrer = doc ? doc.referrer : undefined;
  if (!referrer) return {};
  return getSearchInfoFromReferrer(referrer);
}

/** @return {string|undefined} */
export function getBrowserLanguage() {
  return nav ? nav.language || nav['userLanguage'] : undefined;
}

/** @return {string|undefined} */
function getBrowserLanguagePrefix() {
  const lang = getBrowserLanguage();
  return isString(lang) ? lang.split('-')[0] : undefined;
}

/** @return {string} */
function getReferrer() {
  return (doc && doc.referrer) || DIRECT;
}

/** @return {string} */
function getReferringDomain() {
  if (!doc || !doc.referrer) return DIRECT;
  const u = convertToURL(doc.referrer);
  return (u && u.host) || DIRECT;
}

/** @return {!Object} */
export function getReferrerInfo() {
  return {'$referrer': getReferrer(), '$referring_domain': getReferringDomain()};
}

/**
 * @param {boolean|undefined} maskPersonalData
 * @param {!Array<string>|undefined} customPersonalData
 * @param {boolean=} disableHashes
 * @return {!Object}
 */
export function getPersonInfo(maskPersonalData, customPersonalData, disableHashes) {
  const href = disableHashes ? stripUrlHash(loc ? loc.href : undefined) : (loc ? loc.href : undefined);
  const url = href ? href.substring(0, 1000) : href;
  return {
    'r': getReferrer().substring(0, 1000),
    'u': url ? maskQueryParams(url, paramsToMask(maskPersonalData, customPersonalData), MASKED) : undefined,
  };
}

/**
 * @param {!Object} info {r, u}
 * @param {boolean=} disableHashes
 * @return {!Object}
 */
export function getPersonPropsFromInfo(info, disableHashes) {
  const referrer = info['r'];
  const u = info['u'];
  const url = disableHashes ? stripUrlHash(u) : u;
  let referringDomain;
  if (referrer == null) {
    referringDomain = undefined;
  } else if (referrer == DIRECT) {
    referringDomain = DIRECT;
  } else {
    const parsed = convertToURL(referrer);
    referringDomain = parsed ? parsed.host : undefined;
  }
  const props = {'$referrer': referrer, '$referring_domain': referringDomain};
  if (url) {
    props['$current_url'] = url;
    const l = convertToURL(url);
    props['$host'] = l ? l.host : undefined;
    props['$pathname'] = l ? l.pathname : undefined;
    extend(props, getCampaignParamsFromUrl(url));
  }
  if (referrer) extend(props, getSearchInfoFromReferrer(referrer));
  return props;
}

/**
 * @param {!Object} info
 * @param {boolean=} disableHashes
 * @return {!Object}
 */
export function getInitialPersonPropsFromInfo(info, disableHashes) {
  const props = {};
  each(getPersonPropsFromInfo(info, disableHashes), function(v, k) {
    props['$initial_' + stripLeadingDollar(k)] = v;
  });
  return props;
}

/** @return {string|undefined} */
export function getTimezone() {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch (e) {
    return undefined;
  }
}

/** @return {number|undefined} */
function getTimezoneOffset() {
  try {
    return new Date().getTimezoneOffset();
  } catch (e) {
    return undefined;
  }
}

/**
 * @param {boolean|undefined} maskPersonalData
 * @param {!Array<string>|undefined} customPersonalData
 * @param {boolean|undefined} detectGoogleSearchApp
 * @param {boolean=} disableHashes
 * @return {!Object}
 */
export function getEventProperties(maskPersonalData, customPersonalData, detectGoogleSearchApp, disableHashes) {
  if (!userAgent) return {};
  const masked = paramsToMask(maskPersonalData, customPersonalData);
  const os = detectOS(userAgent);
  const webview = detectWebviewApp(userAgent);
  const hints = /** @type {!BrowserDetectionHints} */ (nav && nav['brave'] ? {brave: true} : {});
  const browserOptions = /** @type {!BrowserDetectionOptions} */ ({});
  if (!isUndefined(detectGoogleSearchApp)) browserOptions.detectGoogleSearchApp = detectGoogleSearchApp;
  const deviceOptions = /** @type {!DeviceTypeOptions} */ ({});
  const uaData = nav ? nav['userAgentData'] : undefined;
  const platform = uaData ? uaData['platform'] : undefined;
  const maxTouchPoints = nav ? nav['maxTouchPoints'] : undefined;
  const screenWidth = win && win.screen ? win.screen.width : undefined;
  const screenHeight = win && win.screen ? win.screen.height : undefined;
  const dpr = win ? win.devicePixelRatio : undefined;
  if (!isUndefined(platform)) deviceOptions.userAgentDataPlatform = platform;
  if (!isUndefined(maxTouchPoints)) deviceOptions.maxTouchPoints = maxTouchPoints;
  if (!isUndefined(screenWidth)) deviceOptions.screenWidth = screenWidth;
  if (!isUndefined(screenHeight)) deviceOptions.screenHeight = screenHeight;
  if (!isUndefined(dpr)) deviceOptions.devicePixelRatio = dpr;
  const vendor = nav ? nav['vendor'] : undefined;
  const href = loc ? loc.href : undefined;

  const properties = extend(stripEmptyProperties({
    '$os': os[0],
    '$os_version': os[1],
    '$browser': detectBrowser(userAgent, vendor, hints, browserOptions),
    '$webview_app': webview[0],
    '$webview_app_version': webview[1],
    '$device': detectDevice(userAgent),
    '$device_type': detectDeviceType(userAgent, deviceOptions),
    '$timezone': getTimezone(),
    '$timezone_offset': getTimezoneOffset(),
  }), {
    '$current_url': maskQueryParams(disableHashes ? stripUrlHash(href) : href, masked, MASKED),
    '$host': loc ? loc.host : undefined,
    '$pathname': loc ? loc.pathname : undefined,
    '$raw_user_agent': userAgent.length > 1000 ? userAgent.substring(0, 997) + '...' : userAgent,
    '$browser_version': detectBrowserVersion(userAgent, vendor, hints, browserOptions),
    '$browser_language': getBrowserLanguage(),
    '$browser_language_prefix': getBrowserLanguagePrefix(),
    '$screen_height': win && win.screen ? win.screen.height : undefined,
    '$screen_width': win && win.screen ? win.screen.width : undefined,
    '$viewport_height': win ? win.innerHeight : undefined,
    '$viewport_width': win ? win.innerWidth : undefined,
    '$lib': Config.LIB_NAME,
    '$lib_version': Config.LIB_VERSION,
    '$insert_id': Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10),
    '$time': new Date().getTime() / 1000,
  });
  if (Config.SDK_DIST_CHANNEL) properties[SDK_DIST_CHANNEL_KEY] = Config.SDK_DIST_CHANNEL;
  return properties;
}
