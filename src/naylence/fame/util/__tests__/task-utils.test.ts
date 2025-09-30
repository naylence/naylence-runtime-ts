import type { SpawnedTask } from "../task-types.js";
import {
  debounce,
  delay,
  retryWithBackoff,
  throttle,
  waitForAll,
  waitForAllSettled,
  waitForAny,
  withTimeout,
} from "../task-utils.js";

describe("task-utils", () => {
  function createTask<T>(promise: Promise<T>): SpawnedTask<T> {
    return {
      id: "task-id",
      name: undefined,
      promise,
      abortController: new AbortController(),
      startTime: Date.now(),
      cancel: jest.fn(),
      isCancelled: jest.fn(() => false),
      isCompleted: jest.fn(() => false),
      isFailed: jest.fn(() => false),
    };
  }

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  describe("waitForAny", () => {
    it("throws when no tasks are provided", async () => {
      await expect(waitForAny([])).rejects.toThrow("Cannot wait for any of zero tasks");
    });

    it("resolves with the first completed task", async () => {
      const slow = new Promise<string>((resolve) => setTimeout(() => resolve("slow"), 50));
      const fast = Promise.resolve("fast");
      const tasks = [createTask(slow), createTask(fast)];

      await expect(waitForAny(tasks)).resolves.toBe("fast");
    });
  });

  it("waitForAll resolves all results", async () => {
    const tasks = [createTask(Promise.resolve(1)), createTask(Promise.resolve(2))];
    await expect(waitForAll(tasks)).resolves.toEqual([1, 2]);
  });

  it("waitForAllSettled resolves settled results", async () => {
    const tasks = [
      createTask(Promise.resolve("ok")),
      createTask(Promise.reject(new Error("fail"))),
    ];

    const results = await waitForAllSettled(tasks);
    expect(results[0]).toEqual({ status: "fulfilled", value: "ok" });
    expect(results[1]).toMatchObject({ status: "rejected" });
  });

  describe("delay", () => {
    it("resolves after the requested time", async () => {
      jest.useFakeTimers();
      const promise = delay(20);
      await jest.advanceTimersByTimeAsync(20);
      await expect(promise).resolves.toBeUndefined();
    });

    it("rejects immediately when signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(delay(10, controller.signal)).rejects.toThrow("Aborted");
    });

    it("rejects when the signal aborts while waiting", async () => {
      jest.useFakeTimers();
      const controller = new AbortController();
      const promise = delay(100, controller.signal);
      controller.abort();
      await expect(promise).rejects.toThrow("Aborted");
    });
  });

  describe("withTimeout", () => {
    it("resolves when the promise settles before the timeout", async () => {
      const result = await withTimeout(Promise.resolve("ok"), 50);
      expect(result).toBe("ok");
    });

    it("rejects with the provided message when timing out", async () => {
      jest.useFakeTimers();
      const promise = withTimeout(new Promise(() => undefined), 40, "too slow");
      void promise.catch(() => undefined);
      await jest.advanceTimersByTimeAsync(40);
      await expect(promise).rejects.toThrow("too slow");
    });
  });

  describe("retryWithBackoff", () => {
    it("resolves without retries when the task succeeds", async () => {
      const result = await retryWithBackoff(async () => "value", { maxRetries: 2 });
      expect(result).toBe("value");
    });

    it("retries with exponential delays until success", async () => {
      jest.useFakeTimers();
      let attempts = 0;
      const taskFn = jest.fn(async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error(`fail-${attempts}`);
        }
        return "done";
      });

      const promise = retryWithBackoff(taskFn, {
        maxRetries: 5,
        baseDelayMs: 10,
        backoffMultiplier: 2,
        maxDelayMs: 40,
      });

      await jest.advanceTimersByTimeAsync(10);
      await jest.advanceTimersByTimeAsync(20);
      await expect(promise).resolves.toBe("done");
      expect(taskFn).toHaveBeenCalledTimes(3);
    });

    it("throws the last error after exhausting retries", async () => {
      jest.useFakeTimers();
      const error = new Error("nope");
      const taskFn = jest.fn(async () => {
        throw error;
      });

      const promise = retryWithBackoff(taskFn, { maxRetries: 1, baseDelayMs: 5 });
      void promise.catch(() => undefined);
      await jest.advanceTimersByTimeAsync(5);
      await expect(promise).rejects.toBe(error);
      expect(taskFn).toHaveBeenCalledTimes(2);
    });

    it("aborts immediately when the signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        retryWithBackoff(async () => "never", { signal: controller.signal })
      ).rejects.toThrow("Aborted");
    });

    it("aborts during backoff when the signal is triggered", async () => {
      jest.useFakeTimers();
      const controller = new AbortController();
      const taskFn = jest.fn(async () => {
        throw new Error("fail");
      });

      const promise = retryWithBackoff(taskFn, {
        maxRetries: 4,
        baseDelayMs: 20,
        signal: controller.signal,
      });

      void promise.catch(() => undefined);
      controller.abort();
      await expect(promise).rejects.toThrow("Aborted");
      expect(taskFn).toHaveBeenCalledTimes(1);
    });
  });

  describe("debounce", () => {
    it("only executes once with the latest arguments", async () => {
      jest.useFakeTimers();
      const fn = jest.fn(async (value: string) => `processed-${value}`);
      const debounced = debounce(fn, 30);

      debounced("one");
      const latest = debounced("two");
      await jest.advanceTimersByTimeAsync(30);

      await expect(latest).resolves.toBe("processed-two");
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith("two");
    });

    it("propagates errors from the wrapped function", async () => {
      jest.useFakeTimers();
      const error = new Error("boom");
      const debounced = debounce(async () => {
        throw error;
      }, 25);

      const promise = debounced();
      void promise.catch(() => undefined);
      await jest.advanceTimersByTimeAsync(25);
      await expect(promise).rejects.toBe(error);
    });
  });

  describe("throttle", () => {
    it("executes immediately when interval has elapsed", async () => {
      jest.useFakeTimers();
      jest.setSystemTime?.(1_000);
      const fn = jest.fn(async (value: string) => `result-${value}`);
      const throttled = throttle(fn, 50);

      await expect(throttled("first")).resolves.toBe("result-first");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("returns the pending promise when a call is in flight", async () => {
      jest.useFakeTimers();
      jest.setSystemTime?.(1_000);
      let resolvePromise: (value: string) => void = () => {
        throw new Error("resolver not set");
      };
      const fn = jest.fn(() => {
        return new Promise<string>((resolve) => {
          resolvePromise = resolve;
        });
      });
      const throttled = throttle(fn, 100);

      const first = throttled();
      const second = throttled();

      resolvePromise("done");

      await expect(first).resolves.toBe("done");
      await expect(second).resolves.toBe("done");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("schedules a later execution when called within the interval", async () => {
      jest.useFakeTimers();
      jest.setSystemTime?.(1_000);
      const fn = jest.fn(async (value: string) => `value-${value}`);
      const throttled = throttle(fn, 40);

      await throttled("initial");
      expect(fn).toHaveBeenCalledTimes(1);

      jest.setSystemTime?.(1_010);
      const scheduled = throttled("delayed");
      expect(fn).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(30);
      await expect(scheduled).resolves.toBeDefined();
      expect(fn).toHaveBeenCalledTimes(2);
      expect(fn).toHaveBeenLastCalledWith("delayed");
    });

    it("propagates errors from scheduled executions", async () => {
      jest.useFakeTimers();
      jest.setSystemTime?.(1_000);
      let calls = 0;
      const fn = jest.fn(async () => {
        calls += 1;
        if (calls === 1) {
          return "ok";
        }
        throw new Error("explode");
      });
      const throttled = throttle(fn, 20);

      await throttled();
      jest.setSystemTime?.(1_005);
      const failing = throttled();
      void failing.catch(() => undefined);
      await jest.advanceTimersByTimeAsync(15);
      await expect(failing).rejects.toThrow("explode");
    });
  });
});
