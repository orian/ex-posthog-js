/**
 * @fileoverview Everything: core + feature flags + session replay + web experiments +
 * exceptions + autocapture, dead clicks and heatmaps + web vitals + tracing headers.
 * core.js runs first (and may already init from the snippet); the extension
 * registry attaches modules registered afterwards to live instances, so the
 * order of these imports only fixes flags-before-experiments.
 */
import './core.js';
import '../flags/index.js';
// Session replay registers before experiments, like upstream's extension order.
import '../replay/index.js';
import '../experiments/index.js';
import '../exceptions/index.js';
// Autocapture, dead clicks and heatmaps (they share src/dom/).
import '../autocapture/index.js';
import '../dead-clicks/index.js';
import '../heatmaps/index.js';
// Web vitals and tracing headers (each needs only core).
import '../web-vitals/index.js';
import '../tracing-headers/index.js';
