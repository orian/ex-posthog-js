/**
 * @fileoverview The metrics aggregator. Port of upstream
 * core/src/metrics/index.ts (`PostHogMetrics`), metrics-utils.ts and config.ts.
 *
 * Samples fold into per-series aggregates in memory (counts sum, gauges keep
 * the last value, histograms fill buckets) and each flush window goes out as
 * one OTLP `resourceMetrics` payload with one data point per series. Sums and
 * histograms use delta temporality.
 *
 * Exemplars are not ported: they need the host's active span, which the
 * browser host does not provide, so upstream never attaches one in the browser.
 */
import {isArray, isNullish} from '../core/utils.js';
import {Logger} from '../core/logger.js';
import {
  FlushTimer, MAX_FLUSH_BACKOFF_MS, NO_JITTER, SendOutcome, backoffDelayMs, buildOtlpResourceAttributes, drawJitter,
  isFiniteNumber, msToUnixNano, toOtlpKeyValueList, toOtlpResourceKeyValueList,
} from '../otlp/otlp.js';

const OTLP_TEMPORALITY_DELTA = 1;
const DEFAULT_FLUSH_INTERVAL_MS = 10000;
const DEFAULT_MAX_SERIES_PER_FLUSH = 1000;

/** OpenTelemetry's default histogram bucket boundaries. */
/** @const {!Array<number>} */
export const DEFAULT_HISTOGRAM_BOUNDS = [0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000];

/**
 * @typedef {{
 *   serviceName: (string|undefined),
 *   serviceVersion: (string|undefined),
 *   environment: (string|undefined),
 *   resourceAttributes: (?Object|undefined),
 *   beforeSend: *,
 *   flushIntervalMs: number,
 *   maxSeriesPerFlush: number
 * }}
 */
export let ResolvedMetricsConfig;

/**
 * @param {*} a
 * @param {*} b
 * @return {*}
 */
function coalesce(a, b) {
  return isNullish(a) ? b : a;
}

/**
 * Upstream resolveMetricsConfig. `config` is the user's `metrics` option.
 * @param {*} config
 * @return {!ResolvedMetricsConfig}
 */
export function resolveMetricsConfig(config) {
  const c = config || {};
  const ra = c['resourceAttributes'];
  return {
    serviceName: /** @type {string|undefined} */ (coalesce(ra ? ra['service.name'] : undefined, c['serviceName'])),
    serviceVersion: /** @type {string|undefined} */ (coalesce(ra ? ra['service.version'] : undefined, c['serviceVersion'])),
    environment: /** @type {string|undefined} */ (coalesce(ra ? ra['deployment.environment'] : undefined, c['environment'])),
    resourceAttributes: ra,
    beforeSend: c['beforeSend'],
    flushIntervalMs: /** @type {number} */ (coalesce(c['flushIntervalMs'], DEFAULT_FLUSH_INTERVAL_MS)),
    maxSeriesPerFlush: /** @type {number} */ (coalesce(c['maxSeriesPerFlush'], DEFAULT_MAX_SERIES_PER_FLUSH)),
  };
}

/**
 * Series identity: type, name, unit and the attributes with sorted keys.
 * @param {string} type
 * @param {string} name
 * @param {string|undefined} unit
 * @param {?Object|undefined} attributes
 * @return {string}
 */
export function seriesKey(type, name, unit, attributes) {
  let attrsKey = '';
  if (attributes) {
    const names = Object.keys(attributes).sort();
    attrsKey = names.map(function(k) {
      return JSON.stringify(k) + ':' + JSON.stringify(attributes[k]);
    }).join(',');
  }
  return type + '\u0000' + name + '\u0000' + (isNullish(unit) ? '' : unit) + '\u0000' + attrsKey;
}

/**
 * @param {number} value
 * @param {!Array<number>} bounds
 * @return {number}
 */
export function bucketIndexFor(value, bounds) {
  for (let i = 0; i < bounds.length; i++) {
    if (value <= bounds[i]) return i;
  }
  return bounds.length;
}

/**
 * @param {!Array<!Object>} metrics
 * @param {!Object} resourceAttributes
 * @param {string} scopeName
 * @param {string} scopeVersion
 * @return {!Object}
 */
export function buildOtlpMetricsPayload(metrics, resourceAttributes, scopeName, scopeVersion) {
  return {
    'resourceMetrics': [{
      'resource': {'attributes': toOtlpResourceKeyValueList(resourceAttributes)},
      'scopeMetrics': [{'scope': {'name': scopeName, 'version': scopeVersion}, 'metrics': metrics}],
    }],
  };
}

/**
 * @typedef {{bounds: !Array<number>, count: number, sum: number, min: number, max: number,
 *   bucketCounts: !Array<number>}}
 */
let HistogramState;

/**
 * @typedef {{name: string, type: string, unit: (string|undefined), attributes: (?Object|undefined),
 *   windowStartMs: number, total: (number|undefined), last: (number|undefined), hist: (?HistogramState|undefined)}}
 */
let SeriesState;

/**
 * Insertion-ordered string map (upstream uses `Map`).
 * @template V
 */
class OrderedMap {
  constructor() {
    /** @type {!Array<string>} */
    this.keys = [];
    /** @private {!Object<string, V>} */
    this.values_ = Object.create(null);
  }
  /** @return {number} */
  get size() {
    return this.keys.length;
  }
  /**
   * @param {string} key
   * @return {V|undefined}
   */
  get(key) {
    return this.values_[key];
  }
  /**
   * @param {string} key
   * @return {boolean}
   */
  has(key) {
    return key in this.values_;
  }
  /**
   * @param {string} key
   * @param {V} value
   */
  set(key, value) {
    if (!(key in this.values_)) this.keys.push(key);
    this.values_[key] = value;
  }
}

/**
 * What the aggregator needs from its host (upstream MetricsHost).
 * @record
 */
export class MetricsHost {
  constructor() {}
  /** @return {boolean} */
  optedOut() {}
  /**
   * @param {!Object} payload
   * @return {!Promise<!SendOutcome>}
   */
  sendMetricsBatch(payload) {}
  /** @return {string} */
  libraryId() {}
  /** @return {string} */
  libraryVersion() {}
}

/**
 * @param {?} bounds
 * @return {boolean}
 */
function isValidBounds(bounds) {
  if (!isArray(bounds) || bounds.length === 0) return false;
  for (let i = 0; i < bounds.length; i++) {
    if (!isFiniteNumber(bounds[i]) || (i > 0 && bounds[i] <= bounds[i - 1])) return false;
  }
  return true;
}

/**
 * @param {!Array<number>} a
 * @param {!Array<number>} b
 * @return {boolean}
 */
function sameBounds(a, b) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * @param {!Array<number>} bounds
 * @return {!HistogramState}
 */
function emptyHistogram(bounds) {
  const bucketCounts = [];
  for (let i = 0; i <= bounds.length; i++) bucketCounts.push(0);
  return {bounds: bounds, count: 0, sum: 0, min: Infinity, max: -Infinity, bucketCounts: bucketCounts};
}

/** Port of upstream core `PostHogMetrics` (browser host: never disabled). */
export class MetricsAggregator {
  /**
   * @param {!MetricsHost} host
   * @param {!ResolvedMetricsConfig} config
   * @param {!Logger} logger
   */
  constructor(host, config, logger) {
    /** @private @const */ this.host_ = host;
    /** @private @const */ this.config_ = config;
    /** @private @const */ this.logger_ = logger;
    /** @private {!OrderedMap<!SeriesState>} */ this.series_ = new OrderedMap();
    const self = this;
    /** @private @const */ this.flushTimer_ = new FlushTimer(function() {
      self.flush().then(undefined, function(e) {
        self.logger_.error('Metrics flush failed:', e);
      });
    });
    /** @private {?Promise<void>} */ this.flushPromise_ = null;
    /** @private {?Promise<void>} */ this.queuedFlush_ = null;
    /** @private */ this.seriesCapWarned_ = false;
    /** @private {!Object<string, string>} */ this.typeByName_ = Object.create(null);
    /** @private {!Object<string, boolean>} */ this.typeCollisionWarned_ = Object.create(null);
    /** @private {!OrderedMap<!Array<number>>} */ this.boundsByHistogram_ = new OrderedMap();
    /** @private {!Object<string, boolean>} */ this.boundsConflictWarned_ = Object.create(null);
    /** @private */ this.boundsCapWarned_ = false;
    /** @private */ this.consecutiveFlushFailures_ = 0;
    /** @private */ this.flushJitter_ = NO_JITTER;
    /** @private */ this.generation_ = 0;
  }

  /**
   * @param {string} name
   * @param {number=} value
   * @param {?Object=} options {'unit', 'attributes'}
   */
  count(name, value, options) {
    this.capture_({'name': name, 'type': 'count', 'value': value === undefined ? 1 : value,
      'unit': options ? options['unit'] : undefined, 'attributes': options ? options['attributes'] : undefined});
  }

  /**
   * @param {string} name
   * @param {number} value
   * @param {?Object=} options
   */
  gauge(name, value, options) {
    this.capture_({'name': name, 'type': 'gauge', 'value': value, 'unit': options ? options['unit'] : undefined,
      'attributes': options ? options['attributes'] : undefined});
  }

  /**
   * @param {string} name
   * @param {number} value
   * @param {?Object=} options {'unit', 'attributes', 'bounds'}
   */
  histogram(name, value, options) {
    const bounds = options ? options['bounds'] : undefined;
    this.capture_({'name': name, 'type': 'histogram', 'value': value, 'unit': options ? options['unit'] : undefined,
      'attributes': options ? options['attributes'] : undefined, 'bounds': isArray(bounds) ? bounds.slice() : bounds});
  }

  /**
   * Sends everything aggregated so far; flushes queue behind one another.
   * @return {!Promise<void>}
   */
  flush() {
    const prev = this.flushPromise_;
    const self = this;
    // Without a flush in flight the send starts synchronously, as upstream's async run() does.
    const run = prev ? prev.then(undefined, function() {}).then(function() {
      return self.doFlush_();
    }) : this.doFlush_();
    /** @type {?Promise<void>} */
    let p = null;
    const done = function() {
      if (self.flushPromise_ === p) self.flushPromise_ = null;
    };
    p = run.then(done, function(e) {
      done();
      throw e;
    });
    this.flushPromise_ = p;
    return p;
  }

  /**
   * Synchronously snapshots and resets the window (unload drain); null when empty.
   * @return {?Object}
   */
  drainWindow() {
    if (this.series_.size === 0) return null;
    const window = this.series_;
    this.startWindow_();
    return this.buildPayload_(window);
  }

  /** Clears the timer, drops the window and invalidates in-flight flushes. */
  reset() {
    this.generation_++;
    this.consecutiveFlushFailures_ = 0;
    this.flushJitter_ = NO_JITTER;
    this.flushTimer_.clear();
    this.flushPromise_ = null;
    this.queuedFlush_ = null;
    this.startWindow_();
    this.boundsByHistogram_ = new OrderedMap();
    this.boundsCapWarned_ = false;
  }

  /** @private */
  startWindow_() {
    this.series_ = new OrderedMap();
    this.seriesCapWarned_ = false;
    this.typeByName_ = Object.create(null);
    this.typeCollisionWarned_ = Object.create(null);
    this.boundsConflictWarned_ = Object.create(null);
  }

  /**
   * @param {!Object} sample MetricSample (quoted keys, passed to beforeSend)
   * @private
   */
  capture_(sample) {
    if (this.host_.optedOut()) return;
    const filtered = this.runBeforeSend_(sample);
    if (filtered === null) return;
    const name = filtered['name'];
    const type = filtered['type'];
    const value = filtered['value'];
    if (!name || typeof name !== 'string') {
      this.logger_.warn('Dropping metric with empty name');
      return;
    }
    if (typeof value !== 'number' || !isFinite(value)) {
      this.logger_.warn("Dropping metric '" + name + "': value must be a finite number");
      return;
    }
    if (type !== 'count' && type !== 'gauge' && type !== 'histogram') {
      this.logger_.warn("Dropping metric '" + name + "': unknown type '" + String(type) + "'");
      return;
    }
    if (type === 'count' && value < 0) {
      this.logger_.warn("Dropping count '" + name + "': counters are monotonic, value must be >= 0");
      return;
    }
    const unit = filtered['unit'];
    let attributes;
    let key;
    try {
      const attrs = filtered['attributes'];
      if (attrs) {
        attributes = {};
        for (const k in attrs) {
          if (Object.prototype.hasOwnProperty.call(attrs, k)) attributes[k] = attrs[k];
        }
      }
      key = seriesKey(type, name, unit, attributes);
    } catch (e) {
      this.logger_.warn("Dropping metric '" + name + "': attributes could not be serialized", e);
      return;
    }
    let state = this.series_.get(key);
    if (!state && !this.admitNewSeries_()) return;
    let bounds;
    if (type === 'histogram') {
      bounds = this.histogramBounds_(name, unit, filtered['bounds']);
      if (!bounds) return;
    }
    if (!state) {
      state = {name: name, type: type, unit: unit, attributes: attributes, windowStartMs: new Date().getTime(),
        total: undefined, last: undefined, hist: bounds ? emptyHistogram(bounds) : undefined};
      this.series_.set(key, state);
    }
    const seenType = this.typeByName_[name];
    if (seenType === undefined) {
      this.typeByName_[name] = type;
    } else if (seenType !== type && !this.typeCollisionWarned_[name]) {
      this.typeCollisionWarned_[name] = true;
      this.logger_.warn("Metric name '" + name + "' is already used as a " + seenType + '; recording it as a ' + type +
          ' too will blend both series in charts. Use a distinct name.');
    }
    this.fold_(state, value);
    this.armFlushTimer_();
  }

  /**
   * @return {boolean}
   * @private
   */
  admitNewSeries_() {
    if (this.series_.size < this.config_.maxSeriesPerFlush) return true;
    if (!this.seriesCapWarned_) {
      this.seriesCapWarned_ = true;
      this.logger_.warn('Metric series cap reached (' + this.config_.maxSeriesPerFlush + ' per flush window); ' +
          'dropping new series until the next flush. Reduce attribute cardinality.');
    }
    return false;
  }

  /**
   * @param {string} name
   * @param {string|undefined} unit
   * @param {*} requested
   * @return {!Array<number>|undefined}
   * @private
   */
  histogramBounds_(name, unit, requested) {
    if (requested !== undefined && !isValidBounds(requested)) {
      this.logger_.warn("Dropping histogram '" + name +
          "': bounds must be a non-empty array of finite, strictly increasing numbers");
      return undefined;
    }
    const req = /** @type {!Array<number>|undefined} */ (requested);
    const histogramKey = seriesKey('histogram', name, unit, undefined);
    const fixed = this.boundsByHistogram_.get(histogramKey);
    if (fixed) {
      if (!sameBounds(fixed, req || DEFAULT_HISTOGRAM_BOUNDS) && !this.boundsConflictWarned_[histogramKey]) {
        this.boundsConflictWarned_[histogramKey] = true;
        this.logger_.warn("Histogram '" + name + "' already uses the bounds [" + fixed.join(', ') + ']; ' +
            'samples that pass different bounds are recorded in those buckets.');
      }
      return fixed;
    }
    if (this.boundsByHistogram_.size >= this.config_.maxSeriesPerFlush) {
      if (!this.boundsCapWarned_) {
        this.boundsCapWarned_ = true;
        this.logger_.warn('Histogram bounds limit reached (' + this.config_.maxSeriesPerFlush + ' distinct histograms); ' +
            'new histograms that pass custom bounds are dropped. Reduce histogram name cardinality.');
      }
      if (req && !sameBounds(req, DEFAULT_HISTOGRAM_BOUNDS)) return undefined;
      return DEFAULT_HISTOGRAM_BOUNDS;
    }
    const bounds = req ? req.slice() : DEFAULT_HISTOGRAM_BOUNDS;
    this.boundsByHistogram_.set(histogramKey, bounds);
    return bounds;
  }

  /**
   * @param {!SeriesState} state
   * @param {number} value
   * @private
   */
  fold_(state, value) {
    if (state.type === 'count') {
      state.total = (state.total || 0) + value;
    } else if (state.type === 'gauge') {
      state.last = value;
    } else {
      const hist = /** @type {!HistogramState} */ (state.hist);
      hist.count += 1;
      hist.sum += value;
      hist.min = Math.min(hist.min, value);
      hist.max = Math.max(hist.max, value);
      hist.bucketCounts[bucketIndexFor(value, hist.bounds)] += 1;
    }
  }

  /**
   * @param {!Object} sample
   * @return {?Object}
   * @private
   */
  runBeforeSend_(sample) {
    const beforeSend = this.config_.beforeSend;
    if (!beforeSend) return sample;
    const fns = isArray(beforeSend) ? /** @type {!Array<?>} */ (beforeSend) : [beforeSend];
    let result = sample;
    for (let i = 0; i < fns.length; i++) {
      try {
        const next = fns[i](result);
        if (!next) {
          this.logger_.info('Metric was rejected in beforeSend function');
          return null;
        }
        result = next;
      } catch (e) {
        this.logger_.error('Error in beforeSend function for metric:', e);
        return null;
      }
    }
    return result;
  }

  /** @private */
  armFlushTimer_() {
    if (this.flushTimer_.pending) return;
    this.flushTimer_.arm(this.nextFlushDelay_());
  }

  /**
   * @return {number}
   * @private
   */
  nextFlushDelay_() {
    return backoffDelayMs(this.config_.flushIntervalMs, this.consecutiveFlushFailures_, this.flushJitter_,
        MAX_FLUSH_BACKOFF_MS);
  }

  /**
   * @return {!Promise<void>}
   * @private
   */
  doFlush_() {
    this.flushTimer_.clear();
    if (this.series_.size === 0) return Promise.resolve();
    const window = this.series_;
    this.startWindow_();
    const generation = this.generation_;
    const self = this;
    return this.host_.sendMetricsBatch(this.buildPayload_(window)).then(function(outcome) {
      if (generation !== self.generation_) return;
      if (outcome.kind === 'retry-later') {
        self.consecutiveFlushFailures_++;
        self.flushJitter_ = drawJitter();
      } else {
        self.consecutiveFlushFailures_ = 0;
        self.flushJitter_ = NO_JITTER;
      }
      if (self.flushTimer_.pending) self.flushTimer_.arm(self.nextFlushDelay_());
      if (outcome.kind === 'retry-later') {
        self.mergeWindowBack_(window);
        self.flushTimer_.armNoEarlierThan(self.nextFlushDelay_());
      } else if (outcome.kind === 'too-large') {
        self.logger_.warn('Metrics batch exceeded the server size limit and was dropped');
      } else if (outcome.kind === 'fatal') {
        self.logger_.error('Failed to send metrics batch:', outcome.error);
      }
    });
  }

  /**
   * @param {!OrderedMap<!SeriesState>} window
   * @return {!Object}
   * @private
   */
  buildPayload_(window) {
    const id = this.host_.libraryId();
    const version = this.host_.libraryVersion();
    return buildOtlpMetricsPayload(this.buildMetrics_(window), buildOtlpResourceAttributes(this.config_, id, version),
        id, version);
  }

  /**
   * One OTLP metric per (type, name, unit), one data point per attribute set.
   * @param {!OrderedMap<!SeriesState>} window
   * @return {!Array<!Object>}
   * @private
   */
  buildMetrics_(window) {
    const nowNano = msToUnixNano(new Date().getTime());
    /** @type {!OrderedMap<!Object>} */
    const byMetric = new OrderedMap();
    for (let i = 0; i < window.keys.length; i++) {
      const state = /** @type {!SeriesState} */ (window.get(window.keys[i]));
      const metricKey = seriesKey(state.type, state.name, state.unit, undefined);
      let metric = byMetric.get(metricKey);
      if (!metric) {
        metric = {'name': state.name};
        if (state.unit) metric['unit'] = state.unit;
        if (state.type === 'count') {
          metric['sum'] = {'aggregationTemporality': OTLP_TEMPORALITY_DELTA, 'isMonotonic': true, 'dataPoints': []};
        } else if (state.type === 'gauge') {
          metric['gauge'] = {'dataPoints': []};
        } else {
          metric['histogram'] = {'aggregationTemporality': OTLP_TEMPORALITY_DELTA, 'dataPoints': []};
        }
        byMetric.set(metricKey, metric);
      }
      const attributes = toOtlpKeyValueList(state.attributes || {}, this.logger_);
      const startNano = msToUnixNano(state.windowStartMs);
      if (state.type === 'count') {
        metric['sum']['dataPoints'].push({'attributes': attributes, 'startTimeUnixNano': startNano,
          'timeUnixNano': nowNano, 'asDouble': state.total || 0});
      } else if (state.type === 'gauge') {
        metric['gauge']['dataPoints'].push({'attributes': attributes, 'timeUnixNano': nowNano,
          'asDouble': isNullish(state.last) ? 0 : state.last});
      } else {
        const hist = /** @type {!HistogramState} */ (state.hist);
        metric['histogram']['dataPoints'].push({'attributes': attributes, 'startTimeUnixNano': startNano,
          'timeUnixNano': nowNano, 'count': hist.count, 'sum': hist.sum, 'min': hist.min, 'max': hist.max,
          'bucketCounts': hist.bucketCounts, 'explicitBounds': hist.bounds});
      }
    }
    return byMetric.keys.map(function(k) {
      return /** @type {!Object} */ (byMetric.get(k));
    });
  }

  /**
   * @param {!OrderedMap<!SeriesState>} window
   * @private
   */
  mergeWindowBack_(window) {
    for (let i = 0; i < window.keys.length; i++) {
      const key = window.keys[i];
      const old = /** @type {!SeriesState} */ (window.get(key));
      const current = this.series_.get(key);
      if (!current) {
        if (this.admitNewSeries_()) this.series_.set(key, old);
        continue;
      }
      current.windowStartMs = Math.min(current.windowStartMs, old.windowStartMs);
      if (current.type === 'count') {
        current.total = (current.total || 0) + (old.total || 0);
      } else if (current.type === 'histogram') {
        const hist = /** @type {!HistogramState} */ (current.hist);
        const oldHist = /** @type {!HistogramState} */ (old.hist);
        hist.count += oldHist.count;
        hist.sum += oldHist.sum;
        hist.min = Math.min(hist.min, oldHist.min);
        hist.max = Math.max(hist.max, oldHist.max);
        for (let j = 0; j < hist.bucketCounts.length; j++) hist.bucketCounts[j] += oldHist.bucketCounts[j];
      }
    }
  }
}
