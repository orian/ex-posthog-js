/**
 * @fileoverview Registers the heatmaps module, published as `posthog.heatmaps`
 * like upstream. Needs the `dom` and `deadclicks` chunks (heatmaps run their
 * own dead click detector for `deadclick` points).
 */
import {registerExtension} from '../core/extensions.js';
import {Heatmaps} from './heatmaps.js';

const p = Heatmaps.prototype;
p['startIfEnabled'] = p.startIfEnabled;
p['getAndClearBuffer'] = p.getAndClearBuffer;
Object.defineProperty(p, 'isEnabled', {get: /** @this {!Heatmaps} */ function() {
  return this.checkEnabled();
}});
Object.defineProperty(p, 'flushIntervalMilliseconds', {get: /** @this {!Heatmaps} */ function() {
  return this.flushIntervalMs();
}});

registerExtension('heatmaps', function(instance) {
  return new Heatmaps(instance);
});
