/**
 * @fileoverview `posthog.exceptions`, a port of upstream
 * browser/src/posthog-exceptions.ts: builds `$exception` properties, keeps the
 * `$exception_steps` buffer, applies the remote suppression rules and the
 * extension / injected-script / SDK-error filters, and sends the event.
 */
import {PostHog} from '../core/posthog.js';
import {ExceptionsApi} from '../core/extensions.js';
import {logger as baseLogger} from '../core/logger.js';
import {isArray, isNullish, isObject, isString} from '../core/utils.js';
import {
  EXCEPTION_STEP_MESSAGE, EXCEPTION_STEP_TIMESTAMP, ErrorPropertiesBuilder, ExceptionStepsBuffer,
  ResolvedExceptionStepsConfig, buildErrorPropertiesBuilder, getInjectedReleaseId, isError,
  resolveExceptionStepsConfig, stripReservedExceptionStepFields,
} from './error-tracking.js';

const logger = baseLogger.createLogger('[Error tracking]');

export const ERROR_TRACKING_SUPPRESSION_RULES = '$error_tracking_suppression_rules';
export const ERROR_TRACKING_CAPTURE_EXTENSION_EXCEPTIONS = '$error_tracking_capture_extension_exceptions';

const MASKED_URL_PREFIX = 'webkit-masked-url:';
const MASKED_EXTENSION_EXCEPTION_VALUE = [
  {value: 'isolatedAPI.contexts.topHostname', exact: false},
  {value: 'No response from target', exact: true},
];
const EXTENSION_URL_PREFIXES = [
  'chrome-extension://', 'moz-extension://', 'safari-extension:', 'safari-web-extension:', MASKED_URL_PREFIX,
];
const INJECTED_BROWSER_SCRIPT_GLOBALS = ['__firefox__', '__gCrWeb'];

/**
 * @param {string} s
 * @param {string} prefix
 * @return {boolean}
 */
function startsWith(s, prefix) {
  return s.lastIndexOf(prefix, 0) === 0;
}

/**
 * @param {string} value
 * @param {string} pattern
 * @return {boolean}
 */
function isMatchingRegex(value, pattern) {
  try {
    return new RegExp(pattern).test(value);
  } catch (e) {
    return false;
  }
}

/**
 * @param {string} value
 * @return {string}
 */
const toLowerCase = function(value) {
  return value.toLowerCase();
};

/**
 * Upstream core/src/surveys/property-matching.ts `propertyComparisons`
 * (targets, values) => boolean. A plain object indexed by the rule's
 * operator, like upstream.
 * @const {!Object<string, function(!Array<?>, !Array<string>): boolean>}
 */
export const propertyComparisons = {
  'exact': function(targets, values) {
    return values.some(function(value) {
      return targets.some(function(target) {
        return value === target;
      });
    });
  },
  'is_not': function(targets, values) {
    return values.every(function(value) {
      return targets.every(function(target) {
        return value !== target;
      });
    });
  },
  'regex': function(targets, values) {
    return values.some(function(value) {
      return targets.some(function(target) {
        return isMatchingRegex(value, target);
      });
    });
  },
  'not_regex': function(targets, values) {
    return values.every(function(value) {
      return targets.every(function(target) {
        return !isMatchingRegex(value, target);
      });
    });
  },
  'icontains': function(targets, values) {
    return values.map(toLowerCase).some(function(value) {
      return targets.map(toLowerCase).some(function(target) {
        return value.indexOf(target) !== -1;
      });
    });
  },
  'not_icontains': function(targets, values) {
    return values.map(toLowerCase).every(function(value) {
      return targets.map(toLowerCase).every(function(target) {
        return value.indexOf(target) === -1;
      });
    });
  },
  'gt': function(targets, values) {
    return values.some(function(value) {
      const numValue = parseFloat(value);
      return !isNaN(numValue) && targets.some(function(target) {
        return numValue > parseFloat(target);
      });
    });
  },
  'lt': function(targets, values) {
    return values.some(function(value) {
      const numValue = parseFloat(value);
      return !isNaN(numValue) && targets.some(function(target) {
        return numValue < parseFloat(target);
      });
    });
  },
};

/**
 * Upstream isStackOverflowError.
 * @param {*} error
 * @return {boolean}
 */
function isStackOverflowError(error) {
  if (!isError(error)) return false;
  const e = /** @type {?} */ (error);
  return (e.name === 'RangeError' && e.message.indexOf('Maximum call stack size exceeded') === 0) ||
      (e.name === 'InternalError' && e.message === 'too much recursion');
}

/**
 * @param {!Object} exception a `$exception_list` item
 * @return {!Array<!Object>}
 */
function framesOf(exception) {
  const stacktrace = exception['stacktrace'];
  const frames = stacktrace ? stacktrace['frames'] : undefined;
  return frames == null ? [] : frames;
}

/** @implements {ExceptionsApi} */
export class PostHogExceptions {
  /** @param {!PostHog} instance */
  constructor(instance) {
    /** @private @const {!PostHog} */
    this.ph_ = instance;
    // Upstream constructs this extension in the PostHog constructor, before
    // persistence exists, so persisted rules are never read at startup: they
    // only apply once the remote config arrives. Keep that behaviour.
    /** @private {!Array<?>} */
    this.suppressionRules_ = [];
    /** @private @const {!ErrorPropertiesBuilder} */
    this.builder_ = buildErrorPropertiesBuilder();
    /** @private {!ResolvedExceptionStepsConfig} */
    this.stepsConfig_ = resolveExceptionStepsConfig(this.getExceptionStepsConfig_());
    /** @private @const {!ExceptionStepsBuffer} */
    this.stepsBuffer_ = new ExceptionStepsBuffer(this.stepsConfig_);
  }

  /** @return {*} @private */
  getExceptionStepsConfig_() {
    const et = this.ph_.config['error_tracking'];
    const steps = et ? et['exception_steps'] : undefined;
    return steps == null ? {} : steps;
  }

  /** @param {!Object} config */
  onConfigChange(config) {
    this.stepsConfig_ = resolveExceptionStepsConfig(this.getExceptionStepsConfig_());
    this.stepsBuffer_.setConfig(this.stepsConfig_);
  }

  /** @param {?Object} response */
  onRemoteConfig(response) {
    if (!response || !('errorTracking' in response)) return;
    const et = response['errorTracking'];
    const rules = et == null ? undefined : et['suppressionRules'];
    const captureExtensionExceptions = et == null ? undefined : et['captureExtensionExceptions'];
    this.suppressionRules_ = rules == null ? [] : rules;
    if (this.ph_.persistence) {
      this.ph_.persistence.register({
        [ERROR_TRACKING_SUPPRESSION_RULES]: this.suppressionRules_,
        [ERROR_TRACKING_CAPTURE_EXTENSION_EXCEPTIONS]: captureExtensionExceptions,
      });
    }
  }

  /** @return {*} @private */
  captureExtensionExceptions_() {
    const enabledServerSide = !!this.ph_.get_property(ERROR_TRACKING_CAPTURE_EXTENSION_EXCEPTIONS);
    const clientSide = this.ph_.config['error_tracking']['captureExtensionExceptions'];
    return clientSide == null ? enabledServerSide : clientSide;
  }

  /**
   * @param {*} input
   * @param {{handled: (boolean|undefined), syntheticException: (?Error|undefined)}=} metadata
   * @return {!Object}
   * @override
   */
  buildProperties(input, metadata) {
    return this.builder_.buildFromUnknown(input, {
      syntheticException: metadata ? metadata.syntheticException : undefined,
      mechanism: {'handled': metadata ? metadata.handled : undefined},
    });
  }

  /**
   * @param {*} message
   * @param {*=} properties
   * @override
   */
  addExceptionStep(message, properties) {
    if (!this.stepsConfig_.enabled) return;
    try {
      if (!isString(message) || /** @type {string} */ (message).trim().length === 0) {
        logger.warn('Ignoring exception step because message must be a non-empty string');
        return;
      }
      const userProperties = {};
      if (isObject(properties)) {
        const src = /** @type {!Object} */ (properties);
        for (const k in src) {
          if (Object.prototype.hasOwnProperty.call(src, k)) userProperties[k] = src[k];
        }
      }
      const stripped = stripReservedExceptionStepFields(userProperties);
      if (stripped.droppedKeys.length > 0) {
        logger.warn('Ignoring reserved exception step fields', {'droppedKeys': stripped.droppedKeys});
      }
      const step = {
        [EXCEPTION_STEP_MESSAGE]: message,
        [EXCEPTION_STEP_TIMESTAMP]: new Date().toISOString(),
      };
      for (const k in stripped.sanitizedProperties) step[k] = stripped.sanitizedProperties[k];
      this.stepsBuffer_.add(step);
    } catch (error) {
      logger.error('Failed to add exception step. Ignoring breadcrumb.', error);
    }
  }

  /**
   * @param {!Object} properties
   * @return {?Object|undefined}
   * @override
   */
  sendExceptionEvent(properties) {
    try {
      const exceptionList = properties['$exception_list'];
      if (!isNullish(exceptionList) && isArray(exceptionList)) {
        const list = /** @type {!Array<!Object>} */ (exceptionList);
        if (this.matchesSuppressionRule_(list)) {
          this.addDroppedExceptionStep_('Exception dropped: matched a suppression rule');
          logger.info('Skipping exception capture because a suppression rule matched');
          return undefined;
        }
        if (!this.captureExtensionExceptions_() && this.isExtensionException_(list)) {
          this.addDroppedExceptionStep_('Exception dropped: thrown by a browser extension');
          logger.info('Skipping exception capture because it was thrown by an extension');
          return undefined;
        }
        if (!this.captureExtensionExceptions_() && this.isInjectedBrowserScriptException_(list)) {
          this.addDroppedExceptionStep_('Exception dropped: thrown by an injected browser script');
          logger.info('Skipping exception capture because it was thrown by an injected browser script');
          return undefined;
        }
        if (!this.ph_.config['error_tracking']['__capturePostHogExceptions'] && this.isPostHogException_(list)) {
          this.addDroppedExceptionStep_('Exception dropped: thrown by the PostHog SDK');
          logger.info('Skipping exception capture because it was thrown by the PostHog SDK');
          return undefined;
        }
      }

      const props = this.stepsConfig_.enabled && isNullish(properties['$exception_steps']) ?
          this.addBufferedExceptionSteps_(properties) : properties;
      const injectedReleaseId = getInjectedReleaseId();
      if (injectedReleaseId) props['$release_id'] = injectedReleaseId;

      try {
        const result = this.ph_.capture('$exception', props, {
          '_noTruncate': true,
          '_batchKey': 'exceptionEvent',
          '_originatedFromCaptureException': true,
        });
        if (result) this.stepsBuffer_.clear();
        return result;
      } catch (error) {
        if (!isStackOverflowError(error)) {
          logger.error('Failed to capture exception event. Dropping this exception.', error);
        }
        this.stepsBuffer_.clear();
        return undefined;
      }
    } catch (error) {
      if (!isStackOverflowError(error)) {
        logger.error('Failed to process exception event. Ignoring this exception.', error);
      }
      return undefined;
    }
  }

  /**
   * @param {!Object} properties
   * @return {!Object}
   * @private
   */
  addBufferedExceptionSteps_(properties) {
    try {
      const steps = this.stepsBuffer_.getAttachable();
      if (steps.length === 0) return properties;
      const out = {};
      for (const k in properties) {
        if (Object.prototype.hasOwnProperty.call(properties, k)) out[k] = properties[k];
      }
      out['$exception_steps'] = steps;
      return out;
    } catch (error) {
      logger.error('Failed to read buffered exception steps. Capturing exception without steps.', error);
      return properties;
    }
  }

  /**
   * @param {string} message
   * @private
   */
  addDroppedExceptionStep_(message) {
    if (this.stepsConfig_.enabled) {
      this.stepsBuffer_.add({
        [EXCEPTION_STEP_MESSAGE]: message,
        [EXCEPTION_STEP_TIMESTAMP]: new Date().toISOString(),
      });
    }
  }

  /**
   * @param {!Array<!Object>} exceptionList
   * @return {boolean}
   * @private
   */
  matchesSuppressionRule_(exceptionList) {
    if (exceptionList.length === 0) return false;
    try {
      const exceptionValues = exceptionList.reduce(function(acc, exception) {
        const type = exception['type'];
        const value = exception['value'];
        if (isString(type) && type.length > 0) acc['$exception_types'].push(type);
        if (isString(value) && value.length > 0) acc['$exception_values'].push(value);
        return acc;
      }, {'$exception_types': [], '$exception_values': []});

      return this.suppressionRules_.some(function(rule) {
        const results = rule['values'].map(function(v) {
          const compare = propertyComparisons[v['operator']];
          const values = exceptionValues[v['key']];
          if (!compare || !values) return false;
          const targets = isArray(v['value']) ? v['value'] : [v['value']];
          return targets.length > 0 ? compare(targets, values) : false;
        });
        return rule['type'] === 'OR' ? results.some(Boolean) : results.every(Boolean);
      });
    } catch (error) {
      logger.warn('Failed to evaluate suppression rules. Capturing the exception.', error);
      return false;
    }
  }

  /**
   * @param {!Array<!Object>} exceptionList
   * @return {boolean}
   * @private
   */
  isExtensionException_(exceptionList) {
    /** @type {!Array<!Object>} */
    const frames = [];
    exceptionList.forEach(function(e) {
      framesOf(e).forEach(function(f) {
        frames.push(f);
      });
    });
    const extensionFrames = frames.filter(function(f) {
      const filename = f['filename'];
      return !!filename && EXTENSION_URL_PREFIXES.some(function(prefix) {
        return startsWith(filename, prefix);
      });
    });
    if (extensionFrames.length === 0) return false;
    const onlyMasked = extensionFrames.every(function(f) {
      return !!f['filename'] && startsWith(f['filename'], MASKED_URL_PREFIX);
    });
    if (onlyMasked) {
      const hasKnownExtensionSignature = exceptionList.some(function(e) {
        const value = e['value'];
        return e['type'] === 'NoResponse' || (isString(value) && MASKED_EXTENSION_EXCEPTION_VALUE.some(function(sig) {
          return sig.exact ? value === sig.value : value.indexOf(sig.value) !== -1;
        }));
      });
      return hasKnownExtensionSignature && !frames.some(function(f) {
        const filename = f['filename'];
        return f['in_app'] && !(filename != null && startsWith(filename, MASKED_URL_PREFIX));
      });
    }
    return true;
  }

  /**
   * @param {!Array<!Object>} exceptionList
   * @return {boolean}
   * @private
   */
  isInjectedBrowserScriptException_(exceptionList) {
    return exceptionList.some(function(e) {
      const value = e['value'];
      return isString(value) && INJECTED_BROWSER_SCRIPT_GLOBALS.some(function(g) {
        return value.indexOf(g) !== -1;
      });
    });
  }

  /**
   * @param {!Array<!Object>} exceptionList
   * @return {boolean}
   * @private
   */
  isPostHogException_(exceptionList) {
    if (exceptionList.length > 0) {
      const frames = framesOf(exceptionList[0]);
      const lastFrame = frames[frames.length - 1];
      const filename = lastFrame ? lastFrame['filename'] : undefined;
      return filename != null && filename.indexOf('posthog.com/static') !== -1;
    }
    return false;
  }
}
