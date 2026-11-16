/**
 * @fileoverview Extension registry. Optional modules (feature flags, web
 * experiments, ...) register a factory here at load time; the core never
 * imports them, so they can be omitted from a build or loaded later as a
 * separate Closure chunk.
 */

/**
 * Lifecycle hooks an extension may implement. All are optional.
 * @record
 */
export class Extension {
  constructor() {
    /**
     * Called once when the extension is attached: during init (at the point
     * upstream initialises its extensions), or immediately when the module is
     * loaded after init.
     * @type {(function()|undefined)}
     */
    this.onInit;
    /**
     * Extra properties merged into every event, after persisted super
     * properties and before the event's own properties (upstream's dynamic
     * event-property producers). Called with the event name.
     * @type {(function(string): ?Object)|undefined}
     */
    this.eventProperties;
    /**
     * Remote config result: the `/array/<token>/config` object, or null when
     * loading failed (upstream `{ok: false}`). Called once per load; an
     * extension attached after the config arrived is called with the last
     * result straight away.
     * @type {(function(?Object): void)|undefined}
     */
    this.onRemoteConfig;
    /**
     * Called by reset() after persistence was cleared and before the new
     * anonymous identity is registered.
     * @type {(function(): void)|undefined}
     */
    this.onReset;
    /**
     * Called by set_config() after the config was updated (upstream calls
     * each extension's onConfigChange / startIfEnabled(OrStop) there), in
     * attach order. Receives the partial config passed to set_config;
     * extensions that only need to re-check their state may ignore it.
     * @type {(function(!Object): void)|undefined}
     */
    this.onConfigChange;
  }
}

/**
 * @typedef {{name: string, factory: function(?): !Extension}}
 */
let ExtensionFactory;

/** @const {!Array<!ExtensionFactory>} */
const factories = [];

/** Instances that have been initialised, so late-loaded modules can attach. */
/** @const {!Array<?>} */
const liveInstances = [];

/**
 * Registers an optional module. `factory` receives the PostHog instance.
 * The instance is typed `?` here to keep the core free of an import cycle.
 * @param {string} name property name on the instance (e.g. 'featureFlags')
 * @param {function(?): !Extension} factory
 */
export function registerExtension(name, factory) {
  for (let i = 0; i < factories.length; i++) {
    if (factories[i].name === name) return;
  }
  factories.push({name: name, factory: factory});
  liveInstances.forEach(function(instance) {
    instance.attachExtension(name, factory);
  });
}

/**
 * @param {string} name
 * @return {(function(?): !Extension)|undefined}
 */
export function findExtensionFactory(name) {
  for (let i = 0; i < factories.length; i++) {
    if (factories[i].name === name) return factories[i].factory;
  }
  return undefined;
}

/**
 * Attaches every registered module to `instance` and marks it live so modules
 * registered later attach too.
 * @param {?} instance
 */
export function attachAllExtensions(instance) {
  if (liveInstances.indexOf(instance) === -1) liveInstances.push(instance);
  factories.slice().forEach(function(f) {
    instance.attachExtension(f.name, f.factory);
  });
}

/**
 * Contract the core relies on for the feature-flags module (port of
 * upstream's PostHogFeatureFlags surface). Implemented by
 * src/flags/feature-flags.js; declared here so the core needs no import.
 * @record
 * @extends {Extension}
 */
export class FeatureFlagsApi {
  constructor() {}
  /** @return {boolean} */
  checkHasLoadedFlags() {}
  /**
   * @param {string} key
   * @param {?Object=} options
   * @return {boolean|string|undefined}
   */
  getFeatureFlag(key, options) {}
  /**
   * @param {string} key
   * @param {?Object=} options
   * @return {?Object|undefined}
   */
  getFeatureFlagResult(key, options) {}
  /**
   * @param {string} key
   * @return {*}
   */
  getFeatureFlagPayload(key) {}
  /**
   * @param {string} key
   * @param {?Object=} options
   * @return {boolean|undefined}
   */
  isFeatureEnabled(key, options) {}
  /** @return {!Array<!Object>} */
  getAllFeatureFlags() {}
  /** @return {!Object<string, (string|boolean)>} */
  getFlagVariants() {}
  /** @return {!Array<string>} */
  getFlags() {}
  /** @return {!Object} */
  getFlagPayloads() {}
  reloadFeatureFlags() {}
  ensureFlagsLoaded() {}
  /** @param {string|undefined} id */
  setAnonymousDistinctId(id) {}
  resetFlagCallReported() {}
  sendFlagCallsPendingCapture() {}
  /**
   * @param {!Object} properties
   * @param {boolean=} reload
   */
  setPersonPropertiesForFlags(properties, reload) {}
  /**
   * @param {!Array<string>} names
   * @param {boolean=} reload
   */
  unsetPersonPropertiesForFlags(names, reload) {}
  /** @param {boolean=} reload */
  resetPersonPropertiesForFlags(reload) {}
  /**
   * @param {!Object} properties
   * @param {boolean=} reload
   */
  setGroupPropertiesForFlags(properties, reload) {}
  /** @param {string=} groupType */
  resetGroupPropertiesForFlags(groupType) {}
  /** Clears in-memory flag state (identity change / reset). */
  reset() {}
  /** Re-applies bootstrap flags. */
  initialize() {}
  /**
   * @param {!Object} config
   * @param {boolean} remoteRequestsDisabled
   */
  updateConfig(config, remoteRequestsDisabled) {}
  /**
   * @param {function(!Array<string>, !Object<string, (string|boolean)>, ?Object=)} callback
   * @return {function()}
   */
  onFeatureFlags(callback) {}
  /**
   * @param {function()} handler
   * @return {function()}
   */
  onReloading(handler) {}
  /** @param {*} options */
  overrideFeatureFlags(options) {}
  /**
   * @param {!Object} flags
   * @param {?Object=} payloads
   * @param {?Object=} options
   */
  updateFlags(flags, payloads, options) {}
  /**
   * @param {function(!Array<!Object>)} callback
   * @param {boolean=} forceReload
   * @param {!Array<string>=} stages
   */
  getEarlyAccessFeatures(callback, forceReload, stages) {}
  /**
   * @param {string} key
   * @param {boolean} isEnrolled
   * @param {string=} stage
   */
  updateEarlyAccessFeatureEnrollment(key, isEnrolled, stage) {}
}

/**
 * Contract the core relies on for the exceptions module (upstream
 * PostHogExceptions, published as `posthog.exceptions`). Implemented by
 * src/exceptions/exceptions.js.
 * @record
 * @extends {Extension}
 */
export class ExceptionsApi {
  constructor() {}
  /**
   * @param {*} input
   * @param {{handled: (boolean|undefined), syntheticException: (?Error|undefined)}=} metadata
   * @return {!Object}
   */
  buildProperties(input, metadata) {}
  /**
   * @param {!Object} properties
   * @return {?Object|undefined}
   */
  sendExceptionEvent(properties) {}
  /**
   * @param {*} message
   * @param {*=} properties
   */
  addExceptionStep(message, properties) {}
}

/**
 * Contract the core relies on for the session replay module (upstream's
 * `posthog.sessionRecording` calls in posthog-core.ts). Implemented by
 * src/replay/session-recording.js.
 * @record
 * @extends {Extension}
 */
export class SessionRecordingApi {
  constructor() {}
  /** @return {boolean} */
  isStarted() {}
  /** @param {string=} startReason */
  startIfEnabledOrStop(startReason) {}
  /** @param {boolean=} discardBufferedEvents */
  disposeRecording(discardBufferedEvents) {}
  /** @return {!Object} */
  getSdkDebugProperties() {}
  flushBeforeIdentityReset() {}
  overrideSampling() {}
  overrideLinkedFlag() {}
  /** @param {string} triggerType */
  overrideTrigger(triggerType) {}
}
