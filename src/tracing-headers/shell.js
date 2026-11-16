/**
 * @fileoverview Registers the tracing headers module, published as
 * `posthog.tracingHeaders` like upstream (the shell; the patches are the lazy
 * part in lazy.js, index.js loads both). Needs only the core chunk.
 */
import {registerExtension} from '../core/extensions.js';
import {TracingHeaders} from './tracing-headers.js';

TracingHeaders.prototype['startIfEnabledOrStop'] = TracingHeaders.prototype.startIfEnabledOrStop;

registerExtension('tracingHeaders', function(instance) {
  return new TracingHeaders(instance);
});
