/**
 * @fileoverview Everything: core + feature flags + web experiments +
 * autocapture, dead clicks and heatmaps.
 * core.js runs first (and may already init from the snippet); the extension
 * registry attaches modules registered afterwards to live instances, so the
 * order of these imports only fixes flags-before-experiments.
 */
import './core.js';
import '../flags/index.js';
import '../experiments/index.js';
// Autocapture, dead clicks and heatmaps (they share src/dom/).
import '../autocapture/index.js';
import '../dead-clicks/index.js';
import '../heatmaps/index.js';
