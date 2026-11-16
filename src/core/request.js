/**
 * @fileoverview HTTP transports: fetch, XHR and sendBeacon, with optional
 * native gzip (CompressionStream) and base64 form encoding for beacons.
 */
import {addQueryParams, base64Encode, jsonParse, jsonStringify, nav, now, win} from './utils.js';
import {logger} from './logger.js';

/**
 * @typedef {{
 *   statusCode: number,
 *   text: (string|undefined),
 *   json: *,
 *   error: *
 * }}
 */
export let HttpResponse;

/**
 * compression: 'gzip-js' | 'base64' | undefined
 * transport:   'fetch' | 'XHR' | 'sendBeacon' | undefined
 * @typedef {{
 *   url: string,
 *   method: string,
 *   data: *,
 *   headers: (!Object<string,string>|undefined),
 *   compression: (string|undefined),
 *   transport: (string|undefined),
 *   timeout: (number|undefined),
 *   callback: (function(!HttpResponse)|undefined)
 * }}
 */
export let RequestOptions;

/** @return {boolean} */
function hasFetch() {
  return !!(win && win.fetch);
}

/** @return {boolean} */
function hasBeacon() {
  return !!(nav && nav.sendBeacon);
}

/** @return {boolean} */
function hasNativeGzip() {
  return !!(win && win['CompressionStream'] && win['Response'] && win['Blob'] && win['Promise']);
}

/**
 * @param {!RequestOptions} opts
 * @param {number} status
 * @param {string|undefined} text
 * @param {*=} error
 */
function respond(opts, status, text, error) {
  if (!opts.callback) return;
  /** @type {!HttpResponse} */
  const res = {statusCode: status, text: text, json: jsonParse(text), error: error};
  try {
    opts.callback(res);
  } catch (e) {
    logger.error('request callback threw', e);
  }
}

/**
 * @param {!RequestOptions} opts
 * @param {(string|!Blob|undefined)} body
 * @param {string} contentType
 */
function sendFetch(opts, body, contentType) {
  const headers = {};
  if (opts.headers) {
    for (const k in opts.headers) headers[k] = opts.headers[k];
  }
  if (body !== undefined) headers['Content-Type'] = contentType;
  let controller = null;
  let timer = 0;
  if (win['AbortController']) {
    controller = new win['AbortController']();
    timer = win.setTimeout(function() {
      controller['abort']();
    }, opts.timeout || 60000);
  }
  const init = {
    'method': opts.method,
    'headers': headers,
    'body': body,
    // keepalive lets small requests survive navigation; limited to 64kb.
    'keepalive': opts.method === 'POST' && (typeof body === 'string' ? body.length : 0) < 52000,
    'signal': controller ? controller['signal'] : undefined,
  };
  win.fetch(opts.url, /** @type {!RequestInit} */ (init)).then(function(res) {
    return res.text().then(function(text) {
      win.clearTimeout(timer);
      respond(opts, res.status, text);
    });
  }).catch(function(err) {
    win.clearTimeout(timer);
    respond(opts, 0, undefined, err);
  });
}

/**
 * @param {!RequestOptions} opts
 * @param {(string|!Blob|undefined)} body
 * @param {string} contentType
 */
function sendXHR(opts, body, contentType) {
  const xhr = new XMLHttpRequest();
  xhr.open(opts.method, opts.url, true);
  if (body !== undefined) xhr.setRequestHeader('Content-Type', contentType);
  if (opts.headers) {
    for (const k in opts.headers) xhr.setRequestHeader(k, opts.headers[k]);
  }
  xhr.timeout = opts.timeout || 60000;
  xhr.withCredentials = true;
  xhr.onreadystatechange = function() {
    if (xhr.readyState === 4) respond(opts, xhr.status, xhr.responseText);
  };
  xhr.send(body === undefined ? null : body);
}

/**
 * @param {!RequestOptions} opts
 * @param {string} body
 */
function sendBeacon(opts, body) {
  try {
    const blob = new Blob([body], {type: 'application/x-www-form-urlencoded'});
    const ok = nav.sendBeacon(opts.url, blob);
    if (!ok) {
      logger.warn('beacon rejected, falling back');
      if (hasFetch()) sendFetch(opts, body, 'application/x-www-form-urlencoded');
      else sendXHR(opts, body, 'application/x-www-form-urlencoded');
      return;
    }
    respond(opts, 200, undefined);
  } catch (e) {
    logger.warn('beacon failed', e);
  }
}

/**
 * Gzips a string with the native CompressionStream.
 * @param {string} s
 * @return {!Promise<!Blob>}
 */
function gzip(s) {
  const CS = win['CompressionStream'];
  const stream = new Blob([s])['stream']()['pipeThrough'](new CS('gzip'));
  return new win['Response'](stream)['blob']();
}

/**
 * Sends a request. POST bodies are JSON; gzip is applied when requested and
 * natively supported, beacons always use base64 form encoding (CORS-simple).
 * @param {!RequestOptions} opts
 */
export function request(opts) {
  const transport = opts.transport === 'sendBeacon' && hasBeacon() ? 'sendBeacon' :
      opts.transport === 'XHR' || !hasFetch() ? 'XHR' : 'fetch';
  const isPost = opts.method === 'POST' && opts.data !== undefined;

  if (!isPost) {
    opts.url = addQueryParams(opts.url, {'_': String(now())});
    if (transport === 'XHR') sendXHR(opts, undefined, '');
    else sendFetch(opts, undefined, '');
    return;
  }

  const json = jsonStringify(opts.data);

  if (transport === 'sendBeacon' || opts.compression === 'base64') {
    opts.url = addQueryParams(opts.url, {'compression': 'base64'});
    const body = 'data=' + encodeURIComponent(base64Encode(json));
    if (transport === 'sendBeacon') sendBeacon(opts, body);
    else if (transport === 'XHR') sendXHR(opts, body, 'application/x-www-form-urlencoded');
    else sendFetch(opts, body, 'application/x-www-form-urlencoded');
    return;
  }

  if (opts.compression === 'gzip-js' && hasNativeGzip()) {
    const url = opts.url;
    gzip(json).then(function(blob) {
      opts.url = addQueryParams(url, {'compression': 'gzip-js'});
      if (transport === 'XHR') sendXHR(opts, blob, 'text/plain');
      else sendFetch(opts, blob, 'text/plain');
    }, function(err) {
      logger.warn('gzip failed, sending uncompressed', err);
      if (transport === 'XHR') sendXHR(opts, json, 'application/json');
      else sendFetch(opts, json, 'application/json');
    });
    return;
  }

  if (transport === 'XHR') sendXHR(opts, json, 'application/json');
  else sendFetch(opts, json, 'application/json');
}
