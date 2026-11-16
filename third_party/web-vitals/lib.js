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
 * @fileoverview web-vitals 6.2.1 `src/lib/*` ported to JSDoc-typed ES2020 for
 * Closure ADVANCED (see README.md in this folder for what changed). Metric
 * objects use quoted keys: they are handed to the caller as data.
 */

// ---- local helpers (no dependency on the SDK) -------------------------------

/**
 * `{...src}` into `target` (own enumerable keys, undefined values included).
 * @param {!Object} target
 * @param {?Object|undefined} src
 * @return {!Object}
 */
export function spreadInto(target, src) {
  if (src) {
    for (const k in src) {
      if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k];
    }
  }
  return target;
}

/**
 * Array.prototype.find.
 * @param {!IArrayLike<?>} list
 * @param {function(?): *} fn
 * @return {?}
 */
export function find(list, fn) {
  for (let i = 0; i < list.length; i++) {
    if (fn(list[i])) return list[i];
  }
  return undefined;
}

/**
 * Array.prototype.findLast.
 * @param {!IArrayLike<?>} list
 * @param {function(?): *} fn
 * @return {?}
 */
export function findLast(list, fn) {
  for (let i = list.length - 1; i >= 0; i--) {
    if (fn(list[i])) return list[i];
  }
  return undefined;
}

/**
 * Array.prototype.at(-1).
 * @param {!IArrayLike<?>} list
 * @return {?}
 */
export function last(list) {
  return list.length ? list[list.length - 1] : undefined;
}

/**
 * The global `addEventListener` (window).
 * @param {string} type
 * @param {function(?)} listener
 * @param {(boolean|!AddEventListenerOptions)} options
 */
export function addListener(type, listener, options) {
  window.addEventListener(type, listener, options);
}

/**
 * The global `removeEventListener` (window).
 * @param {string} type
 * @param {function(?)} listener
 * @param {(boolean|!EventListenerOptions)} options
 */
export function removeListener(type, listener, options) {
  window.removeEventListener(type, listener, options);
}

// ---- types --------------------------------------------------------------------

/**
 * A metric (quoted keys): 'name', 'value', 'rating', 'delta', 'entries', 'id',
 * 'navigationType', 'navigationId', 'navigationInteractionId',
 * 'navigationURL', 'navigationStartTime' and, with attribution, 'attribution'.
 * @typedef {!Object}
 */
export let Metric;

/**
 * Report options (quoted keys): 'reportAllChanges', 'reportSoftNavs',
 * 'durationThreshold', 'includeProcessedEventEntries', 'generateTarget',
 * 'resourceBufferSize'.
 * @typedef {!Object}
 */
export let ReportOpts;

/** @typedef {!Array<number>} */
export let MetricRatingThresholds;

// ---- bfcache.ts ---------------------------------------------------------------

let bfcacheRestoreTime = -1;

/** @return {number} */
export function getBFCacheRestoreTime() {
  return bfcacheRestoreTime;
}

/** @param {function(!PageTransitionEvent)} cb */
export function onBFCacheRestore(cb) {
  addListener('pageshow', function(event) {
    const e = /** @type {!PageTransitionEvent} */ (event);
    if (e.persisted) {
      bfcacheRestoreTime = e.timeStamp;
      cb(e);
    }
  }, true);
}

// ---- bindReporter.ts ------------------------------------------------------------

/**
 * @param {number} value
 * @param {!MetricRatingThresholds} thresholds
 * @return {string}
 */
function getRating(value, thresholds) {
  if (value > thresholds[1]) return 'poor';
  if (value > thresholds[0]) return 'needs-improvement';
  return 'good';
}

/**
 * @param {function(!Metric)} callback
 * @param {!Metric} metric
 * @param {!MetricRatingThresholds} thresholds
 * @param {boolean=} reportAllChanges
 * @return {function(boolean=)}
 */
export function bindReporter(callback, metric, thresholds, reportAllChanges) {
  /** @type {number|undefined} */
  let prevValue;
  let delta;
  return /** @param {boolean=} forceReport */ function(forceReport) {
    if (metric['value'] >= 0) {
      if (forceReport || reportAllChanges) {
        delta = metric['value'] - (prevValue != null ? prevValue : 0);
        // Report the metric if there's a non-zero delta or if no previous
        // value exists (which can happen in the case of the document becoming
        // hidden when the metric value is 0).
        if (delta || prevValue === undefined) {
          prevValue = metric['value'];
          metric['delta'] = delta;
          metric['rating'] = getRating(metric['value'], thresholds);
          callback(metric);
        }
      }
    }
  };
}

// ---- doubleRAF.ts ---------------------------------------------------------------

/** @param {function()} cb */
export function doubleRAF(cb) {
  requestAnimationFrame(function() {
    requestAnimationFrame(function() {
      cb();
    });
  });
}

// ---- entry managers (FCPEntryManager.ts, LCPEntryManager.ts, LayoutShiftManager.ts) ----

export class FCPEntryManager {
  constructor() {
    /** @type {!Map<?, !PerformanceSoftNavigation>|undefined} */
    this.softNavigationEntryMap = undefined;
  }
}

export class LCPEntryManager {
  constructor() {
    /** @type {(function(!LargestContentfulPaint))|undefined} */
    this.onBeforeProcessingEntry = undefined;
    /** @type {!Map<?, !PerformanceSoftNavigation>|undefined} */
    this.softNavigationEntryMap = undefined;
  }

  /** @param {!LargestContentfulPaint} entry */
  processEntry(entry) {
    if (this.onBeforeProcessingEntry) this.onBeforeProcessingEntry(entry);
  }
}

export class LayoutShiftManager {
  constructor() {
    /** @type {(function(!LayoutShift))|undefined} */
    this.onAfterProcessingUnexpectedShift = undefined;
    /** @type {number} */
    this.sessionValue = 0;
    /** @type {!Array<!LayoutShift>} */
    this.sessionEntries = [];
  }

  /** @param {!LayoutShift} entry */
  processEntry(entry) {
    // Only count layout shifts without recent user input.
    if (entry.hadRecentInput) return;
    const firstSessionEntry = this.sessionEntries[0];
    const lastSessionEntry = last(this.sessionEntries);
    // If the entry occurred less than 1 second after the previous entry
    // and less than 5 seconds after the first entry in the session,
    // include the entry in the current session. Otherwise, start a new
    // session.
    if (this.sessionValue && firstSessionEntry && lastSessionEntry &&
        entry.startTime - lastSessionEntry.startTime < 1000 &&
        entry.startTime - firstSessionEntry.startTime < 5000) {
      this.sessionValue += entry.value;
      this.sessionEntries.push(entry);
    } else {
      this.sessionValue = entry.value;
      this.sessionEntries = [entry];
    }
    if (this.onAfterProcessingUnexpectedShift) this.onAfterProcessingUnexpectedShift(entry);
  }
}

// ---- generateUniqueID.ts ----------------------------------------------------------

/**
 * Performantly generate a unique, 30-char string by combining a version
 * number, the current timestamp with a 13-digit number integer.
 * @return {string}
 */
export function generateUniqueID() {
  return 'v6-' + Date.now() + '-' + (Math.floor(Math.random() * (9e12 - 1)) + 1e12);
}

// ---- getNavigationEntry.ts, getActivationStart.ts, getLoadState.ts ------------------

/** @return {!PerformanceNavigationTiming|undefined} */
export function getNavigationEntry() {
  const navigationEntry = /** @type {!PerformanceNavigationTiming|undefined} */ (
    performance.getEntriesByType('navigation')[0]);
  // Check to ensure the `responseStart` property is present and valid.
  // In some cases a zero value is reported by the browser (for
  // privacy/security reasons), and in other cases (bugs) the value is
  // negative or is larger than the current page time. Ignore these cases.
  if (navigationEntry && navigationEntry.responseStart > 0 &&
      navigationEntry.responseStart < performance.now()) {
    return navigationEntry;
  }
  return undefined;
}

/** @return {number} */
export function getActivationStart() {
  const entry = getNavigationEntry();
  const activationStart = entry ? entry.activationStart : undefined;
  return activationStart != null ? activationStart : 0;
}

/**
 * @param {number} timestamp
 * @return {string}
 */
export function getLoadState(timestamp) {
  if (document.readyState === 'loading') {
    // If the `readyState` is 'loading' there's no need to look at timestamps
    // since the timestamp has to be the current time or earlier.
    return 'loading';
  }
  const hardNavEntry = getNavigationEntry();
  if (hardNavEntry) {
    if (timestamp < hardNavEntry.domInteractive) {
      return 'loading';
    } else if (hardNavEntry.domContentLoadedEventStart === 0 ||
        timestamp < hardNavEntry.domContentLoadedEventStart) {
      return 'dom-interactive';
    } else if (hardNavEntry.domComplete === 0 || timestamp < hardNavEntry.domComplete) {
      return 'dom-content-loaded';
    }
  }
  // If any of the above fail, default to loaded.
  return 'complete';
}

// ---- getSelector.ts -------------------------------------------------------------------

/**
 * @param {!Node} node
 * @return {string}
 */
function getName(node) {
  const name = node.nodeName;
  return node.nodeType === 1 ? name.toLowerCase() : name.toUpperCase().replace(/^#/, '');
}

const MAX_LEN = 100;

/**
 * @param {?Node} node
 * @return {string}
 */
export function getSelector(node) {
  let sel = '';
  try {
    while ((node ? node.nodeType : undefined) !== 9) {
      // As upstream: a null node throws here and the selector so far is returned.
      const el = /** @type {!Element} */ (node);
      const classList = el.classList;
      const part = el.id ? '#' + el.id :
          [getName(el)].concat(Array.prototype.slice.call(classList != null ? classList : []).sort()).join('.');
      if (sel.length + part.length > MAX_LEN - 1) {
        return sel || part;
      }
      sel = sel ? part + '>' + sel : part;
      if (el.id) {
        break;
      }
      node = el.parentNode;
    }
  } catch (e) {
    // Do nothing...
  }
  return sel;
}

// ---- getVisibilityWatcher.ts ------------------------------------------------------------

let firstHiddenTime = -1;
/** @type {?Set<function()>} */
let onHiddenFunctions = null;

/** @return {number} */
function initHiddenTime() {
  // If the document is hidden when this code runs, assume it was always
  // hidden and the page was loaded in the background, with the one exception
  // that visibility state is always 'hidden' during prerendering.
  return document.visibilityState === 'hidden' && !document.prerendering ? 0 : Infinity;
}

/** @param {!Event} event */
function onVisibilityUpdate(event) {
  // Handle changes to hidden state
  if (document.visibilityState === 'hidden') {
    if (event.type === 'visibilitychange' && onHiddenFunctions) {
      onHiddenFunctions.forEach(function(onHiddenFunction) {
        onHiddenFunction();
      });
    }
    // If the document is 'hidden' and no previous hidden timestamp has been
    // set (so is infinity), update it based on the current event data.
    if (!isFinite(firstHiddenTime)) {
      firstHiddenTime = event.type === 'visibilitychange' ? event.timeStamp : 0;
      // We no longer need the `prerenderingchange` event listener.
      removeListener('prerenderingchange', onVisibilityUpdate, true);
    }
  }
}

/**
 * @typedef {{getFirstHiddenTime: function(): number, onHidden: function(function())}}
 */
export let VisibilityWatcher;

/**
 * @param {boolean=} reset
 * @return {!VisibilityWatcher}
 */
export function getVisibilityWatcher(reset) {
  if (!onHiddenFunctions) onHiddenFunctions = new Set();
  if (reset) {
    firstHiddenTime = Infinity;
  }
  if (firstHiddenTime < 0) {
    // Check if we have a previous hidden `visibility-state` performance entry.
    const activationStart = getActivationStart();
    const hiddenEntry = !document.prerendering ?
        find(performance.getEntriesByType('visibility-state'), function(e) {
          return e.name === 'hidden' && e.startTime >= activationStart;
        }) : undefined;
    const firstVisibilityStateHiddenTime = hiddenEntry ? hiddenEntry.startTime : undefined;
    // Prefer that, but if it's not available and the document is hidden when
    // this code runs, assume it was hidden since navigation start.
    firstHiddenTime = firstVisibilityStateHiddenTime != null ? firstVisibilityStateHiddenTime : initHiddenTime();
    // Listen for visibility changes so we can handle things like bfcache
    // restores and/or prerender, and also for onHidden function calls.
    addListener('visibilitychange', onVisibilityUpdate, true);
    // When a page is prerendering, its `visibilityState` is 'hidden', so an
    // additional check after prerendering completes is also required.
    addListener('prerenderingchange', onVisibilityUpdate, true);
    // Reset the time on bfcache restores.
    onBFCacheRestore(function() {
      // Schedule a task in order to track the `visibilityState` once it's
      // had an opportunity to change to visible in all browsers.
      setTimeout(function() {
        firstHiddenTime = initHiddenTime();
      });
    });
  }
  const hiddenFunctions = onHiddenFunctions;
  return {
    getFirstHiddenTime: function() {
      return firstHiddenTime;
    },
    onHidden: function(cb) {
      hiddenFunctions.add(cb);
    },
  };
}

// ---- initMetric.ts ------------------------------------------------------------------------

/**
 * @param {string} name
 * @param {number=} value
 * @param {string=} navigationType
 * @param {*=} navigationId
 * @param {*=} navigationInteractionId
 * @param {string=} navigationURL
 * @param {number=} navigationStartTime
 * @return {!Metric}
 */
export function initMetric(name, value, navigationType, navigationId, navigationInteractionId, navigationURL,
    navigationStartTime) {
  const hardNavEntry = getNavigationEntry();
  const hardNavId = (hardNavEntry ? hardNavEntry.navigationId : undefined) || 0;
  let type = 'navigate';
  if (navigationType) {
    // If it was passed in, then use that
    type = navigationType;
  } else if (getBFCacheRestoreTime() >= 0) {
    type = 'back-forward-cache';
  } else if (hardNavEntry) {
    if (document.prerendering || getActivationStart() > 0) {
      type = 'prerender';
    } else if (document.wasDiscarded) {
      type = 'restore';
    } else if (hardNavEntry.type) {
      type = String(hardNavEntry.type).replace(/_/g, '-');
    }
  }
  return {
    'name': name,
    'value': value === undefined ? -1 : value,
    'rating': 'good', // If needed, will be updated when reported.
    'delta': 0,
    'entries': [],
    'id': generateUniqueID(),
    'navigationType': type,
    'navigationId': (navigationId === undefined ? 0 : navigationId) || hardNavId,
    'navigationInteractionId': navigationInteractionId,
    'navigationURL': navigationURL || (hardNavEntry ? hardNavEntry.name : undefined),
    'navigationStartTime': navigationStartTime || 0,
  };
}

// ---- initUnique.ts ----------------------------------------------------------------------------

/** @type {?WeakMap<!Function, !WeakMap<!Object, ?>>} */
let instanceMap = null;

/**
 * Returns either a new instance of `ClassObj` or the existing one created for
 * the same identity object.
 * @param {!Object} identityObj
 * @param {function(new: T)} ClassObj
 * @return {T}
 * @template T
 */
export function initUnique(identityObj, ClassObj) {
  if (!instanceMap) instanceMap = new WeakMap();
  let classInstances = instanceMap.get(ClassObj);
  if (!classInstances) {
    classInstances = new WeakMap();
    instanceMap.set(ClassObj, classInstances);
  }
  if (!classInstances.get(identityObj)) {
    classInstances.set(identityObj, new ClassObj());
  }
  return classInstances.get(identityObj);
}

// ---- polyfills/interactionCountPolyfill.ts --------------------------------------------------

let interactionCountEstimate = 0;
let minKnownInteractionId = Infinity;
let maxKnownInteractionId = 0;

/** @param {!Array<!PerformanceEntry>} entries */
function updateEstimate(entries) {
  for (let i = 0; i < entries.length; i++) {
    const entry = /** @type {!PerformanceEventTiming} */ (entries[i]);
    if (entry.interactionId) {
      minKnownInteractionId = Math.min(minKnownInteractionId, entry.interactionId);
      maxKnownInteractionId = Math.max(maxKnownInteractionId, entry.interactionId);
      interactionCountEstimate = maxKnownInteractionId ?
          (maxKnownInteractionId - minKnownInteractionId) / 7 + 1 : 0;
    }
  }
}

/** @type {!PerformanceObserver|undefined} */
let countPo;

/**
 * Returns the `interactionCount` value using the native API (if available)
 * or the polyfill estimate in this module.
 * @return {number}
 */
export function getInteractionCount() {
  return countPo ? interactionCountEstimate :
      (performance.interactionCount != null ? performance.interactionCount : 0);
}

/** Feature detects native support or initializes the polyfill if needed. */
export function initInteractionCountPolyfill() {
  if ('interactionCount' in performance || countPo) return;
  countPo = observe(['event'], updateEstimate, {'durationThreshold': 0});
}

// ---- InteractionManager.ts ----------------------------------------------------------------------

/**
 * @typedef {{latency: number, id: number, entries: !Array<!PerformanceEventTiming>}}
 */
export let Interaction;

// To prevent unnecessary memory usage on pages with lots of interactions,
// store at most 10 of the longest interactions to consider as INP candidates.
const MAX_INTERACTIONS_TO_CONSIDER = 10;

export class InteractionManager {
  constructor() {
    /**
     * The interaction count at the start of the current navigation.
     * @type {number}
     */
    this.prevInteractionCount = 0;
    /**
     * The longest interactions on the page (by latency), longest first.
     * @type {!Array<!Interaction>}
     */
    this.longestInteractionList = [];
    /** @type {!Map<number, !Interaction>} */
    this.longestInteractionMap = new Map();
    /** @type {(function(!PerformanceEventTiming))|undefined} */
    this.onBeforeProcessingEntry = undefined;
    /** @type {(function(!Interaction))|undefined} */
    this.onAfterProcessingINPCandidate = undefined;
  }

  /** @return {number} */
  getInteractionCountForNavigation() {
    return getInteractionCount() - this.prevInteractionCount;
  }

  resetInteractions() {
    this.prevInteractionCount = getInteractionCount();
    this.longestInteractionList.length = 0;
    this.longestInteractionMap.clear();
  }

  /**
   * Returns the estimated p98 longest interaction based on the stored
   * interaction candidates and the interaction count for the current page.
   * @param {string} navigationType
   * @return {!Interaction|undefined}
   */
  estimateP98LongestInteraction(navigationType) {
    const interactionCountForNavigation = this.getInteractionCountForNavigation();
    const candidateInteractionIndex = Math.min(this.longestInteractionList.length - 1,
        Math.floor(interactionCountForNavigation / 50));
    // If we have a non-zero interactionCountForNavigation but no
    // candidateInteractionIndex, then it's below the 16ms limit so report a
    // dummy 8ms interaction (soft navs and bfcache restores only).
    if (interactionCountForNavigation && candidateInteractionIndex === -1 &&
        (navigationType === 'soft-navigation' || navigationType === 'back-forward-cache')) {
      return {latency: 8, id: -1, entries: []};
    }
    return this.longestInteractionList[candidateInteractionIndex];
  }

  /**
   * Adds an entry to the list of worst interactions if it is long enough, or
   * merges it into an existing interaction.
   * @param {!PerformanceEventTiming} entry
   */
  processEntry(entry) {
    if (this.onBeforeProcessingEntry) this.onBeforeProcessingEntry(entry);
    // Skip further processing for entries that cannot be INP candidates.
    if (!entry.interactionId) return;
    // The least-long of the 10 longest interactions.
    const minLongestInteraction = last(this.longestInteractionList);
    let interaction = this.longestInteractionMap.get(entry.interactionId);
    // Only process the entry if it's possibly one of the ten longest,
    // or if it's part of an existing interaction.
    if (interaction || this.longestInteractionList.length < MAX_INTERACTIONS_TO_CONSIDER ||
        entry.duration > minLongestInteraction.latency) {
      if (interaction) {
        // If the new entry has a longer duration, replace the old entries,
        // otherwise add to the array.
        if (entry.duration > interaction.latency) {
          interaction.entries = [entry];
          interaction.latency = entry.duration;
        } else if (entry.duration === interaction.latency &&
            entry.startTime === interaction.entries[0].startTime) {
          interaction.entries.push(entry);
        }
      } else {
        interaction = {id: entry.interactionId, entries: [entry], latency: entry.duration};
        this.longestInteractionMap.set(interaction.id, interaction);
        this.longestInteractionList.push(interaction);
      }
      // Sort the entries by latency (descending) and keep only the top ten.
      this.longestInteractionList.sort(function(a, b) {
        return b.latency - a.latency;
      });
      if (this.longestInteractionList.length > MAX_INTERACTIONS_TO_CONSIDER) {
        const removed = this.longestInteractionList.splice(MAX_INTERACTIONS_TO_CONSIDER);
        for (let i = 0; i < removed.length; i++) {
          this.longestInteractionMap.delete(removed[i].id);
        }
      }
      // Call any post-processing on the interaction
      if (this.onAfterProcessingINPCandidate) this.onAfterProcessingINPCandidate(interaction);
    }
  }
}

// ---- observe.ts ---------------------------------------------------------------------------------

/**
 * Creates a `PerformanceObserver` that observes the given entry types with
 * buffering enabled and calls `callback` with the entries of each batch.
 * Feature-detects entry support and swallows errors in unsupporting browsers.
 * @param {!Array<string>} types
 * @param {function(!Array<!PerformanceEntry>)} callback
 * @param {?Object=} opts extra PerformanceObserverInit keys (quoted)
 * @return {!PerformanceObserver|undefined}
 */
export function observe(types, callback, opts) {
  try {
    const supportedTypes = types.filter(function(t) {
      return PerformanceObserver.supportedEntryTypes.indexOf(t) !== -1;
    });
    if (supportedTypes.length > 0) {
      const po = new PerformanceObserver(function(list) {
        // Delay by a microtask to workaround a bug in Safari where the
        // callback is invoked immediately, rather than in a separate task.
        queueMicrotask(function() {
          const entries = list.getEntries();
          // When observing more than one entry type, entries from different
          // types can be delivered out of order, so sort by end time.
          if (supportedTypes.length > 1) {
            entries.sort(function(a, b) {
              return (a.startTime + a.duration) - (b.startTime + b.duration);
            });
          }
          callback(entries);
        });
      });
      for (let i = 0; i < supportedTypes.length; i++) {
        po.observe(/** @type {!PerformanceObserverInit} */ (
          spreadInto({'type': supportedTypes[i], 'buffered': true}, opts || {})));
      }
      return po;
    }
  } catch (e) {
    // Do nothing.
  }
  return undefined;
}

// ---- runOnce.ts, whenActivated.ts, whenIdleOrHidden.ts -----------------------------------------

/**
 * @param {function(?)} cb
 * @return {function(?)}
 */
export function runOnce(cb) {
  let called = false;
  return function(arg) {
    if (!called) {
      cb(arg);
      called = true;
    }
  };
}

/** @param {function()} callback */
export function whenActivated(callback) {
  if (document.prerendering) {
    addListener('prerenderingchange', callback, true);
  } else {
    callback();
  }
}

/**
 * Runs the passed callback during the next idle period, or immediately
 * if the browser's visibility state is (or becomes) hidden.
 * @param {function()} cb
 */
export function whenIdleOrHidden(cb) {
  // Cap the requestIdleCallback to 1 sec for very busy apps.
  // If not using rIC, then the setTimeout timeout should be 0.
  const timeout = 'requestIdleCallback' in window ? 1000 : 0;
  const rIC = /** @type {?} */ (window['requestIdleCallback'] || setTimeout);
  const cIC = /** @type {?} */ (window['cancelIdleCallback'] || clearTimeout);
  // If the document is hidden, run the callback immediately, otherwise
  // race an idle callback with the next `visibilitychange` event.
  if (document.visibilityState === 'hidden') {
    cb();
  } else {
    const wrappedCb = runOnce(cb);
    let idleHandle = -1;
    const onHidden = function() {
      cIC(idleHandle);
      wrappedCb(undefined);
    };
    addListener('visibilitychange', onHidden, /** @type {!AddEventListenerOptions} */ ({'once': true, 'capture': true}));
    idleHandle = rIC(function() {
      removeListener('visibilitychange', onHidden, /** @type {!EventListenerOptions} */ ({'capture': true}));
      wrappedCb(undefined);
    }, {'timeout': timeout});
  }
}

// ---- softNavs.ts --------------------------------------------------------------------------------

/**
 * @param {!ReportOpts|undefined} opts
 * @return {*}
 */
export function checkSoftNavsEnabled(opts) {
  const PO = window['PerformanceObserver'];
  const supported = PO != null && PO['supportedEntryTypes'] != null ?
      PO['supportedEntryTypes'].indexOf('soft-navigation') !== -1 : undefined;
  const PSN = window['PerformanceSoftNavigation'];
  const proto = PSN != null ? PSN['prototype'] : undefined;
  return (
    // Firefox has a preference to disable this, which some people use so add a guard
    supported &&
    // Older implementations expose the value as an attribute rather than the
    // method. Only the newer method is supported.
    typeof (proto != null ? proto['getLargestInteractionContentfulPaint'] : undefined) === 'function' &&
    opts && opts['reportSoftNavs']);
}

/**
 * Stores a soft navigation entry keyed by its navigationId, keeping only the
 * 2 most recent entries so the map cannot grow unbounded.
 * @param {!Map<?, !PerformanceSoftNavigation>} map
 * @param {!PerformanceSoftNavigation} entry
 */
export function storeSoftNavEntry(map, entry) {
  map.set(entry.navigationId, entry);
  if (map.size > 2) {
    const firstKey = map.keys().next().value;
    if (firstKey !== undefined) {
      map.delete(firstKey);
    }
  }
}
