/**
 * Cross-platform logging utilities for Naylence Fame
 *
 * This module provides structured logging that works in both Node.js and browser environments.
 * It mimics the functionality of the Python structlog-based logging system.
 */

// Log levels matching Python logging
export enum LogLevel {
  TRACE = 5,
  DEBUG = 10,
  INFO = 20,
  WARNING = 30,
  ERROR = 40,
  CRITICAL = 50,
  OFF = 100,
}

export const LogLevelNames: Record<LogLevel, string> = {
  [LogLevel.TRACE]: "TRACE",
  [LogLevel.DEBUG]: "DEBUG",
  [LogLevel.INFO]: "INFO",
  [LogLevel.WARNING]: "WARNING",
  [LogLevel.ERROR]: "ERROR",
  [LogLevel.CRITICAL]: "CRITICAL",
  [LogLevel.OFF]: "OFF",
};

// Environment detection
export const isNode = (() => {
  try {
    return (
      typeof globalThis !== "undefined" &&
      typeof (globalThis as any).process !== "undefined" &&
      (globalThis as any).process.versions?.node
    );
  } catch {
    return false;
  }
})();

export const isBrowser = !isNode;

// Base log entry structure
export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  logger: string;
  event: string;
  [key: string]: any;
}

// Envelope context for structured logging
export interface EnvelopeSnapshot {
  trace_id?: string;
  id?: string;
  flow_id?: string;
}

// Logger interface that works across platforms
export interface Logger {
  trace(event: string, ...args: any[]): void;
  trace(event: string, extra: Record<string, any>): void;
  debug(event: string, ...args: any[]): void;
  debug(event: string, extra: Record<string, any>): void;
  info(event: string, ...args: any[]): void;
  info(event: string, extra: Record<string, any>): void;
  warning(event: string, ...args: any[]): void;
  warning(event: string, extra: Record<string, any>): void;
  error(event: string, ...args: any[]): void;
  error(event: string, extra: Record<string, any>): void;
  critical(event: string, ...args: any[]): void;
  critical(event: string, extra: Record<string, any>): void;
  child(bindings: Record<string, any>): Logger;
  setLevel(level: LogLevel): void;
}

// Processor function type (similar to structlog processors)
export type LogProcessor = (entry: LogEntry) => LogEntry | null;

// Transport function type for outputting logs
export type LogTransport = (entry: LogEntry) => void;
