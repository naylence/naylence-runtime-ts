/**
 * TaskSpawner - Cross-platform async task management
 *
 * Provides functionality similar to Python's asyncio TaskSpawner with proper
 * error handling, cancellation, and graceful shutdown capabilities.
 */

import { getLogger } from './logging.js';
import {
  withEnvelopeContextAsync,
  getCurrentEnvelope,
} from './envelope-context.js';
import {
  SpawnedTask,
  TaskSpawnerConfig,
  ShutdownOptions,
  TaskState,
  TaskTimeoutError,
  TaskCancelledError,
} from './task-types.js';

const logger = getLogger('naylence.fame.util.task_spawner');

// Allow snake_case configuration inputs to match Python parity.
type TaskSpawnerConfigInput = TaskSpawnerConfig & {
  max_concurrent?: number | string;
  default_timeout?: number | string;
  auto_cleanup?: boolean | string;
};

type SpawnTaskOptions = {
  name?: string;
  task_name?: string;
  taskName?: string;
  timeout?: number | string;
  task_timeout?: number | string;
  taskTimeout?: number | string;
};

type ShutdownOptionsInput = ShutdownOptions & {
  grace_period?: number | string;
  gracePeriod?: number | string;
  cancel_hanging?: boolean | string;
  cancelHanging?: boolean | string;
  join_timeout?: number | string;
  joinTimeout?: number | string;
};

function firstDefined(
  source: Record<string, unknown>,
  keys: string[]
): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const value = source[key];
      if (value !== undefined) {
        return value;
      }
    }
  }
  return undefined;
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return undefined;
    }
    const parsed = Number(trimmed);
    if (!Number.isNaN(parsed) && Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function coerceBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized.length === 0) {
      return undefined;
    }
    if (['true', '1', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }
  return undefined;
}

function normalizeTaskSpawnerConfig(
  config: TaskSpawnerConfigInput = {}
): Required<TaskSpawnerConfig> {
  const source = config as Record<string, unknown>;

  const maxConcurrent =
    coerceNumber(firstDefined(source, ['maxConcurrent', 'max_concurrent'])) ??
    0;

  const defaultTimeout =
    coerceNumber(firstDefined(source, ['defaultTimeout', 'default_timeout'])) ??
    0;

  const autoCleanup =
    coerceBoolean(firstDefined(source, ['autoCleanup', 'auto_cleanup'])) ??
    true;

  return {
    maxConcurrent,
    defaultTimeout,
    autoCleanup,
  };
}

function normalizeSpawnOptions(options: SpawnTaskOptions = {}): {
  name?: string;
  timeout?: number;
} {
  const source = options as Record<string, unknown>;
  const nameRaw = firstDefined(source, ['name', 'task_name', 'taskName']);
  const timeoutRaw = firstDefined(source, [
    'timeout',
    'task_timeout',
    'taskTimeout',
  ]);

  const name = typeof nameRaw === 'string' ? nameRaw : undefined;
  const timeout = coerceNumber(timeoutRaw);

  return { name, timeout };
}

function normalizeShutdownOptions(
  options: ShutdownOptionsInput = {}
): Required<ShutdownOptions> {
  const source = options as Record<string, unknown>;

  const gracePeriod =
    coerceNumber(firstDefined(source, ['gracePeriod', 'grace_period'])) ?? 2000;
  const cancelHanging =
    coerceBoolean(firstDefined(source, ['cancelHanging', 'cancel_hanging'])) ??
    true;
  const joinTimeout =
    coerceNumber(firstDefined(source, ['joinTimeout', 'join_timeout'])) ?? 1000;

  return {
    gracePeriod,
    cancelHanging,
    joinTimeout,
  };
}

// Internal task implementation
class TaskImpl<T> implements SpawnedTask<T> {
  public readonly id: string;
  public readonly name: string;
  public readonly promise: Promise<T>;
  public readonly abortController: AbortController;
  public readonly startTime: number;

  private _state: TaskState = TaskState.RUNNING;
  private _result?: T;
  private _error?: Error;

  constructor(
    id: string,
    name: string | undefined,
    promise: Promise<T>,
    abortController: AbortController
  ) {
    this.id = id;
    this.name = name || `task-${id}`;
    this.abortController = abortController;
    this.startTime = Date.now();

    // Wrap the promise to track state changes
    this.promise = promise
      .then((result) => {
        this._state = TaskState.COMPLETED;
        this._result = result;
        return result;
      })
      .catch((error) => {
        if (
          error.name === 'AbortError' ||
          this.abortController.signal.aborted
        ) {
          this._state = TaskState.CANCELLED;
          throw new TaskCancelledError(this.name);
        } else {
          this._state = TaskState.FAILED;
          this._error = error;
          throw error;
        }
      });
  }

  cancel(): void {
    if (this._state === TaskState.RUNNING) {
      this.abortController.abort();
    }
  }

  isCancelled(): boolean {
    return this._state === TaskState.CANCELLED;
  }

  isCompleted(): boolean {
    return this._state === TaskState.COMPLETED;
  }

  isFailed(): boolean {
    return this._state === TaskState.FAILED;
  }

  getState(): TaskState {
    return this._state;
  }

  getResult(): T | undefined {
    return this._result;
  }

  getError(): Error | undefined {
    return this._error;
  }
}

export class TaskSpawner {
  private readonly _config: Required<TaskSpawnerConfig>;
  private readonly _tasks = new Map<string, TaskImpl<any>>();
  private _taskCounter = 0;
  private _lastSpawnerError: Error | null = null;
  private _suppressCompletionLogging = false;

  constructor(config: TaskSpawnerConfigInput = {}) {
    this._config = normalizeTaskSpawnerConfig(config);
  }

  /**
   * Spawn a new async task with proper error handling and context propagation
   */
  spawn<T>(
    taskFn: (signal?: AbortSignal) => Promise<T>,
    options: SpawnTaskOptions = {}
  ): SpawnedTask<T> {
    const normalizedOptions = normalizeSpawnOptions(options);
    // Reset logging suppression when new work is spawned. Any lingering
    // completion events from a previous shutdown will remain suppressed
    // until the corresponding tasks finish.
    this._suppressCompletionLogging = false;

    // Check concurrency limits
    if (
      this._config.maxConcurrent > 0 &&
      this._tasks.size >= this._config.maxConcurrent
    ) {
      throw new Error(
        `Task limit reached: ${this._config.maxConcurrent} concurrent tasks`
      );
    }

    const taskId = `task-${++this._taskCounter}`;
    const taskName = normalizedOptions.name || `unnamed-${taskId}`;
    const timeout = normalizedOptions.timeout ?? this._config.defaultTimeout;

    logger.debug('starting_background_task', {
      task_name: taskName,
      task_id: taskId,
    });

    // Create abort controller for cancellation
    const abortController = new AbortController();

    // Capture current envelope context
    const currentEnvelope = getCurrentEnvelope();

    // Create the task promise with context propagation
    const taskPromise = this._createTaskPromise(
      taskFn,
      abortController.signal,
      timeout,
      taskName,
      currentEnvelope
    );

    // Create task wrapper
    const task = new TaskImpl(taskId, taskName, taskPromise, abortController);
    this._tasks.set(taskId, task);

    // Set up completion handling
    task.promise
      .then(() => {
        if (!this._suppressCompletionLogging) {
          logger.debug('task_completed_successfully', {
            task_name: taskName,
            task_id: taskId,
            duration_ms: Date.now() - task.startTime,
          });
        }
      })
      .catch((error) => {
        this._handleTaskError(task, error);
      })
      .finally(() => {
        if (this._config.autoCleanup) {
          this._tasks.delete(taskId);
        }
      });

    return task;
  }

  /**
   * Create the actual task promise with all the wrapping logic
   */
  private async _createTaskPromise<T>(
    taskFn: (signal?: AbortSignal) => Promise<T>,
    signal: AbortSignal,
    timeout: number,
    taskName: string,
    envelopeContext: any
  ): Promise<T> {
    // Run the task with envelope context if available
    const runTask = envelopeContext
      ? () => withEnvelopeContextAsync(envelopeContext, () => taskFn(signal))
      : () => taskFn(signal);

    // Handle timeout if specified
    if (timeout > 0) {
      return Promise.race<T>([
        runTask(),
        this._createTimeoutPromise<T>(timeout, taskName),
      ]);
    }

    return runTask();
  }

  /**
   * Create a timeout promise that rejects after the specified time
   */
  private _createTimeoutPromise<T>(
    timeout: number,
    taskName: string
  ): Promise<T> {
    return new Promise<T>((_, reject) => {
      setTimeout(() => {
        reject(new TaskTimeoutError(taskName, timeout));
      }, timeout);
    });
  }

  /**
   * Handle task errors with proper logging and classification
   */
  private _handleTaskError(task: TaskImpl<any>, error: Error): void {
    const taskName = task.name || task.id;

    // Handle cancellation (including AbortError from AbortSignal)
    if (
      error instanceof TaskCancelledError ||
      error.name === 'AbortError' ||
      error.message === 'Task cancelled' ||
      error.message === 'Aborted'
    ) {
      logger.debug('task_cancelled', {
        task_name: taskName,
        note: 'Task cancelled as requested',
      });
      return;
    }

    // Handle timeout
    if (error instanceof TaskTimeoutError) {
      logger.warning('task_timed_out', {
        task_name: taskName,
        error: error.message,
      });
      if (this._lastSpawnerError === null) {
        this._lastSpawnerError = error;
      }
      return;
    }

    // Handle known WebSocket shutdown race condition (similar to Python version)
    if (
      error.message.includes("await wasn't used with future") ||
      error.message.includes('WebSocket closed during receive')
    ) {
      logger.debug('task_shutdown_race_condition_handled', {
        task_name: taskName,
        note: 'Normal WebSocket close timing during shutdown - not an error',
      });
      return;
    }

    // Handle transport close errors (similar to Python FameTransportClose)
    if (
      error.name === 'FameTransportClose' ||
      error.message.includes('normal closure') ||
      error.message.includes('Connection closed')
    ) {
      logger.debug('task_shutdown_completed_normally', {
        task_name: taskName,
        note: 'Task closed normally during shutdown',
      });
      return;
    }

    // All other exceptions are considered real failures
    logger.error('background_task_failed', {
      task_name: taskName,
      error: error.message,
      stack: error.stack,
    });

    if (this._lastSpawnerError === null) {
      this._lastSpawnerError = error;
    }
  }

  /**
   * Gracefully shutdown all spawned tasks
   *
   * This implementation mimics Python's asyncio.wait() behavior more closely
   * for better shutdown performance and responsiveness.
   */
  async shutdownTasks(options: ShutdownOptionsInput = {}): Promise<void> {
    const { gracePeriod, cancelHanging, joinTimeout } =
      normalizeShutdownOptions(options);

    if (this._tasks.size === 0) {
      logger.debug('shutdown_tasks_no_tasks_to_shutdown');
      return;
    }

    this._suppressCompletionLogging = true;

    logger.debug('shutting_down_tasks', {
      task_count: this._tasks.size,
      task_names: Array.from(this._tasks.values()).map((t) => t.name),
      grace_period_ms: gracePeriod,
    });

    const tasks = Array.from(this._tasks.values());

    // 1. Signal all tasks to stop immediately (abort signal)
    // This allows long-running loops to break out of waits/sleeps
    tasks.forEach((task) => task.cancel());

    // 2. Wait gracefully for tasks to complete their cleanup
    const completed = await this._waitWithGracePeriod(tasks, gracePeriod);

    // 3. Check for stragglers that didn't respond to cancellation
    if (cancelHanging) {
      const stillRunning = tasks.filter(
        (task) => task.getState() === TaskState.RUNNING && !completed.has(task)
      );

      if (stillRunning.length > 0) {
        logger.debug('tasks_did_not_complete_within_grace_period', {
          hanging_count: stillRunning.length,
        });

        // Wait for them to finish with individual timeouts
        await Promise.allSettled(
          stillRunning.map(async (task) => {
            try {
              await this._waitWithTimeout(task.promise, joinTimeout);
            } catch (error) {
              if (error instanceof TaskTimeoutError) {
                logger.warning('task_did_not_shutdown', {
                  task_name: task.name || task.id,
                  join_timeout_ms: joinTimeout,
                });
                // NOTE: This branch is defensively coded but effectively unreachable with the current
                // TaskImpl implementation. Any rejection after abort() is mapped to TaskCancelledError
                // because the catch wrapper checks the abort signal. We keep this logic in case that
                // implementation changes in future refactors.
              } else if (!(error instanceof TaskCancelledError)) {
                /* istanbul ignore next - unreachable defensive branch */
                logger.error('task_raised_during_cancellation', {
                  task_name: task.name || task.id,
                  error: error instanceof Error ? error.message : String(error),
                });
                /* istanbul ignore next */
                if (this._lastSpawnerError === null && error instanceof Error) {
                  this._lastSpawnerError = error;
                }
              }
            }
          })
        );
      }
    }

    // Clear all tasks after shutdown
    this._tasks.clear();
  }

  /**
   * Wait for tasks with grace period - similar to Python's asyncio.wait()
   * Returns immediately when grace period expires, unlike Promise.allSettled()
   */
  private async _waitWithGracePeriod(
    tasks: TaskImpl<any>[],
    gracePeriod: number
  ): Promise<Set<TaskImpl<any>>> {
    const completed = new Set<TaskImpl<any>>();
    const promises = tasks.map(async (task) => {
      try {
        await task.promise;
        completed.add(task);
      } catch {
        // Task failed or was cancelled - still consider it "completed"
        completed.add(task);
      }
    });

    // Race all tasks against the timeout
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<void>((resolve) => {
      timeoutId = setTimeout(resolve, gracePeriod);
    });

    try {
      await Promise.race([Promise.allSettled(promises), timeoutPromise]);
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }

    return completed;
  }

  /**
   * Wait for a promise with a timeout
   */
  private async _waitWithTimeout<T>(
    promise: Promise<T>,
    timeout: number
  ): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new TaskTimeoutError('shutdown-wait', timeout)),
        timeout
      );
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }

  /**
   * Get the last spawner error (helper for callers that want to bubble the error)
   */
  get lastSpawnerError(): Error | null {
    return this._lastSpawnerError;
  }

  /**
   * Get current task count
   */
  get taskCount(): number {
    return this._tasks.size;
  }

  /**
   * Get all active tasks
   */
  get activeTasks(): ReadonlyArray<SpawnedTask> {
    return Array.from(this._tasks.values());
  }

  /**
   * Get task by ID
   */
  getTask(id: string): SpawnedTask | undefined {
    return this._tasks.get(id);
  }

  /**
   * Cancel all tasks
   */
  cancelAllTasks(): void {
    this._tasks.forEach((task) => task.cancel());
  }
}
