/**
 * @fileoverview Extra externs: browser APIs missing from Closure's defaults
 * and the public shapes that must never be renamed (they cross the SDK
 * boundary, e.g. the response object handed to `on_request_error`).
 * @externs
 */

/** @type {number} Snippet version marker set by the PostHog HTML snippet. */
Array.prototype.__SV;

/**
 * HTTP response passed to request callbacks and `on_request_error`.
 * @record
 */
function PHResponse() {}
/** @type {number} */
PHResponse.prototype.statusCode;
/** @type {string|undefined} */
PHResponse.prototype.text;
/** @type {*} */
PHResponse.prototype.json;
/** @type {*} */
PHResponse.prototype.error;
