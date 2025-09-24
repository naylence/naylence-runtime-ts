/**
 * Cross-platform structured logging implementation
 * 
 * This module provides a unified logging interface that works in both Node.js and browser environments.
 * It includes structured logging with processors similar to Python's structlog.
 */

import { LogLevel, LogLevelNames, LogEntry, Logger, LogProcessor, LogTransport, isNode } from './logging-types.js';
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
    if (value === null || value === undefined || value === '' || 
        (Array.isArray(value) && value.length === 0) ||
        (typeof value === 'object' && value !== null && Object.keys(value).length === 0)) {
      delete result[key];
    }
  }
  
  return result;
};

export const stringifyNonPrimitives: LogProcessor = (entry: LogEntry): LogEntry => {
  const result: LogEntry = { ...entry };
  const primitives = ['string', 'number', 'boolean', 'undefined'];
  
  for (const [key, value] of Object.entries(result)) {
    if (value !== null && !primitives.includes(typeof value) && !Array.isArray(value)) {
      result[key] = String(value);
    }
  }
  
  return result;
};

// Default transports
export const consoleTransport: LogTransport = (entry: LogEntry): void => {
  const { level, event, timestamp, logger, level_name, ...extra } = entry;
  
  if (isNode) {
    // Node.js: Use structured JSON output
    console.log(JSON.stringify(entry, null, 0));
  } else {
    // Browser: Use pretty formatting with colors
    const color = getConsoleColor(level);
    const extraStr = Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : '';
    console.log(`%c${timestamp} [${level_name}] ${logger}: ${event}${extraStr}`, color);
  }
};

function getConsoleColor(level: LogLevel): string {
  switch (level) {
    case LogLevel.TRACE: return 'color: #888';
    case LogLevel.DEBUG: return 'color: #888';
    case LogLevel.INFO: return 'color: #000';
    case LogLevel.WARNING: return 'color: #ff8c00';
    case LogLevel.ERROR: return 'color: #ff0000';
    case LogLevel.CRITICAL: return 'color: #ff0000; font-weight: bold';
    default: return 'color: #000';
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
    case LogLevel.TRACE: return 'trace';
    case LogLevel.DEBUG: return 'debug';
    case LogLevel.INFO: return 'info';
    case LogLevel.WARNING: return 'warn';
    case LogLevel.ERROR: return 'error';
    case LogLevel.CRITICAL: return 'fatal';
    default: return 'info';
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
      const pino = require('pino');
      
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
          }
        }
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
const isTest = typeof process !== 'undefined' && 
               (process.env.NODE_ENV === 'test' ||
                process.env.JEST_WORKER_ID !== undefined ||
                typeof global !== 'undefined' && (global as any).expect !== undefined);

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

const defaultConfig: LoggerConfig = {
  level: isTest ? LogLevel.OFF : LogLevel.TRACE, // Silent during tests
  processors: [
    addTimestamp,
    addEnvelopeFields,
    dropEmpty,
    stringifyNonPrimitives,
    addLogLevel,
  ],
  transports: [consoleTransport], // Start with console, switch to Pino when available
};

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

  private log(level: LogLevel, event: string, extra: Record<string, any> = {}): void {
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
    return new FameLogger(this.name, this.config, { ...this.bindings, ...bindings });
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
const loggers = new Map<string, Logger>();

/**
 * Get a logger instance (similar to Python's getLogger)
 */
export function getLogger(name: string): Logger {
  if (!loggers.has(name)) {
    loggers.set(name, new FameLogger(name));
  }
  return loggers.get(name)!;
}

/**
 * Configure basic logging (similar to Python's basicConfig)
 */
export function basicConfig(options: {
  level?: LogLevel;
  format?: 'json' | 'pretty';
} = {}): void {
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
    (logger as FameLogger).setLevel(level);
  }
}

// Re-export log levels and types
export { LogLevel, LogLevelNames } from './logging-types.js';