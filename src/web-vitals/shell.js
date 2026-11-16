/**
 * @fileoverview Registers the web vitals module, published as
 * `posthog.webVitalsAutocapture` like upstream (the shell; Google's web-vitals
 * library is the lazy part in lazy.js, index.js loads both). Needs only the
 * core chunk.
 */
import {registerExtension} from '../core/extensions.js';
import {WebVitalsAutocapture} from './web-vitals.js';

const p = WebVitalsAutocapture.prototype;
p['startIfEnabled'] = p.startIfEnabled;
/**
 * @param {string} name
 * @param {function(this:WebVitalsAutocapture): *} getter
 */
function getter(name, getter) {
  Object.defineProperty(p, name, {get: getter});
}
getter('isEnabled', function() {
  return this.checkEnabled();
});
getter('allowedMetrics', function() {
  return this.getAllowedMetrics();
});
getter('flushToCaptureTimeoutMs', function() {
  return this.getFlushToCaptureTimeoutMs();
});
getter('attributionMetrics', function() {
  return this.getAttributionMetrics();
});
getter('useAttribution', function() {
  return this.shouldUseAttribution();
});
getter('useSoftNavs', function() {
  return this.shouldUseSoftNavs();
});

registerExtension('webVitalsAutocapture', function(instance) {
  return new WebVitalsAutocapture(instance);
});
