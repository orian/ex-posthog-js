/*
 * Copyright 2022 Google LLC
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
 * @fileoverview web-vitals 6.2.1 `src/attribution/onFCP.ts`, `onCLS.ts`,
 * `onINP.ts` and `onLCP.ts` ported to JSDoc-typed ES2020 for Closure ADVANCED.
 * Attribution objects use quoted keys (they are handed to the caller as data).
 *
 * Difference from the npm module: `attribution/onLCP.ts` starts its
 * `resource` observer when the module is evaluated. Here the observer is
 * started by `startResourceBuffer()`, which the caller runs at the point the
 * attribution build would have been loaded (see README.md).
 */
import {
  FCPEntryManager, Interaction, InteractionManager, LCPEntryManager, LayoutShiftManager, Metric, ReportOpts,
  checkSoftNavsEnabled, find, findLast, getBFCacheRestoreTime, getLoadState, getNavigationEntry, getSelector,
  initUnique, last, observe, spreadInto, whenIdleOrHidden,
} from './lib.js';
import {
  onCLS as unattributedOnCLS, onFCP as unattributedOnFCP, onINP as unattributedOnINP, onLCP as unattributedOnLCP,
} from './metrics.js';

/**
 * `opts = Object.assign({}, opts)` for an optional argument.
 * @param {!ReportOpts|undefined} opts
 * @return {!ReportOpts}
 */
function cloneOpts(opts) {
  return spreadInto({}, opts === undefined ? {} : opts);
}

/**
 * @param {?Node} node
 * @param {!ReportOpts} opts
 * @return {*}
 */
function targetFor(node, opts) {
  const generateTarget = opts['generateTarget'];
  const custom = generateTarget ? generateTarget(node) : undefined;
  return custom != null ? custom : getSelector(node);
}

// ---- attribution/onFCP.ts ---------------------------------------------------------

/**
 * @param {function(!Metric)} onReport
 * @param {!ReportOpts=} optsArg
 */
export function onFCP(onReport, optsArg) {
  const opts = cloneOpts(optsArg);

  // Init the fcpEntryManager (which will already be initialised in the
  // unattributed onFCP method if soft navigation reporting is enabled).
  const fcpEntryManager = initUnique(opts, FCPEntryManager);
  if (checkSoftNavsEnabled(opts)) {
    fcpEntryManager.softNavigationEntryMap = new Map();
  }

  /**
   * @param {!Metric} metric
   * @return {!Metric}
   */
  const attributeFCP = function(metric) {
    // Use a default object if no other attribution has been set.
    let attribution = {
      'timeToFirstByte': 0,
      'firstByteToFCP': metric['value'],
      'loadState': getLoadState(getBFCacheRestoreTime()),
    };

    if (metric['navigationType'] !== 'soft-navigation') {
      if (metric['entries'].length) {
        const navigationEntry = getNavigationEntry();
        const fcpEntry = last(metric['entries']);
        if (navigationEntry) {
          const responseStart = navigationEntry.responseStart;
          const activationStart = navigationEntry.activationStart || 0;
          const ttfb = Math.max(0, responseStart - activationStart);

          attribution = {
            'timeToFirstByte': ttfb,
            'firstByteToFCP': metric['value'] - ttfb,
            'loadState': getLoadState(metric['entries'][0].startTime),
            'navigationEntry': navigationEntry,
            'fcpEntry': fcpEntry,
          };
        }
      }
    } else {
      // Lookup the soft navigation entry.
      const map = fcpEntryManager.softNavigationEntryMap;
      const navigationEntry = map ? map.get(metric['navigationId']) : undefined;
      if (navigationEntry) {
        attribution = {
          'timeToFirstByte': 0,
          'firstByteToFCP': metric['value'],
          'loadState': 'complete',
          'navigationEntry': navigationEntry,
        };
      }
    }
    metric['attribution'] = attribution;
    return metric;
  };

  unattributedOnFCP(function(metric) {
    onReport(attributeFCP(metric));
  }, opts);
}

// ---- attribution/onCLS.ts ---------------------------------------------------------

/**
 * @param {!Array<!LayoutShift>} entries
 * @return {!LayoutShift}
 */
function getLargestLayoutShiftEntry(entries) {
  return entries.reduce(function(a, b) {
    return a.value > b.value ? a : b;
  });
}

/**
 * @param {!Array<!LayoutShiftAttribution>} sources
 * @return {!LayoutShiftAttribution|undefined}
 */
function getLargestLayoutShiftSource(sources) {
  return find(sources, function(s) {
    return (s.node ? s.node.nodeType : undefined) === 1;
  }) || sources[0];
}

/**
 * @param {function(!Metric)} onReport
 * @param {!ReportOpts=} optsArg
 */
export function onCLS(onReport, optsArg) {
  const opts = cloneOpts(optsArg);

  const layoutShiftManager = initUnique(opts, LayoutShiftManager);
  /** @type {!WeakMap<!LayoutShiftAttribution, *>} */
  const layoutShiftTargetMap = new WeakMap();

  layoutShiftManager.onAfterProcessingUnexpectedShift = function(entry) {
    if (entry && entry.sources && entry.sources.length) {
      const largestSource = getLargestLayoutShiftSource(entry.sources);
      const node = largestSource ? largestSource.node : undefined;
      if (node) {
        layoutShiftTargetMap.set(/** @type {!LayoutShiftAttribution} */ (largestSource), targetFor(node, opts));
      }
    }
  };

  /**
   * @param {!Metric} metric
   * @return {!Metric}
   */
  const attributeCLS = function(metric) {
    // Use an empty object if no other attribution has been set.
    let attribution = {};

    if (metric['entries'].length) {
      const largestEntry = getLargestLayoutShiftEntry(metric['entries']);
      if (largestEntry && largestEntry.sources && largestEntry.sources.length) {
        const largestSource = getLargestLayoutShiftSource(largestEntry.sources);
        if (largestSource) {
          attribution = {
            'largestShiftTarget': layoutShiftTargetMap.get(largestSource),
            'largestShiftTime': largestEntry.startTime,
            'largestShiftValue': largestEntry.value,
            'largestShiftSource': largestSource,
            'largestShiftEntry': largestEntry,
            'loadState': getLoadState(largestEntry.startTime),
          };
        }
      }
    }
    metric['attribution'] = attribution;
    return metric;
  };

  unattributedOnCLS(function(metric) {
    onReport(attributeCLS(metric));
  }, opts);
}

// ---- attribution/onINP.ts ---------------------------------------------------------

/**
 * @typedef {{startTime: number, processingStart: number, processingEnd: number, renderTime: number,
 *     entries: !Array<!PerformanceEventTiming>}}
 */
let PendingEntriesGroup;

// The maximum number of previous frames for which data is kept (event and
// LoAF entries can be dispatched out of order).
const MAX_PENDING_FRAMES = 10;

/**
 * @param {function(!Metric)} onReport
 * @param {!ReportOpts=} optsArg
 */
export function onINP(onReport, optsArg) {
  // Clone the opts object to ensure it's unique, so the `InteractionManager`
  // is shared only with the `unattributedOnINP()` invocation below.
  const opts = cloneOpts(optsArg);

  const interactionManager = initUnique(opts, InteractionManager);

  // LoAF entries that could intersect with the INP candidate interaction.
  /** @type {!Array<!PerformanceLongAnimationFrameTiming>} */
  let pendingLoAFs = [];

  // Groups of all the event timing entries that occurred within a frame.
  /** @type {!Array<!PendingEntriesGroup>} */
  let pendingEntriesGroups = [];

  // The `processingEnd` time of most recently-processed event, chronologically.
  let latestProcessingEnd = 0;

  // Looks up the event-timing-entries group of a given ("important") entry.
  /** @type {!WeakMap<!PerformanceEventTiming, !PendingEntriesGroup>} */
  const entryToEntriesGroupMap = new WeakMap();

  // A mapping of interactions to the target Node selector.
  /** @type {!WeakMap<!Interaction, *>} */
  const interactionTargetMap = new WeakMap();

  // Whether a cleanup task has been queued.
  let cleanupPending = false;

  /** @type {function()} */
  let queueCleanup;

  /** @param {!Array<!PerformanceEntry>} entries */
  const handleLoAFEntries = function(entries) {
    pendingLoAFs = pendingLoAFs.concat(/** @type {!Array<!PerformanceLongAnimationFrameTiming>} */ (entries));
    queueCleanup();
  };

  /** @param {!Interaction} interaction */
  const saveInteractionTarget = function(interaction) {
    if (!interactionTargetMap.get(interaction)) {
      // Use find to get first selector
      const withTarget = find(interaction.entries, function(e) {
        return e.target;
      });
      const node = withTarget ? withTarget.target : undefined;
      if (node) {
        interactionTargetMap.set(interaction, targetFor(node, opts));
      } else {
        // Fall back to targetSelector
        const withSelector = find(interaction.entries, function(e) {
          return e.targetSelector;
        });
        const selector = withSelector ? withSelector.targetSelector : undefined;
        if (selector) {
          interactionTargetMap.set(interaction, selector);
        }
      }
    }
  };

  /**
   * Groups entries that were presented within the same animation frame by a
   * common `renderTime`.
   * @param {!PerformanceEventTiming} entry
   */
  const groupEntriesByRenderTime = function(entry) {
    const renderTime = entry.startTime + entry.duration;
    /** @type {!PendingEntriesGroup|undefined} */
    let group;

    latestProcessingEnd = Math.max(latestProcessingEnd, entry.processingEnd);

    // Iterate over all previous render times in reverse order to find a match.
    for (let i = pendingEntriesGroups.length - 1; i >= 0; i--) {
      const potentialGroup = pendingEntriesGroups[i];

      // If a group's render time is within 8ms of the entry's render time,
      // assume they were part of the same frame and add it to the group.
      if (Math.abs(renderTime - potentialGroup.renderTime) <= 8) {
        group = potentialGroup;
        group.startTime = Math.min(entry.startTime, group.startTime);
        group.processingStart = Math.min(entry.processingStart, group.processingStart);
        group.processingEnd = Math.max(entry.processingEnd, group.processingEnd);
        if (opts['includeProcessedEventEntries']) {
          group.entries.push(entry);
        }
        break;
      }
    }

    // If there was no matching group, assume this is a new frame.
    if (!group) {
      group = {
        startTime: entry.startTime,
        processingStart: entry.processingStart,
        processingEnd: entry.processingEnd,
        renderTime: renderTime,
        entries: opts['includeProcessedEventEntries'] ? [entry] : [],
      };
      pendingEntriesGroups.push(group);
    }

    // Store the grouped render time for this entry for reference later.
    if (entry.interactionId) {
      entryToEntriesGroupMap.set(entry, group);
    }

    queueCleanup();
  };

  /**
   * @param {number} start
   * @param {number} end
   * @return {!Array<!PerformanceLongAnimationFrameTiming>}
   */
  const getIntersectingLoAFs = function(start, end) {
    const intersectingLoAFs = [];
    for (let i = 0; i < pendingLoAFs.length; i++) {
      const loaf = pendingLoAFs[i];
      // If the LoAF ends before the given start time, ignore it.
      if (loaf.startTime + loaf.duration < start) continue;
      // If the LoAF starts after the given end time, ignore it and all
      // subsequent pending LoAFs (because they're in time order).
      if (loaf.startTime > end) break;
      intersectingLoAFs.push(loaf);
    }
    return intersectingLoAFs;
  };

  const cleanupEntries = function() {
    // Entries groups that are part of the longest interactions.
    const longestInteractionGroups = new Set(interactionManager.longestInteractionList.map(function(i) {
      return entryToEntriesGroupMap.get(i.entries[0]);
    }));

    // Keep groups of the current longest interactions or of the most recent
    // MAX_PENDING_FRAMES frames.
    const minIndexToKeep = pendingEntriesGroups.length - MAX_PENDING_FRAMES;
    pendingEntriesGroups = pendingEntriesGroups.filter(function(group, i) {
      return i >= minIndexToKeep || longestInteractionGroups.has(group);
    });

    // LoAF entries that intersect with the remaining groups.
    /** @type {!Set<!PerformanceLongAnimationFrameTiming>} */
    const intersectingLoAFs = new Set();
    for (let g = 0; g < pendingEntriesGroups.length; g++) {
      const group = pendingEntriesGroups[g];
      const loafs = getIntersectingLoAFs(group.startTime, group.processingEnd);
      for (let i = 0; i < loafs.length; i++) {
        intersectingLoAFs.add(loafs[i]);
      }
    }

    // Keep LoAFs that intersect with a pending group or occurred after the
    // most recently processed event entry.
    pendingLoAFs = pendingLoAFs.filter(function(loaf) {
      return loaf.startTime > latestProcessingEnd || intersectingLoAFs.has(loaf);
    });

    cleanupPending = false;
  };

  queueCleanup = function() {
    // Queue cleanup of entries that are not part of any INP candidates.
    if (!cleanupPending) {
      whenIdleOrHidden(cleanupEntries);
      cleanupPending = true;
    }
  };

  interactionManager.onBeforeProcessingEntry = groupEntriesByRenderTime;
  interactionManager.onAfterProcessingINPCandidate = saveInteractionTarget;

  /** @param {!Object} attribution */
  const attributeLoAFDetails = function(attribution) {
    const interactionTime = attribution['interactionTime'];
    const nextPaintTime = attribution['nextPaintTime'];
    const loafEntries = attribution['longAnimationFrameEntries'];

    // If there is no LoAF data, interactionTime or paintTime then nothing
    // further to attribute here.
    if (!(loafEntries ? loafEntries.length : undefined) || !interactionTime || !nextPaintTime) {
      return;
    }
    const inputDelay = attribution['inputDelay'];
    const processingDuration = attribution['processingDuration'];

    // Stats across all LoAF entries and scripts.
    let totalScriptDuration = 0;
    let totalStyleAndLayoutDuration = 0;
    let totalPaintDuration = 0;
    let longestScriptDuration = 0;
    /** @type {!PerformanceScriptTiming|undefined} */
    let longestScriptEntry;
    /** @type {string|undefined} */
    let longestScriptSubpart;

    for (let l = 0; l < loafEntries.length; l++) {
      const loafEntry = /** @type {!PerformanceLongAnimationFrameTiming} */ (loafEntries[l]);
      totalStyleAndLayoutDuration =
          totalStyleAndLayoutDuration + loafEntry.startTime + loafEntry.duration - loafEntry.styleAndLayoutStart;

      for (let s = 0; s < loafEntry.scripts.length; s++) {
        const script = loafEntry.scripts[s];
        const scriptEndTime = script.startTime + script.duration;
        if (scriptEndTime < interactionTime) {
          continue;
        }
        const intersectingScriptDuration = scriptEndTime - Math.max(interactionTime, script.startTime);
        // forcedStyleAndLayoutDuration has no timestamps, so apportion the
        // total based on the intersectingScriptDuration.
        const intersectingForceStyleAndLayoutDuration = script.duration ?
            (intersectingScriptDuration / script.duration) * script.forcedStyleAndLayoutDuration : 0;
        // Scripts exclude forcedStyleAndLayout (as DevTools does), which is
        // counted in totalStyleAndLayoutDuration instead.
        totalScriptDuration += intersectingScriptDuration - intersectingForceStyleAndLayoutDuration;
        totalStyleAndLayoutDuration += intersectingForceStyleAndLayoutDuration;

        if (intersectingScriptDuration > longestScriptDuration) {
          // Set the subpart this occurred in.
          longestScriptSubpart = script.startTime < interactionTime + inputDelay ? 'input-delay' :
              script.startTime >= interactionTime + inputDelay + processingDuration ? 'presentation-delay' :
              'processing-duration';
          longestScriptEntry = script;
          longestScriptDuration = intersectingScriptDuration;
        }
      }
    }

    // Calculate the totalPaintDuration from the last LoAF after
    // presentationDelay starts (where available)
    const lastLoAF = /** @type {!PerformanceLongAnimationFrameTiming|undefined} */ (last(loafEntries));
    const lastLoAFEndTime = lastLoAF ? lastLoAF.startTime + lastLoAF.duration : 0;
    if (lastLoAFEndTime >= interactionTime + inputDelay + processingDuration) {
      totalPaintDuration = nextPaintTime - lastLoAFEndTime;
    }

    if (longestScriptEntry && longestScriptSubpart) {
      attribution['longestScript'] = {
        'entry': longestScriptEntry,
        'subpart': longestScriptSubpart,
        'intersectingDuration': longestScriptDuration,
      };
    }
    attribution['totalScriptDuration'] = totalScriptDuration;
    attribution['totalStyleAndLayoutDuration'] = totalStyleAndLayoutDuration;
    attribution['totalPaintDuration'] = totalPaintDuration;
    attribution['totalUnattributedDuration'] =
        nextPaintTime - interactionTime - totalScriptDuration - totalStyleAndLayoutDuration - totalPaintDuration;
  };

  /**
   * @param {!Metric} metric
   * @return {!Metric}
   */
  const attributeINP = function(metric) {
    // Soft navs and bfcache can have a dummy INP with no entries.
    if (metric['entries'].length === 0) {
      const navStartTime = metric['navigationStartTime'] || 0;
      metric['attribution'] = {
        'processedEventEntries': [],
        'longAnimationFrameEntries': [],
        'inputDelay': 0,
        'processingDuration': 0,
        'presentationDelay': metric['value'],
        'loadState': getLoadState(navStartTime),
      };
      return metric;
    }

    const firstEntry = /** @type {!PerformanceEventTiming} */ (metric['entries'][0]);
    const group = /** @type {!PendingEntriesGroup} */ (entryToEntriesGroupMap.get(firstEntry));

    // Clamp so `inputDelay` is never negative.
    const processingStart = Math.max(group.processingStart, firstEntry.startTime);

    // Durations are rounded to 8ms: clamp `nextPaintTime` so it doesn't
    // appear to occur before processing starts.
    const nextPaintTime = Math.max(firstEntry.startTime + firstEntry.duration, processingStart);
    // Clamp `processingEnd` to `nextPaintTime` (sync modals, e.g. `alert()`).
    const processingEnd = Math.min(group.processingEnd, nextPaintTime);

    // Sort the entries in processing time order.
    const processedEventEntries = group.entries.sort(function(a, b) {
      return a.processingStart - b.processingStart;
    });

    const longAnimationFrameEntries = getIntersectingLoAFs(firstEntry.startTime, processingEnd);

    const interaction = interactionManager.longestInteractionMap.get(firstEntry.interactionId);

    const attribution = {
      'interactionTarget': interactionTargetMap.get(/** @type {!Interaction} */ (interaction)),
      'interactionType': firstEntry.name.indexOf('key') === 0 ? 'keyboard' : 'pointer',
      'interactionTime': firstEntry.startTime,
      'nextPaintTime': nextPaintTime,
      'processedEventEntries': processedEventEntries,
      'longAnimationFrameEntries': longAnimationFrameEntries,
      'inputDelay': processingStart - firstEntry.startTime,
      'processingDuration': processingEnd - processingStart,
      'presentationDelay': nextPaintTime - processingEnd,
      'loadState': getLoadState(firstEntry.startTime),
      'longestScript': undefined,
      'totalScriptDuration': undefined,
      'totalStyleAndLayoutDuration': undefined,
      'totalPaintDuration': undefined,
      'totalUnattributedDuration': undefined,
    };

    attributeLoAFDetails(attribution);
    metric['attribution'] = attribution;
    return metric;
  };

  // Start observing LoAF entries for attribution.
  observe(['long-animation-frame'], handleLoAFEntries, opts);

  unattributedOnINP(function(metric) {
    onReport(attributeINP(metric));
  }, opts);
}

// ---- attribution/onLCP.ts ---------------------------------------------------------

// Resource buffer for media LCP URLs and subpart attribution (default 50).
const DEFAULT_RESOURCE_BUFFER_SIZE = 50;
let resourceBufferSizeLimit = DEFAULT_RESOURCE_BUFFER_SIZE;

/** @const {!Array<!PerformanceResourceTiming>} */
const resourceBuffer = [];

let resourceBufferStarted = false;

/**
 * The module-level `observe(['resource'], ...)` of attribution/onLCP.ts. Runs
 * once; call it where the attribution build would have been evaluated.
 */
export function startResourceBuffer() {
  if (resourceBufferStarted) return;
  resourceBufferStarted = true;
  observe(['resource'], function(entries) {
    for (let i = 0; i < entries.length; i++) {
      resourceBuffer.push(/** @type {!PerformanceResourceTiming} */ (entries[i]));
      // Keep only the last resourceBufferSizeLimit entries.
      if (resourceBuffer.length > resourceBufferSizeLimit) {
        resourceBuffer.shift();
      }
    }
  });
}

/**
 * @param {function(!Metric)} onReport
 * @param {!ReportOpts=} optsArg
 */
export function onLCP(onReport, optsArg) {
  // Clone the opts object so the `LCPEntryManager` is shared only with the
  // `unattributedOnLCP()` invocation below.
  const opts = cloneOpts(optsArg);

  if (opts['resourceBufferSize'] != undefined) {
    resourceBufferSizeLimit = opts['resourceBufferSize'];
  }

  const lcpEntryManager = initUnique(opts, LCPEntryManager);
  /** @type {!WeakMap<!LargestContentfulPaint, *>} */
  const lcpTargetMap = new WeakMap();

  if (checkSoftNavsEnabled(opts)) {
    lcpEntryManager.softNavigationEntryMap = new Map();
  }

  lcpEntryManager.onBeforeProcessingEntry = function(entry) {
    const node = entry.element;
    if (node) {
      lcpTargetMap.set(entry, targetFor(node, opts));
    } else if (entry.id) {
      // Use the LargestContentfulPaint.id property when the element has been
      // removed from the DOM (and so node is null), but still has an ID.
      lcpTargetMap.set(entry, '#' + entry.id);
    }
  };

  /**
   * @param {!Metric} metric
   * @return {!Metric}
   */
  const attributeLCP = function(metric) {
    // Use a default object if no other attribution has been set.
    let attribution = {
      'timeToFirstByte': 0,
      'resourceLoadDelay': 0,
      'resourceLoadDuration': 0,
      'elementRenderDelay': metric['value'],
    };

    if (metric['entries'].length) {
      const lcpEntry = /** @type {!LargestContentfulPaint} */ (last(metric['entries']));
      // Get the Resource Timing entry checking the local buffer first (the
      // latest one, in case a resource is requested multiple times).
      const byUrl = function(e) {
        return e.name === lcpEntry.url;
      };
      const lcpResourceEntry = /** @type {?PerformanceResourceTiming|undefined|string} */ (lcpEntry.url &&
          (findLast(resourceBuffer, byUrl) || findLast(performance.getEntriesByType('resource'), byUrl)));

      attribution['target'] = lcpTargetMap.get(lcpEntry);
      attribution['lcpEntry'] = lcpEntry;
      // Only attribute the URL and resource entry if they exist.
      if (lcpEntry.url) {
        attribution['url'] = lcpEntry.url;
      }
      if (lcpResourceEntry) {
        attribution['lcpResourceEntry'] = lcpResourceEntry;
      }
      const resource = /** @type {?PerformanceResourceTiming} */ (lcpResourceEntry || null);

      // Get subparts from navigation entry.
      /** @type {?PerformanceEntry|undefined} */
      let navigationEntry;
      let activationStart = 0;
      let responseStart = 0;

      if (metric['navigationType'] !== 'soft-navigation') {
        const hardNavEntry = getNavigationEntry();
        navigationEntry = hardNavEntry;
        activationStart = (hardNavEntry ? hardNavEntry.activationStart : undefined) != null ?
            hardNavEntry.activationStart : 0;
        responseStart = (hardNavEntry ? hardNavEntry.responseStart : undefined) != null ?
            hardNavEntry.responseStart : 0;
      } else {
        // Set activationStart to the navigation start time
        activationStart = metric['navigationStartTime'] || 0;
        // Lookup the soft navigation entry.
        const map = lcpEntryManager.softNavigationEntryMap;
        navigationEntry = map ? map.get(metric['navigationId']) : undefined;
      }

      if (navigationEntry) {
        const ttfb = Math.max(0, responseStart - activationStart);
        // Prefer `requestStart` (if TOA is set), otherwise use `startTime`.
        const lcpRequestStart = Math.max(ttfb,
            resource ? (resource.requestStart || resource.startTime) - activationStart : 0);
        const lcpResponseEnd = Math.min(
            // Cap at LCP time (videos continue downloading after LCP for example)
            metric['value'],
            Math.max(lcpRequestStart, resource ? resource.responseEnd - activationStart : 0));

        attribution = spreadInto(spreadInto({}, attribution), {
          'timeToFirstByte': ttfb,
          'resourceLoadDelay': lcpRequestStart - ttfb,
          'resourceLoadDuration': lcpResponseEnd - lcpRequestStart,
          'elementRenderDelay': metric['value'] - lcpResponseEnd,
          'navigationEntry': navigationEntry,
        });
      }
    }
    metric['attribution'] = attribution;
    return metric;
  };

  unattributedOnLCP(function(metric) {
    onReport(attributeLCP(metric));
  }, opts);
}
