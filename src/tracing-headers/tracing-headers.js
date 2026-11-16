/**
 * @fileoverview Tracing headers (optional module). Port of upstream
 * browser/src/extensions/tracing-headers.ts: patches fetch and XMLHttpRequest
 * to add PostHog's session / window / distinct id headers to requests for
 * `tracing_headers` hostnames (deprecated aliases `addTracingHeaders` and
 * `__add_tracing_headers`, whose `true` means every host) and a W3C
 * `traceparent` to `trace_propagation_targets`. Re-checked on set_config.
 *
 * The patch functions (patch-fns.js) are the lazy part `tracing-headers`
 * (upstream `/static/tracing-headers.js`). The lazy build loads them as their
 * own chunk at upstream's trigger point. Elsewhere they are compiled in, so
 * fetch and XHR are patched synchronously during init; like the script load,
 * patching is then refused while `disable_external_dependency_loading` is set
 * (until it has "loaded" once).
 */
import {PostHog} from '../core/posthog.js';
import {Extension} from '../core/extensions.js';
import {logger as baseLogger} from '../core/logger.js';
import {lazyChunksEnabled, lazyPart, loadLazy} from '../core/lazy.js';
import {isArray, isString, isUndefined} from '../core/utils.js';
import {TRACING_HEADERS_KIND, TraceparentTargets, TracingHeadersHostnames, TracingHeadersPatchFns} from './types.js';

const logger = baseLogger.createLogger('[TracingHeaders]');

/** @implements {Extension} */
export class TracingHeaders {
  /** @param {!PostHog} instance */
  constructor(instance) {
    /** @type {!PostHog} */
    this.instance = instance;
    /** @private {(function())|undefined} */
    this.restoreXHRPatch_ = undefined;
    /** @private {(function())|undefined} */
    this.restoreFetchPatch_ = undefined;
    /** @private {TracingHeadersHostnames} */
    this.hostnamesForPatch_ = undefined;
    /**
     * The hostnames value the installed patches were given.
     * @private {TracingHeadersHostnames}
     */
    this.patchedHostnames_ = undefined;
    /**
     * Mutated in place (never reassigned) so installed patches see config changes.
     * @private @const {!Array<string>}
     */
    this.traceparentTargetsForPatch_ = [];
    /** @private {boolean} */
    this.loaded_ = false;
  }

  /** Upstream initialize(). */
  onInit() {
    this.startIfEnabledOrStop();
  }

  /** Upstream: set_config calls startIfEnabledOrStop(). */
  onConfigChange() {
    this.startIfEnabledOrStop();
  }

  /**
   * Upstream `_loadScript` (the patch functions are compiled in).
   * @param {function()} cb
   * @private
   */
  loadScript_(cb) {
    if (lazyChunksEnabled()) {
      loadLazy(this.instance, TRACING_HEADERS_KIND, function(err) {
        if (err) {
          logger.error('failed to load script', err);
          return;
        }
        cb();
      });
      return;
    }
    if (!this.loaded_ && this.instance.config['disable_external_dependency_loading']) {
      logger.error('failed to load script', 'Loading of external scripts is disabled');
      return;
    }
    this.loaded_ = true;
    cb();
  }

  /**
   * The public `tracing_headers` option, else the deprecated aliases.
   * @return {*}
   * @private
   */
  configuredHostnames_() {
    const config = this.instance.config;
    const value = config['tracing_headers'];
    if (value != null) return value;
    const alias = config['addTracingHeaders'];
    return alias != null ? alias : config['__add_tracing_headers'];
  }

  /**
   * @return {TracingHeadersHostnames}
   * @private
   */
  syncHostnamesForPatch_() {
    const hostnames = this.configuredHostnames_();

    if (isArray(hostnames)) {
      const list = /** @type {!Array<string>} */ (hostnames);
      if (isArray(this.hostnamesForPatch_)) {
        const current = /** @type {!Array<string>} */ (this.hostnamesForPatch_);
        current.splice.apply(current, [0, current.length].concat(list));
      } else {
        this.hostnamesForPatch_ = list.slice();
      }
      return list.length > 0 ? this.hostnamesForPatch_ : undefined;
    }

    if (isArray(this.hostnamesForPatch_)) {
      // Empty the array before reassignment: installed fetch/XHR patches may
      // be reading it, and stale hostnames must not keep receiving headers.
      /** @type {!Array<string>} */ (this.hostnamesForPatch_).splice(0);
      if (!hostnames) {
        // Keep the (now empty) array instance: installed patches may still be
        // reading it for trace_propagation_targets, and re-enabling
        // tracing_headers later must reach them.
        return undefined;
      }
    }

    this.hostnamesForPatch_ = /** @type {TracingHeadersHostnames} */ (hostnames || undefined);
    return this.hostnamesForPatch_;
  }

  /**
   * @return {TraceparentTargets}
   * @private
   */
  syncTraceparentTargetsForPatch_() {
    const configured = this.instance.config['trace_propagation_targets'];
    const targets = isArray(configured) ? configured.filter(function(target) {
      return isString(target) && !!target;
    }) : [];
    const live = this.traceparentTargetsForPatch_;
    live.splice.apply(live, [0, live.length].concat(targets));
    return targets.length > 0 ? live : undefined;
  }

  /** @private */
  stopCapturing_() {
    if (this.restoreXHRPatch_) this.restoreXHRPatch_();
    if (this.restoreFetchPatch_) this.restoreFetchPatch_();
    // we don't want to call these twice so we reset them
    this.restoreXHRPatch_ = undefined;
    this.restoreFetchPatch_ = undefined;
  }

  startIfEnabledOrStop() {
    const hostnames = this.syncHostnamesForPatch_();
    const traceparentTargets = this.syncTraceparentTargetsForPatch_();
    if (hostnames || traceparentTargets) {
      const self = this;
      this.loadScript_(function() {
        self.startCapturing_();
      });
    } else {
      this.stopCapturing_();
    }
  }

  /** @private */
  startCapturing_() {
    const hostnames = this.syncHostnamesForPatch_();
    const traceparentTargets = this.syncTraceparentTargetsForPatch_();
    if (!hostnames && !traceparentTargets) {
      this.stopCapturing_();
      return;
    }
    // Always hand the patches the live arrays, even when one feature is
    // currently empty, so enabling it later via set_config needs no re-patch.
    if (!hostnames && !isArray(this.hostnamesForPatch_)) {
      this.hostnamesForPatch_ = [];
    }
    // Arrays reach installed patches in place, but a boolean (legacy
    // `__add_tracing_headers: true`) is captured by value, so when the
    // hostnames value itself changes the patches must be reinstalled.
    if (this.patchedHostnames_ !== this.hostnamesForPatch_) {
      this.stopCapturing_();
      this.patchedHostnames_ = this.hostnamesForPatch_;
    }

    const fns = /** @type {!TracingHeadersPatchFns|undefined} */ (lazyPart(TRACING_HEADERS_KIND));
    if (!fns) return;
    const instance = this.instance;
    const distinctId = function() {
      return /** @type {string|undefined} */ (instance.get_distinct_id());
    };
    if (isUndefined(this.restoreXHRPatch_)) {
      this.restoreXHRPatch_ = fns.patchXHR(this.hostnamesForPatch_, distinctId, instance.sessionManager,
          this.traceparentTargetsForPatch_);
    }
    if (isUndefined(this.restoreFetchPatch_)) {
      this.restoreFetchPatch_ = fns.patchFetch(this.hostnamesForPatch_, distinctId, instance.sessionManager,
          this.traceparentTargetsForPatch_);
    }
  }
}
