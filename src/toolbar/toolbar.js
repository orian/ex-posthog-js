/**
 * @fileoverview The toolbar loader (optional module), published as
 * `posthog.toolbar`. Port of upstream browser/src/extensions/toolbar.ts and
 * the toolbar branch of entrypoints/external-scripts-loader.ts.
 *
 * The toolbar params come from the `__posthog=` (or legacy `state=`) hash
 * param, read when this module is parsed (frameworks often rewrite the URL
 * before `init`), or from `_postHogToolbarParams` in localStorage, written by
 * a previous launch. When their token matches, the hosted
 * `/static/toolbar.js` is loaded from the assets host (`?v=<version>&t=<5 min
 * boundary>`, or `/static/<version>/toolbar.js` under
 * `strict_script_versioning`) and `window.ph_load_toolbar(params, posthog)` is
 * called. `window.ph_toolbar_state` keeps several SDK instances from loading
 * it twice. The hosted toolbar itself is not part of this SDK.
 */
import {PostHog} from '../core/posthog.js';
import {Extension} from '../core/extensions.js';
import {Config} from '../core/constants.js';
import {logger as baseLogger} from '../core/logger.js';
import {loadScript} from '../core/script-loader.js';
import {addEventListener, doc, isFunction, isNullish, win} from '../core/utils.js';

const logger = baseLogger.createLogger('[Toolbar]');

const LOCALSTORAGE_KEY = '_postHogToolbarParams';
const TOOLBAR_ID = '__POSTHOG_TOOLBAR__';
const TOOLBAR_INTERNAL_INSTANCE_NAME = 'ph_toolbar_internal';
/** @enum {number} */
const ToolbarState = {UNINITIALIZED: 0, LOADING: 1, LOADED: 2};

/**
 * Upstream _getHashParam.
 * @param {string} hash
 * @param {string} param
 * @return {?string}
 */
function getHashParam(hash, param) {
  const matches = hash.match(new RegExp(param + '=([^&]*)'));
  return matches ? matches[1] : null;
}

// Read as soon as the SDK is parsed: frameworks may change the route before init.
/** @const {?string} */
const STATE_FROM_WINDOW = win && win.location ?
  getHashParam(win.location.hash, '__posthog') || getHashParam(win.location.hash, 'state') : null;

/**
 * @param {function(): *} fn
 * @return {*}
 */
function trySafe(fn) {
  try {
    return fn();
  } catch (e) {
    return undefined;
  }
}

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

/** @const {!Object<string, string>} versioned url -> fallback url */
const fallbackScripts = {};

/**
 * Upstream `__PosthogExtensions__.loadExternalDependency(posthog, 'toolbar', cb)`.
 * @param {!PostHog} instance
 * @param {function((string|!Event|undefined)=)} callback
 */
function loadToolbarScript(instance, callback) {
  const version = Config.LIB_VERSION;
  const legacyUrl = function() {
    // toolbar.js has a 24 h CDN TTL but a token valid for 5 minutes: bust the cache on a 5 minute boundary.
    const fiveMinutes = 5 * 60 * 1000;
    const t = Math.floor(new Date().getTime() / fiveMinutes) * fiveMinutes;
    return instance.requestRouter.endpointFor('assets', '/static/toolbar.js?v=' + version + '&t=' + t);
  };
  const scriptVersioning = instance.config['strict_script_versioning'];
  if (scriptVersioning) {
    const url = instance.requestRouter.endpointFor('assets', '/static/' + version + '/toolbar.js');
    const existingFallback = fallbackScripts[url];
    if (scriptVersioning === 'fallback' && existingFallback) {
      if (findScript(existingFallback)) {
        loadScript(instance.config, existingFallback, callback);
        return;
      }
      delete fallbackScripts[url];
    }
    loadScript(instance.config, url, scriptVersioning === 'fallback' ? function(error) {
      if (!error) {
        callback(undefined);
      } else if (typeof error === 'string') {
        callback(error);
      } else {
        const fallbackUrl = legacyUrl();
        fallbackScripts[url] = fallbackUrl;
        const failed = findScript(url);
        if (failed && failed.parentNode) failed.parentNode.removeChild(failed);
        loadScript(instance.config, fallbackUrl, callback);
      }
    } : callback);
    return;
  }
  loadScript(instance.config, legacyUrl(), callback);
}

/** @implements {Extension} */
export class Toolbar {
  /** @param {!PostHog} instance */
  constructor(instance) {
    /** @type {!PostHog} */
    this.instance = instance;
  }

  /**
   * @param {number} state
   * @private
   */
  setToolbarState_(state) {
    win['ph_toolbar_state'] = state;
  }

  /**
   * @return {number}
   * @private
   */
  getToolbarState_() {
    const state = win['ph_toolbar_state'];
    return isNullish(state) ? ToolbarState.UNINITIALIZED : state;
  }

  /** Upstream `initialize()`. */
  onInit() {
    this.maybeLoadToolbar();
  }

  /**
   * Loads the toolbar when the URL hash or a previous launch (localStorage)
   * carries params for this project's token.
   * @param {?Location=} location
   * @param {?Storage=} localStorage
   * @param {?History=} history
   * @return {boolean}
   */
  maybeLoadToolbar(location, localStorage, history) {
    if (this.instance.config['name'] === TOOLBAR_INTERNAL_INSTANCE_NAME) return false;
    if (!win || !doc) return false;
    const loc = location || win.location;
    const hist = history || win.history;
    try {
      let storage = localStorage;
      if (!storage) {
        try {
          win.localStorage.setItem('test', 'test');
          win.localStorage.removeItem('test');
        } catch (e) {
          return false;
        }
        storage = win.localStorage;
      }
      const stateHash = /** @type {string} */ (STATE_FROM_WINDOW || getHashParam(loc.hash, '__posthog') ||
          getHashParam(loc.hash, 'state'));
      const state = stateHash ?
        /** @type {?} */ (trySafe(function() {
          return JSON.parse(atob(decodeURIComponent(stateHash)));
        }) || trySafe(function() {
          return JSON.parse(decodeURIComponent(stateHash));
        })) : null;
      const parseFromUrl = state && state['action'] === 'ph_authorize';
      let toolbarParams;
      if (parseFromUrl) {
        toolbarParams = state;
        toolbarParams['source'] = 'url';
        if (toolbarParams && Object.keys(toolbarParams).length > 0) {
          if (state['desiredHash']) {
            loc.hash = state['desiredHash'];
          } else if (hist) {
            hist.replaceState(hist.state, '', loc.pathname + loc.search);
          } else {
            loc.hash = '';
          }
        }
      } else {
        toolbarParams = JSON.parse(storage.getItem(LOCALSTORAGE_KEY) || '{}');
        toolbarParams['source'] = 'localstorage';
        delete toolbarParams['userIntent'];
      }
      if (toolbarParams['token'] && this.instance.config['token'] === toolbarParams['token']) {
        this.loadToolbar(toolbarParams);
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  /**
   * @param {!Object} params
   * @private
   */
  callLoadToolbar_(params) {
    const loadFn = win['ph_load_toolbar'] || win['ph_load_editor'];
    if (isNullish(loadFn) || !isFunction(loadFn)) {
      logger.warn('No toolbar load function found');
      return;
    }
    loadFn(params, this.instance);
  }

  /**
   * @param {?=} params
   * @return {boolean}
   */
  loadToolbar(params) {
    const toolbarRunning = !!(doc && doc.getElementById(TOOLBAR_ID));
    if (!win || toolbarRunning) return false;
    const disableToolbarMetrics = this.instance.requestRouter.region() === 'custom' &&
      this.instance.config['advanced_disable_toolbar_metrics'];
    // {token, ...params, apiURL, instrument?}: a `token` in params overrides the config token in place.
    const toolbarParams = {'token': this.instance.config['token']};
    if (params) {
      for (const k in params) {
        if (Object.prototype.hasOwnProperty.call(params, k)) toolbarParams[k] = params[k];
      }
    }
    toolbarParams['apiURL'] = this.instance.requestRouter.endpointFor('ui');
    if (disableToolbarMetrics) toolbarParams['instrument'] = false;
    const stored = {};
    for (const k in toolbarParams) stored[k] = toolbarParams[k];
    stored['source'] = undefined;
    win.localStorage.setItem(LOCALSTORAGE_KEY, JSON.stringify(stored));

    const self = this;
    if (this.getToolbarState_() === ToolbarState.LOADED) {
      this.callLoadToolbar_(toolbarParams);
    } else if (this.getToolbarState_() === ToolbarState.UNINITIALIZED) {
      this.setToolbarState_(ToolbarState.LOADING);
      loadToolbarScript(this.instance, function(err) {
        if (err) {
          logger.error('[Toolbar] Failed to load', err);
          self.setToolbarState_(ToolbarState.UNINITIALIZED);
          return;
        }
        self.setToolbarState_(ToolbarState.LOADED);
        self.callLoadToolbar_(toolbarParams);
      });
      // Turbolinks replaces the body (and the toolbar) without an onload event.
      addEventListener(win, 'turbolinks:load', function() {
        self.setToolbarState_(ToolbarState.UNINITIALIZED);
        self.loadToolbar(toolbarParams);
      });
    }
    return true;
  }

  /**
   * @deprecated Use loadToolbar.
   * @param {*} params
   * @return {boolean}
   */
  loadEditor(params) {
    return this.loadToolbar(params);
  }

  /**
   * @deprecated Use maybeLoadToolbar.
   * @param {?Location=} location
   * @param {?Storage=} localStorage
   * @param {?History=} history
   * @return {boolean}
   */
  maybeLoadEditor(location, localStorage, history) {
    return this.maybeLoadToolbar(location, localStorage, history);
  }
}
