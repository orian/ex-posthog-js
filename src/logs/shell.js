/**
 * @fileoverview Registers the logs module, published as `posthog.logs` like
 * upstream (`posthog.captureLog` and `posthog.logger` delegate to it); the
 * shell, console capture is the lazy part in console-logs.js and index.js
 * loads both. Needs the
 * `otlp` chunk.
 */
import {registerExtension} from '../core/extensions.js';
import {PostHogLogs} from './logs.js';

const p = PostHogLogs.prototype;
p['captureLog'] = p.captureLog;
p['captureConsoleLog'] = p.captureConsoleLog;
p['captureBufferedConsoleLog'] = p.captureBufferedConsoleLog;
p['flushLogs'] = p.flushLogs;
p['flush'] = p.flush;
p['reset'] = p.onReset;
p['loadIfEnabled'] = p.loadIfEnabled;
p['dispose'] = p.dispose;
p['name'] = 'logs';
Object.defineProperty(p, 'logger', {get: /** @this {!PostHogLogs} */ function() {
  return this.getLogger();
}});

registerExtension('logs', function(instance) {
  return new PostHogLogs(instance);
});
