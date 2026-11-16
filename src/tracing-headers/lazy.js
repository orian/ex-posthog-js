/**
 * @fileoverview The lazy part `tracing-headers` (upstream
 * entrypoints/tracing-headers.ts): registers the fetch/XHR patch functions.
 */
import {provideLazy} from '../core/lazy.js';
import {patchFetch, patchXHR} from './patch-fns.js';
import {TRACING_HEADERS_KIND, TracingHeadersPatchFns} from './types.js';

provideLazy(TRACING_HEADERS_KIND, /** @type {!TracingHeadersPatchFns} */ ({patchFetch: patchFetch, patchXHR: patchXHR}));
