/**
 * @fileoverview External script loading (port of upstream
 * entrypoints/external-scripts-loader.ts `loadScript`). Used for the remote
 * config script and available to extensions that lazy-load code.
 */
import {doc} from './utils.js';
import {logger as baseLogger} from './logger.js';

const logger = baseLogger.createLogger('[ExternalScriptsLoader]');

/**
 * @param {string} url
 * @return {?HTMLScriptElement}
 */
function findScript(url) {
  const scripts = doc ? doc.querySelectorAll('script') : null;
  if (scripts) {
    for (let i = 0; i < scripts.length; i++) {
      const s = /** @type {!HTMLScriptElement} */ (scripts[i]);
      if (s.src === url || s.getAttribute('src') === url) return s;
    }
  }
  return null;
}

/**
 * Injects `<script src=url>` and calls back with (error) or ().
 * @param {!Object} config PostHog config (quoted keys)
 * @param {string} url
 * @param {function((string|!Event|undefined)=)} callback
 */
export function loadScript(config, url, callback) {
  if (config['disable_external_dependency_loading']) {
    logger.warn(url + ' was requested but loading of external scripts is disabled.');
    callback('Loading of external scripts is disabled');
    return;
  }
  const waitForBody = function() {
    if (doc) doc.addEventListener('DOMContentLoaded', addScript);
  };
  const addScript = function() {
    if (doc) doc.removeEventListener('DOMContentLoaded', addScript);
    if (config['disable_external_dependency_loading']) return callback('Loading of external scripts is disabled');
    if (!doc) return callback('document not found');
    let tag = /** @type {?HTMLScriptElement} */ (doc.createElement('script'));
    tag.type = 'text/javascript';
    tag.crossOrigin = 'anonymous';
    tag.src = url;
    const created = tag;
    tag.onload = function(event) {
      created['__posthog_loading_callback_fired'] = true;
      callback(undefined);
    };
    tag.onerror = function(error) {
      created['__posthog_loading_error'] = error;
      callback(/** @type {!Event} */ (error));
    };
    const prepare = config['prepare_external_dependency_script'];
    if (prepare) tag = prepare(tag);
    if (!tag) return callback('prepare_external_dependency_script returned null');
    if (config['disable_external_dependency_loading']) return callback('Loading of external scripts is disabled');
    const existing = findScript(tag.src);
    if (existing) {
      if (existing.integrity !== tag.integrity || existing.crossOrigin !== tag.crossOrigin ||
          existing['nonce'] !== tag['nonce']) {
        return callback('Existing script conflicts with prepared script policy');
      }
      if (existing['__posthog_loading_callback_fired']) return callback();
      if (existing['__posthog_loading_error']) return callback(existing['__posthog_loading_error']);
      existing.addEventListener('load', function() {
        existing['__posthog_loading_callback_fired'] = true;
        callback();
      });
      existing.addEventListener('error', function(error) {
        existing['__posthog_loading_error'] = error;
        callback(error);
      });
      return;
    }
    if (!doc.body) return waitForBody();
    if (config['external_scripts_inject_target'] === 'head') {
      doc.head.appendChild(tag);
    } else {
      const scripts = doc.querySelectorAll('body > script');
      if (scripts.length > 0 && scripts[0].parentNode) scripts[0].parentNode.insertBefore(tag, scripts[0]);
      else doc.body.appendChild(tag);
    }
    return undefined;
  };
  if ((doc && doc.body) || findScript(url)) addScript();
  else waitForBody();
}
