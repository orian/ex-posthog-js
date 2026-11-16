/**
 * @fileoverview Everything: core + feature flags + session replay + web experiments.
 * core.js runs first (and may already init from the snippet); the extension
 * registry attaches modules registered afterwards to live instances, so the
 * order of these imports only fixes flags-before-experiments.
 */
import './core.js';
import '../flags/index.js';
// Session replay registers before experiments, like upstream's extension order.
import '../replay/index.js';
import '../experiments/index.js';
