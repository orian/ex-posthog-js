/**
 * @fileoverview No-code web experiments module (optional, requires the
 * feature flags module). Fetches `/api/web_experiments/` and applies the
 * variant's DOM transforms.
 *
 * Safety: upstream sanitises `html` transforms with DOMPurify. This port does
 * not bundle a sanitizer, so `html` transforms are only applied when the host
 * supplies `web_experiments_html_sanitizer: (html) => safeHtml` in config.
 * `text`, `css`, `attributes` and `imgUrl` transforms are applied directly
 * (they cannot inject markup).
 */
import {PostHog} from '../core/posthog.js';
import {Extension, FeatureFlagsApi} from '../core/extensions.js';
import {request, HttpResponse} from '../core/request.js';
import {logger} from '../core/logger.js';
import {getCampaignParams} from '../core/persistence.js';
import {isLikelyBot} from '../core/event-props.js';
import {doc, getQueryParam, isArray, isFunction, isNullish, isObject, isString, userAgent, win} from '../core/utils.js';

/** @const {string} */
const WEB_EXPERIMENTS_KEY = '$web_experiments';

/** @type {!Object<string, function(string, string): boolean>} */
const URL_MATCHERS = {
  'exact': function(cond, href) {
    return href === cond;
  },
  'is_not': function(cond, href) {
    return href !== cond;
  },
  'regex': function(cond, href) {
    return safeRegexTest(cond, href);
  },
  'not_regex': function(cond, href) {
    return !safeRegexTest(cond, href);
  },
  'icontains': function(cond, href) {
    return href.toLowerCase().indexOf(cond.toLowerCase()) !== -1;
  },
  'not_icontains': function(cond, href) {
    return href.toLowerCase().indexOf(cond.toLowerCase()) === -1;
  },
};

/**
 * @param {string} pattern
 * @param {string} value
 * @return {boolean}
 */
function safeRegexTest(pattern, value) {
  try {
    return new RegExp(pattern).test(value);
  } catch (e) {
    return false;
  }
}

/** @implements {Extension} */
export class WebExperiments {
  /** @param {!PostHog} instance */
  constructor(instance) {
    /** @private @const {!PostHog} */
    this.ph_ = instance;
    /** @private {!Array<!Object>} */
    this.experiments_ = [];
    /** Applied experiment names, so re-evaluation doesn't re-apply. @private {!Object<string, string>} */
    this.applied_ = {};
  }

  /** @private @return {?FeatureFlagsApi} */
  flags_() {
    const f = this.ph_.extensions['featureFlags'];
    return f ? /** @type {!FeatureFlagsApi} */ (f) : null;
  }

  /** @override */
  onInit() {
    const c = this.ph_.config;
    if (c['disable_web_experiments']) return;
    if (!this.flags_()) {
      logger.warn('[WebExperiments] feature flags module is required; experiments disabled');
      return;
    }
    if (isLikelyBot(userAgent, c['custom_blocked_useragents'])) return;
    this.handlePreview_();
    const self = this;
    this.load_(function() {
      // Flags may already be loaded; onFlags fires immediately in that case
      // and again whenever they change.
      /** @type {!FeatureFlagsApi} */ (self.flags_()).onFlags(function() {
        self.evaluate_();
      });
      self.evaluate_();
    });
  }

  /**
   * @param {function()} done
   * @private
   */
  load_(done) {
    const self = this;
    const cached = this.ph_.get_property(WEB_EXPERIMENTS_KEY);
    if (isArray(cached)) {
      this.experiments_ = /** @type {!Array<!Object>} */ (cached);
      done();
    }
    request({
      url: this.ph_.apiUrl('/api/web_experiments/?token=' + encodeURIComponent(this.ph_.config['token'])),
      method: 'GET',
      data: undefined,
      headers: this.ph_.config['request_headers'],
      compression: undefined,
      transport: undefined,
      timeout: undefined,
      callback: function(/** !HttpResponse */ res) {
        if (res.statusCode !== 200 || !isObject(res.json)) return;
        const list = res.json['experiments'];
        self.experiments_ = isArray(list) ? list : [];
        self.ph_.register({[WEB_EXPERIMENTS_KEY]: self.experiments_});
        if (!isArray(cached)) done();
        else self.evaluate_();
      },
    });
  }

  /** @private */
  evaluate_() {
    const flags = this.flags_();
    const self = this;
    this.experiments_.forEach(function(exp) {
      const variants = exp['variants'] || {};
      const flagKey = exp['feature_flag_key'];
      if (flagKey && flags) {
        const variant = flags.getFlag(flagKey, {'send_event': false});
        if (isString(variant) && variants[variant] && self.matchesUrl_(variants[variant])) {
          self.apply_(exp, /** @type {string} */ (variant));
        }
      } else {
        for (const name in variants) {
          const v = variants[name];
          if (v && v['conditions'] && self.matchesUrl_(v) && self.matchesUtm_(v)) {
            self.apply_(exp, name);
          }
        }
      }
    });
  }

  /** Supports `?__experiment_id=1&__experiment_variant=test` previews. @private */
  handlePreview_() {
    if (!win) return;
    const id = getQueryParam(win.location.search, '__experiment_id');
    const variant = getQueryParam(win.location.search, '__experiment_variant');
    if (!id || !variant) return;
    const self = this;
    this.load_(function() {
      self.experiments_.forEach(function(exp) {
        if (String(exp['id']) === id && exp['variants'] && exp['variants'][variant]) {
          self.apply_(exp, variant);
        }
      });
    });
  }

  /**
   * @param {!Object} variant
   * @return {boolean}
   * @private
   */
  matchesUrl_(variant) {
    const cond = variant['conditions'];
    if (isNullish(cond) || isNullish(cond['url'])) return true;
    if (!win) return false;
    const matcher = URL_MATCHERS[cond['urlMatchType'] || 'icontains'] || URL_MATCHERS['icontains'];
    return matcher(String(cond['url']), win.location.href);
  }

  /**
   * @param {!Object} variant
   * @return {boolean}
   * @private
   */
  matchesUtm_(variant) {
    const utm = variant['conditions'] ? variant['conditions']['utm'] : null;
    if (isNullish(utm)) return true;
    const params = getCampaignParams();
    if (!params['utm_source']) return false;
    const keys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term'];
    for (let i = 0; i < keys.length; i++) {
      if (utm[keys[i]] && utm[keys[i]] != params[keys[i]]) return false;
    }
    return true;
  }

  /**
   * @param {!Object} exp
   * @param {string} variantName
   * @private
   */
  apply_(exp, variantName) {
    const key = String(exp['id']);
    if (this.applied_[key] === variantName) return;
    this.applied_[key] = variantName;
    if (variantName === 'control') return; // control leaves the page untouched
    const transforms = (exp['variants'][variantName] || {})['transforms'] || [];
    const sanitizer = this.ph_.config['web_experiments_html_sanitizer'];
    transforms.forEach(function(t) {
      if (!t || !t['selector'] || !doc) return;
      let nodes;
      try {
        nodes = doc.querySelectorAll(t['selector']);
      } catch (e) {
        logger.warn('[WebExperiments] invalid selector', t['selector']);
        return;
      }
      if (!nodes.length) {
        logger.warn('[WebExperiments] no element matches ' + t['selector']);
        return;
      }
      for (let i = 0; i < nodes.length; i++) {
        const el = /** @type {!HTMLElement} */ (nodes[i]);
        if (el.tagName.toLowerCase() === 'script') continue;
        if (isString(t['text'])) el.textContent = t['text'];
        if (isString(t['html'])) {
          if (isFunction(sanitizer)) {
            el.innerHTML = String(sanitizer(t['html']));
          } else {
            logger.warn('[WebExperiments] html transform skipped: set web_experiments_html_sanitizer to enable');
          }
        }
        if (isString(t['css'])) el.setAttribute('style', t['css']);
        if (isString(t['imgUrl']) && el.tagName.toLowerCase() === 'img' && /^https?:\/\//i.test(t['imgUrl'])) {
          el.setAttribute('src', t['imgUrl']);
        }
        if (isArray(t['attributes'])) {
          t['attributes'].forEach(function(a) {
            const name = String(a['name'] || '').toLowerCase();
            // Event-handler and javascript: attributes could execute code.
            if (!name || name.indexOf('on') === 0) return;
            const value = String(a['value']);
            if ((name === 'href' || name === 'src' || name === 'action') && /^\s*javascript:/i.test(value)) return;
            el.setAttribute(name, value);
          });
        }
      }
    });
    logger.info('[WebExperiments] applied variant ' + variantName + ' of ' + exp['name']);
  }
}
