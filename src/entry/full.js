/**
 * @fileoverview Everything: core + feature flags + session replay + web experiments +
 * exceptions + autocapture, dead clicks and heatmaps.
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
// Logs and metrics (they share src/otlp/), and the toolbar loader.
import '../logs/index.js';
import '../metrics/index.js';
import '../toolbar/index.js';
