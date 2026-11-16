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
     * Called once the instance finished init (or immediately if the module
     * was loaded after init).
     * @type {(function()|undefined)}
     */
    this.onInit;
    /**
     * Extra properties merged into every event (e.g. `$feature/<key>`).
     * @type {(function(string): ?Object)|undefined}
     */
    this.eventProperties;
    /**
     * Called after distinct_id / groups / person properties changed.
     * @type {(function(string): void)|undefined}
     */
    this.onIdentityChange;
    /**
     * Called by reset().
     * @type {(function(): void)|undefined}
     */
    this.onReset;
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
 * @param {?} instance
 */
export function attachAllExtensions(instance) {
  if (liveInstances.indexOf(instance) === -1) liveInstances.push(instance);
  factories.slice().forEach(function(f) {
    instance.attachExtension(f.name, f.factory);
  });
}

/**
 * Contract the core's feature-flag facade relies on. Implemented by
 * src/flags/feature-flags.js; declared here so the core needs no import.
 * @record
 * @extends {Extension}
 */
export class FeatureFlagsApi {
  constructor() {}
  /**
   * @param {string} key
   * @param {?Object=} options
   * @return {boolean|string|undefined}
   */
  getFlag(key, options) {}
  /**
   * @param {string} key
   * @return {*}
   */
  getFlagPayload(key) {}
  /**
   * @param {string} key
   * @param {?Object=} options
   * @return {boolean|undefined}
   */
  isEnabled(key, options) {}
  /** Debounced reload from the server. */
  reload() {}
  /**
   * @param {function(!Array<string>, !Object<string, (string|boolean)>, ?Object)} cb
   * @return {function()}
   */
  onFlags(cb) {}
  /** @param {(boolean|!Array<string>|!Object<string, (string|boolean)>)} overrides */
  override(overrides) {}
  /** @return {!Object<string, (string|boolean)>} */
  getFlagVariants() {}
}
