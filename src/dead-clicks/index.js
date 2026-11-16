/**
 * @fileoverview Registers the dead clicks module, published as
 * `posthog.deadClicksAutocapture` like upstream. Needs the `dom` chunk.
 */
import {registerExtension} from '../core/extensions.js';
import {DeadClicksAutocapture, isDeadClicksEnabledForAutocapture} from './dead-clicks.js';

const p = DeadClicksAutocapture.prototype;
p['startIfEnabledOrStop'] = p.startIfEnabledOrStop;
p['stop'] = p.stop;
Object.defineProperty(p, 'lazyLoadedDeadClicksAutocapture', {get: /** @this {!DeadClicksAutocapture} */ function() {
  return this.detector || undefined;
}});

registerExtension('deadClicksAutocapture', function(instance) {
  return new DeadClicksAutocapture(instance, isDeadClicksEnabledForAutocapture);
});
