/**
 * @fileoverview Console capture types and helpers shared by the logs extension
 * (its pre-load recorder) and the lazy part `logs` (console-logs.js); port of
 * browser-common logs-types.ts and utils/console-original.ts.
 */
import {LogSdkContext} from './logs-core.js';

/** @const {string} the lazy part (upstream kind) */
export const LOGS_KIND = 'logs';

/** The console methods recorded and captured, in upstream's order. */
/** @const {!Array<string>} */
export const BUFFERED_CONSOLE_LEVELS = ['debug', 'log', 'warn', 'error', 'info'];

/**
 * A console call recorded before capture took over (upstream BufferedConsoleEntry).
 * @typedef {{level: string, args: !Array<*>, occurredAtMs: number, context: !LogSdkContext}}
 */
export let BufferedConsoleEntry;

/**
 * Where captured console records go (upstream ConsoleLogsSink).
 * @record
 */
export class ConsoleLogsSink {
  constructor() {}
  /** @param {!Object} options */
  captureConsoleLog(options) {}
  /**
   * @param {!Object} options
   * @param {!LogSdkContext} context
   * @param {number} occurredAtMs
   */
  captureBufferedConsoleLog(options, context, occurredAtMs) {}
}

/**
 * @typedef {{console: !Object, hostname: string, getCapturingLogs: function(): ?ConsoleLogsSink}}
 */
export let ConsoleLogsHost;

/**
 * Walks `__rrweb_original__` markers to the real console method.
 * @param {*} method
 * @return {*}
 */
export function originalConsoleMethod(method) {
  while (method && method['__rrweb_original__']) method = method['__rrweb_original__'];
  return method;
}

/**
 * The lazy part (upstream `__PosthogExtensions__.logs`).
 * @record
 */
export class ConsoleLogsPart {
  constructor() {
    /** @type {function(!ConsoleLogsHost): function()} patches `console`, returns the dispose function */
    this.initializeLogs;
    /** @type {function(!ConsoleLogsHost, !Array<!BufferedConsoleEntry>)} */
    this.replayConsoleBuffer;
  }
}
