/**
 * @fileoverview Web vitals (optional module). Port of upstream
 * browser/src/extensions/web-vitals/index.ts: buffers LCP / CLS / FCP / INP
 * reports per navigation and sends them as one `$web_vitals` event when every
 * allowed metric arrived, after `web_vitals_delayed_flush_ms` (5 s), when the
 * navigation changes, or (by beacon) when the page is hidden or unloaded.
 * Enabled by `capture_performance` (`true` or `{web_vitals: true}`) or the
 * remote `capturePerformance.web_vitals`, persisted as
 * `$web_vitals_enabled_server_side` (with `$web_vitals_allowed_metrics`).
 *
 * Difference from upstream: upstream lazy-loads PostHog's
 * `/static/web-vitals*.js`, which bundles Google's web-vitals 6.2.1. Here the
 * same web-vitals release is compiled in (third_party/web-vitals), so the
 * observers are registered synchronously when the module starts, instead of
 * once that script has loaded. Callbacks already present on
 * `window.__PosthogExtensions__` (e.g. a page that loaded PostHog's script
 * itself) are used first, as upstream does.
 */
import {PostHog} from '../core/posthog.js';
import {Extension} from '../core/extensions.js';
import {logger as baseLogger} from '../core/logger.js';
import {MASKED, paramsToMask} from '../core/event-utils.js';
import {
  addEventListener, assign, isArray, isBoolean, isNullish, isNumber, isObject, isUndefined, maskQueryParams,
  stripUrlHash, win,
} from '../core/utils.js';
import {onCLS, onFCP, onINP, onLCP} from '../../third_party/web-vitals/metrics.js';
import {
  onCLS as onCLSWithAttribution, onFCP as onFCPWithAttribution, onINP as onINPWithAttribution,
  onLCP as onLCPWithAttribution, startResourceBuffer,
} from '../../third_party/web-vitals/attribution.js';

const logger = baseLogger.createLogger('[Web Vitals]');

/** @const {string} */
export const WEB_VITALS_ENABLED_SERVER_SIDE = '$web_vitals_enabled_server_side';
/** @const {string} */
export const WEB_VITALS_ALLOWED_METRICS = '$web_vitals_allowed_metrics';

export const DEFAULT_FLUSH_TO_CAPTURE_TIMEOUT_MILLISECONDS = 5000;
const ONE_MINUTE_IN_MILLIS = 60 * 1000;
export const FIFTEEN_MINUTES_IN_MILLIS = 15 * ONE_MINUTE_IN_MILLIS;

// INP and LCP are attributed by default (CLS attribution leaks detached nodes in SPAs).
/** @const {!Array<string>} */
const ALL_WEB_VITALS_METRICS = ['CLS', 'FCP', 'INP', 'LCP'];
/** @const {!Array<string>} */
const DEFAULT_WEB_VITALS_ATTRIBUTION_METRICS = ['INP', 'LCP'];

// Only these small scalar attribution fields are kept, so the payload stays bounded.
/** @const {!Array<string>} */
const WEB_VITALS_ATTRIBUTION_ALLOWLIST = [
  // INP: which element was interacted with, plus the phase breakdown
  'interactionTarget', 'interactionType', 'inputDelay', 'processingDuration', 'presentationDelay', 'loadState',
  // LCP: which element rendered, plus the load-phase breakdown
  'target', 'url', 'timeToFirstByte', 'resourceLoadDelay', 'resourceLoadDuration', 'elementRenderDelay',
  // CLS: the single largest shift
  'largestShiftTarget', 'largestShiftTime', 'largestShiftValue',
  // FCP
  'firstByteToFCP',
];

/**
 * A metric observer registration function (onLCP, onCLS, ...).
 * @typedef {function(function(?), !Object=)}
 */
let MetricCallback;

/**
 * Upstream WebVitalsCallbacks (quoted keys: 'onLCP', 'onCLS', 'onFCP',
 * 'onINP', and 'withoutAttribution' in the attribution flavors).
 * @typedef {!Object}
 */
let WebVitalsCallbacks;

/** @const {!WebVitalsCallbacks} */
const CALLBACKS = {'onLCP': onLCP, 'onCLS': onCLS, 'onFCP': onFCP, 'onINP': onINP};
/** @const {!WebVitalsCallbacks} */
const CALLBACKS_WITH_ATTRIBUTION = {
  'onLCP': onLCPWithAttribution, 'onCLS': onCLSWithAttribution, 'onFCP': onFCPWithAttribution,
  'onINP': onINPWithAttribution, 'withoutAttribution': CALLBACKS,
};

/**
 * The built-in callbacks for a flavor (what upstream's /static/<flavor>.js
 * defines). The soft-navigation builds are the same web-vitals release.
 * @param {string} flavor
 * @return {!WebVitalsCallbacks}
 */
function builtInCallbacks(flavor) {
  return flavor.indexOf('with-attribution') !== -1 ? CALLBACKS_WITH_ATTRIBUTION : CALLBACKS;
}

/** @return {?Object} `window.__PosthogExtensions__` */
function posthogExtensions() {
  const ext = win ? win['__PosthogExtensions__'] : undefined;
  return isObject(ext) ? /** @type {!Object} */ (ext) : null;
}

/**
 * Callbacks some other script already put on `window.__PosthogExtensions__`
 * (upstream's lookup in `_loadScript` / `_startCapturing`).
 * @param {string} flavor
 * @return {!WebVitalsCallbacks|undefined}
 */
function externalCallbacks(flavor) {
  const ext = posthogExtensions();
  const byFlavor = ext ? ext['postHogWebVitalsCallbacksByFlavor'] : undefined;
  if (byFlavor && byFlavor[flavor]) return byFlavor[flavor];
  if (flavor === 'web-vitals' && isUndefined(byFlavor) && ext && ext['postHogWebVitalsCallbacks']) {
    return ext['postHogWebVitalsCallbacks'];
  }
  return undefined;
}

/**
 * @typedef {{navigationKey: (string|undefined), url: (string|undefined), metrics: !Array<!Object>,
 *     firstMetricTimestamp: (number|undefined)}}
 */
let WebVitalsEventBuffer;

/** @return {!WebVitalsEventBuffer} */
function emptyBuffer() {
  return {navigationKey: undefined, url: undefined, metrics: [], firstMetricTimestamp: undefined};
}

/** @implements {Extension} */
export class WebVitalsAutocapture {
  /** @param {!PostHog} instance */
  constructor(instance) {
    /** @type {!PostHog} */
    this.instance = instance;
    /** @type {boolean} */
    this.enabledServerSide = !!(instance.persistence && instance.persistence.props[WEB_VITALS_ENABLED_SERVER_SIDE]);
    /** @type {boolean} */
    this.initialized = false;
    /** @type {!WebVitalsEventBuffer} */
    this.buffer = emptyBuffer();
    /** @private {number|undefined} */
    this.delayedFlushTimer_ = undefined;
    const self = this;
    /** @const {function(?)} */
    this.addToBuffer = function(metric) {
      self.add_(metric);
    };
  }

  /** Upstream starts from the constructor. */
  onInit() {
    this.startIfEnabled();
  }

  /**
   * @return {*} `capture_performance`
   * @private
   */
  perfConfig_() {
    return this.instance.config['capture_performance'];
  }

  /**
   * @param {string} key
   * @return {*} `capture_performance[key]` when it is an object
   * @private
   */
  perfOption_(key) {
    const c = this.perfConfig_();
    return isObject(c) ? c[key] : undefined;
  }

  /** @return {!Array<string>} */
  getAllowedMetrics() {
    const clientConfigMetricAllowList = this.perfOption_('web_vitals_allowed_metrics');
    if (!isNullish(clientConfigMetricAllowList)) return /** @type {!Array<string>} */ (clientConfigMetricAllowList);
    const persisted = this.instance.persistence ? this.instance.persistence.props[WEB_VITALS_ALLOWED_METRICS] : undefined;
    return persisted || ALL_WEB_VITALS_METRICS;
  }

  /** @return {number} */
  getFlushToCaptureTimeoutMs() {
    return /** @type {number} */ (this.perfOption_('web_vitals_delayed_flush_ms')) ||
        DEFAULT_FLUSH_TO_CAPTURE_TIMEOUT_MILLISECONDS;
  }

  /**
   * The metrics attribution is captured for: `true` all, `false` none, an
   * array names them, and the default attributes INP and LCP only.
   * @return {!Array<string>}
   */
  getAttributionMetrics() {
    const clientConfig = this.perfOption_('web_vitals_attribution');
    if (isBoolean(clientConfig)) return clientConfig ? ALL_WEB_VITALS_METRICS : [];
    if (isArray(clientConfig)) return /** @type {!Array<string>} */ (clientConfig);
    return DEFAULT_WEB_VITALS_ATTRIBUTION_METRICS;
  }

  /** @return {boolean} */
  shouldUseAttribution() {
    return this.getAttributionMetrics().length > 0;
  }

  /** @return {boolean} */
  shouldUseSoftNavs() {
    const clientConfig = this.perfOption_('__preview_web_vitals_soft_navs');
    return /** @type {boolean} */ (clientConfig != null ? clientConfig : false);
  }

  /** @return {number} */
  maxAllowedValue() {
    const v = this.perfOption_('__web_vitals_max_value');
    const configured = isNumber(v) ? /** @type {number} */ (v) : FIFTEEN_MINUTES_IN_MILLIS;
    // 0 disables the check; 1 ms to 1 minute would be a silly low maximum.
    return 0 < configured && configured <= ONE_MINUTE_IN_MILLIS ? FIFTEEN_MINUTES_IN_MILLIS : configured;
  }

  /** @return {boolean} */
  checkEnabled() {
    // Always disable web vitals if we're not on http or https
    const protocol = win && win.location ? win.location.protocol : undefined;
    if (protocol !== 'http:' && protocol !== 'https:') {
      logger.info('Web Vitals are disabled on non-http/https protocols');
      return false;
    }
    const c = this.perfConfig_();
    const clientConfig = isObject(c) ? c['web_vitals'] : isBoolean(c) ? c : undefined;
    return isBoolean(clientConfig) ? /** @type {boolean} */ (clientConfig) : this.enabledServerSide;
  }

  startIfEnabled() {
    if (this.checkEnabled() && !this.initialized) {
      logger.info('enabled, starting...');
      const self = this;
      this.loadScript_(function() {
        self.startCapturing_();
      });
    }
  }

  /** @param {?Object} response remote config, null when loading failed */
  onRemoteConfig(response) {
    // Failure behaves like a response without a capturePerformance key.
    if (!response || !('capturePerformance' in response)) return;
    const perf = response['capturePerformance'];
    const webVitalsOptIn = isObject(perf) && !!perf['web_vitals'];
    const allowedMetrics = isObject(perf) ? perf['web_vitals_allowed_metrics'] : undefined;
    const persistence = this.instance.persistence;
    if (persistence) {
      persistence.register({[WEB_VITALS_ENABLED_SERVER_SIDE]: webVitalsOptIn});
      persistence.register({[WEB_VITALS_ALLOWED_METRICS]: allowedMetrics});
    }
    // store this in-memory in case persistence is disabled
    this.enabledServerSide = webVitalsOptIn;
    this.startIfEnabled();
  }

  /** @return {string} */
  callbackFlavor() {
    return this.shouldUseSoftNavs() ?
        (this.shouldUseAttribution() ? 'web-vitals-with-attribution-soft-navs' : 'web-vitals-soft-navs') :
        (this.shouldUseAttribution() ? 'web-vitals-with-attribution' : 'web-vitals');
  }

  /**
   * Upstream `_loadScript`: uses callbacks already on
   * `__PosthogExtensions__`, else loads `/static/<flavor>.js`. The script is
   * compiled in here; like the script load, it is refused while
   * `disable_external_dependency_loading` is set.
   * @param {function()} cb
   * @private
   */
  loadScript_(cb) {
    const flavor = this.callbackFlavor();
    if (externalCallbacks(flavor)) {
      cb();
      return;
    }
    if (this.instance.config['disable_external_dependency_loading']) {
      logger.error('failed to load script', 'Loading of external scripts is disabled');
      return;
    }
    // The attribution build's module-level resource observer starts when it loads.
    if (builtInCallbacks(flavor) === CALLBACKS_WITH_ATTRIBUTION) startResourceBuffer();
    cb();
  }

  /**
   * @param {string=} url
   * @return {string|undefined}
   * @private
   */
  maskedURL_(url) {
    const href = url || (win ? win.location.href : undefined);
    if (!href) {
      logger.error('Could not determine current URL');
      return undefined;
    }
    const config = this.instance.config;
    const urlWithoutHash = config['disable_capture_url_hashes'] ? stripUrlHash(href) : href;
    return /** @type {string} */ (maskQueryParams(urlWithoutHash,
        paramsToMask(config['mask_personal_data_properties'], config['custom_personal_data_properties']), MASKED));
  }

  /**
   * @param {boolean} onPageHide
   * @private
   */
  flush_(onPageHide) {
    clearTimeout(this.delayedFlushTimer_);
    this.delayedFlushTimer_ = undefined;
    if (this.buffer.metrics.length === 0) return;
    const properties = {'$current_url': this.buffer.url};
    this.buffer.metrics.forEach(function(metric) {
      // the entire event so we can use it in the future e.g. includes google's rating
      properties['$web_vitals_' + metric['name'] + '_event'] = assign(metric);
      properties['$web_vitals_' + metric['name'] + '_value'] = metric['value'];
    });
    this.instance.capture('$web_vitals', properties,
        onPageHide ? {'transport': 'sendBeacon', 'send_instantly': true} : undefined);
    this.buffer = emptyBuffer();
  }

  /**
   * @param {?} metric
   * @private
   */
  add_(metric) {
    this.buffer = this.buffer || emptyBuffer();

    if (isNullish(metric ? metric['name'] : undefined) || isNullish(metric ? metric['value'] : undefined)) {
      logger.error('Invalid metric received', metric);
      return;
    }

    const navigationURL = typeof metric['navigationURL'] === 'string' ? metric['navigationURL'] : undefined;
    const currentUrl = this.maskedURL_(navigationURL);
    if (isUndefined(currentUrl)) return;
    const navigationId = metric['navigationId'];
    const hasNavigationId = isNumber(navigationId) || typeof navigationId === 'string';
    const navigationKey = hasNavigationId ? 'navigation:' + navigationId : 'url:' + currentUrl;

    // we observe some very large values sometimes, we'll ignore them
    const max = this.maxAllowedValue();
    if (max && metric['value'] >= max) {
      logger.error('Ignoring metric with value >= ' + max, metric);
      return;
    }

    if (this.buffer.navigationKey !== navigationKey) {
      // we need to send what we have
      this.flush_(false);
      // poor performance is >4s, we wait twice that time to send, in case we
      // haven't received all metrics
      const self = this;
      this.delayedFlushTimer_ = setTimeout(function() {
        self.flush_(false);
      }, this.getFlushToCaptureTimeoutMs());
    }

    if (isUndefined(this.buffer.navigationKey)) {
      this.buffer.navigationKey = navigationKey;
      this.buffer.url = currentUrl;
    }

    this.buffer.firstMetricTimestamp = isUndefined(this.buffer.firstMetricTimestamp) ?
        Date.now() : this.buffer.firstMetricTimestamp;

    const sessionManager = this.instance.sessionManager;
    const sessionIds = sessionManager ? sessionManager.checkAndGetSessionAndWindowId(true) : undefined;
    const bufferedMetric = assign(metric);
    if (navigationURL) bufferedMetric['navigationURL'] = currentUrl;
    bufferedMetric['$current_url'] = currentUrl;
    bufferedMetric['timestamp'] = Date.now();

    // `entries` holds raw PerformanceEntry objects (serialised as `[{}]`): always dropped.
    delete bufferedMetric['entries'];

    // Keep attribution only for the metrics we attribute, bounded to small fields.
    const attributionIn = metric['attribution'];
    if (isObject(attributionIn) && this.getAttributionMetrics().indexOf(metric['name']) > -1) {
      const attribution = {};
      const self = this;
      WEB_VITALS_ATTRIBUTION_ALLOWLIST.forEach(function(key) {
        const value = key === 'url' && typeof attributionIn[key] === 'string' ?
            self.maskedURL_(attributionIn[key]) : attributionIn[key];
        if (!isUndefined(value)) attribution[key] = value;
      });
      bufferedMetric['attribution'] = attribution;
    } else {
      delete bufferedMetric['attribution'];
    }
    if (!isUndefined(sessionIds)) {
      bufferedMetric['$session_id'] = sessionIds.sessionId;
      bufferedMetric['$window_id'] = sessionIds.windowId;
    }

    this.buffer.metrics.push(bufferedMetric);

    if (this.buffer.metrics.length === this.getAllowedMetrics().length) {
      // we have all allowed metrics
      this.flush_(false);
    }
  }

  /** @private */
  startCapturing_() {
    // web-vitals has no cleanup functions and must not be called twice per page.
    if (this.initialized) return;

    const flavor = this.callbackFlavor();
    const callbacks = externalCallbacks(flavor) || builtInCallbacks(flavor);
    const withoutAttribution = callbacks['withoutAttribution'];
    const attributionMetrics = this.getAttributionMetrics();
    // only the attribution bundle exposes unattributed observers alongside the attributed ones
    const isAttributionBundle = !isUndefined(withoutAttribution);
    /**
     * @param {string} name
     * @return {?MetricCallback|undefined}
     */
    const pick = function(name) {
      const key = 'on' + name;
      return attributionMetrics.indexOf(name) > -1 ? callbacks[key] :
          (withoutAttribution ? withoutAttribution[key] : undefined) || callbacks[key];
    };
    const lcp = pick('LCP');
    const cls = pick('CLS');
    const fcp = pick('FCP');
    const inp = pick('INP');

    if (!lcp || !cls || !fcp || !inp) {
      logger.error('web vitals callbacks not loaded - not starting');
      return;
    }

    // Scope metrics to Soft Navigation entries when opted in.
    const reportOpts = {'reportSoftNavs': this.shouldUseSoftNavs()};
    // `processedEventEntries` is never read: opt out (attribution build only).
    const inpReportOpts = isAttributionBundle && attributionMetrics.indexOf('INP') > -1 ?
        assign(reportOpts) : reportOpts;
    if (inpReportOpts !== reportOpts) inpReportOpts['includeProcessedEventEntries'] = false;

    const allowed = this.getAllowedMetrics();
    if (allowed.indexOf('LCP') > -1) lcp(this.addToBuffer, reportOpts);
    if (allowed.indexOf('CLS') > -1) cls(this.addToBuffer, reportOpts);
    if (allowed.indexOf('FCP') > -1) fcp(this.addToBuffer, reportOpts);
    if (allowed.indexOf('INP') > -1) inp(this.addToBuffer, inpReportOpts);

    // Registered after the web-vitals observers so their hidden-page callbacks
    // can place final LCP, CLS and INP reports into the buffer before it drains.
    const pageDocument = win ? win.document : undefined;
    const self = this;
    addEventListener(pageDocument, 'visibilitychange', function() {
      if (pageDocument && pageDocument.visibilityState === 'hidden') self.flush_(true);
    });
    addEventListener(win, 'pagehide', function() {
      self.flush_(true);
    });

    this.initialized = true;
  }
}
