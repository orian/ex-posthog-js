/*
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @fileoverview web-vitals 6.2.1 `src/onFCP.ts`, `src/onCLS.ts`,
 * `src/onINP.ts` and `src/onLCP.ts` (the unattributed observers) ported to
 * JSDoc-typed ES2020 for Closure ADVANCED. See README.md in this folder.
 */
import {
  FCPEntryManager, InteractionManager, LCPEntryManager, LayoutShiftManager, Metric, ReportOpts, addListener,
  bindReporter, checkSoftNavsEnabled, doubleRAF, getActivationStart, getBFCacheRestoreTime, getVisibilityWatcher,
  initInteractionCountPolyfill, initMetric, initUnique, observe, onBFCacheRestore, removeListener, runOnce,
  spreadInto, storeSoftNavEntry, whenActivated, whenIdleOrHidden,
} from './lib.js';

/**
 * @param {!ReportOpts|undefined} opts
 * @return {!ReportOpts}
 */
function defaultOpts(opts) {
  return opts === undefined ? {} : opts;
}

// ---- onFCP.ts -----------------------------------------------------------------------

/** Thresholds for FCP. See https://web.dev/articles/fcp#what_is_a_good_fcp_score */
export const FCPThresholds = [1800, 3000];

/**
 * Calculates the FCP value for the current page and calls `onReport` once the
 * value is ready, along with the relevant `paint` performance entry.
 * @param {function(!Metric)} onReport
 * @param {!ReportOpts=} optsArg
 */
export function onFCP(onReport, optsArg) {
  const opts = defaultOpts(optsArg);
  const softNavsEnabled = checkSoftNavsEnabled(opts);

  whenActivated(function() {
    // Create a new FCP entry manager for each page activation (used to track
    // soft navigations when attribution is enabled).
    const fcpEntryManager = initUnique(opts, FCPEntryManager);
    const visibilityWatcher = getVisibilityWatcher();
    let metric = initMetric('FCP');
    /** @type {function(boolean=)} */
    let report;

    /** @type {!PerformanceObserver|undefined} */
    let po;
    const handleEntries = function(entries) {
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.name === 'first-contentful-paint') {
          po.disconnect();
          // Only report if the page wasn't hidden prior to FCP.
          if (entry.startTime < visibilityWatcher.getFirstHiddenTime()) {
            // FCP is relative to page activation rather than navigation start
            // if the page was prerendered, clamped at 0.
            metric['value'] = Math.max(entry.startTime - getActivationStart(), 0);
            metric['entries'].push(entry);
            metric['navigationId'] = entry.navigationId || metric['navigationId'];
            // FCP should only be reported once so can report right away
            report(true);
          }
        }
      }
    };

    po = observe(['paint'], handleEntries);

    if (po) {
      report = bindReporter(onReport, metric, FCPThresholds, opts['reportAllChanges']);

      // Only report after a bfcache restore if the `PerformanceObserver`
      // successfully registered or the `paint` entry exists.
      onBFCacheRestore(function(event) {
        metric = initMetric('FCP', -1, 'back-forward-cache', metric['navigationId'],
            metric['navigationInteractionId'], metric['navigationURL'], getBFCacheRestoreTime());
        report = bindReporter(onReport, metric, FCPThresholds, opts['reportAllChanges']);
        doubleRAF(function() {
          metric['value'] = performance.now() - event.timeStamp;
          report(true);
        });
      });
    }

    if (softNavsEnabled) {
      // As first-contentful-paint is only reported once, soft navigations are
      // handled afterwards on their own.
      const handleSoftNavEntries = function(entries) {
        entries.forEach(function(e) {
          const entry = /** @type {!PerformanceSoftNavigation} */ (e);
          // Stored for attribution (only set when attribution is enabled).
          if (fcpEntryManager.softNavigationEntryMap && entry.navigationId) {
            storeSoftNavEntry(fcpEntryManager.softNavigationEntryMap, entry);
          }
          // Clamp FCP at 0.
          const FCPTime = Math.max((entry.presentationTime || entry.paintTime || 0) - entry.startTime, 0);
          metric = initMetric('FCP', FCPTime, 'soft-navigation', entry.navigationId, entry.interactionId,
              entry.name, entry.startTime);
          report = bindReporter(onReport, metric, FCPThresholds, opts['reportAllChanges']);
          report(true);
        });
      };
      observe(['soft-navigation'], handleSoftNavEntries, opts);
    }
  });
}

// ---- onCLS.ts -----------------------------------------------------------------------

/** Thresholds for CLS. See https://web.dev/articles/cls#what_is_a_good_cls_score */
export const CLSThresholds = [0.1, 0.25];

/**
 * Calculates the CLS value for the current page and calls `onReport` once the
 * value is ready to be reported (always when the page becomes hidden).
 * @param {function(!Metric)} onReport
 * @param {!ReportOpts=} optsArg
 */
export function onCLS(onReport, optsArg) {
  const opts = defaultOpts(optsArg);
  const visibilityWatcher = getVisibilityWatcher();
  // Start monitoring FCP so we can only report CLS if FCP is also reported.
  onFCP(runOnce(function() {
    let metric = initMetric('CLS', 0);
    /** @type {function(boolean=)} */
    let report;

    const layoutShiftManager = initUnique(opts, LayoutShiftManager);

    /**
     * @param {string=} navigationType
     * @param {*=} navigationId
     * @param {*=} navigationInteractionId
     * @param {string=} navigationURL
     * @param {number=} navigationStartTime
     */
    const initNewCLSMetric = function(navigationType, navigationId, navigationInteractionId, navigationURL,
        navigationStartTime) {
      metric = initMetric('CLS', 0, navigationType, navigationId, navigationInteractionId, navigationURL,
          navigationStartTime);
      layoutShiftManager.sessionValue = 0;
      report = bindReporter(onReport, metric, CLSThresholds, opts['reportAllChanges']);
    };

    /** @param {boolean=} forceReport */
    const updateAndReportMetric = function(forceReport) {
      // If the current session value is larger than the current CLS value,
      // update CLS and the entries contributing to it.
      if (layoutShiftManager.sessionValue > metric['value']) {
        metric['value'] = layoutShiftManager.sessionValue;
        metric['entries'] = layoutShiftManager.sessionEntries;
      }
      report(forceReport === undefined ? false : forceReport);
    };

    /** @param {!PerformanceSoftNavigation} entry */
    const handleSoftNavEntry = function(entry) {
      updateAndReportMetric(true);
      initNewCLSMetric('soft-navigation', entry.navigationId, entry.interactionId, entry.name, entry.startTime);
    };

    /** @param {!Array<!PerformanceEntry>} entries */
    const handleEntries = function(entries) {
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.entryType === 'soft-navigation') {
          handleSoftNavEntry(/** @type {!PerformanceSoftNavigation} */ (entry));
          continue;
        }
        layoutShiftManager.processEntry(/** @type {!LayoutShift} */ (entry));
      }
      updateAndReportMetric();
    };

    const types = ['layout-shift'];
    if (checkSoftNavsEnabled(opts)) {
      types.push('soft-navigation');
    }
    const po = observe(types, handleEntries);
    if (po) {
      report = bindReporter(onReport, metric, CLSThresholds, opts['reportAllChanges']);

      visibilityWatcher.onHidden(function() {
        handleEntries(po.takeRecords());
        report(true);
      });

      // Only report after a bfcache restore if the `PerformanceObserver`
      // successfully registered.
      onBFCacheRestore(function() {
        initNewCLSMetric('back-forward-cache', metric['navigationId'], metric['navigationInteractionId'],
            metric['navigationURL'], getBFCacheRestoreTime());
        doubleRAF(report);
      });

      // Queue a task to report (if nothing else triggers a report first).
      setTimeout(report);
    }
  }));
}

// ---- onINP.ts -----------------------------------------------------------------------

/** Thresholds for INP. See https://web.dev/articles/inp#what_is_a_good_inp_score */
export const INPThresholds = [200, 500];

// The default `durationThreshold` used for observing `event` entries.
const DEFAULT_DURATION_THRESHOLD = 40;

/**
 * Calculates the INP value for the current page and calls `onReport` once the
 * value is ready (always when the page becomes hidden).
 * @param {function(!Metric)} onReport
 * @param {!ReportOpts=} optsArg
 */
export function onINP(onReport, optsArg) {
  const opts = defaultOpts(optsArg);
  // Return if the browser doesn't support all APIs needed to measure INP.
  const PET = window['PerformanceEventTiming'];
  if (!(PET && 'interactionId' in PET['prototype'])) {
    return;
  }

  const visibilityWatcher = getVisibilityWatcher();

  whenActivated(function() {
    initInteractionCountPolyfill();

    let metric = initMetric('INP');
    /** @type {function(boolean=)} */
    let report;

    const interactionManager = initUnique(opts, InteractionManager);

    /**
     * @param {string=} navigationType
     * @param {*=} navigationId
     * @param {*=} navigationInteractionId
     * @param {string=} navigationURL
     * @param {number=} navigationStartTime
     */
    const initNewINPMetric = function(navigationType, navigationId, navigationInteractionId, navigationURL,
        navigationStartTime) {
      interactionManager.resetInteractions();
      metric = initMetric('INP', -1, navigationType, navigationId, navigationInteractionId, navigationURL,
          navigationStartTime);
      report = bindReporter(onReport, metric, INPThresholds, opts['reportAllChanges']);
    };

    const updateINPMetric = function() {
      const inp = interactionManager.estimateP98LongestInteraction(metric['navigationType']);
      if (inp && inp.latency !== metric['value']) {
        metric['value'] = inp.latency;
        metric['entries'] = inp.entries;
        report();
      }
    };

    /** @param {!PerformanceSoftNavigation} entry */
    const handleSoftNavEntry = function(entry) {
      updateINPMetric();
      report(true);
      initNewINPMetric('soft-navigation', entry.navigationId, entry.interactionId, entry.name, entry.startTime);
    };

    /**
     * @param {!Array<!PerformanceEntry>} entries
     * @param {boolean=} forceReport
     */
    const handleEntries = function(entries, forceReport) {
      // Queue the `handleEntries()` callback in the next idle task, so all
      // event entries between the interaction and the next paint are in.
      whenIdleOrHidden(function() {
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          if (entry.entryType === 'soft-navigation') {
            handleSoftNavEntry(/** @type {!PerformanceSoftNavigation} */ (entry));
            continue;
          }
          interactionManager.processEntry(/** @type {!PerformanceEventTiming} */ (entry));
        }
        updateINPMetric();
        if (forceReport) {
          report(true);
        }
      });
    };

    const types = ['event', 'first-input'];
    if (checkSoftNavsEnabled(opts)) {
      types.push('soft-navigation');
    }
    const durationThreshold = opts['durationThreshold'];
    const po = observe(types, function(entries) {
      handleEntries(entries);
    }, spreadInto(spreadInto({}, opts), {
      'durationThreshold': durationThreshold != null ? durationThreshold : DEFAULT_DURATION_THRESHOLD,
    }));

    report = bindReporter(onReport, metric, INPThresholds, opts['reportAllChanges']);

    if (po) {
      visibilityWatcher.onHidden(function() {
        handleEntries(po.takeRecords(), true); // forceReport after processing all entries
      });

      // Only report after a bfcache restore if the `PerformanceObserver`
      // successfully registered.
      onBFCacheRestore(function() {
        initNewINPMetric('back-forward-cache', metric['navigationId'], metric['navigationInteractionId'],
            metric['navigationURL'], getBFCacheRestoreTime());
      });
    }
  });
}

// ---- onLCP.ts -----------------------------------------------------------------------

/** Thresholds for LCP. See https://web.dev/articles/lcp#what_is_a_good_lcp_score */
export const LCPThresholds = [2500, 4000];

/**
 * Calculates the LCP value for the current page and calls `onReport` once the
 * value is ready (after input or when the page becomes hidden).
 * @param {function(!Metric)} onReport
 * @param {!ReportOpts=} optsArg
 */
export function onLCP(onReport, optsArg) {
  const opts = defaultOpts(optsArg);
  // As InteractionContentfulPaint entries used by soft navs can emit after
  // LCP is finalized, we need a flag to know to ignore them.
  let isFinalized = false;
  const softNavsEnabled = checkSoftNavsEnabled(opts);

  whenActivated(function() {
    let visibilityWatcher = getVisibilityWatcher();
    let metric = initMetric('LCP');
    /** @type {function(boolean=)} */
    let report;

    const lcpEntryManager = initUnique(opts, LCPEntryManager);

    /**
     * @param {string=} navigation
     * @param {*=} navigationId
     * @param {*=} navigationInteractionId
     * @param {string=} navigationURL
     * @param {number=} navigationStartTime
     */
    const initNewLCPMetric = function(navigation, navigationId, navigationInteractionId, navigationURL,
        navigationStartTime) {
      metric = initMetric('LCP', -1, navigation, navigationId, navigationInteractionId, navigationURL,
          navigationStartTime);
      report = bindReporter(onReport, metric, LCPThresholds, opts['reportAllChanges']);
      // Reset the finalized flag
      isFinalized = false;
      // If it's a soft nav, then need to reset the visibilityWatcher
      if (navigation === 'soft-navigation') {
        visibilityWatcher = getVisibilityWatcher(true);
      }
    };

    /** @type {function(!Array<?PerformanceEntry>)} */
    let handleEntries;

    /** @param {!PerformanceSoftNavigation} entry */
    const handleSoftNavEntry = function(entry) {
      if (lcpEntryManager.softNavigationEntryMap && entry.navigationId) {
        storeSoftNavEntry(lcpEntryManager.softNavigationEntryMap, entry);
      }
      if (!isFinalized) report(true);
      initNewLCPMetric('soft-navigation', entry.navigationId, entry.interactionId, entry.name, entry.startTime);
      // Soft Navs should contain the largest paint until now, so handle that
      // as if it just happened, then listen for more. It can be null.
      const largestInteractionContentfulPaint = entry.getLargestInteractionContentfulPaint ?
          entry.getLargestInteractionContentfulPaint() : undefined;
      if (largestInteractionContentfulPaint) {
        handleEntries([largestInteractionContentfulPaint]);
      }
    };

    handleEntries = function(entriesArg) {
      let entries = entriesArg;
      // If reportAllChanges is set or soft navs is enabled then call this
      // function for each entry, otherwise only consider the last one.
      if (!opts['reportAllChanges'] && !softNavsEnabled) {
        entries = entries.slice(-1);
      }

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (!entry) continue;

        if (entry.entryType === 'soft-navigation') {
          handleSoftNavEntry(/** @type {!PerformanceSoftNavigation} */ (entry));
          continue;
        }

        let value = 0;
        /** @type {!Array<!LargestContentfulPaint>} */
        let metricEntries = [];
        let renderTime = entry.startTime;
        if (entry.entryType === 'largest-contentful-paint') {
          // LCP is relative to page activation if the page was prerendered,
          // clamped at 0.
          value = Math.max(entry.startTime - getActivationStart(), 0);
          lcpEntryManager.processEntry(/** @type {!LargestContentfulPaint} */ (entry));
          metricEntries = [/** @type {!LargestContentfulPaint} */ (entry)];
        } else if (entry.entryType === 'interaction-contentful-paint') {
          const ICPEntry = /** @type {!InteractionContentfulPaint} */ (entry);
          // InteractionContentfulPaints should only happen after a soft
          // navigation, so the metric has a non-zero navigationId.
          if (!metric['navigationId']) continue;

          // Ignore interactions not for this soft nav.
          if ('interactionId' in ICPEntry && ICPEntry.interactionId != metric['navigationInteractionId']) {
            continue;
          }

          const lcp = ICPEntry.largestContentfulPaint;
          renderTime = (lcp ? lcp.renderTime : undefined) || 0;

          // Paints should never be less than 0 but add cap just in case
          value = Math.max(renderTime - entry.startTime, 0);

          if (lcp) {
            lcpEntryManager.processEntry(lcp);
            metricEntries = [lcp];
          }
        }

        // Only report if the page wasn't hidden prior to LCP.
        if (renderTime < visibilityWatcher.getFirstHiddenTime()) {
          metric['value'] = value;
          metric['entries'] = metricEntries;
          report();
        }
      }
    };

    const types = ['largest-contentful-paint'];
    if (softNavsEnabled) {
      types.push('interaction-contentful-paint', 'soft-navigation');
    }
    const po = observe(types, handleEntries);

    if (po) {
      report = bindReporter(onReport, metric, LCPThresholds, opts['reportAllChanges']);

      const finalizeEventTypes = ['keydown', 'click', 'visibilitychange'];

      /** @param {!Event} event */
      const finalizeLCP = function(event) {
        if (event.isTrusted && !isFinalized) {
          // Wrap the listener in an idle callback so it's run in a separate
          // task to reduce potential INP impact.
          const metricIdToFinalize = metric['id'];
          whenIdleOrHidden(function() {
            if (!isFinalized) {
              if (!softNavsEnabled) {
                // Do some clean up since these won't be needed anymore.
                po.disconnect();
                for (let i = 0; i < finalizeEventTypes.length; i++) {
                  removeListener(finalizeEventTypes[i], finalizeLCP,
                      /** @type {!EventListenerOptions} */ ({'capture': true}));
                }
              }
              // Ignore if we've moved on to another metric in the meantime.
              if (metricIdToFinalize === metric['id']) {
                isFinalized = true;
                report(true);
              }
            }
          });
        }
      };

      // Finalize the current LCP after input or visibilitychange.
      for (let i = 0; i < finalizeEventTypes.length; i++) {
        addListener(finalizeEventTypes[i], finalizeLCP, /** @type {!AddEventListenerOptions} */ ({'capture': true}));
      }

      // Only report after a bfcache restore if the `PerformanceObserver`
      // successfully registered.
      onBFCacheRestore(function(event) {
        initNewLCPMetric('back-forward-cache', metric['navigationId'], metric['navigationInteractionId'],
            metric['navigationURL'], getBFCacheRestoreTime());
        report = bindReporter(onReport, metric, LCPThresholds, opts['reportAllChanges']);
        doubleRAF(function() {
          metric['value'] = performance.now() - event.timeStamp;
          isFinalized = true;
          report(true);
        });
      });
    }
  });
}
