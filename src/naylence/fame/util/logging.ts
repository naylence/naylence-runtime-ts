/**
 * Cross-platform structured logging implementation
 *
 * This module provides a unified logging interface that works in both Node.js and browser environments.
 * It includes structured logging with processors similar to Python's structlog.
 *
 * Environment Variables:
 * - FAME_LOG_LEVEL: Set the initial log level at framework initialization (Node.js only)
 *   Valid values: TRACE, DEBUG, INFO, WARNING, WARN, ERROR, CRITICAL
 *   Default: INFO (balanced verbosity), OFF during tests
 *
 * Usage:
 * ```typescript
 * // Automatic - just set the environment variable
 * // FAME_LOG_LEVEL=INFO node my-app.js
 *
 * // Or call enableLogging() to override at runtime
 * import { enableLogging, getLogger } from '@naylence/runtime';
 * enableLogging('DEBUG');
 *
 * const logger = getLogger('my.app');
 * logger.info('Application started');
 * ```
 */

import {
  LogLevel,
  LogLevelNames,
  LogEntry,
  Logger,
  LogProcessor,
  LogTransport,
  isNode,
} from './logging-types.js';
import type { FameEnvelope } from '@naylence/core';
import { getCurrentEnvelope } from './envelope-context.js';

// Default processors (similar to structlog processors)
export const addTimestamp: LogProcessor = (entry: LogEntry): LogEntry => {
  return {
    ...entry,
    timestamp: new Date().toISOString(),
  };
};

export const addLogLevel: LogProcessor = (entry: LogEntry): LogEntry => {
  return {
    ...entry,
    level_name: LogLevelNames[entry.level],
  };
};

export const addEnvelopeFields: LogProcessor = (entry: LogEntry): LogEntry => {
  const envelope = getCurrentEnvelope();
  if (!envelope) return entry;

  const updates: Record<string, any> = {};
  if (envelope.trace_id) updates.trace_id = envelope.trace_id;
  if (envelope.id) updates.ctx_envp_id = envelope.id;
  if (envelope.flow_id) updates.ctx_flow_id = envelope.flow_id;

  return { ...entry, ...updates };
};

export const dropEmpty: LogProcessor = (entry: LogEntry): LogEntry => {
  const result: LogEntry = { ...entry };

  // Remove empty values
  for (const [key, value] of Object.entries(result)) {
    if (
      value === null ||
      value === undefined ||
      value === '' ||
      (Array.isArray(value) && value.length === 0) ||
      (typeof value === 'object' &&
        value !== null &&
        Object.keys(value).length === 0)
    ) {
      delete result[key];
    }
  }

  return result;
};

export const stringifyNonPrimitives: LogProcessor = (
  entry: LogEntry
): LogEntry => {
  const result: LogEntry = { ...entry };
  const primitives = ['string', 'number', 'boolean', 'undefined'];

  for (const [key, value] of Object.entries(result)) {
    if (
      value !== null &&
      !primitives.includes(typeof value) &&
      !Array.isArray(value)
    ) {
      result[key] = String(value);
    }
  }

  return result;
};

const CORE_LOG_FIELDS = new Set([
  'timestamp',
  'level',
  'logger',
  'event',
  'level_name',
]);
const ANSI_RESET = '\u001B[0m';

function formatValueForConsole(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';

  if (typeof value === 'string') {
    return /[\s"=]/.test(value) ? JSON.stringify(value) : value;
  }

  if (
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean'
  ) {
    return String(value);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildConsoleParts(entry: LogEntry) {
  const timestamp = entry.timestamp ?? new Date().toISOString();
  const levelName =
    entry.level_name ?? LogLevelNames[entry.level] ?? String(entry.level);
  const loggerName = entry.logger ?? 'root';
  const event = entry.event ?? '';

  const extras: string[] = [];
  for (const [key, value] of Object.entries(entry)) {
    if (CORE_LOG_FIELDS.has(key)) continue;
    extras.push(`${key}=${formatValueForConsole(value)}`);
  }

  extras.sort((a, b) => a.localeCompare(b));

  return { timestamp, levelName, loggerName, event, extras };
}

function supportsAnsiColors(): boolean {
  if (!isNode) return false;
  if (typeof process === 'undefined') return false;
  const stdout = (process as any).stdout;
  return Boolean(stdout && typeof stdout.isTTY === 'boolean' && stdout.isTTY);
}

function getAnsiColor(level: LogLevel): string | null {
  switch (level) {
    case LogLevel.TRACE:
      return '\u001B[90m';
    case LogLevel.DEBUG:
      return '\u001B[36m';
    case LogLevel.INFO:
      return '\u001B[32m';
    case LogLevel.WARNING:
      return '\u001B[33m';
    case LogLevel.ERROR:
      return '\u001B[31m';
    case LogLevel.CRITICAL:
      return '\u001B[31m';
    default:
      return null;
  }
}

function formatNodeConsoleLine(entry: LogEntry): string {
  const { timestamp, levelName, loggerName, event, extras } =
    buildConsoleParts(entry);
  const shouldColorize = supportsAnsiColors() && !isTest;
  const paddedLevel = levelName.toUpperCase().padEnd(7, ' ');
  const color = shouldColorize ? getAnsiColor(entry.level) : null;
  const levelSegment = color
    ? `${color}${paddedLevel}${ANSI_RESET}`
    : paddedLevel;
  const extrasJoined = extras.join(' ');
  const eventSegment = event ? ` | ${event}` : '';
  const extrasSegment = extrasJoined
    ? event
      ? ` ${extrasJoined}`
      : ` | ${extrasJoined}`
    : '';
  return `${timestamp} | ${levelSegment} | ${loggerName}${eventSegment}${extrasSegment}`.trimEnd();
}

function formatBrowserConsoleLine(entry: LogEntry): {
  message: string;
  styles: string[];
} {
  const { timestamp, levelName, loggerName, event, extras } =
    buildConsoleParts(entry);
  const color = getConsoleColor(entry.level);
  const extrasJoined = extras.join(' ');
  const eventSegment = event ? ` | ${event}` : '';
  const extrasSegment = extrasJoined
    ? event
      ? ` ${extrasJoined}`
      : ` | ${extrasJoined}`
    : '';
  const message = `%c${timestamp} | ${levelName.toUpperCase()} | ${loggerName}${eventSegment}${extrasSegment}`;
  return { message, styles: [color] };
}

// Default transports
export const consoleTransport: LogTransport = (entry: LogEntry): void => {
  if (isNode) {
    console.log(formatNodeConsoleLine(entry));
  } else {
    const { message, styles } = formatBrowserConsoleLine(entry);
    console.log(message, ...styles);
  }
};

function getConsoleColor(level: LogLevel): string {
  switch (level) {
    case LogLevel.TRACE:
      return 'color: #9AA0A6';
    case LogLevel.DEBUG:
      return 'color: #50B5FF';
    case LogLevel.INFO:
      return 'color: #2E7D32; font-weight: 600';
    case LogLevel.WARNING:
      return 'color: #F9AB00; font-weight: 600';
    case LogLevel.ERROR:
      return 'color: #E53935; font-weight: 600';
    case LogLevel.CRITICAL:
      return 'color: #B71C1C; font-weight: 700; text-decoration: underline';
    default:
      return 'color: #37474F';
  }
}

// Node.js-specific Pino transport (when available)
let pinoLogger: any = null;
export const pinoTransport: LogTransport = (entry: LogEntry): void => {
  if (!isNode || !pinoLogger) {
    // Fall back to console if Pino isn't available
    consoleTransport(entry);
    return;
  }

  const { level, event, ...extra } = entry;
  const pinoLevel = getPinoLevel(level);
  pinoLogger[pinoLevel](extra, event);
};

function getPinoLevel(level: LogLevel): string {
  switch (level) {
    case LogLevel.TRACE:
      return 'trace';
    case LogLevel.DEBUG:
      return 'debug';
    case LogLevel.INFO:
      return 'info';
    case LogLevel.WARNING:
      return 'warn';
    case LogLevel.ERROR:
      return 'error';
    case LogLevel.CRITICAL:
      return 'fatal';
    default:
      return 'info';
  }
}

// Initialize Pino if available (Node.js only)
function initializePino(): void {
  if (!isNode || pinoLogger) return;

  if (isTest) {
    // Don't initialize Pino in tests to avoid worker threads
    return;
  }

  try {
    // Try to require pino synchronously - this will only work in Node.js
    if (typeof require !== 'undefined') {
      const moduleSpecifier = String.fromCharCode(112, 105, 110, 111);
      const pino = require(moduleSpecifier);

      // Use pretty transport for development
      pinoLogger = pino({
        level: 'trace',
        customLevels: { trace: 5 },
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'yyyy-mm-dd HH:MM:ss',
            ignore: 'pid,hostname',
          },
        },
      });

      // Switch default transport to Pino now that it's available
      defaultConfig.transports = [pinoTransport];
    }
  } catch {
    // Pino not available, fall back to console
    pinoLogger = null;
  }
}

// Detect test environment for quieter logging
const isTest =
  typeof process !== 'undefined' &&
  (process.env.NODE_ENV === 'test' ||
    process.env.JEST_WORKER_ID !== undefined ||
    (typeof global !== 'undefined' && (global as any).expect !== undefined));

// Initialize Pino immediately in Node.js environments
if (isNode) {
  initializePino();
}

// Main logger configuration
export interface LoggerConfig {
  level: LogLevel;
  processors: LogProcessor[];
  transports: LogTransport[];
}

/**
 * Get initial log level from environment variable or defaults
 */
function getInitialLogLevel(): LogLevel {
  // Tests should be silent
  if (isTest) {
    return LogLevel.OFF;
  }

  // Check FAME_LOG_LEVEL environment variable
  let envLevel: string | undefined;

  if (isNode && typeof process !== 'undefined') {
    envLevel = process.env.FAME_LOG_LEVEL;
  } else if (typeof window !== 'undefined' && (window as any).__ENV__) {
    envLevel = (window as any).__ENV__.FAME_LOG_LEVEL;
  }

  if (envLevel) {
    try {
      const normalized = envLevel.trim().toUpperCase();
      // Direct enum name match (e.g., "DEBUG", "INFO")
      if (normalized in LogLevel) {
        return LogLevel[normalized as keyof typeof LogLevel];
      }
      // Try alternative mappings
      if (normalized === 'WARN') return LogLevel.WARNING;
    } catch {
      // Fall through to default
    }
  }

  // Default to INFO - balanced verbosity for most use cases
  return LogLevel.INFO;
}

const defaultConfig: LoggerConfig = {
  level: getInitialLogLevel(),
  processors: [
    addTimestamp,
    addEnvelopeFields,
    dropEmpty,
    stringifyNonPrimitives,
    addLogLevel,
  ],
  transports: [consoleTransport], // Start with console, switch to Pino when available
};

const logLevelValues = new Set<number>();
const logLevelNameLookup = new Map<string, LogLevel>();

for (const value of Object.values(LogLevel)) {
  if (typeof value === 'number') {
    logLevelValues.add(value);
    const name = LogLevelNames[value as LogLevel];
    if (name) {
      logLevelNameLookup.set(name.toUpperCase(), value as LogLevel);
    }
  }
}

// Logger implementation
class FameLogger implements Logger {
  private config: LoggerConfig;
  private bindings: Record<string, any>;

  constructor(
    private name: string,
    config: Partial<LoggerConfig> = {},
    bindings: Record<string, any> = {}
  ) {
    this.config = { ...defaultConfig, ...config };
    this.bindings = bindings;
  }

  private log(
    level: LogLevel,
    event: string,
    extra: Record<string, any> = {}
  ): void {
    if (level < this.config.level) return;

    let entry: LogEntry = {
      timestamp: '',
      level,
      logger: this.name,
      event,
      ...this.bindings,
      ...extra,
    };

    // Apply processors
    for (const processor of this.config.processors) {
      const processed = processor(entry);
      if (processed === null) return; // Processor filtered out the entry
      entry = processed;
    }

    // Send to transports
    for (const transport of this.config.transports) {
      transport(entry);
    }
  }

  trace(event: string, ...args: any[]): void {
    const extra = this.parseArgs(args);
    this.log(LogLevel.TRACE, event, extra);
  }

  debug(event: string, ...args: any[]): void {
    const extra = this.parseArgs(args);
    this.log(LogLevel.DEBUG, event, extra);
  }

  info(event: string, ...args: any[]): void {
    const extra = this.parseArgs(args);
    this.log(LogLevel.INFO, event, extra);
  }

  warning(event: string, ...args: any[]): void {
    const extra = this.parseArgs(args);
    this.log(LogLevel.WARNING, event, extra);
  }

  error(event: string, ...args: any[]): void {
    const extra = this.parseArgs(args);
    this.log(LogLevel.ERROR, event, extra);
  }

  critical(event: string, ...args: any[]): void {
    const extra = this.parseArgs(args);
    this.log(LogLevel.CRITICAL, event, extra);
  }

  child(bindings: Record<string, any>): Logger {
    return new FameLogger(this.name, this.config, {
      ...this.bindings,
      ...bindings,
    });
  }

  setLevel(level: LogLevel): void {
    this.config.level = level;
  }

  private parseArgs(args: any[]): Record<string, any> {
    if (args.length === 0) return {};
    if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
      return args[0];
    }
    // Convert positional args to numbered keys
    const result: Record<string, any> = {};
    args.forEach((arg, index) => {
      result[`arg${index}`] = arg;
    });
    return result;
  }
}

// Global logger registry
const loggers = new Map<string, FameLogger>();
let naylenceLogLevelOverride: LogLevel | null = null;

function isNaylenceLogger(name: string): boolean {
  return name === 'naylence' || name.startsWith('naylence.');
}

function normalizeLogLevel(level: LogLevel | string | number): LogLevel {
  if (typeof level === 'number') {
    if (logLevelValues.has(level)) {
      return level as LogLevel;
    }
  } else {
    const key = level.toString().toUpperCase();
    const resolved = logLevelNameLookup.get(key);
    if (resolved !== undefined) {
      return resolved;
    }
  }

  throw new Error(`Unknown log level: ${level}`);
}

/**
 * Get a logger instance (similar to Python's getLogger)
 */
export function getLogger(name: string): Logger {
  if (!loggers.has(name)) {
    const config: Partial<LoggerConfig> = {};
    if (naylenceLogLevelOverride !== null && isNaylenceLogger(name)) {
      config.level = naylenceLogLevelOverride;
    }
    loggers.set(name, new FameLogger(name, config));
  }
  return loggers.get(name)!;
}

/**
 * Configure basic logging (similar to Python's basicConfig)
 */
export function basicConfig(
  options: {
    level?: LogLevel;
    format?: 'json' | 'pretty';
  } = {}
): void {
  const level = options.level ?? LogLevel.TRACE;
  const useJson = options.format === 'json';

  const transport: LogTransport = useJson
    ? (entry) => console.log(JSON.stringify(entry))
    : consoleTransport;

  // Update default config
  defaultConfig.level = level;
  defaultConfig.transports = [transport];

  // Update existing loggers
  for (const logger of loggers.values()) {
    logger.setLevel(level);
  }
}

export function enableLogging(level: LogLevel | string | number): void {
  const resolvedLevel = normalizeLogLevel(level);

  basicConfig({ level: LogLevel.WARNING });

  naylenceLogLevelOverride = resolvedLevel;

  for (const [name, logger] of loggers.entries()) {
    if (isNaylenceLogger(name)) {
      logger.setLevel(resolvedLevel);
    }
  }
}

export function summarizeEnvelope(
  envelope: FameEnvelope | null | undefined,
  prefix: string = 'child_'
): Record<string, unknown> {
  if (!envelope) {
    return {};
  }

  const safePrefix = prefix ?? '';

  return {
    [`${safePrefix}envp_id`]: envelope.id ?? null,
    [`${safePrefix}sid`]: envelope.sid ? `${String(envelope.sid)}…` : null,
    [`${safePrefix}to`]: envelope.to ? String(envelope.to) : null,
    [`${safePrefix}trace_id`]: envelope.traceId ?? null,
    [`${safePrefix}frame`]:
      envelope.frame && typeof envelope.frame === 'object'
        ? ((envelope.frame as { type?: unknown }).type ??
          envelope.frame.constructor?.name ??
          'Unknown')
        : null,
    [`${safePrefix}corr_id`]: envelope.corrId ?? null,
  };
}

// Re-export log levels and types
export { LogLevel, LogLevelNames } from './logging-types.js';
