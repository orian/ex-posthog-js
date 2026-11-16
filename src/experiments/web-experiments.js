/**
 * @fileoverview No-code web experiments (optional, requires the feature
 * flags module). Port of upstream web-experiments.ts: fetches
 * `/api/web_experiments/`, and applies a variant's `html` (sanitised like
 * upstream's DOMPurify setup, see sanitizer.js) and `css` transforms. Like
 * upstream, `disable_web_experiments` defaults to true.
 */
import {PostHog} from '../core/posthog.js';
import {Extension} from '../core/extensions.js';
import {RequestOptions} from '../core/request.js';
import {logger} from '../core/logger.js';
import {getCampaignParams} from '../core/event-utils.js';
import {isLikelyBot} from '../core/user-agent.js';
import {doc, getQueryParam, isFunction, isNullish, isString, nav, win} from '../core/utils.js';
import {WEB_EXPERIMENTS} from '../core/constants.js';
import {sanitizeExperimentHtml} from './sanitizer.js';

const BOT_REFUSE_MSG = 'Refusing to render web experiment since the viewer is a likely bot';

/**
 * @param {string} value
 * @param {string} pattern
 * @return {boolean}
 */
function isMatchingRegex(value, pattern) {
  try {
    return new RegExp(pattern).test(value);
  } catch (e) {
    return false;
  }
}

/** @const {!Object<string, function(string, string): boolean>} */
export const webExperimentUrlValidationMap = {
  'icontains': function(c, href) {
    return href.toLowerCase().indexOf(c.toLowerCase()) > -1;
  },
  'not_icontains': function(c, href) {
    return href.toLowerCase().indexOf(c.toLowerCase()) === -1;
  },
  'regex': function(c, href) {
    return isMatchingRegex(href, c);
  },
  'not_regex': function(c, href) {
    return !isMatchingRegex(href, c);
  },
  'exact': function(c, href) {
    return href === c;
  },
  'is_not': function(c, href) {
    return href !== c;
  },
};

/**
 * @param {*} x
 * @param {string} msg
 */
function logInfo(x, msg) {
  logger.info('[WebExperiments] ' + msg, x);
}

/** @implements {Extension} */
export class WebExperiments {
  /** @param {!PostHog} instance */
  constructor(instance) {
    /** @private @const {!PostHog} */
    this.ph_ = instance;
    /** @private {?Object<string, !Object>} flag key -> experiment */
    this.flagToExperiments_ = null;
    const self = this;
    instance.onFeatureFlags(function(flags) {
      self.onFeatureFlags(flags);
    });
  }

  /** @return {!Object} @private */
  config_() {
    return this.ph_.config;
  }

  /** @param {!Array<string>} flags */
  onFeatureFlags(flags) {
    if (this.isBot_()) {
      logInfo([], BOT_REFUSE_MSG);
      return;
    }
    if (this.config_()['disable_web_experiments']) return;
    if (isNullish(this.flagToExperiments_)) {
      this.flagToExperiments_ = {};
      this.loadIfEnabled();
      this.previewWebExperiment();
      return;
    }
    logInfo([flags], 'applying feature flags');
    const self = this;
    flags.forEach(function(flag) {
      const map = self.flagToExperiments_;
      if (map && Object.prototype.hasOwnProperty.call(map, flag)) {
        const variant = self.ph_.getFeatureFlag(flag);
        const exp = map[flag];
        if (variant && exp && exp['variants'][/** @type {string} */ (variant)]) {
          self.applyVariantForFlag_(exp, /** @type {string} */ (variant));
        }
      }
    });
  }

  previewWebExperiment() {
    const location = win ? win.location : null;
    if (location && location.search) {
      const id = getQueryParam(location.search, '__experiment_id');
      const variant = getQueryParam(location.search, '__experiment_variant');
      if (id && variant) {
        logInfo([], 'previewing web experiments ' + id + ' && ' + variant);
        const self = this;
        this.getWebExperiments(function(exps) {
          self.showPreview_(parseInt(id, 10), variant, exps);
        }, false, true);
      }
    }
  }

  loadIfEnabled() {
    if (this.config_()['disable_web_experiments']) return;
    this.getWebExperimentsAndEvaluateDisplayLogic();
  }

  /** @param {boolean=} forceReload */
  getWebExperimentsAndEvaluateDisplayLogic(forceReload) {
    const self = this;
    this.getWebExperiments(function(exps) {
      logInfo([], 'retrieved web experiments from the server');
      self.flagToExperiments_ = {};
      exps.forEach(function(exp) {
        if (exp['feature_flag_key']) {
          if (self.flagToExperiments_) self.flagToExperiments_[exp['feature_flag_key']] = exp;
          const variant = self.ph_.getFeatureFlag(exp['feature_flag_key']);
          if (isString(variant) && exp['variants'][/** @type {string} */ (variant)]) {
            self.applyVariantForFlag_(exp, /** @type {string} */ (variant));
          }
        } else if (exp['variants']) {
          for (const name in exp['variants']) {
            const v = exp['variants'][name];
            if (WebExperiments.matchesTestVariant_(v, self.config_())) {
              self.applyTransforms_(exp['name'], name, v['transforms']);
            }
          }
        }
      });
    }, !!forceReload);
  }

  /**
   * @param {function(!Array<!Object>)} callback
   * @param {boolean} forceReload
   * @param {boolean=} previewing
   */
  getWebExperiments(callback, forceReload, previewing) {
    if (this.config_()['disable_web_experiments'] && !previewing) return callback([]);
    const existing = this.ph_.get_property(WEB_EXPERIMENTS);
    if (existing && !forceReload) return callback(/** @type {!Array<!Object>} */ (existing));
    this.ph_.sendRequest(/** @type {!RequestOptions} */ ({
      url: this.ph_.endpointFor('api', '/api/web_experiments/?token=' + this.config_()['token']),
      method: 'GET',
      timestampMode: 'query',
      callback: function(response) {
        if (response.statusCode !== 200 || !response.json) return callback([]);
        return callback(response.json['experiments'] || []);
      },
    }));
    return undefined;
  }

  /**
   * @param {number} id
   * @param {string} variant
   * @param {!Array<!Object>} exps
   * @private
   */
  showPreview_(id, variant, exps) {
    const preview = exps.filter(function(e) {
      return e['id'] === id;
    });
    if (preview && preview.length > 0) {
      logInfo([], 'Previewing web experiment [' + preview[0]['name'] + '] with variant [' + variant + ']');
      this.applyTransforms_(preview[0]['name'], variant, preview[0]['variants'][variant]['transforms']);
    }
  }

  /**
   * @param {!Object} exp
   * @param {string} variant
   * @private
   */
  applyVariantForFlag_(exp, variant) {
    const v = exp['variants'][variant];
    if (!WebExperiments.matchUrlConditions_(v, this.config_())) {
      logInfo([], 'skipping variant ' + variant + ' of experiment ' + exp['name'] +
          ' because this page does not match its url conditions');
      return;
    }
    this.applyTransforms_(exp['name'], variant, v['transforms']);
  }

  /**
   * @param {!Object} v
   * @param {!Object} config
   * @return {boolean}
   * @private
   */
  static matchesTestVariant_(v, config) {
    if (isNullish(v['conditions'])) return false;
    return WebExperiments.matchUrlConditions_(v, config) && WebExperiments.matchUTMConditions_(v);
  }

  /**
   * @param {!Object} v
   * @param {!Object} config
   * @return {boolean}
   * @private
   */
  static matchUrlConditions_(v, config) {
    const cond = v['conditions'];
    if (isNullish(cond) || isNullish(cond['url'])) return true;
    const location = win ? win.location : null;
    if (location) {
      let href = location.href;
      const getUrl = config['get_current_url'];
      if (isFunction(getUrl)) {
        try {
          const overridden = getUrl(href);
          if (isString(overridden) && overridden) href = overridden;
        } catch (e) {}
      }
      return cond['url'] ? webExperimentUrlValidationMap[cond['urlMatchType'] || 'icontains'](cond['url'], href) : true;
    }
    return false;
  }

  /**
   * @param {!Object} v
   * @return {boolean}
   * @private
   */
  static matchUTMConditions_(v) {
    const cond = v['conditions'];
    if (isNullish(cond) || isNullish(cond['utm'])) return true;
    const params = getCampaignParams(undefined);
    if (params['utm_source']) {
      const utm = cond['utm'];
      const ok = function(k) {
        return utm[k] ? utm[k] == params[k] : true;
      };
      return ok('utm_campaign') && ok('utm_medium') && ok('utm_term') && ok('utm_source');
    }
    return false;
  }

  /**
   * @param {string} experiment
   * @param {string} variant
   * @param {!Array<!Object>} transforms
   * @private
   */
  applyTransforms_(experiment, variant, transforms) {
    if (this.isBot_()) {
      logInfo([], BOT_REFUSE_MSG);
      return;
    }
    if (variant === 'control') {
      logInfo([], 'Control variants leave the page unmodified.');
      return;
    }
    transforms.forEach(function(transform) {
      if (!transform['selector']) return;
      logInfo(transform, 'applying transform of variant ' + variant + ' for experiment ' + experiment + ' ');
      const elements = doc ? doc.querySelectorAll(transform['selector']) : null;
      if (!elements || !elements.length) {
        logger.warn('[WebExperiments] no element on this page matches selector ' + transform['selector'] +
            ' of variant ' + variant + ' for experiment ' + experiment, []);
        return;
      }
      const sanitized = {};
      for (let i = 0; i < elements.length; i++) {
        const element = /** @type {!HTMLElement} */ (elements[i]);
        if (String(element.localName).toLowerCase() === 'script') continue;
        if (transform['html']) {
          const encoding = element.namespaceURI === 'http://www.w3.org/1998/Math/MathML' &&
              element.localName === 'annotation-xml' ? (element.getAttribute('encoding') || '').toLowerCase() : '';
          const contextKey = JSON.stringify([element.namespaceURI, element.localName, encoding]);
          let html = sanitized[contextKey];
          if (isNullish(html)) {
            html = sanitizeExperimentHtml(element, String(transform['html']));
            sanitized[contextKey] = html;
          }
          element.innerHTML = html;
        }
        if (transform['css']) element.setAttribute('style', transform['css']);
      }
    });
  }

  /** @return {boolean} @private */
  isBot_() {
    return nav ? isLikelyBot(nav, this.config_()['custom_blocked_useragents']) : false;
  }
}
