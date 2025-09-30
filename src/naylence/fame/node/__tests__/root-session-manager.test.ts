import * as core from "naylence-core";
import type { FameEnvelopeWith, NodeWelcomeFrame } from "naylence-core";
import { RootSessionManager, type RootSessionManagerOptions } from "../root-session-manager.js";
import { TaskCancelledError } from "../../util/task-types.js";
import { FameConnectError } from "../../errors/errors.js";
import type { NodeLike } from "../node-like.js";
import type { AdmissionClient } from "../admission/admission-client.js";
import type { SpawnedTask } from "../../util/task-types.js";
import type { CryptoProvider } from "../../security/crypto/providers/crypto-provider.js";

jest.mock("../../util/logging.js", () => {
  const actual = jest.requireActual("../../util/logging.js");
  const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
  };
  return {
    ...actual,
    getLogger: jest.fn(() => mockLogger),
    __mockLogger: mockLogger,
  };
});

const { __mockLogger: loggerMock } = jest.requireMock("../../util/logging.js") as {
  __mockLogger: {
    debug: jest.Mock;
    info: jest.Mock;
    warning: jest.Mock;
    error: jest.Mock;
  };
};

function createAdmissionClient(overrides: Partial<AdmissionClient> = {}): AdmissionClient {
  return {
    hasUpstream: true,
    hello: jest.fn(),
    close: jest.fn(),
    ...overrides,
  } as unknown as AdmissionClient;
}

function createNode(overrides: Partial<NodeLike> = {}): NodeLike {
  const base: Partial<NodeLike> = {
    id: "node-1",
    cryptoProvider: null as unknown as CryptoProvider,
  };

  return {
    ...base,
    ...overrides,
  } as unknown as NodeLike;
}

function createManager(overrides: Partial<RootSessionManagerOptions> = {}): RootSessionManager {
  const options: RootSessionManagerOptions = {
    node: overrides.node ?? createNode(),
    admissionClient: overrides.admissionClient ?? createAdmissionClient(),
    requestedLogicals: overrides.requestedLogicals ?? ["logical-a"],
    onWelcome: overrides.onWelcome ?? jest.fn(),
  };

  if (overrides.onEpochChange) {
    options.onEpochChange = overrides.onEpochChange;
  }
  if (overrides.onAdmissionFailed) {
    options.onAdmissionFailed = overrides.onAdmissionFailed;
  }
  if (overrides.enableContinuousRefresh !== undefined) {
    options.enableContinuousRefresh = overrides.enableContinuousRefresh;
  }

  const manager = new RootSessionManager(options);
  createdManagers.push(manager);
  return manager;
}

function createTaskStub(name: string, promise?: Promise<void>): SpawnedTask<void> {
  const taskPromise = promise ?? Promise.resolve();
  // Avoid unhandled rejections in tests
  void taskPromise.catch(() => undefined);
  const base: SpawnedTask<void> = {
    name,
    promise: taskPromise,
    cancel: jest.fn(),
    isCancelled: jest.fn(() => false),
    isCompleted: jest.fn(() => false),
    isFailed: jest.fn(() => false),
  } as unknown as SpawnedTask<void>;
  return base;
}

const createdManagers: RootSessionManager[] = [];

afterEach(async () => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  jest.clearAllMocks();
  const managers = createdManagers.splice(0);
  for (const manager of managers) {
    try {
      await manager.stop();
    } catch {
      // Ignore shutdown failures in tests
    }
    try {
      await manager.shutdownTasks({ cancelHanging: true });
    } catch {
      // Ignore
    }
  }
});

describe("RootSessionManager", () => {
  describe("createForRootSentinel", () => {
    it("provides default welcome and failure handlers", async () => {
      const manager = RootSessionManager.createForRootSentinel(
        createNode(),
        createAdmissionClient(),
        ["logical"]
      );
      createdManagers.push(manager);

      const welcomeFrame: NodeWelcomeFrame = {
        systemId: "root",
        assignedPath: "/root",
        acceptedLogicals: ["logical"],
        connectionGrants: [{ purpose: "ingress" }, "skip"],
      } as NodeWelcomeFrame;

      await (
        manager as unknown as { onWelcome: (frame: NodeWelcomeFrame) => Promise<void> }
      ).onWelcome(welcomeFrame);

      expect(loggerMock.info).toHaveBeenCalledWith("root_admission_successful", {
        system_id: "root",
        assigned_path: "/root",
        accepted_logicals: ["logical"],
        grants_count: 2,
      });
      expect(loggerMock.debug).toHaveBeenCalledWith("received_admission_grant", {
        purpose: "ingress",
      });

      await (
        manager as unknown as { onAdmissionFailed: (error: Error) => Promise<void> }
      ).onAdmissionFailed(new Error("fatal"));

      expect(loggerMock.error).toHaveBeenCalledWith("root_admission_failed_permanently", {
        error: "fatal",
      });
    });
  });

  describe("start", () => {
    it("returns early when already running", async () => {
      const manager = createManager();
      const existingTask = createTaskStub("existing-task");
      (manager as unknown as { admissionTask: SpawnedTask<void> | null }).admissionTask =
        existingTask;
      const spawnSpy = jest.spyOn(manager, "spawn");

      await manager.start();

      expect(spawnSpy).not.toHaveBeenCalled();
      expect(
        (manager as unknown as { admissionTask: SpawnedTask<void> | null }).admissionTask
      ).toBe(existingTask);
    });

    it("waits for readiness when admission loop resolves", async () => {
      const manager = createManager();
      const admissionLoop = jest
        .spyOn(
          manager as unknown as { admissionLoop: (signal?: AbortSignal) => Promise<void> },
          "admissionLoop"
        )
        .mockImplementation(async function (this: Record<string, any>) {
          this.readyEvent.set();
        });

      await manager.start();

      expect(manager.isReady).toBe(true);
      expect(admissionLoop).toHaveBeenCalled();
    });

    it("throws when admission completes without readiness", async () => {
      const manager = createManager();
      jest
        .spyOn(
          manager as unknown as { admissionLoop: (signal?: AbortSignal) => Promise<void> },
          "admissionLoop"
        )
        .mockResolvedValue(undefined);

      await expect(manager.start()).rejects.toThrow(FameConnectError);
    });
  });

  describe("stop", () => {
    it("cancels background tasks and clears references", async () => {
      const manager = createManager();
      const admissionTask = createTaskStub("admission");
      const expiryTask = createTaskStub("expiry");
      (manager as unknown as { admissionTask: SpawnedTask<void> | null }).admissionTask =
        admissionTask;
      (manager as unknown as { expiryGuardTask: SpawnedTask<void> | null }).expiryGuardTask =
        expiryTask;

      await manager.stop();

      expect(admissionTask.cancel).toHaveBeenCalled();
      expect(expiryTask.cancel).toHaveBeenCalled();
      expect(
        (manager as unknown as { admissionTask: SpawnedTask<void> | null }).admissionTask
      ).toBeNull();
      expect(
        (manager as unknown as { expiryGuardTask: SpawnedTask<void> | null }).expiryGuardTask
      ).toBeNull();
    });
  });

  describe("awaitReady", () => {
    it("returns immediately when already ready", async () => {
      const manager = createManager();
      (manager as any).readyEvent.set();

      await expect(manager.awaitReady()).resolves.toBeUndefined();
    });

    it("resolves when no admission task is running", async () => {
      const manager = createManager();

      await expect(manager.awaitReady()).resolves.toBeUndefined();
    });

    it("throws when admission finishes without readiness", async () => {
      const manager = createManager();
      const admissionTask = createTaskStub("admission");
      (manager as unknown as { admissionTask: SpawnedTask<void> | null }).admissionTask =
        admissionTask;

      await expect(manager.awaitReady()).rejects.toThrow(
        "Root session manager terminated before ready"
      );
    });

    it("rejects when wait timeout elapses first", async () => {
      const manager = createManager();
      const pending = new Promise<void>(() => undefined);
      void pending.catch(() => undefined);
      const admissionTask = createTaskStub("admission", pending);
      (manager as unknown as { admissionTask: SpawnedTask<void> | null }).admissionTask =
        admissionTask;

      await expect(manager.awaitReady(0)).rejects.toThrow(
        "Timed out waiting for root session manager readiness"
      );

      (manager as unknown as { admissionTask: SpawnedTask<void> | null }).admissionTask = null;
    });
  });

  describe("performAdmission", () => {
    it("initializes identity, stores welcome, and prepares crypto", async () => {
      const prepareSpy = jest.fn();
      const node = createNode({
        id: "",
        cryptoProvider: { prepareForAttach: prepareSpy } as unknown as CryptoProvider,
      });
      const helloMock = jest.fn<
        Promise<FameEnvelopeWith<NodeWelcomeFrame>>,
        [string, string, string[] | undefined]
      >();
      const admissionClient = createAdmissionClient({ hello: helloMock });
      const manager = createManager({ node, admissionClient });

      const welcomeFrame: NodeWelcomeFrame = {
        systemId: "sys",
        assignedPath: "/path",
        acceptedLogicals: ["logical-a"],
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      } as NodeWelcomeFrame;

      helloMock.mockResolvedValue({ frame: welcomeFrame } as FameEnvelopeWith<NodeWelcomeFrame>);

      const result = await manager.performAdmission();

      expect(result).toBe(welcomeFrame);
      expect(prepareSpy).toHaveBeenCalledWith("sys", "/path", ["logical-a"]);
      expect(
        (manager as unknown as { currentWelcome: NodeWelcomeFrame | null }).currentWelcome
      ).toBe(welcomeFrame);
    });

    it("returns welcome frame without invoking crypto when path missing", async () => {
      const prepareSpy = jest.fn();
      const node = createNode({
        cryptoProvider: { prepareForAttach: prepareSpy } as unknown as CryptoProvider,
      });
      const admissionClient = createAdmissionClient();
      const manager = createManager({ admissionClient, node });
      const welcomeFrame: NodeWelcomeFrame = {
        systemId: "sys",
        assignedPath: undefined,
        acceptedLogicals: undefined,
      } as NodeWelcomeFrame;

      (admissionClient.hello as jest.Mock).mockResolvedValue({ frame: welcomeFrame });

      const result = await manager.performAdmission();

      expect(result).toBe(welcomeFrame);
      expect(prepareSpy).not.toHaveBeenCalled();
    });
  });

  describe("handleEpochChange", () => {
    it("invokes epoch handler when provided", async () => {
      const onEpochChange = jest.fn();
      const manager = createManager({ onEpochChange });

      await manager.handleEpochChange("epoch-42");

      expect(onEpochChange).toHaveBeenCalledWith("epoch-42");
    });

    it("logs when epoch handler is missing", async () => {
      const manager = createManager();

      await manager.handleEpochChange("ignored");

      expect(loggerMock.debug).toHaveBeenCalledWith("epoch_change_ignored_no_handler", {
        epoch: "ignored",
      });
    });
  });

  describe("backoff and sleep helpers", () => {
    it("applies exponential backoff with jitter", async () => {
      const manager = createManager();
      const sleepSpy = jest
        .spyOn(
          manager as unknown as {
            sleepWithStop: (delay: number, signal?: AbortSignal) => Promise<void>;
          },
          "sleepWithStop"
        )
        .mockResolvedValue(undefined);
      jest.spyOn(Math, "random").mockReturnValue(0.25);

      const nextDelay = await (
        manager as unknown as {
          applyBackoff: (delay: number, signal?: AbortSignal) => Promise<number>;
        }
      ).applyBackoff(4);

      expect(nextDelay).toBe(8);
      expect(sleepSpy).toHaveBeenCalledWith(5, undefined);
    });

    it("returns immediately when sleep duration is non-positive", async () => {
      const manager = createManager();

      await expect(
        (manager as unknown as { sleepWithStop: (delay: number) => Promise<void> }).sleepWithStop(0)
      ).resolves.toBeUndefined();
    });

    it("clears timers when stop event fires during sleep", async () => {
      jest.useFakeTimers();
      const manager = createManager();
      (
        manager as unknown as { stopEvent: { set: () => void; clear: () => void } }
      ).stopEvent.clear();
      const sleepPromise = (
        manager as unknown as { sleepWithStop: (delay: number) => Promise<void> }
      ).sleepWithStop(10);
      (manager as unknown as { stopEvent: { set: () => void } }).stopEvent.set();
      await expect(sleepPromise).resolves.toBeUndefined();
      jest.useRealTimers();
    });

    it("allows timers to resolve naturally without clearing again", async () => {
      jest.useFakeTimers();
      const manager = createManager();
      const clearSpy = jest.spyOn(global, "clearTimeout");

      const sleepPromise = (
        manager as unknown as { sleepWithStop: (delay: number) => Promise<void> }
      ).sleepWithStop(1);

      jest.advanceTimersByTime(1000);
      await expect(sleepPromise).resolves.toBeUndefined();
      expect(clearSpy).not.toHaveBeenCalled();

      clearSpy.mockRestore();
      jest.useRealTimers();
    });

    it("caps exponential backoff at the configured maximum", async () => {
      const manager = createManager();
      const sleepSpy = jest
        .spyOn(
          manager as unknown as {
            sleepWithStop: (delay: number, signal?: AbortSignal) => Promise<void>;
          },
          "sleepWithStop"
        )
        .mockResolvedValue(undefined);
      jest.spyOn(Math, "random").mockReturnValue(0);

      const result = await (
        manager as unknown as {
          applyBackoff: (delay: number, signal?: AbortSignal) => Promise<number>;
        }
      ).applyBackoff(RootSessionManager.BACKOFF_CAP);

      expect(result).toBe(RootSessionManager.BACKOFF_CAP);
      expect(sleepSpy).toHaveBeenCalledWith(RootSessionManager.BACKOFF_CAP, undefined);
    });
  });

  describe("expiry handling", () => {
    it("starts expiry guard when none is running", async () => {
      const manager = createManager();
      const spawnedTask = createTaskStub("fresh");
      const spawnSpy = jest.spyOn(manager, "spawn").mockReturnValue(spawnedTask);

      const welcome: NodeWelcomeFrame = {
        systemId: "sys",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      } as NodeWelcomeFrame;

      await (
        manager as unknown as { startExpiryGuard: (frame: NodeWelcomeFrame) => Promise<void> }
      ).startExpiryGuard(welcome);

      expect(spawnSpy).toHaveBeenCalledWith(expect.any(Function), {
        name: expect.stringContaining("root-expiry-guard-"),
      });
      expect(
        (manager as unknown as { expiryGuardTask: SpawnedTask<void> | null }).expiryGuardTask
      ).toBe(spawnedTask);
    });

    it("replaces existing expiry guard tasks", async () => {
      const manager = createManager();
      const previousTask = createTaskStub("previous");
      (manager as unknown as { expiryGuardTask: SpawnedTask<void> | null }).expiryGuardTask =
        previousTask;
      const newTask = createTaskStub("new");
      const spawnSpy = jest.spyOn(manager, "spawn").mockReturnValue(newTask);

      const welcome: NodeWelcomeFrame = {
        systemId: "sys",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      } as NodeWelcomeFrame;

      await (
        manager as unknown as { startExpiryGuard: (frame: NodeWelcomeFrame) => Promise<void> }
      ).startExpiryGuard(welcome);

      expect(previousTask.cancel).toHaveBeenCalled();
      expect(spawnSpy).toHaveBeenCalled();
      expect(
        (manager as unknown as { expiryGuardTask: SpawnedTask<void> | null }).expiryGuardTask
      ).toBe(newTask);
    });

    it("returns false when no expiry guard task exists", async () => {
      const manager = createManager();

      const result = await (
        manager as unknown as { waitForExpiryOrStop: () => Promise<boolean> }
      ).waitForExpiryOrStop();

      expect(result).toBe(false);
    });

    it("cancels expiry guard when stop event wins the race", async () => {
      const manager = createManager();
      let resolveTask: () => void = () => undefined;
      const deferred = new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
      const expiryTask = createTaskStub("expiry", deferred);
      expiryTask.cancel = jest.fn(() => {
        resolveTask();
      });
      expiryTask.isCancelled = jest.fn(() => true);
      (manager as unknown as { expiryGuardTask: SpawnedTask<void> | null }).expiryGuardTask =
        expiryTask;
      (manager as unknown as { stopEvent: { set: () => void; clear: () => void } }).stopEvent.set();

      const result = await (
        manager as unknown as { waitForExpiryOrStop: () => Promise<boolean> }
      ).waitForExpiryOrStop();

      expect(result).toBe(false);
      expect(expiryTask.cancel).toHaveBeenCalled();
      (manager as unknown as { stopEvent: { clear: () => void } }).stopEvent.clear();
      (manager as unknown as { expiryGuardTask: SpawnedTask<void> | null }).expiryGuardTask = null;
    });

    it("returns true when expiry guard completes first", async () => {
      const manager = createManager();
      const expiryTask = createTaskStub("expiry", Promise.resolve());
      (manager as unknown as { expiryGuardTask: SpawnedTask<void> | null }).expiryGuardTask =
        expiryTask;
      (manager as unknown as { stopEvent: { clear: () => void } }).stopEvent.clear();

      const result = await (
        manager as unknown as { waitForExpiryOrStop: () => Promise<boolean> }
      ).waitForExpiryOrStop();

      expect(result).toBe(true);
    });

    it("handles task cancellation during expiry wait", async () => {
      const manager = createManager();
      const cancelledPromise = Promise.reject(new TaskCancelledError("cancelled"));
      void cancelledPromise.catch(() => undefined);
      const expiryTask = createTaskStub("expiry", cancelledPromise);
      expiryTask.isCancelled = jest.fn(() => true);
      (manager as unknown as { expiryGuardTask: SpawnedTask<void> | null }).expiryGuardTask =
        expiryTask;

      const result = await (
        manager as unknown as { waitForExpiryOrStop: () => Promise<boolean> }
      ).waitForExpiryOrStop();

      expect(result).toBe(false);
      expect(
        (manager as unknown as { expiryGuardTask: SpawnedTask<void> | null }).expiryGuardTask
      ).toBeNull();
    });

    it("waits for stop event when no expiry timestamp configured", async () => {
      const manager = createManager();
      (manager as unknown as { stopEvent: { set: () => void; clear: () => void } }).stopEvent.set();

      await expect(
        (
          manager as unknown as { expiryGuard: (frame: NodeWelcomeFrame) => Promise<void> }
        ).expiryGuard({
          systemId: "sys",
        } as NodeWelcomeFrame)
      ).resolves.toBeUndefined();

      (manager as unknown as { stopEvent: { clear: () => void } }).stopEvent.clear();
    });

    it("logs when admission expiry triggers refresh", async () => {
      const manager = createManager();
      const sleepSpy = jest
        .spyOn(
          manager as unknown as {
            sleepWithStop: (delay: number, signal?: AbortSignal) => Promise<void>;
          },
          "sleepWithStop"
        )
        .mockResolvedValue(undefined);

      await (
        manager as unknown as { expiryGuard: (frame: NodeWelcomeFrame) => Promise<void> }
      ).expiryGuard({
        systemId: "sys",
        expiresAt: new Date(Date.now() + 120000).toISOString(),
      } as NodeWelcomeFrame);

      expect(sleepSpy).toHaveBeenCalled();
      expect(loggerMock.debug).toHaveBeenCalledWith(
        "admission_expiry_triggered_refresh",
        expect.objectContaining({ expires_at: expect.any(String) })
      );
    });

    it("stops expiry guard when abort signal triggers", async () => {
      const manager = createManager();
      const sleepSpy = jest
        .spyOn(
          manager as unknown as {
            sleepWithStop: (delay: number, signal?: AbortSignal) => Promise<void>;
          },
          "sleepWithStop"
        )
        .mockResolvedValue(undefined);
      const controller = new AbortController();
      controller.abort();

      await expect(
        (
          manager as unknown as {
            expiryGuard: (frame: NodeWelcomeFrame, signal?: AbortSignal) => Promise<void>;
          }
        ).expiryGuard(
          {
            systemId: "sys",
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          } as NodeWelcomeFrame,
          controller.signal
        )
      ).resolves.toBeUndefined();

      expect(sleepSpy).toHaveBeenCalled();
    });
  });

  describe("identity and task utilities", () => {
    it("generates identity when node id missing", () => {
      const node: any = { id: "" };
      const manager = createManager({ node });
      const generated = "generated-id";
      const idSpy = jest.spyOn(core, "generateId").mockReturnValueOnce(generated);

      (
        manager as unknown as { initializeRootIdentityIfNeeded: () => void }
      ).initializeRootIdentityIfNeeded();

      expect(node._id).toBe(generated);
      expect(idSpy).toHaveBeenCalled();
    });

    it("ignores TaskCancelledError when consuming task", async () => {
      const manager = createManager();
      const task = createTaskStub("cancelled", Promise.reject(new TaskCancelledError("cancelled")));

      await expect(
        (
          manager as unknown as { consumeTask: (task: SpawnedTask<void>) => Promise<void> }
        ).consumeTask(task)
      ).resolves.toBeUndefined();
    });

    it("leaves identity untouched when node already identified", () => {
      const node: any = { id: "existing-node" };
      const manager = createManager({ node });
      const idSpy = jest.spyOn(core, "generateId");

      (
        manager as unknown as { initializeRootIdentityIfNeeded: () => void }
      ).initializeRootIdentityIfNeeded();

      expect(node._id).toBeUndefined();
      expect(idSpy).not.toHaveBeenCalled();
    });

    it("logs unexpected errors when consuming task", async () => {
      const manager = createManager();
      const task = createTaskStub("failed", Promise.reject(new Error("boom")));

      await (
        manager as unknown as { consumeTask: (task: SpawnedTask<void>) => Promise<void> }
      ).consumeTask(task);

      expect(loggerMock.debug).toHaveBeenCalledWith("background_task_error", {
        task_name: "failed",
        error: "boom",
      });
    });
  });

  describe("abort and timeout helpers", () => {
    it("rejects instantly when signal already aborted", async () => {
      const manager = createManager();
      const controller = new AbortController();
      controller.abort();

      await expect(
        (
          manager as unknown as { waitForAbort: (signal: AbortSignal) => Promise<never> }
        ).waitForAbort(controller.signal)
      ).rejects.toBeInstanceOf(TaskCancelledError);
    });

    it("rejects when abort signal fires later", async () => {
      const manager = createManager();
      const controller = new AbortController();
      const waitPromise = (
        manager as unknown as { waitForAbort: (signal: AbortSignal) => Promise<never> }
      ).waitForAbort(controller.signal);
      controller.abort();

      await expect(waitPromise).rejects.toBeInstanceOf(TaskCancelledError);
    });

    it("rejects after configured timeout", async () => {
      jest.useFakeTimers();
      const manager = createManager();
      const waitPromise = (
        manager as unknown as { waitWithTimeout: (timeout: number) => Promise<void> }
      ).waitWithTimeout(5);
      jest.runAllTimers();

      await expect(waitPromise).rejects.toBeInstanceOf(FameConnectError);
      jest.useRealTimers();
    });

    it("returns unresolved promise when no signal supplied", async () => {
      const manager = createManager();
      const promise = (
        manager as unknown as { waitForAbort: (signal?: AbortSignal) => Promise<never> }
      ).waitForAbort();

      const result = await Promise.race([promise, Promise.resolve("sentinel")]);

      expect(result).toBe("sentinel");
    });
  });

  describe("admissionLoop", () => {
    it("marks ready and may refresh before returning", async () => {
      const manager = createManager();
      const firstWelcome: NodeWelcomeFrame = {
        systemId: "sys-1",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      } as NodeWelcomeFrame;
      const secondWelcome: NodeWelcomeFrame = {
        systemId: "sys-2",
      } as NodeWelcomeFrame;
      const performAdmission = jest
        .spyOn(manager, "performAdmission")
        .mockResolvedValueOnce(firstWelcome)
        .mockResolvedValueOnce(secondWelcome);
      const onWelcome = jest.fn();
      (manager as unknown as { onWelcome: (frame: NodeWelcomeFrame) => Promise<void> }).onWelcome =
        onWelcome;
      const startExpiryGuard = jest
        .spyOn(
          manager as unknown as { startExpiryGuard: (frame: NodeWelcomeFrame) => Promise<void> },
          "startExpiryGuard"
        )
        .mockResolvedValue(undefined);
      const waitForExpiryOrStop = jest
        .spyOn(
          manager as unknown as { waitForExpiryOrStop: () => Promise<boolean> },
          "waitForExpiryOrStop"
        )
        .mockResolvedValueOnce(true);

      await (
        manager as unknown as { admissionLoop: (signal?: AbortSignal) => Promise<void> }
      ).admissionLoop();

      expect(performAdmission).toHaveBeenCalledTimes(2);
      expect(startExpiryGuard).toHaveBeenCalledWith(firstWelcome);
      expect(waitForExpiryOrStop).toHaveBeenCalledTimes(1);
      expect(onWelcome).toHaveBeenCalledTimes(2);
      expect(manager.isReady).toBe(true);
    });

    it("retries admissions and reports failure when never successful", async () => {
      const onAdmissionFailed = jest.fn();
      const manager = createManager({ onAdmissionFailed });
      jest.spyOn(manager, "performAdmission").mockRejectedValue(new Error("fail"));
      const backoffSpy = jest
        .spyOn(
          manager as unknown as {
            applyBackoff: (delay: number, signal?: AbortSignal) => Promise<number>;
          },
          "applyBackoff"
        )
        .mockImplementation(async (delay) => delay);

      await expect(
        (manager as unknown as { admissionLoop: () => Promise<void> }).admissionLoop()
      ).rejects.toThrow("fail");

      expect(onAdmissionFailed).toHaveBeenCalledWith(expect.objectContaining({ message: "fail" }));
      expect(backoffSpy).toHaveBeenCalled();
      expect(loggerMock.warning).toHaveBeenCalledWith(
        "root_admission_failed",
        expect.objectContaining({ will_retry: expect.any(Boolean) })
      );
    });

    it("throws fame connect errors without invoking failure handler when absent", async () => {
      const manager = createManager();
      jest
        .spyOn(manager, "performAdmission")
        .mockRejectedValue(new FameConnectError("connect-fail"));
      const backoffSpy = jest
        .spyOn(
          manager as unknown as {
            applyBackoff: (delay: number, signal?: AbortSignal) => Promise<number>;
          },
          "applyBackoff"
        )
        .mockImplementation(async (delay) => delay);

      await expect(
        (manager as unknown as { admissionLoop: () => Promise<void> }).admissionLoop()
      ).rejects.toBeInstanceOf(FameConnectError);

      expect(backoffSpy).toHaveBeenCalled();
      expect(loggerMock.warning).toHaveBeenCalledWith(
        "root_admission_failed",
        expect.objectContaining({ exc_info: false })
      );
    });

    it("exhausts retries and rethrows when failure handler missing", async () => {
      const manager = createManager();
      jest.spyOn(manager, "performAdmission").mockRejectedValue(new Error("fatal"));
      const backoffSpy = jest
        .spyOn(
          manager as unknown as {
            applyBackoff: (delay: number, signal?: AbortSignal) => Promise<number>;
          },
          "applyBackoff"
        )
        .mockImplementation(async (delay) => delay);

      await expect(
        (manager as unknown as { admissionLoop: () => Promise<void> }).admissionLoop()
      ).rejects.toThrow("fatal");

      expect(backoffSpy).toHaveBeenCalled();
      const lastWarning = loggerMock.warning.mock.calls[loggerMock.warning.mock.calls.length - 1];
      expect(lastWarning?.[0]).toBe("root_admission_failed");
      expect(lastWarning?.[1]).toEqual(expect.objectContaining({ will_retry: false }));
    });

    it("logs when maximum retries exceeded after prior success", async () => {
      const manager = createManager();
      (manager as any).hadSuccessfulAdmission = true;
      jest.spyOn(manager, "performAdmission").mockRejectedValue(new Error("late-fail"));
      const backoffSpy = jest
        .spyOn(
          manager as unknown as {
            applyBackoff: (delay: number, signal?: AbortSignal) => Promise<number>;
          },
          "applyBackoff"
        )
        .mockImplementation(async (delay) => delay);

      await (manager as unknown as { admissionLoop: () => Promise<void> }).admissionLoop();

      expect(backoffSpy).toHaveBeenCalled();
      expect(loggerMock.error).toHaveBeenCalledWith("root_admission_max_attempts_exceeded", {
        max_attempts: RootSessionManager.RETRY_MAX_ATTEMPTS,
      });
    });

    it("propagates task cancellation errors", async () => {
      const manager = createManager();
      jest.spyOn(manager, "performAdmission").mockRejectedValue(new TaskCancelledError("stop"));

      await expect(
        (manager as unknown as { admissionLoop: () => Promise<void> }).admissionLoop()
      ).rejects.toBeInstanceOf(TaskCancelledError);
    });
  });
});
