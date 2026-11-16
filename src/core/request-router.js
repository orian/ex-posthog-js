/**
 * @fileoverview Endpoint routing (port of upstream utils/request-router.ts).
 * `endpointFor(target, path)` resolves 'api' | 'assets' | 'ui' | 'flags'
 * URLs, deriving the region-specific ingestion/asset hosts for PostHog Cloud
 * and honouring `flags_api_host`, `ui_host`, `asset_host` and
 * `rewriteRequestPath`.
 */
import {convertToURL, isFunction} from './utils.js';

/** @enum {string} */
export const RequestRouterRegion = {US: 'us', EU: 'eu', CUSTOM: 'custom'};

const INGESTION_DOMAIN = 'i.posthog.com';

export class RequestRouter {
  /** @param {function(): !Object} getConfig */
  constructor(getConfig) {
    /** @private @const */
    this.getConfig_ = getConfig;
    /** @private @const {!Object<string, string>} */
    this.regionCache_ = {};
  }

  /** @return {string} */
  apiHost() {
    const host = String(this.getConfig_()['api_host']).replace(/^\s+|\s+$/g, '').replace(/\/$/, '');
    return host === 'https://app.posthog.com' ? 'https://us.i.posthog.com' : host;
  }

  /** @return {string} */
  flagsApiHost() {
    const custom = this.getConfig_()['flags_api_host'];
    if (custom) return String(custom).replace(/^\s+|\s+$/g, '').replace(/\/$/, '');
    return this.apiHost();
  }

  /** @return {string} */
  uiHost() {
    const ui = this.getConfig_()['ui_host'];
    let host = ui ? String(ui).replace(/\/$/, '') : '';
    if (!host) host = this.apiHost().replace('.' + INGESTION_DOMAIN, '.posthog.com');
    return host === 'https://app.posthog.com' ? 'https://us.posthog.com' : host;
  }

  /** @return {string} one of RequestRouterRegion */
  region() {
    const apiHost = this.apiHost();
    if (!this.regionCache_[apiHost]) {
      if (/https:\/\/(app|us|us-assets)(\.i)?\.posthog\.com/i.test(apiHost)) {
        this.regionCache_[apiHost] = RequestRouterRegion.US;
      } else if (/https:\/\/(eu|eu-assets)(\.i)?\.posthog\.com/i.test(apiHost)) {
        this.regionCache_[apiHost] = RequestRouterRegion.EU;
      } else {
        this.regionCache_[apiHost] = RequestRouterRegion.CUSTOM;
      }
    }
    return this.regionCache_[apiHost];
  }

  /**
   * @param {string} path
   * @return {string|undefined}
   * @private
   */
  staticAssetHostOverride_(path) {
    if (!/^\/static\//.test(path)) return undefined;
    const override = this.getConfig_()['asset_host'];
    if (typeof override !== 'string') return undefined;
    const normalized = override.replace(/^\s+|\s+$/g, '').replace(/\/$/, '');
    return normalized || undefined;
  }

  /**
   * @param {string} target
   * @param {string} url
   * @return {string}
   * @private
   */
  prepare_(target, url) {
    if (target === 'ui') return url;
    const rewrite = this.getConfig_()['rewriteRequestPath'];
    if (isFunction(rewrite)) {
      const parsed = convertToURL(url);
      const U = /** @type {?} */ (window['URL']);
      return String(rewrite(new U(parsed ? parsed.href : url)));
    }
    return url;
  }

  /**
   * @param {string} target 'api' | 'assets' | 'ui' | 'flags'
   * @param {string=} path
   * @return {string}
   */
  endpointFor(target, path) {
    let p = path || '';
    if (p) p = p.charAt(0) === '/' ? p : '/' + p;
    if (target === 'ui') return this.prepare_(target, this.uiHost() + p);
    if (target === 'flags') return this.prepare_(target, this.flagsApiHost() + p);
    if (target === 'assets') {
      const override = this.staticAssetHostOverride_(p);
      if (override) return this.prepare_(target, override + p);
    }
    if (this.region() === RequestRouterRegion.CUSTOM) return this.prepare_(target, this.apiHost() + p);
    const suffix = INGESTION_DOMAIN + p;
    if (target === 'assets') return this.prepare_(target, 'https://' + this.region() + '-assets.' + suffix);
    return this.prepare_(target, 'https://' + this.region() + '.' + suffix);
  }
}
