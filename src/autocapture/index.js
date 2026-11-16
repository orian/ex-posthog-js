/**
 * @fileoverview Registers the autocapture module, published as
 * `posthog.autocapture` with upstream's public members. Needs the shared DOM
 * helpers in src/dom/ (the `dom` chunk).
 */
import {registerExtension} from '../core/extensions.js';
import {Autocapture} from './autocapture.js';

const p = Autocapture.prototype;
p['startIfEnabled'] = p.startIfEnabled;
p['setElementSelectors'] = p.setElementSelectors;
p['getElementSelectors'] = p.getElementSelectors;
p['isBrowserSupported'] = p.isBrowserSupported;
p['dispose'] = p.dispose;
Object.defineProperty(p, 'isEnabled', {get: /** @this {!Autocapture} */ function() {
  return this.checkEnabled();
}});

registerExtension('autocapture', function(instance) {
  return new Autocapture(instance);
});
