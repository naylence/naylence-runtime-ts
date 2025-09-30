import {
  ConnectorState,
  DeliveryOriginType,
  FameResponseType,
  createFameEnvelope,
  type FameConnector,
  type FameDeliveryContext,
  type FameEnvelope,
  type FameEnvelopeHandler,
  type FameEnvelopeWith,
  type NodeAttachAckFrame,
  type NodeWelcomeFrame,
} from "naylence-core";
import * as Core from "naylence-core";

let DefaultNodeAttachClient: any;
let KeyValidationErrorCtor: any;
let modulesLoaded = false;

async function ensureModulesLoaded() {
  if (modulesLoaded) {
    return;
  }

  await (jest as any).unstable_mockModule("../../../security/keys/attachment-key-validator", () => {
    class MockKeyValidationError extends Error {
      public readonly code: string;
      public readonly kid: string | null;
      public readonly details: Record<string, unknown>;

      constructor(
        code: string,
        message: string,
        options: { kid?: string | null; details?: Record<string, unknown> | null } = {}
      ) {
        super(message);
        this.name = "KeyValidationError";
        this.code = code;
        this.kid = options.kid ?? null;
        this.details = options.details ? { ...options.details } : {};
      }
    }

    class MockAttachmentKeyValidator {}

    return {
      KeyValidationError: MockKeyValidationError,
      AttachmentKeyValidator: MockAttachmentKeyValidator,
    };
  });

  const defaultClientModule = await import("../default-node-attach-client.js");
  const keyModule: any = await import("../../../security/keys/attachment-key-validator");

  DefaultNodeAttachClient = defaultClientModule.DefaultNodeAttachClient;
  KeyValidationErrorCtor = keyModule.KeyValidationError;
  modulesLoaded = true;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

type AttachmentKeyValidatorMock = {
  validateKeys: jest.Mock;
};

type ReplicaStickinessManagerMock = {
  offer: jest.Mock;
  accept: jest.Mock;
};

const generateIdSpy = jest.spyOn(Core, "generateId");

const ACK_CONTEXT: FameDeliveryContext = {
  originType: DeliveryOriginType.UPSTREAM,
  expectedResponseType: FameResponseType.NONE,
};

describe("DefaultNodeAttachClient", () => {
  afterAll(() => {
    generateIdSpy.mockRestore();
  });

  beforeAll(async () => {
    await ensureModulesLoaded();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    generateIdSpy.mockReset();
    generateIdSpy.mockImplementation(() => `auto-${Math.random()}`);
  });

  function queueIds(...values: string[]) {
    const queue = [...values];
    generateIdSpy.mockImplementation(() => {
      if (queue.length === 0) {
        throw new Error("No queued ids available");
      }
      return queue.shift()!;
    });
  }

  function createConnector(): {
    connector: jest.Mocked<Mutable<FameConnector>>;
    handlerRef: { current: FameEnvelopeHandler | null };
  } {
    const handlerRef: { current: FameEnvelopeHandler | null } = { current: null };
    const connector: Partial<Mutable<FameConnector>> = {
      state: ConnectorState.STARTED,
      replaceHandler: jest.fn(async (handler: FameEnvelopeHandler) => {
        handlerRef.current = handler;
      }),
      send: jest.fn(async () => {}),
    };

    return { connector: connector as jest.Mocked<Mutable<FameConnector>>, handlerRef };
  }

  function createAckEnvelope(
    options: {
      frame?: Partial<NodeAttachAckFrame>;
      corrId?: string | null;
    } = {}
  ): FameEnvelopeWith<NodeAttachAckFrame> {
    const { frame: frameOverrides = {}, corrId = "corr-ack" } = options;

    const frame: NodeAttachAckFrame = {
      type: "NodeAttachAck",
      ok: true,
      assignedPath: "ack-path",
      targetPhysicalPath: "parent/path",
      targetSystemId: "parent-system",
      stickiness: { version: 1 },
      ...frameOverrides,
    } as NodeAttachAckFrame;

    return {
      id: "ack-envelope-id",
      traceId: "ack-trace-id",
      ts: new Date(),
      frame,
      corrId: corrId ?? undefined,
    } as FameEnvelopeWith<NodeAttachAckFrame>;
  }

  function createWelcomeFrame(overrides: Partial<NodeWelcomeFrame> = {}): NodeWelcomeFrame {
    return {
      type: "NodeWelcome",
      systemId: "child-system",
      instanceId: "child-instance",
      acceptedCapabilities: ["capability-a"],
      acceptedLogicals: ["logical-a"],
      assignedPath: "welcome-path",
      targetPhysicalPath: "welcome/physical",
      ...overrides,
    } as NodeWelcomeFrame;
  }

  function createNode(
    overrides: {
      dispatchEnvelopeEvent?: jest.Mock;
    } = {}
  ) {
    const dispatchEnvelopeEvent =
      overrides.dispatchEnvelopeEvent ??
      jest.fn(async (event: string, _node: unknown, envelope: FameEnvelope) => {
        if (event === "onForwardUpstream") {
          return envelope;
        }
        return envelope;
      });

    return {
      dispatchEnvelopeEvent,
      sid: "node-sid",
      physicalPath: "/node",
    } as unknown;
  }

  it("performs successful attach handshake with validator and stickiness", async () => {
    queueIds("corr-1", "trace-1");

    const { connector, handlerRef } = createConnector();
    const welcomeFrame = createWelcomeFrame();

    const ackEnvelope = createAckEnvelope({
      corrId: "corr-1",
      frame: {
        keys: [{ kid: "key-1" } as Record<string, unknown>],
        expiresAt: new Date("2024-01-01T00:00:00Z").toISOString(),
        routingEpoch: "epoch-42",
        stickiness: { version: 1, mode: "attr" },
      },
    });

    const bufferedEnvelope = createFameEnvelope({
      frame: { type: "Data", payload: "buffered" } as any,
    });

    const validator: AttachmentKeyValidatorMock = {
      validateKeys: jest.fn().mockResolvedValue([{ kid: "key-1" }]),
    };

    const replicaStickinessManager = {
      offer: jest.fn(() => ({ version: 1, mode: "attr" })),
      accept: jest.fn(),
    } as ReplicaStickinessManagerMock;

    const finalHandler = jest.fn(async () => null);
    const node = createNode() as any;

    const client = new DefaultNodeAttachClient({
      attachmentKeyValidator: validator as any,
      replicaStickinessManager,
      timeoutMs: 100,
    });

    connector.send.mockImplementation(async () => {
      if (handlerRef.current) {
        await handlerRef.current(ackEnvelope, ACK_CONTEXT);
        await handlerRef.current(bufferedEnvelope, ACK_CONTEXT);
      }
    });

    const attachInfo = await client.attach(
      node,
      DeliveryOriginType.DOWNSTREAM,
      connector,
      welcomeFrame,
      finalHandler,
      [{ kid: "child-key" }],
      [{ type: "Grant" }]
    );

    expect(connector.replaceHandler).toHaveBeenCalledTimes(2);
    expect(connector.send).toHaveBeenCalledTimes(1);
    expect(finalHandler).toHaveBeenCalledWith(bufferedEnvelope);
    expect(validator.validateKeys).toHaveBeenCalledWith([{ kid: "key-1" }]);
    expect(replicaStickinessManager.offer).toHaveBeenCalledTimes(1);
    expect(replicaStickinessManager.accept).toHaveBeenCalledWith({ version: 1, mode: "attr" });
    expect(attachInfo).toMatchObject({
      systemId: "child-system",
      targetSystemId: "parent-system",
      targetPhysicalPath: "parent/path",
      assignedPath: "welcome-path",
      routingEpoch: "epoch-42",
      attachExpiresAt: new Date("2024-01-01T00:00:00Z"),
    });
  });

  it("forwards envelopes through interim handler after handshake completes", async () => {
    queueIds("corr-forward", "trace-forward");

    const { connector, handlerRef } = createConnector();
    const welcomeFrame = createWelcomeFrame();
    const ackEnvelope = createAckEnvelope({ corrId: "corr-forward" });

    connector.send.mockImplementation(async () => {
      if (handlerRef.current) {
        await handlerRef.current(ackEnvelope, ACK_CONTEXT);
      }
    });

    const finalHandler = jest.fn(async () => null);
    const client = new DefaultNodeAttachClient({ timeoutMs: 50 });

    await client.attach(
      createNode() as any,
      DeliveryOriginType.DOWNSTREAM,
      connector,
      welcomeFrame,
      finalHandler
    );

    const interimHandler = connector.replaceHandler.mock.calls[0][0] as FameEnvelopeHandler;
    const forwardedEnvelope = createFameEnvelope({
      frame: { type: "Data", payload: "post-handshake" } as any,
    });
    const context: FameDeliveryContext = {
      originType: DeliveryOriginType.UPSTREAM,
      expectedResponseType: FameResponseType.NONE,
    };

    await interimHandler(forwardedEnvelope, context);

    expect(finalHandler).toHaveBeenCalledWith(forwardedEnvelope, context);
  });

  it("skips stickiness offer when manager throws", async () => {
    queueIds("corr-2", "trace-2");

    const { connector, handlerRef } = createConnector();
    const welcomeFrame = createWelcomeFrame();
    const ackEnvelope = createAckEnvelope({ corrId: "corr-2", frame: { stickiness: undefined } });

    const replicaStickinessManager = {
      offer: jest.fn(() => {
        throw new Error("offer error");
      }),
      accept: jest.fn(),
    } as ReplicaStickinessManagerMock;

    const client = new DefaultNodeAttachClient({ replicaStickinessManager, timeoutMs: 50 });

    connector.send.mockImplementation(async () => {
      if (handlerRef.current) {
        await handlerRef.current(ackEnvelope, ACK_CONTEXT);
      }
    });

    const result = await client.attach(
      createNode() as any,
      DeliveryOriginType.DOWNSTREAM,
      connector,
      welcomeFrame,
      jest.fn()
    );

    expect(result).toMatchObject({ assignedPath: "welcome-path" });
    expect(replicaStickinessManager.offer).toHaveBeenCalledTimes(1);
    expect(replicaStickinessManager.accept).toHaveBeenCalledWith(null);
  });

  it("ignores stickiness accept errors without failing attach", async () => {
    queueIds("corr-3", "trace-3");

    const { connector, handlerRef } = createConnector();
    const welcomeFrame = createWelcomeFrame({ assignedPath: undefined });
    const ackEnvelope = createAckEnvelope({
      corrId: "corr-3",
      frame: { assignedPath: "ack-path", stickiness: undefined },
    });

    const replicaStickinessManager = {
      offer: jest.fn(() => null),
      accept: jest.fn(() => {
        throw new Error("accept failure");
      }),
    } as ReplicaStickinessManagerMock;

    const client = new DefaultNodeAttachClient({ replicaStickinessManager, timeoutMs: 50 });

    connector.send.mockImplementation(async () => {
      if (handlerRef.current) {
        await handlerRef.current(ackEnvelope, ACK_CONTEXT);
      }
    });

    await expect(
      client.attach(
        createNode() as any,
        DeliveryOriginType.DOWNSTREAM,
        connector,
        welcomeFrame,
        jest.fn()
      )
    ).resolves.toMatchObject({ assignedPath: "ack-path" });

    expect(replicaStickinessManager.accept).toHaveBeenCalledWith(null);
  });

  it("throws when ack correlation id mismatches", async () => {
    queueIds("corr-x", "trace-x");

    const { connector, handlerRef } = createConnector();
    const welcomeFrame = createWelcomeFrame();
    const ackEnvelope = createAckEnvelope({ corrId: "wrong-corr" });

    const client = new DefaultNodeAttachClient({ timeoutMs: 50 });

    connector.send.mockImplementation(async () => {
      if (handlerRef.current) {
        await handlerRef.current(ackEnvelope, ACK_CONTEXT);
      }
    });

    await expect(
      client.attach(
        createNode() as any,
        DeliveryOriginType.DOWNSTREAM,
        connector,
        welcomeFrame,
        jest.fn()
      )
    ).rejects.toThrow("Attach rejected, invalid correlation id");
  });

  it("throws when ack indicates failure", async () => {
    queueIds("corr-y", "trace-y");

    const { connector, handlerRef } = createConnector();
    const welcomeFrame = createWelcomeFrame();
    const ackEnvelope = createAckEnvelope({
      corrId: "corr-y",
      frame: { ok: false, reason: "denied" },
    });

    const client = new DefaultNodeAttachClient({ timeoutMs: 50 });

    connector.send.mockImplementation(async () => {
      if (handlerRef.current) {
        await handlerRef.current(ackEnvelope, ACK_CONTEXT);
      }
    });

    await expect(
      client.attach(
        createNode() as any,
        DeliveryOriginType.DOWNSTREAM,
        connector,
        welcomeFrame,
        jest.fn()
      )
    ).rejects.toThrow("Attach rejected: denied");
  });

  it("wraps key validation errors from validator", async () => {
    queueIds("corr-z", "trace-z");

    const { connector, handlerRef } = createConnector();
    const welcomeFrame = createWelcomeFrame();
    const ackEnvelope = createAckEnvelope({
      corrId: "corr-z",
      frame: { keys: [{ kid: "fail" } as Record<string, unknown>] },
    });

    const validator: AttachmentKeyValidatorMock = {
      validateKeys: jest.fn(() => {
        throw new KeyValidationErrorCtor("code-1", "invalid", { kid: "kid-1" });
      }),
    };

    const client = new DefaultNodeAttachClient({
      attachmentKeyValidator: validator as any,
      timeoutMs: 50,
    });

    connector.send.mockImplementation(async () => {
      if (handlerRef.current) {
        await handlerRef.current(ackEnvelope, ACK_CONTEXT);
      }
    });

    await expect(
      client.attach(
        createNode() as any,
        DeliveryOriginType.DOWNSTREAM,
        connector,
        welcomeFrame,
        jest.fn()
      )
    ).rejects.toThrow("Parent certificate validation failed: invalid");
  });

  it("rethrows unexpected validator errors without wrapping", async () => {
    queueIds("corr-err", "trace-err");

    const { connector, handlerRef } = createConnector();
    const welcomeFrame = createWelcomeFrame();
    const ackEnvelope = createAckEnvelope({
      corrId: "corr-err",
      frame: { keys: [{ kid: "boom" } as Record<string, unknown>] },
    });

    const validator: AttachmentKeyValidatorMock = {
      validateKeys: jest.fn(() => {
        throw new Error("validator failed");
      }),
    };

    const client = new DefaultNodeAttachClient({
      attachmentKeyValidator: validator as any,
      timeoutMs: 50,
    });

    connector.send.mockImplementation(async () => {
      if (handlerRef.current) {
        await handlerRef.current(ackEnvelope, ACK_CONTEXT);
      }
    });

    await expect(
      client.attach(
        createNode() as any,
        DeliveryOriginType.DOWNSTREAM,
        connector,
        welcomeFrame,
        jest.fn()
      )
    ).rejects.toThrow("validator failed");
  });

  it("throws when assigned path is missing after handshake", async () => {
    queueIds("corr-assign", "trace-assign");

    const { connector, handlerRef } = createConnector();
    const welcomeFrame = createWelcomeFrame({ assignedPath: undefined });
    const ackEnvelope = createAckEnvelope({
      corrId: "corr-assign",
      frame: { assignedPath: undefined },
    });

    const client = new DefaultNodeAttachClient({ timeoutMs: 20 });

    connector.send.mockImplementation(async () => {
      if (handlerRef.current) {
        await handlerRef.current(ackEnvelope, ACK_CONTEXT);
      }
    });

    await expect(
      client.attach(
        createNode() as any,
        DeliveryOriginType.DOWNSTREAM,
        connector,
        welcomeFrame,
        jest.fn()
      )
    ).rejects.toThrow("Assigned path must be present after attach handshake");
  });

  it("throws when target physical path is missing", async () => {
    queueIds("corr-phys", "trace-phys");

    const { connector, handlerRef } = createConnector();
    const welcomeFrame = createWelcomeFrame({ targetPhysicalPath: undefined });
    const ackEnvelope = createAckEnvelope({
      corrId: "corr-phys",
      frame: { targetPhysicalPath: undefined },
    });

    const client = new DefaultNodeAttachClient({ timeoutMs: 20 });

    connector.send.mockImplementation(async () => {
      if (handlerRef.current) {
        await handlerRef.current(ackEnvelope, ACK_CONTEXT);
      }
    });

    await expect(
      client.attach(
        createNode() as any,
        DeliveryOriginType.DOWNSTREAM,
        connector,
        welcomeFrame,
        jest.fn()
      )
    ).rejects.toThrow("Target physical path must be present after attach handshake");
  });

  it("throws when target system id is missing in ack", async () => {
    queueIds("corr-system", "trace-system");

    const { connector, handlerRef } = createConnector();
    const welcomeFrame = createWelcomeFrame();
    const ackEnvelope = createAckEnvelope({
      corrId: "corr-system",
      frame: { targetSystemId: undefined },
    });

    const client = new DefaultNodeAttachClient({ timeoutMs: 20 });

    connector.send.mockImplementation(async () => {
      if (handlerRef.current) {
        await handlerRef.current(ackEnvelope, ACK_CONTEXT);
      }
    });

    await expect(
      client.attach(
        createNode() as any,
        DeliveryOriginType.DOWNSTREAM,
        connector,
        welcomeFrame,
        jest.fn()
      )
    ).rejects.toThrow("Target system ID must be set in NodeAttachAckFrame on success");
  });

  it("throws when upstream event blocks the envelope", async () => {
    queueIds("corr-block", "trace-block");

    const dispatchEnvelopeEvent = jest.fn(async (event: string) => {
      if (event === "onForwardUpstream") {
        return null;
      }
      return createFameEnvelope({ frame: { type: "noop" } as any });
    });

    const node = createNode({ dispatchEnvelopeEvent }) as any;
    const { connector } = createConnector();
    const client = new DefaultNodeAttachClient({ timeoutMs: 20 });

    await expect(
      client.attach(node, DeliveryOriginType.DOWNSTREAM, connector, createWelcomeFrame(), jest.fn())
    ).rejects.toThrow("Envelope was blocked by onForwardUpstream event");

    expect(connector.send).not.toHaveBeenCalled();
  });

  it("propagates connector.send errors and completes upstream event with error", async () => {
    queueIds("corr-send", "trace-send");

    const { connector } = createConnector();

    const dispatched: FameEnvelope[] = [];
    const error = new Error("send failed");

    const dispatchEnvelopeEvent = jest.fn(
      async (
        event: string,
        _node: unknown,
        envelope: FameEnvelope,
        _context?: FameDeliveryContext,
        maybeError?: Error
      ) => {
        if (event === "onForwardUpstream") {
          dispatched.push(envelope);
          return envelope;
        }
        if (event === "onForwardUpstreamComplete" && maybeError) {
          return Promise.reject(maybeError);
        }
        return envelope;
      }
    );

    const node = createNode({ dispatchEnvelopeEvent }) as any;

    connector.send.mockImplementation(async () => {
      throw error;
    });

    const client = new DefaultNodeAttachClient({ timeoutMs: 20 });

    await expect(
      client.attach(node, DeliveryOriginType.DOWNSTREAM, connector, createWelcomeFrame(), jest.fn())
    ).rejects.toThrow("send failed");

    expect(dispatched).toHaveLength(1);
    expect(dispatchEnvelopeEvent).toHaveBeenCalledWith(
      "onForwardUpstreamComplete",
      node,
      expect.any(Object),
      undefined,
      expect.any(Error),
      expect.objectContaining({ expectedResponseType: FameResponseType.NONE })
    );
  });

  it("stops draining buffered envelopes when a null entry is encountered", async () => {
    queueIds("corr-null", "trace-null");

    const { connector, handlerRef } = createConnector();
    const welcomeFrame = createWelcomeFrame();

    const ackEnvelope = createAckEnvelope({ corrId: "corr-null" });
    const bufferedEnvelope = createFameEnvelope({
      frame: { type: "Data", payload: "after-null" } as any,
    });

    const finalHandler = jest.fn(async () => null);
    const client = new DefaultNodeAttachClient({ timeoutMs: 50 });

    connector.send.mockImplementation(async () => {
      if (handlerRef.current) {
        await handlerRef.current(ackEnvelope, ACK_CONTEXT);
        (client as any).buffer.push(null as unknown as FameEnvelope);
        await handlerRef.current(bufferedEnvelope, ACK_CONTEXT);
      }
    });

    const result = await client.attach(
      createNode() as any,
      DeliveryOriginType.DOWNSTREAM,
      connector,
      welcomeFrame,
      finalHandler
    );

    expect(result.assignedPath).toBe("welcome-path");
    expect(finalHandler).not.toHaveBeenCalledWith(bufferedEnvelope);
  });

  it("awaitAck throws when connector closes with details", async () => {
    const { connector } = createConnector();
    connector.state = ConnectorState.STOPPED;
    connector.closeCode = 4001;
    connector.closeReason = "manual-close";
    connector.lastError = new Error("network");

    const client = new DefaultNodeAttachClient({ timeoutMs: 10 });

    await expect((client as any).awaitAck(connector)).rejects.toThrow(
      "Connector closed while waiting for NodeAttachAck (code=4001, reason=manual-close) - Error: network"
    );
  });

  it("awaitAck skips unexpected frames before resolving", async () => {
    const { connector } = createConnector();
    const client = new DefaultNodeAttachClient({ timeoutMs: 50 });

    const unexpected = {
      id: "unexpected-id",
      traceId: "unexpected-trace",
      ts: new Date(),
      frame: { type: "NodeHello" },
    } as FameEnvelope;
    const ackEnvelope = createAckEnvelope({ corrId: "expected" });

    (client as any).buffer.push(unexpected);
    (client as any).buffer.push(ackEnvelope);

    const result = await (client as any).awaitAck(connector);
    expect(result).toBe(ackEnvelope);
  });

  it("awaitAck ignores null buffer entries before resolving with ack", async () => {
    const { connector } = createConnector();
    const client = new DefaultNodeAttachClient({ timeoutMs: 100 });

    const ackEnvelope = createAckEnvelope({ corrId: "expected-null" });

    (client as any).buffer.push(null as unknown as FameEnvelope);
    (client as any).buffer.push(ackEnvelope);

    await expect((client as any).awaitAck(connector)).resolves.toBe(ackEnvelope);
  });

  it("omits optional attach fields when welcome frame lacks them", async () => {
    queueIds("corr-optional", "trace-optional");

    const { connector, handlerRef } = createConnector();
    const welcomeFrame = createWelcomeFrame({
      acceptedCapabilities: [],
      acceptedLogicals: undefined,
    });
    const ackEnvelope = createAckEnvelope({ corrId: "corr-optional" });

    const node = createNode() as any;
    const finalHandler = jest.fn(async () => null);
    const client = new DefaultNodeAttachClient();

    connector.send.mockImplementation(async (sentEnvelope: FameEnvelope) => {
      const attachFrame = sentEnvelope.frame as any;
      expect((attachFrame as any).capabilities).toBeUndefined();
      expect((attachFrame as any).acceptedLogicals).toBeUndefined();

      if (handlerRef.current) {
        await handlerRef.current(ackEnvelope, ACK_CONTEXT);
      }
    });

    const result = await client.attach(
      node,
      DeliveryOriginType.DOWNSTREAM,
      connector,
      welcomeFrame,
      finalHandler
    );

    expect(result).not.toHaveProperty("acceptedLogicals");
  });

  it("awaitAck times out when no ack arrives", async () => {
    const { connector } = createConnector();
    const client = new DefaultNodeAttachClient({ timeoutMs: 5 });

    await expect((client as any).awaitAck(connector)).rejects.toThrow(
      "Timeout waiting for NodeAttachAck"
    );
  });
});
