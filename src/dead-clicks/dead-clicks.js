/**
 * @fileoverview Dead clicks (optional module). Port of upstream
 * browser/src/extensions/dead-clicks-autocapture.ts (the extension, enabled by
 * `capture_dead_clicks` or the remote `captureDeadClicks`, persisted as
 * `$dead_clicks_enabled_server_side`) and of the lazily loaded detector in
 * browser/src/entrypoints/dead-clicks-autocapture.ts (detector.js, the lazy
 * part `dead-clicks-autocapture`). Upstream loads the detector from /static.
 * In the bundles and chunks it is compiled in, so it starts synchronously; the
 * lazy build loads it as its own chunk at upstream's trigger point.
 * Heatmaps reuse the detector to plot `deadclick` points.
 */
import {PostHog} from '../core/posthog.js';
import {Extension} from '../core/extensions.js';
import {logger as baseLogger} from '../core/logger.js';
import {lazyChunksEnabled, lazyPart, loadLazy} from '../core/lazy.js';
import {doc, extend, isBoolean, isObject} from '../core/utils.js';

const logger = baseLogger.createLogger('[Dead Clicks]');

/** @const {string} */
export const DEAD_CLICKS_ENABLED_SERVER_SIDE = '$dead_clicks_enabled_server_side';

/** @const {string} the lazy part (upstream kind) */
export const DEAD_CLICKS_KIND = 'dead-clicks-autocapture';

/** A queued click or swipe (upstream DeadClickCandidate). */
export class DeadClickCandidate {
  /**
   * @param {!Element} node
   * @param {!Event} originalEvent
   * @param {string} type 'click' | 'swipe'
   */
  constructor(node, originalEvent, type) {
    /** @type {!Element} */
    this.node = node;
    /** @type {!Event} */
    this.originalEvent = originalEvent;
    /** @type {number} */
    this.timestamp = Date.now();
    /** @type {string} */
    this.type = type;
    /** @type {string|undefined} */
    this.swipeDirection = undefined;
    /** @type {number|undefined} */
    this.swipeDistancePx = undefined;
    /** @type {number|undefined} */
    this.scrollDelayMs = undefined;
    /** @type {number|undefined} */
    this.mutationDelayMs = undefined;
    /** @type {number|undefined} */
    this.absoluteDelayMs = undefined;
    /** @type {number|undefined} */
    this.selectionChangedDelayMs = undefined;
    /** @type {number|undefined} */
    this.visibilityChangedDelayMs = undefined;
    /** @type {number|undefined} */
    this.focusChangedDelayMs = undefined;
    /** @type {boolean|undefined} */
    this.selectionChangedDuringGesture = undefined;
  }
}

/** @typedef {function(!DeadClickCandidate, !Object)} */
export let DeadClickCallback;

/**
 * The detector (upstream LazyLoadedDeadClicksAutocaptureInterface).
 * @record
 */
export class DeadClickDetectorApi {
  constructor() {}
  /** @param {!Document} document */
  start(document) {}
  stop() {}
}

/**
 * Creates the detector: (instance, `capture_dead_clicks` options, onCapture).
 * @typedef {function(!PostHog, !Object, (?DeadClickCallback|undefined)): !DeadClickDetectorApi}
 */
export let DeadClickDetectorFactory;

/** Whether upstream would have loaded the lazy detector script by now. */
let detectorLoaded = false;

/** @return {boolean} heatmaps always run their own detector */
export function isDeadClicksEnabledForHeatmaps() {
  return true;
}

/**
 * @param {!DeadClicksAutocapture} dca
 * @return {boolean}
 */
export function isDeadClicksEnabledForAutocapture(dca) {
  const p = dca.instance.persistence;
  const isRemoteEnabled = !!(p && p.get_property(DEAD_CLICKS_ENABLED_SERVER_SIDE));
  const clientConfig = dca.instance.config['capture_dead_clicks'];
  if (isBoolean(clientConfig)) return /** @type {boolean} */ (clientConfig);
  if (isObject(clientConfig)) return true;
  return isRemoteEnabled;
}

/**
 * The dead clicks extension (upstream DeadClicksAutocapture).
 * @implements {Extension}
 */
export class DeadClicksAutocapture {
  /**
   * @param {!PostHog} instance
   * @param {function(!DeadClicksAutocapture): boolean} isEnabled
   * @param {?DeadClickCallback=} onCapture
   */
  constructor(instance, isEnabled, onCapture) {
    /** @type {!PostHog} */
    this.instance = instance;
    /** @private @const {function(!DeadClicksAutocapture): boolean} */
    this.isEnabled_ = isEnabled;
    /** @private @const {?DeadClickCallback|undefined} */
    this.onCapture_ = onCapture;
    /** @type {?DeadClickDetectorApi} */
    this.detector = null;
    this.startIfEnabledOrStop();
  }

  /** @param {?Object} response remote config, null when loading failed */
  onRemoteConfig(response) {
    if (!response || !('captureDeadClicks' in response)) return;
    if (this.instance.persistence) {
      this.instance.persistence.register({[DEAD_CLICKS_ENABLED_SERVER_SIDE]: response['captureDeadClicks']});
    }
    this.startIfEnabledOrStop();
  }

  /** Re-checks `capture_dead_clicks` after `set_config`. */
  onConfigChange() {
    this.startIfEnabledOrStop();
  }

  startIfEnabledOrStop() {
    if (this.isEnabled_(this)) {
      if (lazyChunksEnabled()) {
        // Lazy build: upstream's `_loadScript` / `_start`.
        const self = this;
        loadLazy(this.instance, DEAD_CLICKS_KIND, function(err) {
          if (err) {
            logger.error('failed to load script', err);
            return;
          }
          self.start_();
        });
        return;
      }
      // Upstream lazy-loads the detector script; with external dependency
      // loading disabled that load fails (until it has loaded once) and dead
      // clicks never start. The detector is compiled in here, so only the
      // refusal is mirrored.
      if (!detectorLoaded && this.instance.config['disable_external_dependency_loading']) {
        logger.error('failed to load script', 'Loading of external scripts is disabled');
        return;
      }
      detectorLoaded = true;
      this.start_();
    } else {
      this.stop();
    }
  }

  /** @private */
  start_() {
    if (!doc) {
      logger.error('`document` not found. Cannot start.');
      return;
    }
    const factory = /** @type {!DeadClickDetectorFactory|undefined} */ (lazyPart(DEAD_CLICKS_KIND));
    if (!this.detector && factory) {
      const userConfig = this.instance.config['capture_dead_clicks'];
      // Copied so the writes below can't leak into the user's config object.
      const config = isObject(userConfig) ? extend({}, userConfig) : {};
      if (this.onCapture_) config['capture_dead_swipes'] = false;
      this.detector = factory(this.instance, config, this.onCapture_);
      this.detector.start(doc);
      logger.info('starting...');
    }
  }

  stop() {
    if (this.detector) {
      this.detector.stop();
      this.detector = null;
      logger.info('stopping...');
    }
  }
}
