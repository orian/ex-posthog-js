/**
 * @fileoverview The `logs` extension (optional module), published as
 * `posthog.logs`. Port of upstream browser-common/src/logs.ts (`PostHogLogs`)
 * and browser/src/posthog-logs.ts (SDK context, console loader).
 *
 * - `posthog.captureLog({body, level, attributes, ...})` and
 *   `posthog.logger.<level>(body, attributes)` queue OTLP log records that are
 *   POSTed to `/i/v1/logs?token=<token>` (see logs-core.js), under the SDK's
 *   service and scope.
 * - Console capture (`logs: {captureConsoleLogs: true}`, or the remote
 *   `logs.captureConsoleLogs`, persisted as `$logs_capture_enabled_server_side`)
 *   mirrors `console.*` calls into a second queue with service
 *   `posthog-browser-logs` and scope `console`. Like upstream, a recorder
 *   buffers console calls while the decision is pending (persisted hint, or the
 *   remote config enabling it) and hands them over when capture starts.
 *   Upstream loads the capture code as `/static/logs.js`; here it is compiled in,
 *   so the hand-over happens synchronously (still refused under
 *   `disable_external_dependency_loading`, as upstream's script load is).
 * - On unload (with `request_batching`) both queues are drained with sendBeacon.
 */
import {PostHog} from '../core/posthog.js';
import {Extension, FeatureFlagsApi} from '../core/extensions.js';
import {RequestOptions} from '../core/request.js';
import {Config} from '../core/constants.js';
import {logger as baseLogger, Logger} from '../core/logger.js';
import {addEventListener, isNullish, stripUrlHash, win} from '../core/utils.js';
import {SendOutcome, isBrowserOnline, patch} from '../otlp/otlp.js';
import {
  LogSdkContext, LogsHost, LogsPipeline, ResolvedLogsConfig, buildOtlpLogsPayload, buildResourceAttributes,
  resolveLogsConfig,
} from './logs-core.js';
import {
  BUFFERED_CONSOLE_LEVELS, BufferedConsoleEntry, ConsoleLogsHost, ConsoleLogsSink, initializeLogs,
  originalConsoleMethod, replayConsoleBuffer,
} from './console-logs.js';

/** @const {string} */
export const LOGS_CAPTURE_ENABLED_SERVER_SIDE = '$logs_capture_enabled_server_side';
/** @const {number} */
export const RECORDER_MAX_AGE_MS = 30000;
const CONSOLE_SCOPE_NAME = 'console';
const LOGS_SEND_TIMEOUT_MS = 90000;
const MAX_CONSECUTIVE_STATUS_ZERO_FAILURES = 3;
const LOGS_PATH = '/i/v1/logs';
const HANDLED = '__posthogHandledLogsRequestError';

/**
 * @param {*} error
 * @param {string} fallbackMessage
 * @return {!Error}
 */
function markHandled(error, fallbackMessage) {
  const handled = error instanceof Error ? error : new Error(fallbackMessage);
  handled[HANDLED] = true;
  return handled;
}

/**
 * @param {*} error
 * @return {boolean}
 */
function isHandled(error) {
  return !!error && typeof error === 'object' && error[HANDLED] === true;
}

/**
 * Upstream getSdkContext (browser posthog-logs.ts).
 * @param {!PostHog} instance
 * @return {!LogSdkContext}
 */
function getSdkContext(instance) {
  /** @type {!LogSdkContext} */
  const context = {
    distinctId: undefined, sessionId: undefined, windowId: undefined, sessionStartTimestamp: undefined,
    lastActivityTimestamp: undefined, currentUrl: undefined, activeFeatureFlags: undefined,
  };
  context.distinctId = instance.get_distinct_id();
  if (instance.sessionManager) {
    const ids = instance.sessionManager.checkAndGetSessionAndWindowId(true);
    context.sessionId = ids.sessionId;
    context.windowId = ids.windowId;
    if (!isNullish(ids.sessionStartTimestamp)) context.sessionStartTimestamp = ids.sessionStartTimestamp;
    if (!isNullish(ids.lastActivityTimestamp)) context.lastActivityTimestamp = ids.lastActivityTimestamp;
  }
  if (win && win.location && win.location.href) {
    context.currentUrl = instance.config['disable_capture_url_hashes'] ? stripUrlHash(win.location.href) :
      win.location.href;
  }
  const flags = /** @type {?FeatureFlagsApi} */ (instance.extensions['featureFlags'] || null);
  if (flags) {
    const enabled = flags.getFlags();
    if (enabled && enabled.length > 0) context.activeFeatureFlags = enabled;
  }
  return context;
}

/** @implements {Extension} */
export class PostHogLogs {
  /** @param {!PostHog} instance */
  constructor(instance) {
    /** @type {!PostHog} */
    this.instance = instance;
    /** @private {boolean} */
    this.isLogsEnabled_ = !!this.logsConfig_()['captureConsoleLogs'];
    /** @private {boolean} */
    this.isLoaded_ = false;
    /** @private {!Logger} */
    this.logger_ = baseLogger.createLogger('[logs]');
    const self = this;
    /** @private {!Logger} errors this module already reported (transport) are not logged twice */
    this.coreLogger_ = /** @type {!Logger} */ ({
      info: function(...args) {
        self.logger_.info.apply(null, args);
      },
      warn: function(...args) {
        self.logger_.warn.apply(null, args);
      },
      error: function(...args) {
        if (!args.some(isHandled)) self.logger_.error.apply(null, args);
      },
      critical: function(...args) {
        self.logger_.critical.apply(null, args);
      },
      uninitializedWarning: function(m) {
        self.logger_.uninitializedWarning(m);
      },
      createLogger: function(p) {
        return self.logger_.createLogger(p);
      },
    });
    /** @private {!Array<!Object>} */
    this.queue_ = [];
    /** @private {?LogsPipeline} */
    this.core_ = null;
    /** @private {?ResolvedLogsConfig} */
    this.resolvedConfig_ = null;
    /** @private {*} the `logs` config the current core was built from */
    this.resolvedFrom_ = undefined;
    /** @private {?Object} */
    this.captureLogger_ = null;
    /** @private {!Array<!Object>} */
    this.consoleQueue_ = [];
    /** @private {?LogsPipeline} */
    this.consoleCore_ = null;
    /** @private {?function()} */
    this.consoleLogsDispose_ = null;
    /** @private {?ResolvedLogsConfig} */
    this.consoleResolvedConfig_ = null;
    /** @private {*} */
    this.consoleResolvedFrom_ = undefined;
    /** @private {number} */
    this.consecutiveStatusZeroFailures_ = 0;
    /** @private {boolean} */
    this.setUp_ = false;
    /** @private {boolean} */
    this.disposed_ = false;
    /** @private {!Array<!BufferedConsoleEntry>} */
    this.consoleBuffer_ = [];
    /** @private {!Array<function()>} */
    this.consoleRecorderUnpatchers_ = [];
    /** @private {boolean} */
    this.isRecordingConsole_ = false;
    /** @private {number|undefined} */
    this.consoleRecorderTimeout_ = undefined;
    /** @private {boolean} */
    this.isRecordingConsoleEntry_ = false;
    /** @private {boolean} */
    this.listeningForReconnect_ = false;
    /** @private @const */
    this.onReconnect_ = function() {
      if (self.disposed_) return;
      self.consecutiveStatusZeroFailures_ = 0;
      if (self.core_) self.core_.onReconnect();
      if (self.consoleCore_) self.consoleCore_.onReconnect();
    };
    // Reset the breaker before application reconnect handlers can capture new logs.
    this.listenForReconnect_();
  }

  /**
   * The user's `logs` config (quoted keys), or an empty object.
   * @return {!Object}
   * @private
   */
  logsConfig_() {
    const c = this.instance.config ? this.instance.config['logs'] : undefined;
    return c || {};
  }

  /**
   * The `logs` option itself, compared by identity to rebuild the pipelines.
   * @return {*}
   * @private
   */
  logsOption_() {
    return this.instance.config ? this.instance.config['logs'] : undefined;
  }

  /** @private */
  listenForReconnect_() {
    if (this.listeningForReconnect_ || !win) return;
    addEventListener(win, 'online', this.onReconnect_);
    this.listeningForReconnect_ = true;
  }

  /**
   * @return {boolean}
   * @private
   */
  remoteConfigWillArrive_() {
    if (!this.instance.shouldDisableFlags()) return true;
    const cached = win ? win['_POSTHOG_REMOTE_CONFIG'] : undefined;
    const entry = cached ? cached[this.instance.config['token']] : undefined;
    return !!(entry && entry['config']);
  }

  /**
   * @return {boolean}
   * @private
   */
  canCapture_() {
    return this.instance.is_capturing();
  }

  /**
   * @param {function(): !Array<!Object>} getQueue
   * @param {function(!Array<!Object>)} setQueue
   * @return {!LogsHost}
   * @private
   */
  createHost_(getQueue, setQueue) {
    const self = this;
    return /** @type {!LogsHost} */ ({
      optedOut: function() {
        return !self.canCapture_();
      },
      getQueue: getQueue,
      setQueue: setQueue,
      sendLogsBatch: function(payload) {
        return self.sendLogsBatch_(payload);
      },
      libraryId: function() {
        return Config.LIB_NAME;
      },
      libraryVersion: function() {
        return Config.LIB_VERSION;
      },
    });
  }

  /**
   * @param {function(): !Array<!Object>} getQueue
   * @param {function(!Array<!Object>)} setQueue
   * @param {{serviceNameDefault: (string|undefined), consoleCapture: (boolean|undefined)}=} opts
   * @param {string=} scopeName
   * @return {{core: !LogsPipeline, config: !ResolvedLogsConfig}}
   * @private
   */
  buildCore_(getQueue, setQueue, opts, scopeName) {
    this.listenForReconnect_();
    const config = resolveLogsConfig(this.logsOption_(), opts);
    const self = this;
    const core = new LogsPipeline(this.createHost_(getQueue, setQueue), config, this.coreLogger_, function() {
      return getSdkContext(self.instance);
    }, scopeName);
    return {core: core, config: config};
  }

  /**
   * @return {!LogsPipeline}
   * @private
   */
  getCore_() {
    const option = this.logsOption_();
    if (!this.core_ || this.resolvedFrom_ !== option) {
      if (this.core_) this.core_.reset();
      this.resolvedFrom_ = option;
      const self = this;
      const built = this.buildCore_(function() {
        return self.queue_;
      }, function(q) {
        self.queue_ = q;
      });
      this.core_ = built.core;
      this.resolvedConfig_ = built.config;
    }
    return this.core_;
  }

  /**
   * @return {!LogsPipeline}
   * @private
   */
  getConsoleCore_() {
    const option = this.logsOption_();
    if (!this.consoleCore_ || this.consoleResolvedFrom_ !== option) {
      if (this.consoleCore_) this.consoleCore_.reset();
      this.consoleResolvedFrom_ = option;
      const self = this;
      const built = this.buildCore_(function() {
        return self.consoleQueue_;
      }, function(q) {
        self.consoleQueue_ = q;
      }, {serviceNameDefault: 'posthog-browser-logs', consoleCapture: true}, CONSOLE_SCOPE_NAME);
      this.consoleCore_ = built.core;
      this.consoleResolvedConfig_ = built.config;
    }
    return this.consoleCore_;
  }

  /** Upstream `setup` + `_finishSetup` (run when the extension is attached during init). */
  onInit() {
    if (this.disposed_ || this.setUp_) return;
    this.setUp_ = true;
    this.listenForReconnect_();
    if (this.logsConfig_()['captureConsoleLogs']) this.isLogsEnabled_ = true;
    const persistence = this.instance.persistence;
    if (this.isLogsEnabled_ ||
        (this.remoteConfigWillArrive_() && persistence && persistence.get_property(LOGS_CAPTURE_ENABLED_SERVER_SIDE))) {
      this.startConsoleRecorder_();
    }
    // Upstream subscribes to remote config here; a config that already arrived is
    // replayed by the core right after onInit and loads capture the same way.
    this.loadIfEnabled();
  }

  dispose() {
    if (this.disposed_) return;
    this.disposed_ = true;
    this.stopConsoleRecorder_();
    if (win) win.removeEventListener('online', this.onReconnect_);
    if (this.consoleLogsDispose_) this.consoleLogsDispose_();
    this.consoleLogsDispose_ = null;
    if (this.core_) this.core_.clearQueue();
    if (this.consoleCore_) this.consoleCore_.clearQueue();
    if (this.core_) this.core_.reset();
    if (this.consoleCore_) this.consoleCore_.reset();
  }

  /** @param {?Object} config remote config, or null when loading failed */
  onRemoteConfig(config) {
    if (this.disposed_) return;
    const logs = config ? config['logs'] : undefined;
    const logCapture = logs ? logs['captureConsoleLogs'] : undefined;
    if (isNullish(logCapture)) {
      this.stopRecorderStartedByPersistedHint_();
      return;
    }
    if (this.instance.persistence) this.instance.persistence.register({[LOGS_CAPTURE_ENABLED_SERVER_SIDE]: !!logCapture});
    if (!logCapture) {
      this.stopRecorderStartedByPersistedHint_();
      return;
    }
    this.isLogsEnabled_ = true;
    if (!this.isLoaded_) this.startConsoleRecorder_();
    this.loadIfEnabled();
  }

  /** Upstream `reset()`: the queues and the recorder buffer carry the old identity. */
  onReset() {
    this.stopConsoleRecorder_();
    if (this.core_) this.core_.clearQueue();
    this.queue_ = [];
    if (this.core_) this.core_.reset();
    if (this.consoleCore_) this.consoleCore_.clearQueue();
    this.consoleQueue_ = [];
    if (this.consoleCore_) this.consoleCore_.reset();
    this.consecutiveStatusZeroFailures_ = 0;
  }

  /** @param {!Object} options CaptureLogOptions (quoted keys) */
  captureLog(options) {
    if (!this.disposed_ && this.setUp_) this.getCore_().captureLog(options);
  }

  /** @param {!Object} options */
  captureConsoleLog(options) {
    if (!this.disposed_ && this.setUp_) this.getConsoleCore_().captureLog(options);
  }

  /**
   * @param {!Object} options
   * @param {!LogSdkContext} context
   * @param {number} occurredAtMs
   */
  captureBufferedConsoleLog(options, context, occurredAtMs) {
    if (!this.disposed_ && this.setUp_) {
      this.getConsoleCore_().captureLog(options, {context: context, occurredAtMs: occurredAtMs});
    }
  }

  /** Capturing turned off: release console capture's buffer, patches and queued records. */
  onOptOut() {
    this.stopConsoleRecorder_();
    if (this.consoleCore_) this.consoleCore_.clearQueue();
    this.consoleQueue_ = [];
  }

  /** @private */
  stopRecorderStartedByPersistedHint_() {
    if (this.isLogsEnabled_) return;
    this.stopConsoleRecorder_();
  }

  /** @private */
  startConsoleRecorder_() {
    const console = win ? win.console : null;
    if (this.isRecordingConsole_ || !console) return;
    const maxBufferSize = resolveLogsConfig(this.logsOption_()).maxBufferSize;
    let active = true;
    this.consoleRecorderUnpatchers_.push(function() {
      active = false;
    });
    const self = this;
    BUFFERED_CONSOLE_LEVELS.forEach(function(level) {
      let trueOriginal;
      try {
        trueOriginal = originalConsoleMethod(console[level]);
      } catch (e) {
        return;
      }
      if (!trueOriginal) return;
      self.consoleRecorderUnpatchers_.push(patch(console, level, function(next) {
        const wrapped = function(...args) {
          try {
            if (active) self.recordConsoleEntry_(level, args, maxBufferSize);
          } catch (e) {
            // recording must never break the page's own console output
          }
          return next.apply(console, args);
        };
        wrapped['__rrweb_original__'] = trueOriginal;
        return wrapped;
      }));
    });
    this.isRecordingConsole_ = true;
    this.consoleRecorderTimeout_ = setTimeout(function() {
      self.stopConsoleRecorder_();
    }, RECORDER_MAX_AGE_MS);
  }

  /**
   * @param {string} level
   * @param {!Array<*>} args
   * @param {number} maxBufferSize
   * @private
   */
  recordConsoleEntry_(level, args, maxBufferSize) {
    if (!this.isRecordingConsole_ || this.isRecordingConsoleEntry_ || args.length === 0) return;
    if (!this.setUp_ || !this.canCapture_()) {
      this.stopConsoleRecorder_();
      return;
    }
    if (this.consoleBuffer_.length >= maxBufferSize) return;
    this.isRecordingConsoleEntry_ = true;
    try {
      this.consoleBuffer_.push({level: level, args: args, occurredAtMs: new Date().getTime(),
        context: getSdkContext(this.instance)});
    } finally {
      this.isRecordingConsoleEntry_ = false;
    }
  }

  /** @private */
  stopConsoleRecorder_() {
    this.consoleBuffer_ = [];
    if (!this.isRecordingConsole_) return;
    this.isRecordingConsole_ = false;
    if (this.consoleRecorderTimeout_) {
      clearTimeout(this.consoleRecorderTimeout_);
      this.consoleRecorderTimeout_ = undefined;
    }
    for (let i = 0; i < this.consoleRecorderUnpatchers_.length; i++) this.consoleRecorderUnpatchers_[i]();
    this.consoleRecorderUnpatchers_ = [];
  }

  /**
   * @return {!Array<!BufferedConsoleEntry>}
   * @private
   */
  takeConsoleBuffer_() {
    const buffered = this.consoleBuffer_;
    this.stopConsoleRecorder_();
    return buffered;
  }

  /**
   * `posthog.logger` / `posthog.logs.logger`: one method per severity.
   * @return {!Object}
   */
  getLogger() {
    if (!this.captureLogger_) {
      const self = this;
      const make = function(level) {
        return function(body, attributes) {
          self.captureLog({'body': body, 'level': level, 'attributes': attributes});
        };
      };
      this.captureLogger_ = {
        'trace': make('trace'), 'debug': make('debug'), 'info': make('info'), 'warn': make('warn'),
        'error': make('error'), 'fatal': make('fatal'),
      };
    }
    return this.captureLogger_;
  }

  /**
   * Fire-and-forget flush; with a transport, drains both queues in one request each.
   * @param {string=} transport 'XHR' | 'fetch' | 'sendBeacon'
   */
  flushLogs(transport) {
    if (!this.setUp_ || this.disposed_) return;
    if (transport) {
      this.flushViaTransport_(transport);
      return;
    }
    const self = this;
    const report = function(err) {
      self.logFlushError_(err);
    };
    if (this.core_) this.core_.flush().then(undefined, report);
    if (this.consoleCore_) this.consoleCore_.flush().then(undefined, report);
  }

  /** @return {!Promise<void>} awaits both queues */
  flush() {
    const self = this;
    const report = function(err) {
      self.logFlushError_(err);
    };
    const programmatic = this.core_ ? this.core_.flush().then(undefined, report) : Promise.resolve();
    const consoleFlush = this.consoleCore_ ? this.consoleCore_.flush().then(undefined, report) : Promise.resolve();
    return programmatic.then(function() {
      return consoleFlush;
    });
  }

  /**
   * @param {*} error
   * @private
   */
  logFlushError_(error) {
    if (!isHandled(error)) this.logger_.error('PostHog logs flush failed:', error);
  }

  /** Starts console capture when enabled and not yet started. */
  loadIfEnabled() {
    if (this.disposed_ || !this.isLogsEnabled_ || this.isLoaded_) return;
    if (this.instance.config['disable_external_dependency_loading']) {
      // Upstream's `/static/logs.js` load is refused in this mode.
      this.logger_.error('Could not load logs script', 'Loading of external scripts is disabled');
      this.stopConsoleRecorder_();
      return;
    }
    const buffered = this.takeConsoleBuffer_();
    const host = this.consoleHost_();
    this.consoleLogsDispose_ = initializeLogs(host);
    this.isLoaded_ = true;
    if (buffered.length > 0) replayConsoleBuffer(host, buffered);
  }

  /**
   * @return {!ConsoleLogsHost}
   * @private
   */
  consoleHost_() {
    const self = this;
    return {
      console: /** @type {!Object} */ (win.console),
      hostname: win.location.host,
      getCapturingLogs: function() {
        if (!self.canCapture_()) return null;
        return /** @type {!ConsoleLogsSink} */ ({
          captureConsoleLog: function(options) {
            self.captureConsoleLog(options);
          },
          captureBufferedConsoleLog: function(options, context, occurredAtMs) {
            self.captureBufferedConsoleLog(options, context, occurredAtMs);
          },
        });
      },
    };
  }

  /**
   * @param {!Object} payload
   * @return {!Promise<!SendOutcome>}
   * @private
   */
  sendLogsBatch_(payload) {
    const self = this;
    return new Promise(function(resolve) {
      if (self.consecutiveStatusZeroFailures_ >= MAX_CONSECUTIVE_STATUS_ZERO_FAILURES && isBrowserOnline()) {
        resolve({kind: 'fatal', error: markHandled(undefined, 'logs endpoint is unreachable, dropping batch')});
        return;
      }
      let settled = false;
      let timer = undefined;
      const settle = function(outcome) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      };
      timer = setTimeout(function() {
        self.logger_.warn('Logs request timed out before receiving a response');
        settle({kind: 'retry-later', error: markHandled(undefined, 'logs request timed out')});
      }, LOGS_SEND_TIMEOUT_MS);
      const isRequestReady = self.instance.loaded;
      self.instance.sendRequest(/** @type {!RequestOptions} */ ({
        method: 'POST',
        url: self.logsUrl_(),
        data: payload,
        timeout: 60000,
        fireCallbackOnDrop: true,
        transport: undefined,
        compression: 'best-available',
        batchKey: 'logs',
        callback: function(response) {
          const status = response.statusCode;
          self.trackEndpointReachability_(status, isRequestReady);
          if (status >= 200 && status < 300) {
            settle({kind: 'ok', error: undefined});
          } else if (status === 413) {
            settle({kind: 'too-large', error: undefined});
          } else if (status === 0 || status === 408 || status === 429 || status >= 500) {
            if (status === 0) {
              if (!response.error) self.logger_.warn('Logs request failed before receiving an HTTP response');
              settle({kind: 'retry-later',
                error: markHandled(response.error, 'logs request failed before receiving an HTTP response')});
            } else {
              settle({kind: 'retry-later', error: response.error || new Error('logs request failed with status ' + status)});
            }
          } else {
            settle({kind: 'fatal', error: new Error('logs request failed with status ' + status)});
          }
        },
      }));
    });
  }

  /**
   * @return {string}
   * @private
   */
  logsUrl_() {
    return this.instance.requestRouter.endpointFor('api',
        LOGS_PATH + '?token=' + encodeURIComponent(this.instance.config['token']));
  }

  /**
   * @param {number} statusCode
   * @param {boolean} isRequestReady
   * @private
   */
  trackEndpointReachability_(statusCode, isRequestReady) {
    if (statusCode === 0 && !isRequestReady) return;
    if (statusCode === 0) {
      if (isBrowserOnline()) {
        this.consecutiveStatusZeroFailures_++;
        if (this.consecutiveStatusZeroFailures_ === MAX_CONSECUTIVE_STATUS_ZERO_FAILURES) {
          this.logger_.warn('Log requests are failing before receiving an HTTP response; this can happen due to ' +
              'network issues, CORS, browser blocking, or ad blockers. Stopped sending logs; will try again when ' +
              'connectivity changes.');
        }
      }
      return;
    }
    this.consecutiveStatusZeroFailures_ = 0;
  }

  /**
   * @param {string} transport
   * @private
   */
  flushViaTransport_(transport) {
    const self = this;
    if (this.queue_.length > 0 && this.resolvedConfig_) {
      this.drainQueueViaTransport_(transport, this.queue_, this.resolvedConfig_, Config.LIB_NAME, function(q) {
        self.queue_ = q;
      });
    }
    if (this.consoleQueue_.length > 0 && this.consoleResolvedConfig_) {
      this.drainQueueViaTransport_(transport, this.consoleQueue_, this.consoleResolvedConfig_, CONSOLE_SCOPE_NAME,
          function(q) {
            self.consoleQueue_ = q;
          });
    }
  }

  /**
   * @param {string} transport
   * @param {!Array<!Object>} queue
   * @param {!ResolvedLogsConfig} config
   * @param {string} scopeName
   * @param {function(!Array<!Object>)} setQueue
   * @private
   */
  drainQueueViaTransport_(transport, queue, config, scopeName, setQueue) {
    if (queue.length === 0) return;
    const records = queue.map(function(e) {
      return e['record'];
    });
    setQueue([]);
    const payload = buildOtlpLogsPayload(records, buildResourceAttributes(config, Config.LIB_NAME, Config.LIB_VERSION),
        scopeName, Config.LIB_VERSION);
    // Upstream's Client.sendRequest: a sendBeacon request gets no callback.
    const options = /** @type {!RequestOptions} */ ({
      method: 'POST',
      url: this.logsUrl_(),
      data: payload,
      timeout: 60000,
      fireCallbackOnDrop: true,
      transport: transport,
      compression: 'best-available',
      batchKey: 'logs',
    });
    if (transport !== 'sendBeacon') options.callback = function() {};
    this.instance.sendRequest(options);
  }
}
