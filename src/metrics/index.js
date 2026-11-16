/**
 * @fileoverview Registers the metrics module, published as `posthog.metrics`
 * like upstream (`count`, `gauge`, `histogram`, `flush`). Needs the `otlp` chunk.
 */
import {registerExtension} from '../core/extensions.js';
import {PostHogMetrics} from './metrics.js';

const p = PostHogMetrics.prototype;
p['count'] = p.count;
p['gauge'] = p.gauge;
p['histogram'] = p.histogram;
p['flush'] = p.flush;
p['reset'] = p.onReset;
p['dispose'] = p.dispose;
p['initialize'] = p.onInit;
p['onConfigChange'] = p.onConfigChange;

registerExtension('metrics', function(instance) {
  return new PostHogMetrics(instance);
});
