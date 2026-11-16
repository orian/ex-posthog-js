/**
 * @fileoverview Performance timeline APIs used by web-vitals
 * (third_party/web-vitals) that Closure's default externs lack.
 * @externs
 */

/** @type {*} Navigation id (soft navigations; also on hard-navigation entries). */
PerformanceEntry.prototype.navigationId;

/** @type {string|undefined} */
PerformanceEventTiming.prototype.targetSelector;

/** @type {boolean|undefined} */
Document.prototype.wasDiscarded;

/**
 * @constructor
 * @extends {PerformanceEntry}
 */
function PerformanceSoftNavigation() {}
/** @type {*} */
PerformanceSoftNavigation.prototype.interactionId;
/** @type {number|null|undefined} */
PerformanceSoftNavigation.prototype.presentationTime;
/** @type {number|undefined} */
PerformanceSoftNavigation.prototype.paintTime;
/** @type {(function(): ?InteractionContentfulPaint)|undefined} */
PerformanceSoftNavigation.prototype.getLargestInteractionContentfulPaint;

/**
 * @constructor
 * @extends {PerformanceEntry}
 */
function InteractionContentfulPaint() {}
/** @type {*} */
InteractionContentfulPaint.prototype.interactionId;
/** @type {?LargestContentfulPaint|undefined} */
InteractionContentfulPaint.prototype.largestContentfulPaint;

/**
 * @constructor
 * @extends {PerformanceEntry}
 */
function PerformanceScriptTiming() {}
/** @type {number} */
PerformanceScriptTiming.prototype.forcedStyleAndLayoutDuration;

/**
 * @constructor
 * @extends {PerformanceEntry}
 */
function PerformanceLongAnimationFrameTiming() {}
/** @type {number} */
PerformanceLongAnimationFrameTiming.prototype.styleAndLayoutStart;
/** @type {!Array<!PerformanceScriptTiming>} */
PerformanceLongAnimationFrameTiming.prototype.scripts;
