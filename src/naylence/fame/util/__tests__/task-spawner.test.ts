/**
 * Tests for TaskSpawner functionality
 */

import { TaskSpawner } from "../task-spawner.js";
import { TaskTimeoutError, TaskCancelledError } from "../task-types.js";
import { delay, waitForAll, waitForAny, retryWithBackoff } from "../task-utils.js";

describe("TaskSpawner", () => {
  let spawner: TaskSpawner;

  beforeEach(() => {
    spawner = new TaskSpawner();
  });

  afterEach(async () => {
    await spawner.shutdownTasks({ gracePeriod: 100, joinTimeout: 100 });
  });

  describe("Basic Task Spawning", () => {
    test("should spawn and complete a simple task", async () => {
      const task = spawner.spawn(
        async () => {
          await delay(10);
          return "success";
        },
        { name: "simple-task" }
      );

      expect(task.name).toBe("simple-task");
      expect(task.isCompleted()).toBe(false);
      expect(task.isCancelled()).toBe(false);
      expect(task.isFailed()).toBe(false);

      const result = await task.promise;
      expect(result).toBe("success");
      expect(task.isCompleted()).toBe(true);
    });

    test("should handle task failures", async () => {
      const task = spawner.spawn(
        async () => {
          throw new Error("Task failed");
        },
        { name: "failing-task" }
      );

      await expect(task.promise).rejects.toThrow("Task failed");
      expect(task.isFailed()).toBe(true);
    });

    test("should support task cancellation", async () => {
      const task = spawner.spawn(
        async (signal) => {
          await delay(1000, signal);
          return "should not complete";
        },
        { name: "cancellable-task" }
      );

      expect(task.isCancelled()).toBe(false);

      // Cancel after a short delay
      setTimeout(() => task.cancel(), 10);

      await expect(task.promise).rejects.toThrow(TaskCancelledError);
      expect(task.isCancelled()).toBe(true);
    });

    test("should handle task timeouts", async () => {
      const task = spawner.spawn(
        async () => {
          await delay(200);
          return "should timeout";
        },
        {
          name: "timeout-task",
          timeout: 50,
        }
      );

      await expect(task.promise).rejects.toThrow(TaskTimeoutError);
    });
  });

  describe("Task Management", () => {
    test("should track multiple tasks", async () => {
      const task1 = spawner.spawn(async () => delay(10), { name: "task1" });
      const task2 = spawner.spawn(async () => delay(20), { name: "task2" });
      const task3 = spawner.spawn(async () => delay(30), { name: "task3" });

      expect(spawner.taskCount).toBe(3);
      expect(spawner.activeTasks).toHaveLength(3);

      await Promise.all([task1.promise, task2.promise, task3.promise]);

      // With autoCleanup enabled, tasks should be cleaned up
      await delay(10); // Allow cleanup to happen
      expect(spawner.taskCount).toBe(0);
    });

    test("should respect concurrency limits", () => {
      const limitedSpawner = new TaskSpawner({ maxConcurrent: 2 });

      limitedSpawner.spawn(async () => delay(100), { name: "task1" });
      limitedSpawner.spawn(async () => delay(100), { name: "task2" });

      expect(() => {
        limitedSpawner.spawn(async () => delay(100), { name: "task3" });
      }).toThrow("Task limit reached");
    });

    test("should find tasks by ID", () => {
      const task = spawner.spawn(async () => delay(10), { name: "findable-task" });

      const foundTask = spawner.getTask(task.id);
      expect(foundTask).toBe(task);
      expect(foundTask?.name).toBe("findable-task");
    });

    test("should cancel all tasks", async () => {
      const task1 = spawner.spawn(async (signal) => delay(1000, signal), { name: "task1" });
      const task2 = spawner.spawn(async (signal) => delay(1000, signal), { name: "task2" });

      spawner.cancelAllTasks();

      await expect(task1.promise).rejects.toThrow(TaskCancelledError);
      await expect(task2.promise).rejects.toThrow(TaskCancelledError);
    });

    test("should spawn tasks without explicit names", async () => {
      const task = spawner.spawn(async () => {
        await delay(10);
        return "no-name-result";
      }); // No name provided

      expect(task.name).toMatch(/^unnamed-task-\d+$/);
      const result = await task.promise;
      expect(result).toBe("no-name-result");
    });

    test("should disable autoCleanup when configured", async () => {
      const noCleanupSpawner = new TaskSpawner({ autoCleanup: false });

      const task = noCleanupSpawner.spawn(
        async () => {
          await delay(10);
          return "result";
        },
        { name: "no-cleanup-task" }
      );

      await task.promise;

      // With autoCleanup disabled, task should remain in the spawner
      expect(noCleanupSpawner.taskCount).toBe(1);
      expect(noCleanupSpawner.getTask(task.id)).toBe(task);

      // Clean up manually
      await noCleanupSpawner.shutdownTasks();
    });

    test("should provide task result and error getters", async () => {
      // Test successful task with result getter
      const successTask = spawner.spawn(
        async () => {
          await delay(10);
          return "success-result";
        },
        { name: "success-task" }
      );

      expect(successTask.isCompleted()).toBe(false);
      expect(successTask.isFailed()).toBe(false);

      // Access private methods using type assertion
      const successTaskImpl = successTask as any;
      expect(successTaskImpl.getResult()).toBeUndefined();
      expect(successTaskImpl.getError()).toBeUndefined();

      const result = await successTask.promise;
      expect(result).toBe("success-result");
      expect(successTask.isCompleted()).toBe(true);
      expect(successTask.isFailed()).toBe(false);
      expect(successTaskImpl.getResult()).toBe("success-result");
      expect(successTaskImpl.getError()).toBeUndefined();

      // Test failed task with error getter
      const failedTask = spawner.spawn(
        async () => {
          await delay(10);
          throw new Error("test-error");
        },
        { name: "failed-task" }
      );

      expect(failedTask.isCompleted()).toBe(false);
      expect(failedTask.isFailed()).toBe(false);

      const failedTaskImpl = failedTask as any;
      expect(failedTaskImpl.getResult()).toBeUndefined();
      expect(failedTaskImpl.getError()).toBeUndefined();

      await expect(failedTask.promise).rejects.toThrow("test-error");
      expect(failedTask.isCompleted()).toBe(false);
      expect(failedTask.isFailed()).toBe(true);
      expect(failedTaskImpl.getResult()).toBeUndefined();
      expect(failedTaskImpl.getError()).toBeTruthy();
      expect(failedTaskImpl.getError()?.message).toBe("test-error");
    });
  });

  describe("Graceful Shutdown", () => {
    test("should wait for tasks to complete during shutdown", async () => {
      const results: string[] = [];

      spawner.spawn(
        async () => {
          await delay(50);
          results.push("task1");
        },
        { name: "task1" }
      );

      spawner.spawn(
        async () => {
          await delay(100);
          results.push("task2");
        },
        { name: "task2" }
      );

      await spawner.shutdownTasks({ gracePeriod: 200 });

      expect(results).toEqual(["task1", "task2"]);
      expect(spawner.taskCount).toBe(0);
    });

    test("should cancel hanging tasks after grace period", async () => {
      const results: string[] = [];

      spawner.spawn(
        async (signal) => {
          await delay(1000, signal); // This will be cancelled
          results.push("should not appear");
        },
        { name: "hanging-task" }
      );

      await spawner.shutdownTasks({
        gracePeriod: 50,
        cancelHanging: true,
        joinTimeout: 100,
      });

      expect(results).toEqual([]);
      expect(spawner.taskCount).toBe(0);
    });

    test("should handle tasks that do not shutdown within join timeout", async () => {
      // Create a task that will ignore cancellation signal
      spawner.spawn(
        async () => {
          // This task ignores the abort signal and will timeout during shutdown
          await delay(500); // Longer than joinTimeout
          return "stubborn task";
        },
        { name: "stubborn-task" }
      );

      // Should handle timeout gracefully
      await spawner.shutdownTasks({
        gracePeriod: 50, // Short grace period
        cancelHanging: true,
        joinTimeout: 100, // Short join timeout to trigger the timeout scenario
      });

      expect(spawner.taskCount).toBe(0);
    });

    test("should capture non-cancellation errors in lastSpawnerError during shutdown", async () => {
      // Create a task that will fail during shutdown with a non-cancellation error
      const networkError = new Error("Connection timeout during shutdown");

      spawner.spawn(
        async () => {
          // Simulate a task that fails with a non-AbortError during execution
          await delay(100); // Let the task start
          throw networkError; // This error should pass through to _handleTaskError
        },
        { name: "network-task" }
      );

      expect(spawner.lastSpawnerError).toBeNull();

      // Let the task fail naturally, then shutdown
      await delay(150); // Wait for the task to fail

      await spawner.shutdownTasks({
        gracePeriod: 50,
        cancelHanging: true,
        joinTimeout: 100,
      });

      expect(spawner.taskCount).toBe(0);

      // The network error should be captured since it's not a cancellation error
      expect(spawner.lastSpawnerError).toBeTruthy();
      expect(spawner.lastSpawnerError?.message).toBe("Connection timeout during shutdown");
    });

    test("should respect cancelHanging=false during shutdown", async () => {
      const results: string[] = [];

      spawner.spawn(
        async () => {
          await delay(500); // Long-running task
          results.push("long-task-completed");
          return "completed";
        },
        { name: "long-task" }
      );

      // Shutdown without cancelling hanging tasks
      await spawner.shutdownTasks({
        gracePeriod: 50, // Short grace period
        cancelHanging: false, // Don't cancel hanging tasks
        joinTimeout: 100,
      });

      // The task should have been allowed to continue and complete
      await delay(600); // Wait for the task to complete naturally
      expect(results).toEqual(["long-task-completed"]);
      expect(spawner.taskCount).toBe(0);
    });

    test("should handle empty stillRunning tasks during shutdown", async () => {
      // Create tasks that complete quickly within grace period
      const results: string[] = [];

      spawner.spawn(
        async () => {
          await delay(30); // Shorter than grace period
          results.push("quick-task-1");
        },
        { name: "quick-1" }
      );

      spawner.spawn(
        async () => {
          await delay(40); // Shorter than grace period
          results.push("quick-task-2");
        },
        { name: "quick-2" }
      );

      await spawner.shutdownTasks({
        gracePeriod: 100, // Long enough for tasks to complete
        cancelHanging: true,
        joinTimeout: 50,
      });

      // All tasks should complete within grace period, so stillRunning.length === 0
      expect(results).toEqual(["quick-task-1", "quick-task-2"]);
      expect(spawner.taskCount).toBe(0);
    });
  });

  describe("Error Handling", () => {
    test("should track last spawner error", async () => {
      expect(spawner.lastSpawnerError).toBeNull();

      const task = spawner.spawn(async () => {
        throw new Error("Test error");
      });

      await expect(task.promise).rejects.toThrow("Test error");

      // Give some time for error handling
      await delay(10);

      expect(spawner.lastSpawnerError).toBeTruthy();
      expect(spawner.lastSpawnerError?.message).toBe("Test error");
    });

    test("should handle AbortSignal properly", async () => {
      const task = spawner.spawn(async (signal) => {
        // Simulate checking abort signal
        await delay(10);
        if (signal?.aborted) {
          throw new Error("Aborted");
        }
        await delay(100);
        return "completed";
      });

      task.cancel();

      await expect(task.promise).rejects.toThrow();
      expect(task.isCancelled()).toBe(true);
    });

    test('should treat explicit "Task cancelled" message as cancellation', async () => {
      const task = spawner.spawn(
        async () => {
          await delay(10);
          throw new Error("Task cancelled");
        },
        { name: "explicit-task-cancelled-msg" }
      );

      await expect(task.promise).rejects.toThrow("Task cancelled");
      // Allow handler to run
      await delay(5);
      // Should not record as lastSpawnerError
      expect(spawner.lastSpawnerError).toBeNull();
    });

    test('should treat explicit "Aborted" message as cancellation', async () => {
      const task = spawner.spawn(
        async () => {
          await delay(10);
          throw new Error("Aborted");
        },
        { name: "explicit-aborted-msg" }
      );

      await expect(task.promise).rejects.toThrow("Aborted");
      await delay(5);
      expect(spawner.lastSpawnerError).toBeNull();
    });

    test("should classify native AbortError by name", async () => {
      const task = spawner.spawn(
        async () => {
          await delay(5);
          const abortErr = new Error("Simulated abort");
          (abortErr as any).name = "AbortError";
          throw abortErr;
        },
        { name: "aborterror-by-name" }
      );

      await expect(task.promise).rejects.toThrow(TaskCancelledError);
      await delay(5);
      expect(spawner.lastSpawnerError).toBeNull();
    });

    test("should propagate envelope context to spawned tasks", async () => {
      // Mock getCurrentEnvelope to return a test context
      const mockEnvelope = { test: "context", id: "test-123" };
      const getCurrentEnvelopeSpy = jest
        .spyOn(require("../envelope-context"), "getCurrentEnvelope")
        .mockReturnValue(mockEnvelope);

      // Mock withEnvelopeContextAsync to verify it gets called with the right context
      const withEnvelopeContextAsyncSpy = jest
        .spyOn(require("../envelope-context"), "withEnvelopeContextAsync")
        .mockImplementation((...args: any[]) => {
          const [_context, fn] = args;
          return fn();
        });

      const task = spawner.spawn(
        async () => {
          return "success with context";
        },
        { name: "context-task" }
      );

      const result = await task.promise;

      expect(result).toBe("success with context");
      expect(getCurrentEnvelopeSpy).toHaveBeenCalled();
      expect(withEnvelopeContextAsyncSpy).toHaveBeenCalledWith(mockEnvelope, expect.any(Function));

      // Cleanup
      getCurrentEnvelopeSpy.mockRestore();
      withEnvelopeContextAsyncSpy.mockRestore();
    });

    test("should handle WebSocket shutdown race condition errors", async () => {
      const task = spawner.spawn(
        async () => {
          throw new Error("await wasn't used with future");
        },
        { name: "websocket-race-task" }
      );

      // The error should be caught and handled gracefully (no throw)
      await expect(task.promise).rejects.toThrow("await wasn't used with future");
      expect(task.isFailed()).toBe(true);

      // Should not set lastSpawnerError for this type of error
      await delay(10);
      expect(spawner.lastSpawnerError).toBeNull();
    });

    test("should handle WebSocket close during receive errors", async () => {
      const task = spawner.spawn(
        async () => {
          throw new Error("WebSocket closed during receive");
        },
        { name: "websocket-close-task" }
      );

      await expect(task.promise).rejects.toThrow("WebSocket closed during receive");
      expect(task.isFailed()).toBe(true);

      // Should not set lastSpawnerError for this type of error
      await delay(10);
      expect(spawner.lastSpawnerError).toBeNull();
    });

    test("should handle transport close errors", async () => {
      const fameTransportError = new Error("Connection lost");
      fameTransportError.name = "FameTransportClose";

      const task = spawner.spawn(
        async () => {
          throw fameTransportError;
        },
        { name: "transport-close-task" }
      );

      await expect(task.promise).rejects.toThrow(fameTransportError);
      expect(task.isFailed()).toBe(true);

      // Should not set lastSpawnerError for this type of error
      await delay(10);
      expect(spawner.lastSpawnerError).toBeNull();
    });

    test("should handle normal closure errors", async () => {
      const task = spawner.spawn(
        async () => {
          throw new Error("normal closure - connection ended");
        },
        { name: "normal-closure-task" }
      );

      await expect(task.promise).rejects.toThrow("normal closure");
      expect(task.isFailed()).toBe(true);

      // Should not set lastSpawnerError for this type of error
      await delay(10);
      expect(spawner.lastSpawnerError).toBeNull();
    });

    test("should handle connection closed errors", async () => {
      const task = spawner.spawn(
        async () => {
          throw new Error("Connection closed by peer");
        },
        { name: "connection-closed-task" }
      );

      await expect(task.promise).rejects.toThrow("Connection closed");
      expect(task.isFailed()).toBe(true);
      await delay(10);
      expect(spawner.lastSpawnerError).toBeNull();
    });
  });
});

describe("Task Utilities", () => {
  let spawner: TaskSpawner;

  beforeEach(() => {
    spawner = new TaskSpawner();
  });

  afterEach(async () => {
    await spawner.shutdownTasks({ gracePeriod: 100 });
  });

  test("waitForAny should return first completed task", async () => {
    const task1 = spawner.spawn(async () => {
      await delay(100);
      return "slow";
    });

    const task2 = spawner.spawn(async () => {
      await delay(10);
      return "fast";
    });

    const result = await waitForAny([task1, task2]);
    expect(result).toBe("fast");
  });

  test("waitForAll should wait for all tasks", async () => {
    const task1 = spawner.spawn(async () => {
      await delay(50);
      return "first";
    });

    const task2 = spawner.spawn(async () => {
      await delay(100);
      return "second";
    });

    const results = await waitForAll([task1, task2]);
    expect(results).toEqual(["first", "second"]);
  });

  test("retryWithBackoff should retry failed operations", async () => {
    let attempts = 0;

    const result = await retryWithBackoff(
      async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error("Not yet");
        }
        return "success";
      },
      {
        maxRetries: 5,
        baseDelayMs: 10,
      }
    );

    expect(result).toBe("success");
    expect(attempts).toBe(3);
  });

  test("delay should work with AbortSignal", async () => {
    const controller = new AbortController();

    setTimeout(() => controller.abort(), 50);

    await expect(delay(1000, controller.signal)).rejects.toThrow("Aborted");
  });
});
