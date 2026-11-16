/**
 * @fileoverview The lazy build's main script (dist/lazy/posthog.js), split
 * like upstream's array.js: the core, feature flags, web experiments,
 * exception capture, autocapture, heatmaps, metrics, the toolbar loader and
 * the shell of every lazily loaded extension. The shells load their lazy
 * part from dist/lazy/<kind>.js at the point upstream calls
 * `loadExternalDependency(posthog, kind, cb)`:
 *
 *   upstream kind                       our chunk
 *   lazy-recorder                       replay.js (+ PostHog's recorder.js, rrweb)
 *   exception-autocapture               exception-autocapture.js
 *   dead-clicks-autocapture             dead-clicks-autocapture.js
 *   web-vitals, web-vitals-with-attribution,
 *   web-vitals-soft-navs, web-vitals-with-attribution-soft-navs
 *                                       web-vitals.js (one chunk, every flavour)
 *   tracing-headers                     tracing-headers.js
 *   logs                                logs.js
 *
 * PostHog-hosted assets (config.js, toolbar.js, recorder.js) are loaded from
 * PostHog as in the other builds.
 */
// First: the chunk loader reads document.currentScript while posthog.js runs.
import '../core/lazy-chunks.js';
import './core.js';
import '../flags/index.js';
// Session replay registers before experiments, like upstream's extension order.
import '../replay/shell.js';
import '../experiments/index.js';
import '../exceptions/shell.js';
import '../autocapture/index.js';
import '../dead-clicks/shell.js';
import '../heatmaps/index.js';
import '../web-vitals/shell.js';
import '../tracing-headers/shell.js';
import '../logs/shell.js';
import '../metrics/index.js';
import '../toolbar/index.js';
