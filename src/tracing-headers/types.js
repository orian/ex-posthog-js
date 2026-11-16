/**
 * @fileoverview Types shared by the tracing headers extension and its lazy
 * part (the fetch/XHR patches).
 */
import {SessionManager} from '../core/session.js';

/** @const {string} the lazy part (upstream kind) */
export const TRACING_HEADERS_KIND = 'tracing-headers';

/**
 * Hostnames (or `true` for every host, the legacy `__add_tracing_headers`
 * boolean), mutated in place on config changes.
 * @typedef {!Array<string>|boolean|undefined}
 */
export let TracingHeadersHostnames;

/**
 * Targets that may receive `traceparent`, mutated in place on config changes.
 * @typedef {!Array<string>|undefined}
 */
export let TraceparentTargets;

/**
 * Patches fetch or XHR: (hostnames, distinct id, session manager, traceparent
 * targets); returns the restore function.
 * @typedef {function(TracingHeadersHostnames, (string|function(): (string|undefined)), (?SessionManager|undefined),
 *     TraceparentTargets=): function()}
 */
export let PatchFn;

/**
 * Upstream `__PosthogExtensions__.tracingHeadersPatchFns`; each returns its restore function.
 * @record
 */
export class TracingHeadersPatchFns {
  constructor() {
    /** @type {!PatchFn} */
    this.patchFetch;
    /** @type {!PatchFn} */
    this.patchXHR;
  }
}
