/**
 * @fileoverview The logs export pipeline. Port of upstream
 * core/src/logs/index.ts (`PostHogLogs`), logs-utils.ts (OTLP record and
 * envelope) and browser-common/src/logs-config.ts (`resolveLogsConfig`).
 *
 * Records are built at capture time, queued in memory, and POSTed to
 * `/i/v1/logs` as OTLP `resourceLogs` in slices of `maxBatchRecordsPerPost`:
 * when the queue reaches `maxBufferSize`, when the flush timer fires
 * (`flushIntervalMs`), or when the host drains it. A 413 halves the batch and
 * retries it, a transient failure keeps the records and backs off, anything
 * else drops the batch.
 */
import {isArray, isNullish, isNumber, isUndefined} from '../core/utils.js';
import {Logger} from '../core/logger.js';
import {
  FlushTimer, MAX_FLUSH_BACKOFF_MS, NO_JITTER, SendOutcome, UNSERIALIZABLE_VALUE, assignUserAttributes,
  backoffDelayMs, buildOtlpResourceAttributes, defaultResourceAttributes, drawJitter, sanitizeString,
  toOtlpKeyValueList, toOtlpResourceKeyValueList,
} from '../otlp/otlp.js';

// ---- config (browser-common logs-config.ts) -------------------------------------

const DEFAULT_FLUSH_INTERVAL_MS = 3000;
const DEFAULT_MAX_BUFFER_SIZE = 100;
const DEFAULT_MAX_LOGS_PER_INTERVAL = 1000;
const DEFAULT_CONSOLE_MAX_QUEUE_SIZE = 2048;
const DEFAULT_MAX_BATCH_RECORDS_PER_POST = 100;

/**
 * @typedef {{
 *   serviceName: (string|undefined),
 *   serviceVersion: (string|undefined),
 *   environment: (string|undefined),
 *   resourceAttributes: !Object,
 *   beforeSend: *,
 *   flushIntervalMs: number,
 *   maxBufferSize: number,
 *   maxQueueSize: number,
 *   maxBatchRecordsPerPost: number,
 *   rateCapWindowMs: number,
 *   maxLogsPerInterval: (number|undefined)
 * }}
 */
export let ResolvedLogsConfig;

/**
 * @param {*} obj
 * @param {string} key
 * @return {*}
 */
function field(obj, key) {
  return obj ? obj[key] : undefined;
}

/**
 * @param {*} a
 * @param {*} b
 * @return {*}
 */
function coalesce(a, b) {
  return isNullish(a) ? b : a;
}

/**
 * Upstream resolveLogsConfig. `config` is the user's `logs` option (quoted keys).
 * @param {*} config
 * @param {{serviceNameDefault: (string|undefined), consoleCapture: (boolean|undefined)}=} opts
 * @return {!ResolvedLogsConfig}
 */
export function resolveLogsConfig(config, opts) {
  const flushIntervalMs = /** @type {number} */ (coalesce(field(config, 'flushIntervalMs'), DEFAULT_FLUSH_INTERVAL_MS));
  const maxBufferSize = /** @type {number} */ (coalesce(field(config, 'maxBufferSize'), DEFAULT_MAX_BUFFER_SIZE));
  const maxLogsPerInterval = opts && opts.consoleCapture ? undefined :
    /** @type {number} */ (coalesce(field(config, 'maxLogsPerInterval'), DEFAULT_MAX_LOGS_PER_INTERVAL));
  const maxQueueSize = isUndefined(maxLogsPerInterval) ? Math.max(maxBufferSize, DEFAULT_CONSOLE_MAX_QUEUE_SIZE) :
    Math.max(maxBufferSize, maxLogsPerInterval);
  const resourceAttributes = defaultResourceAttributes();
  const user = field(config, 'resourceAttributes');
  if (user) {
    const names = Object.keys(/** @type {!Object} */ (user));
    for (let i = 0; i < names.length; i++) resourceAttributes[names[i]] = user[names[i]];
  }
  return {
    serviceName: /** @type {string|undefined} */ (coalesce(resourceAttributes['service.name'],
        coalesce(field(config, 'serviceName'), opts ? opts.serviceNameDefault : undefined))),
    serviceVersion: /** @type {string|undefined} */ (coalesce(resourceAttributes['service.version'],
        field(config, 'serviceVersion'))),
    environment: /** @type {string|undefined} */ (coalesce(resourceAttributes['deployment.environment'],
        field(config, 'environment'))),
    resourceAttributes: resourceAttributes,
    beforeSend: field(config, 'beforeSend'),
    flushIntervalMs: flushIntervalMs,
    maxBufferSize: maxBufferSize,
    maxQueueSize: maxQueueSize,
    maxBatchRecordsPerPost: DEFAULT_MAX_BATCH_RECORDS_PER_POST,
    rateCapWindowMs: flushIntervalMs,
    maxLogsPerInterval: maxLogsPerInterval,
  };
}

// ---- OTLP records (core logs-utils.ts) --------------------------------------------

/** @const {!Object<string, !Array<string|number>>} */
const OTLP_SEVERITY_MAP = {
  'trace': ['TRACE', 1],
  'debug': ['DEBUG', 5],
  'info': ['INFO', 9],
  'warn': ['WARN', 13],
  'error': ['ERROR', 17],
  'fatal': ['FATAL', 21],
};

/**
 * State the log record's automatic attributes come from (upstream LogSdkContext).
 * @typedef {{
 *   distinctId: (string|undefined),
 *   sessionId: (string|undefined),
 *   windowId: (string|undefined),
 *   sessionStartTimestamp: (number|undefined),
 *   lastActivityTimestamp: (number|undefined),
 *   currentUrl: (string|undefined),
 *   activeFeatureFlags: (!Array<string>|undefined)
 * }}
 */
export let LogSdkContext;

/**
 * @param {*} body
 * @return {string}
 */
function encodeBody(body) {
  try {
    return sanitizeString(String(body));
  } catch (e) {
    return UNSERIALIZABLE_VALUE;
  }
}

/**
 * Upstream buildOtlpLogRecord. `options` is the user's CaptureLogOptions (quoted keys).
 * @param {!Object} options
 * @param {!LogSdkContext} context
 * @param {?Logger=} logger
 * @param {number=} occurredAtMs
 * @return {!Object}
 */
export function buildOtlpLogRecord(options, context, logger, occurredAtMs) {
  const level = options['level'] || 'info';
  const severity = (Object.prototype.hasOwnProperty.call(OTLP_SEVERITY_MAP, level) && OTLP_SEVERITY_MAP[level]) ||
    OTLP_SEVERITY_MAP['info'];
  const nano = String(isNumber(occurredAtMs) ? occurredAtMs : new Date().getTime()) + '000000';

  const auto = {};
  if (context.distinctId) auto['posthogDistinctId'] = context.distinctId;
  if (context.sessionId) auto['sessionId'] = context.sessionId;
  if (context.windowId) auto['window.id'] = context.windowId;
  if (!isNullish(context.sessionStartTimestamp)) auto['sessionStartTimestamp'] = String(context.sessionStartTimestamp);
  if (!isNullish(context.lastActivityTimestamp)) auto['lastActivityTimestamp'] = String(context.lastActivityTimestamp);
  if (context.currentUrl) auto['url.full'] = context.currentUrl;
  if (context.activeFeatureFlags && context.activeFeatureFlags.length > 0) auto['feature_flags'] = context.activeFeatureFlags;
  const merged = assignUserAttributes(auto, options['attributes']);

  const record = {
    'timeUnixNano': nano,
    'observedTimeUnixNano': nano,
    'severityNumber': severity[1],
    'severityText': severity[0],
    'body': {'stringValue': encodeBody(options['body'])},
    'attributes': toOtlpKeyValueList(merged, logger),
  };
  if (options['trace_id']) record['traceId'] = options['trace_id'];
  if (options['span_id']) record['spanId'] = options['span_id'];
  if (!isUndefined(options['trace_flags'])) record['flags'] = options['trace_flags'];
  return record;
}

/**
 * @param {!ResolvedLogsConfig} config
 * @param {string} sdkName
 * @param {string} sdkVersion
 * @return {!Object}
 */
export function buildResourceAttributes(config, sdkName, sdkVersion) {
  return buildOtlpResourceAttributes(config, sdkName, sdkVersion);
}

/**
 * The OTLP `resourceLogs` envelope.
 * @param {!Array<!Object>} records
 * @param {!Object} resourceAttributes
 * @param {string} scopeName
 * @param {string} scopeVersion
 * @return {!Object}
 */
export function buildOtlpLogsPayload(records, resourceAttributes, scopeName, scopeVersion) {
  return {
    'resourceLogs': [{
      'resource': {'attributes': toOtlpResourceKeyValueList(resourceAttributes)},
      'scopeLogs': [{'scope': {'name': scopeName, 'version': scopeVersion}, 'logRecords': records}],
    }],
  };
}

// ---- the pipeline (core logs/index.ts) -----------------------------------------------

/**
 * What the pipeline needs from its host (upstream LogsHost, as the browser adapts it).
 * @record
 */
export class LogsHost {
  constructor() {}
  /** @return {boolean} */
  optedOut() {}
  /** @return {!Array<!Object>} the live queue of `{record}` entries */
  getQueue() {}
  /** @param {!Array<!Object>} queue */
  setQueue(queue) {}
  /**
   * @param {!Object} payload
   * @return {!Promise<!SendOutcome>}
   */
  sendLogsBatch(payload) {}
  /** @return {string} */
  libraryId() {}
  /** @return {string} */
  libraryVersion() {}
}

/** Port of upstream core `PostHogLogs`, with the browser host's constant answers folded in. */
export class LogsPipeline {
  /**
   * @param {!LogsHost} host
   * @param {!ResolvedLogsConfig} config
   * @param {!Logger} logger
   * @param {function(): !LogSdkContext} getContext
   * @param {string=} scopeName
   */
  constructor(host, config, logger, getContext, scopeName) {
    /** @private @const */ this.host_ = host;
    /** @private @const */ this.config_ = config;
    /** @private @const */ this.logger_ = logger;
    /** @private @const */ this.getContext_ = getContext;
    /** @private @const */ this.scopeName_ = scopeName;
    /** @private */ this.maxBufferSize_ = config.maxBufferSize;
    /** @private */ this.maxQueueSize_ = Math.max(config.maxQueueSize, config.maxBufferSize);
    /** @private */ this.flushIntervalMs_ = config.flushIntervalMs;
    /** @private */ this.maxBatchRecordsPerPost_ = config.maxBatchRecordsPerPost;
    /** @private */ this.rateCapWindowMs_ = config.rateCapWindowMs;
    /** @private */ this.maxLogsPerInterval_ = config.maxLogsPerInterval;
    const self = this;
    /** @private @const */ this.flushTimer_ = new FlushTimer(function() {
      self.flushInBackground();
    });
    /** @private {?Promise<void>} */ this.flushPromise_ = null;
    /** @private */ this.evictedSinceAdvance_ = 0;
    /** @private */ this.queueGeneration_ = 0;
    /** @private {?Promise<void>} */ this.backgroundFlushPromise_ = null;
    /** @private */ this.consecutiveFlushFailures_ = 0;
    /** @private */ this.flushJitter_ = NO_JITTER;
    /** @private */ this.intervalWindowStart_ = 0;
    /** @private */ this.intervalLogCount_ = 0;
    /** @private */ this.droppedWarned_ = false;
  }

  /** Drops every queued record and retires a batch in flight. */
  clearQueue() {
    this.queueGeneration_++;
    this.host_.setQueue([]);
  }

  /** Clears the flush timer and rate-cap state. */
  reset() {
    this.flushTimer_.clear();
    this.intervalWindowStart_ = 0;
    this.intervalLogCount_ = 0;
    this.droppedWarned_ = false;
    this.consecutiveFlushFailures_ = 0;
    this.flushJitter_ = NO_JITTER;
    this.maxBatchRecordsPerPost_ = this.config_.maxBatchRecordsPerPost;
  }

  /** Connectivity restored: clear the backoff and flush now. */
  onReconnect() {
    this.consecutiveFlushFailures_ = 0;
    this.flushJitter_ = NO_JITTER;
    this.flushInBackground();
  }

  /**
   * @param {!Object} options CaptureLogOptions (quoted keys)
   * @param {{context: !LogSdkContext, occurredAtMs: number}=} capturedAt
   */
  captureLog(options, capturedAt) {
    if (this.host_.optedOut()) return;
    if (!options || !options['body']) return;
    const filtered = this.runBeforeSend_(options);
    if (filtered === null) return;
    if (!filtered['body']) {
      this.logger_.info('Log was rejected in beforeSend function');
      return;
    }
    if (!this.checkRateLimit_()) return;
    const record = buildOtlpLogRecord(filtered, capturedAt ? capturedAt.context : this.getContext_(), this.logger_,
        capturedAt ? capturedAt.occurredAtMs : undefined);
    this.enqueue_({'record': record});
  }

  /**
   * @param {!Object} options
   * @return {?Object}
   * @private
   */
  runBeforeSend_(options) {
    const beforeSend = this.config_.beforeSend;
    if (!beforeSend) return options;
    const fns = isArray(beforeSend) ? /** @type {!Array<?>} */ (beforeSend) : [beforeSend];
    let result = options;
    for (let i = 0; i < fns.length; i++) {
      try {
        const next = fns[i](result);
        if (!next) {
          this.logger_.info('Log was rejected in beforeSend function');
          return null;
        }
        result = next;
      } catch (e) {
        this.logger_.error('Error in beforeSend function for log:', e);
        return null;
      }
    }
    return result;
  }

  /**
   * @return {boolean}
   * @private
   */
  checkRateLimit_() {
    if (this.maxLogsPerInterval_ === undefined) return true;
    const now = new Date().getTime();
    const elapsed = now - this.intervalWindowStart_;
    if (elapsed >= this.rateCapWindowMs_ || elapsed < 0) {
      this.intervalWindowStart_ = now;
      this.intervalLogCount_ = 0;
      this.droppedWarned_ = false;
    }
    if (this.intervalLogCount_ >= this.maxLogsPerInterval_) {
      if (!this.droppedWarned_) {
        this.logger_.warn('captureLog dropping logs: exceeded ' + this.maxLogsPerInterval_ + ' logs per ' +
            this.rateCapWindowMs_ + 'ms');
        this.droppedWarned_ = true;
      }
      return false;
    }
    this.intervalLogCount_++;
    return true;
  }

  /**
   * Drains the queue in `maxBatchRecordsPerPost` slices. Concurrent calls share one run.
   * @return {!Promise<void>}
   */
  flush() {
    if (this.flushPromise_) return this.flushPromise_;
    const self = this;
    const done = function() {
      self.flushPromise_ = null;
    };
    const p = this.flushInner_().then(done, function(e) {
      done();
      throw e;
    });
    this.flushPromise_ = p;
    return p;
  }

  /**
   * @return {!Promise<void>}
   * @private
   */
  flushInner_() {
    this.flushTimer_.clear();
    let queue = this.host_.getQueue() || [];
    if (queue.length === 0) return Promise.resolve();
    const originalQueueLength = queue.length;
    let sentCount = 0;
    const self = this;
    /** @return {!Promise<void>} */
    const step = function() {
      if (!(queue.length > 0 && sentCount < originalQueueLength)) return Promise.resolve();
      const generation = self.queueGeneration_;
      self.evictedSinceAdvance_ = 0;
      const batchSize = Math.min(queue.length, self.maxBatchRecordsPerPost_);
      const batch = queue.slice(0, batchSize);
      const records = batch.map(function(e) {
        return e['record'];
      });
      const payload = buildOtlpLogsPayload(records,
          buildResourceAttributes(self.config_, self.host_.libraryId(), self.host_.libraryVersion()),
          self.scopeName_ || self.host_.libraryId(), self.host_.libraryVersion());
      return self.host_.sendLogsBatch(payload).then(function(outcome) {
        if (self.queueGeneration_ !== generation) return undefined;
        if (outcome.kind === 'too-large' && batch.length > 1) {
          self.maxBatchRecordsPerPost_ = Math.max(1, Math.floor(batch.length / 2));
          self.logger_.warn('Logs batch of size ' + batch.length + ' was too large for the ingestion endpoint, ' +
              'reducing batch size to ' + self.maxBatchRecordsPerPost_);
          return step();
        }
        if (self.flushTimer_.pending) self.flushTimer_.arm(self.flushIntervalMs_);
        if (outcome.kind === 'retry-later') throw outcome.error;
        if (outcome.kind === 'too-large') {
          self.logger_.warn('Dropping a single log record with batch size 1 — the record is larger than the ' +
              'server cap and cannot be split further.');
        } else if (outcome.kind === 'ok' && self.maxBatchRecordsPerPost_ < self.config_.maxBatchRecordsPerPost) {
          self.maxBatchRecordsPerPost_ = Math.min(self.config_.maxBatchRecordsPerPost, self.maxBatchRecordsPerPost_ + 1);
        }
        // upstream _persistQueueAdvance (the browser's storage persist is a resolved no-op)
        const drop = Math.max(0, batch.length - self.evictedSinceAdvance_);
        self.host_.setQueue((self.host_.getQueue() || []).slice(drop));
        return Promise.resolve().then(function() {
          queue = self.host_.getQueue() || [];
          sentCount += batch.length;
          if (outcome.kind === 'fatal') throw outcome.error;
          return step();
        });
      });
    };
    return step();
  }

  /**
   * @param {!Object} entry
   * @private
   */
  enqueue_(entry) {
    if (this.host_.optedOut()) return;
    const queue = this.host_.getQueue() || [];
    if (queue.length >= this.maxQueueSize_) {
      queue.shift();
      this.evictedSinceAdvance_++;
      this.logger_.info('Logs queue is full, dropping oldest record.');
    }
    queue.push(entry);
    this.host_.setQueue(queue);
    if (queue.length >= this.maxBufferSize_) {
      this.flushInBackground();
      return;
    }
    this.armFlushTimer_();
  }

  /** @private */
  armFlushTimer_() {
    if (this.flushTimer_.pending) return;
    this.flushTimer_.arm(this.flushIntervalMs_);
  }

  /**
   * @return {number}
   * @private
   */
  nextFlushDelay_() {
    return backoffDelayMs(this.flushIntervalMs_, this.consecutiveFlushFailures_, this.flushJitter_, MAX_FLUSH_BACKOFF_MS);
  }

  /**
   * @return {boolean}
   * @private
   */
  hasQueuedRecords_() {
    const queue = this.host_.getQueue();
    return !!queue && queue.length > 0;
  }

  /**
   * `flush()` that never rejects and re-arms the timer (with backoff) while records remain.
   * @return {!Promise<void>}
   */
  flushInBackground() {
    if (this.backgroundFlushPromise_) return this.backgroundFlushPromise_;
    const self = this;
    /** @type {?Promise<void>} */
    let promise = null;
    promise = this.flush().then(function() {
      self.consecutiveFlushFailures_ = 0;
      self.flushJitter_ = NO_JITTER;
    }, function(err) {
      self.consecutiveFlushFailures_++;
      self.flushJitter_ = drawJitter();
      self.logger_.error('PostHog logs flush failed:', err);
    }).then(function() {
      if (self.backgroundFlushPromise_ === promise) self.backgroundFlushPromise_ = null;
      if (self.hasQueuedRecords_()) self.flushTimer_.armNoEarlierThan(self.nextFlushDelay_());
    });
    this.backgroundFlushPromise_ = promise;
    return promise;
  }
}
