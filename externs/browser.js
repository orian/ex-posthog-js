/**
 * @fileoverview Extra externs for browser APIs missing from Closure's
 * defaults. Most newer APIs (CompressionStream, AbortController,
 * navigator.webdriver) are accessed with quoted keys instead, so this file is
 * intentionally small.
 * @externs
 */

/** @type {number} Snippet version marker set by the PostHog HTML snippet. */
Array.prototype.__SV;
