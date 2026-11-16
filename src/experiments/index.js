/**
 * @fileoverview Registers the web experiments module (needs feature flags).
 */
import {registerExtension} from '../core/extensions.js';
import {WebExperiments} from './web-experiments.js';

registerExtension('webExperiments', function(instance) {
  return new WebExperiments(instance);
});
