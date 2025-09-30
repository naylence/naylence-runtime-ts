/**
 * Task utility functions and helpers
 */

import { SpawnedTask } from "./task-types.js";

/**
 * Wait for any task to complete (first to finish wins)
 */
export async function waitForAny<T>(tasks: SpawnedTask<T>[]): Promise<T> {
  if (tasks.length === 0) {
    throw new Error("Cannot wait for any of zero tasks");
  }

  return Promise.race(tasks.map((task) => task.promise));
}

/**
 * Wait for all tasks to complete
 */
export async function waitForAll<T>(tasks: SpawnedTask<T>[]): Promise<T[]> {
  return Promise.all(tasks.map((task) => task.promise));
}

/**
 * Wait for all tasks to settle (complete or fail)
 */
export async function waitForAllSettled<T>(
  tasks: SpawnedTask<T>[]
): Promise<PromiseSettledResult<T>[]> {
  return Promise.allSettled(tasks.map((task) => task.promise));
}

/**
 * Create a delay task (similar to asyncio.sleep)
 */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }

    const timeoutId = setTimeout(() => {
      resolve();
    }, ms);

    signal?.addEventListener("abort", () => {
      clearTimeout(timeoutId);
      reject(new Error("Aborted"));
    });
  });
}

/**
 * Create a task that times out after specified duration
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage?: string
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(timeoutMessage || `Operation timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }),
  ]);
}

/**
 * Retry a task with exponential backoff
 */
export async function retryWithBackoff<T>(
  taskFn: () => Promise<T>,
  options: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    backoffMultiplier?: number;
    signal?: AbortSignal;
  } = {}
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 100,
    maxDelayMs = 5000,
    backoffMultiplier = 2,
    signal,
  } = options;

  let lastError: Error;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) {
      throw new Error("Aborted");
    }

    try {
      return await taskFn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt === maxRetries) {
        throw lastError;
      }

      // Calculate delay with exponential backoff
      const delayMs = Math.min(baseDelayMs * Math.pow(backoffMultiplier, attempt), maxDelayMs);

      await delay(delayMs, signal);
    }
  }

  throw lastError!;
}

/**
 * Create a debounced task function
 */
export function debounce<T extends any[], R>(
  fn: (...args: T) => Promise<R>,
  delayMs: number
): (...args: T) => Promise<R> {
  let timeoutId: NodeJS.Timeout | number | undefined;
  let resolve: ((value: R) => void) | undefined;
  let reject: ((error: any) => void) | undefined;

  return (...args: T): Promise<R> => {
    return new Promise<R>((res, rej) => {
      // Clear previous timeout
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId as any);
      }

      resolve = res;
      reject = rej;

      timeoutId = setTimeout(async () => {
        try {
          const result = await fn(...args);
          resolve?.(result);
        } catch (error) {
          reject?.(error);
        }
      }, delayMs);
    });
  };
}

/**
 * Create a throttled task function
 */
export function throttle<T extends any[], R>(
  fn: (...args: T) => Promise<R>,
  intervalMs: number
): (...args: T) => Promise<R> {
  let lastExecuted = 0;
  let pendingPromise: Promise<R> | null = null;

  return (...args: T): Promise<R> => {
    const now = Date.now();
    const timeSinceLastExecution = now - lastExecuted;

    if (timeSinceLastExecution >= intervalMs && !pendingPromise) {
      lastExecuted = now;
      pendingPromise = fn(...args).finally(() => {
        pendingPromise = null;
      });
      return pendingPromise;
    }

    // Return existing promise if one is pending
    if (pendingPromise) {
      return pendingPromise;
    }

    // Schedule execution
    const delayMs = intervalMs - timeSinceLastExecution;
    return new Promise<R>((resolve, reject) => {
      setTimeout(async () => {
        try {
          lastExecuted = Date.now();
          const result = await fn(...args);
          resolve(result);
        } catch (error) {
          reject(error);
        }
      }, delayMs);
    });
  };
}
