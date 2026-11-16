/**
 * @fileoverview Registers the dead clicks extension (the shell), published as
 * `posthog.deadClicksAutocapture` like upstream. Needs the `dom` chunk. The
 * detector is the lazy part (detector.js); index.js loads both.
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
