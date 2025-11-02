/**
 * Naylence Fame Utilities - Logging, Task Management & General Utilities Package
 *
 * Cross-platform structured logging, async task management, and general utilities for Naylence Fame runtime
 */

// Export the main logging API
export {
  getLogger,
  basicConfig,
  enableLogging,
  LogLevel,
  LogLevelNames,
  // Processors
  addTimestamp,
  addLogLevel,
  addEnvelopeFields,
  dropEmpty,
  stringifyNonPrimitives,
  // Transports
  consoleTransport,
  pinoTransport,
} from './logging.js';

// Export envelope context utilities
export {
  getCurrentEnvelope,
  currentTraceId,
  withEnvelopeContext,
  withEnvelopeContextAsync,
  EnvelopeContext,
} from './envelope-context.js';

// Export task management
export { TaskSpawner } from './task-spawner.js';

// Export locking utilities
export { AsyncLock, withLock } from './lock.js';

// Export task utilities
export {
  waitForAny,
  waitForAll,
  waitForAllSettled,
  delay,
  withTimeout,
  retryWithBackoff,
  debounce,
  throttle,
} from './task-utils.js';

// Export formatting utilities
export * from './formatter.js';

// Export metrics utilities
export * from './metrics-emitter.js';

// Export general utilities
export * from './util.js';
export * from './logicals.js';
export * from './ttl-validation.js';

export { normalizeEnvelopeSnapshot } from './logging-types.js';

// Export types
export type {
  Logger,
  LogEntry,
  LogProcessor,
  LogTransport,
  EnvelopeSnapshot,
  EnvelopeSnapshotInput,
} from './logging-types.js';

export type {
  SpawnedTask,
  TaskSpawnerConfig,
  ShutdownOptions,
  TaskState,
  TaskTimeoutError,
  TaskCancelledError,
} from './task-types.js';
