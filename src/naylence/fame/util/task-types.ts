/**
 * Cross-platform task spawning and management utilities
 *
 * This module provides functionality similar to Python's asyncio.Task and TaskSpawner,
 * adapted for JavaScript/TypeScript environments.
 */

export interface SpawnedTask<T = any> {
  readonly id: string;
  readonly name: string | undefined;
  readonly promise: Promise<T>;
  readonly abortController: AbortController;
  readonly startTime: number;
  cancel(): void;
  isCancelled(): boolean;
  isCompleted(): boolean;
  isFailed(): boolean;
}

export interface TaskSpawnerConfig {
  /** Maximum number of concurrent tasks (0 = unlimited) */
  maxConcurrent?: number;
  /** Default timeout for tasks in milliseconds */
  defaultTimeout?: number;
  /** Whether to automatically cleanup completed tasks */
  autoCleanup?: boolean;
}

export interface ShutdownOptions {
  /** How long to wait before cancelling tasks (ms) */
  gracePeriod?: number;
  /** Whether to cancel tasks that outlive grace period */
  cancelHanging?: boolean;
  /** Per-task timeout when awaiting cancelled tasks (ms) */
  joinTimeout?: number;
}

// Task states
export enum TaskState {
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

// Errors that can be thrown by tasks
export class TaskTimeoutError extends Error {
  constructor(taskName?: string, timeout?: number) {
    super(`Task ${taskName || 'unknown'} timed out after ${timeout}ms`);
    this.name = 'TaskTimeoutError';
  }
}

export class TaskCancelledError extends Error {
  constructor(taskName?: string) {
    super(`Task ${taskName || 'unknown'} was cancelled`);
    this.name = 'TaskCancelledError';
  }
}
