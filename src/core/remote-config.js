/**
 * @fileoverview Remote config loading (port of upstream remote-config.ts).
 *
 * Order: 1) a config preloaded by a token-specific array.js
 * (`window._POSTHOG_REMOTE_CONFIG[token].config`); 2) the
 * `/array/<token>/config.js` script from the assets host; 3) the
 * `/array/<token>/config` JSON. The result is handed to
 * `PostHog#onRemoteConfig_` ({ok:true, config} or {ok:false}); afterwards
 * feature flags are loaded unless the config says `hasFeatureFlags: false`.
 */
import {loadScript} from './script-loader.js';
import {logger as baseLogger} from './logger.js';
import {win} from './utils.js';

const logger = baseLogger.createLogger('[RemoteConfig]');

/**
 * What the loader needs from the PostHog instance.
 * @record
 */
export class RemoteConfigHost {
  constructor() {}
  /** @return {!Object} */
  getConfig() {}
  /** @return {boolean} */
  shouldDisableFlags() {}
  /**
   * @param {string} target
   * @param {string} path
   * @return {string}
   */
  endpointFor(target, path) {}
  /**
   * GET `url`, calling back with the response.
   * @param {string} url
   * @param {function(!PHResponse)} callback
   */
  getJSON(url, callback) {}
  /** @param {?Object} config the remote config, or null when loading failed */
  applyRemoteConfig(config) {}
  /** Loads flags if they are not loaded/loading (featureFlags.ensureFlagsLoaded). */
  ensureFlagsLoaded() {}
}

export class RemoteConfigLoader {
  /** @param {!RemoteConfigHost} host */
  constructor(host) {
    /** @private @const {!RemoteConfigHost} */
    this.host_ = host;
  }

  /** @return {?Object|undefined} */
  remoteConfig() {
    const all = win ? win['_POSTHOG_REMOTE_CONFIG'] : undefined;
    const entry = all ? all[this.host_.getConfig()['token']] : undefined;
    return entry ? entry['config'] : undefined;
  }

  /**
   * @param {function((?Object|undefined))} cb
   * @private
   */
  loadJs_(cb) {
    const self = this;
    const token = this.host_.getConfig()['token'];
    const url = this.host_.endpointFor('assets', '/array/' + token + '/config.js');
    loadScript(this.host_.getConfig(), url, function() {
      cb(self.remoteConfig());
    });
  }

  load() {
    const self = this;
    try {
      const preloaded = this.remoteConfig();
      if (preloaded) {
        logger.info('Using preloaded remote config', preloaded);
        this.onRemoteConfig_(preloaded);
        return;
      }
      if (this.host_.shouldDisableFlags()) {
        logger.warn('Remote config is disabled. Falling back to local config.');
        return;
      }
      this.loadJs_(function(config) {
        if (!config) {
          logger.info('No config found after loading remote JS config. Falling back to JSON.');
          const token = self.host_.getConfig()['token'];
          self.host_.getJSON(self.host_.endpointFor('assets', '/array/' + token + '/config'), function(response) {
            self.onRemoteConfig_(/** @type {?Object|undefined} */ (response.json), response);
          });
          return;
        }
        self.onRemoteConfig_(config);
      });
    } catch (error) {
      logger.error('Error loading remote config', error);
      this.onRemoteConfig_(undefined);
    }
  }

  /**
   * @param {?Object|undefined} config
   * @param {!PHResponse=} response
   * @private
   */
  onRemoteConfig_(config, response) {
    if (!config && response) {
      if (response.statusCode === 0) {
        if (!response.error) logger.warn('Failed to fetch remote config from PostHog.');
      } else {
        logger.error('Failed to fetch remote config from PostHog.');
      }
    }
    try {
      this.host_.applyRemoteConfig(config || null);
    } catch (error) {
      logger.error('Error applying remote config', error);
    }
    if ((!config || config['hasFeatureFlags'] !== false) &&
        !this.host_.getConfig()['advanced_disable_feature_flags_on_first_load']) {
      try {
        this.host_.ensureFlagsLoaded();
      } catch (error) {
        logger.error('Error loading feature flags', error);
      }
    }
  }
}

/**
 * Whether flags should be loaded after this remote config result.
 * @param {?Object} config
 * @param {!Object} posthogConfig
 * @return {boolean}
 */
export function shouldLoadFlagsAfterRemoteConfig(config, posthogConfig) {
  return (!config || config['hasFeatureFlags'] !== false) &&
      !posthogConfig['advanced_disable_feature_flags_on_first_load'];
}
