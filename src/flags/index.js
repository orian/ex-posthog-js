/**
 * @fileoverview Registers the feature flags module. Importing (or loading the
 * compiled `flags` chunk) is all that's needed to enable flags.
 */
import {registerExtension} from '../core/extensions.js';
import {FeatureFlags} from './feature-flags.js';

registerExtension('featureFlags', function(instance) {
  return new FeatureFlags(instance);
});
