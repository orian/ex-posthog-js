/**
 * @fileoverview Registers exception capture: `posthog.exceptions` (manual
 * `captureException`, `$exception_steps`, filters) and
 * `posthog.exceptionObserver` (autocapture of `window.onerror`,
 * `onunhandledrejection` and, optionally, `console.error`), under upstream's
 * instance names and in upstream's init order (exceptions first).
 */
import {registerExtension} from '../core/extensions.js';
import {PostHogExceptions} from './exceptions.js';
import {ExceptionObserver} from './autocapture.js';

const p = PostHogExceptions.prototype;
p['buildProperties'] = p.buildProperties;
p['sendExceptionEvent'] = p.sendExceptionEvent;
p['addExceptionStep'] = p.addExceptionStep;

const o = ExceptionObserver.prototype;
o['startIfEnabledOrStop'] = o.startIfEnabledOrStop;
o['captureException'] = o.captureException;
Object.defineProperty(o, 'isEnabled', {get: /** @this {!ExceptionObserver} */ function() {
  return this.enabled_();
}});

registerExtension('exceptions', function(instance) {
  return new PostHogExceptions(instance);
});
registerExtension('exceptionObserver', function(instance) {
  return new ExceptionObserver(instance);
});
