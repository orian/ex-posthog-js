/**
 * @fileoverview Registers the feature flags module. Importing (or loading the
 * compiled `flags` chunk) is all that's needed to enable flags. The module is
 * published as `posthog.featureFlags` with upstream's public method names.
 */
import {registerExtension} from '../core/extensions.js';
import {FeatureFlags} from './feature-flags.js';

const p = FeatureFlags.prototype;
p['getFlags'] = p.getFlags;
p['getFlagVariants'] = p.getFlagVariants;
p['getFlagPayloads'] = p.getFlagPayloads;
p['getFlagsWithDetails'] = p.getFlagsWithDetails;
p['getFeatureFlag'] = p.getFeatureFlag;
p['getFeatureFlagDetails'] = p.getFeatureFlagDetails;
p['getFeatureFlagPayload'] = p.getFeatureFlagPayload;
p['getFeatureFlagResult'] = p.getFeatureFlagResult;
p['getAllFeatureFlags'] = p.getAllFeatureFlags;
p['isFeatureEnabled'] = p.isFeatureEnabled;
p['reloadFeatureFlags'] = p.reloadFeatureFlags;
p['ensureFlagsLoaded'] = p.ensureFlagsLoaded;
p['overrideFeatureFlags'] = p.overrideFeatureFlags;
p['override'] = p.override;
p['updateFlags'] = p.updateFlags;
p['onFeatureFlags'] = p.onFeatureFlags;
p['addFeatureFlagsHandler'] = p.addFeatureFlagsHandler;
p['removeFeatureFlagsHandler'] = p.removeFeatureFlagsHandler;
p['getEarlyAccessFeatures'] = p.getEarlyAccessFeatures;
p['updateEarlyAccessFeatureEnrollment'] = p.updateEarlyAccessFeatureEnrollment;
p['setPersonPropertiesForFlags'] = p.setPersonPropertiesForFlags;
p['resetPersonPropertiesForFlags'] = p.resetPersonPropertiesForFlags;
p['setGroupPropertiesForFlags'] = p.setGroupPropertiesForFlags;
p['resetGroupPropertiesForFlags'] = p.resetGroupPropertiesForFlags;
p['setReloadingPaused'] = p.setReloadingPaused;
p['setAnonymousDistinctId'] = p.setAnonymousDistinctId;
p['reset'] = p.reset;
Object.defineProperty(p, 'hasLoadedFlags', {get: /** @this {!FeatureFlags} */ function() {
  return this.hasLoadedFlags();
}});

registerExtension('featureFlags', function(instance) {
  return new FeatureFlags(instance);
});
