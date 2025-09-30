import {
  DeliveryOriginType,
  FameAddress,
  FameResponseType,
  type CapabilityAdvertiseFrame,
  type CapabilityWithdrawFrame,
  type FameConnector,
  type FameDeliveryContext,
  type FameEnvelope,
} from "naylence-core";

import { CapabilityFrameHandler } from "../capability-frame-handler.js";
import type { RoutingNodeLike } from "../../node/routing-node-like.js";
import type { RouteManager } from "../route-manager.js";

jest.mock("../../util/logging.js", () => {
  const logger = {
    debug: jest.fn(),
    warning: jest.fn(),
  };

  return {
    getLogger: () => logger,
    __loggerMock: logger,
  };
});

type LoggerMock = {
  debug: jest.Mock;
  warning: jest.Mock;
};

const { __loggerMock: loggerMock } = jest.requireMock("../../util/logging.js") as {
  __loggerMock: LoggerMock;
};

type RoutingNodeMock = RoutingNodeLike & {
  envelopeFactory?: { createEnvelope: jest.Mock<FameEnvelope, [Record<string, unknown>]> };
  forwardToRoute: jest.Mock<Promise<void> | void, [string, FameEnvelope, FameDeliveryContext]>;
  forwardUpstream: jest.Mock<Promise<void> | void, [FameEnvelope, FameDeliveryContext]>;
};

function createRouteManager(segments: string[] = []): {
  routeManager: RouteManager & { downstreamRoutes: Map<string, FameConnector> };
  downstreamRoutes: Map<string, FameConnector>;
} {
  const downstreamRoutes = new Map<string, FameConnector>();
  for (const segment of segments) {
    downstreamRoutes.set(segment, {} as FameConnector);
  }

  const routeManager = {
    downstreamRoutes,
  } as unknown as RouteManager & { downstreamRoutes: Map<string, FameConnector> };

  return { routeManager, downstreamRoutes };
}

function createRoutingNode(overrides: Partial<RoutingNodeMock> = {}): RoutingNodeMock {
  const node: Partial<RoutingNodeMock> = {
    forwardToRoute: jest
      .fn(async (...args: Parameters<RoutingNodeMock["forwardToRoute"]>) => {
        void args;
        return undefined;
      })
      .mockName("forwardToRoute") as unknown as RoutingNodeMock["forwardToRoute"],
    forwardUpstream: jest
      .fn(async (...args: Parameters<RoutingNodeMock["forwardUpstream"]>) => {
        void args;
        return undefined;
      })
      .mockName("forwardUpstream") as unknown as RoutingNodeMock["forwardUpstream"],
    ...overrides,
  };

  if (!("envelopeFactory" in overrides)) {
    node.envelopeFactory = {
      createEnvelope: jest
        .fn((options: Parameters<RoutingNodeMock["envelopeFactory"]["createEnvelope"]>[0]) => ({
          id: `ack-${Math.random().toString(16).slice(2)}`,
          version: "1.0",
          ts: new Date(),
          frame: options.frame,
          corrId: options.corrId,
        }))
        .mockName(
          "createEnvelope"
        ) as unknown as RoutingNodeMock["envelopeFactory"]["createEnvelope"],
    };
  }

  return node as RoutingNodeMock;
}

function createContext(
  segment?: string,
  overrides: Partial<FameDeliveryContext> = {}
): FameDeliveryContext {
  const base: FameDeliveryContext = {
    originType: DeliveryOriginType.DOWNSTREAM,
    expectedResponseType: FameResponseType.NONE,
  };

  if (segment) {
    base.fromSystemId = segment;
  }

  return {
    ...base,
    ...overrides,
  } as FameDeliveryContext;
}

function createAdvertiseEnvelope(
  options: {
    capabilities?: string[];
    address?: FameAddress;
    corrId?: string;
    id?: string;
  } = {}
): FameEnvelope {
  const {
    capabilities = ["capability.default"],
    address = new FameAddress("svc@/default"),
    corrId,
    id,
  } = options;

  const frame: CapabilityAdvertiseFrame = {
    type: "CapabilityAdvertise",
    address,
    capabilities,
  };

  return {
    id: id ?? `adv-${Math.random().toString(16).slice(2)}`,
    version: "1.0",
    ts: new Date(),
    frame,
    corrId,
  } as FameEnvelope;
}

function createWithdrawEnvelope(
  options: {
    capabilities?: string[];
    address?: FameAddress;
    id?: string;
  } = {}
): FameEnvelope {
  const {
    capabilities = ["capability.default"],
    address = new FameAddress("svc@/default"),
    id,
  } = options;

  const frame: CapabilityWithdrawFrame = {
    type: "CapabilityWithdraw",
    address,
    capabilities,
  };

  return {
    id: id ?? `wd-${Math.random().toString(16).slice(2)}`,
    version: "1.0",
    ts: new Date(),
    frame,
  } as FameEnvelope;
}

describe("CapabilityFrameHandler", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("registers new capability routes and forwards ack upstream for first advertisement", async () => {
    const { routeManager } = createRouteManager(["segment-a"]);
    const routingNode = createRoutingNode();
    const handler = new CapabilityFrameHandler({
      routingNode,
      routeManager,
      upstreamConnector: () => ({}) as FameConnector,
    });

    const address = new FameAddress("svc@/alpha");
    const envelope = createAdvertiseEnvelope({
      capabilities: ["cap.alpha"],
      address,
      corrId: "corr-123",
      id: "env-alpha",
    });
    const context = createContext("segment-a", {
      security: {
        authorization: {
          authenticated: true,
          authorized: true,
          claims: {},
          grantedScopes: ["test"],
          restrictions: {},
        },
      },
      stickinessRequired: true,
      stickySid: "sticky-1",
    });

    await handler.acceptCapabilityAdvertise(envelope, context);

    expect(routingNode.forwardToRoute).toHaveBeenCalledTimes(1);
    const [targetSegment, ackEnvelope, ackContext] = routingNode.forwardToRoute.mock.calls[0];
    expect(targetSegment).toBe("segment-a");
    expect(ackEnvelope.frame).toEqual(
      expect.objectContaining({
        type: "CapabilityAdvertiseAck",
        capabilities: ["cap.alpha"],
        ok: true,
        refId: "env-alpha",
      })
    );
    expect(ackEnvelope.corrId).toBe("corr-123");
    expect(ackContext.originType).toBe(DeliveryOriginType.LOCAL);
    expect(routingNode.forwardUpstream).toHaveBeenCalledWith(envelope, expect.any(Object));
    expect(handler.capRoutes).toEqual({
      "cap.alpha": {
        [address.toString()]: "segment-a",
      },
    });
  });

  it("does not forward upstream when capability already registered for the segment", async () => {
    const { routeManager } = createRouteManager(["segment-a"]);
    const routingNode = createRoutingNode();
    const handler = new CapabilityFrameHandler({
      routingNode,
      routeManager,
      upstreamConnector: () => ({}) as FameConnector,
    });

    const envelope = createAdvertiseEnvelope({ capabilities: ["cap.alpha"] });
    const context = createContext("segment-a");

    await handler.acceptCapabilityAdvertise(envelope, context);
    routingNode.forwardUpstream.mockClear();

    await handler.acceptCapabilityAdvertise(envelope, context);

    expect(routingNode.forwardUpstream).not.toHaveBeenCalled();
    expect(handler.capRoutes).toEqual({
      "cap.alpha": {
        [new FameAddress("svc@/default").toString()]: "segment-a",
      },
    });
  });

  it("ignores advertisements from unknown segments", async () => {
    const { routeManager } = createRouteManager();
    const routingNode = createRoutingNode();
    const handler = new CapabilityFrameHandler({
      routingNode,
      routeManager,
      upstreamConnector: () => null,
    });

    const context = createContext("segment-missing");
    const envelope = createAdvertiseEnvelope();

    await handler.acceptCapabilityAdvertise(envelope, context);

    expect(loggerMock.debug).toHaveBeenCalledWith("capability_advertise_unknown_segment", {
      segment: "segment-missing",
    });
    expect(routingNode.forwardToRoute).not.toHaveBeenCalled();
    expect(handler.capRoutes).toEqual({});
  });

  it("does not propagate upstream when upstream lookup throws", async () => {
    const { routeManager } = createRouteManager(["segment-a"]);
    const routingNode = createRoutingNode();
    const handler = new CapabilityFrameHandler({
      routingNode,
      routeManager,
      upstreamConnector: () => {
        throw new Error("upstream unavailable");
      },
    });

    const envelope = createAdvertiseEnvelope({ capabilities: ["cap.alpha"] });
    const context = createContext("segment-a");

    await handler.acceptCapabilityAdvertise(envelope, context);

    expect(routingNode.forwardUpstream).not.toHaveBeenCalled();
    expect(routingNode.forwardToRoute).toHaveBeenCalledTimes(1);
  });

  it("ignores withdraw frames without source segment", async () => {
    const { routeManager } = createRouteManager(["segment-a"]);
    const routingNode = createRoutingNode();
    const handler = new CapabilityFrameHandler({
      routingNode,
      routeManager,
      upstreamConnector: () => ({}) as FameConnector,
    });

    const withdrawEnvelope = createWithdrawEnvelope();

    await handler.acceptCapabilityWithdraw(withdrawEnvelope, undefined);

    expect(loggerMock.debug).toHaveBeenCalledWith("capability_withdraw_missing_segment");
    expect(routingNode.forwardToRoute).not.toHaveBeenCalled();
  });

  it("removes capability routes and forwards upstream when last subscriber withdraws", async () => {
    const { routeManager } = createRouteManager(["segment-a"]);
    const routingNode = createRoutingNode();
    const handler = new CapabilityFrameHandler({
      routingNode,
      routeManager,
      upstreamConnector: () => ({}) as FameConnector,
    });

    const address = new FameAddress("svc@/alpha");
    const advertise = createAdvertiseEnvelope({
      capabilities: ["cap.alpha"],
      address,
      id: "adv-1",
    });
    const context = createContext("segment-a");

    await handler.acceptCapabilityAdvertise(advertise, context);
    routingNode.forwardUpstream.mockClear();

    const withdraw = createWithdrawEnvelope({ capabilities: ["cap.alpha"], address, id: "wd-1" });
    await handler.acceptCapabilityWithdraw(withdraw, context);

    expect(routingNode.forwardToRoute).toHaveBeenCalledTimes(2);
    expect(routingNode.forwardUpstream).toHaveBeenCalledWith(withdraw, expect.any(Object));
    expect(handler.capRoutes).toEqual({});
  });

  it("retains capability routes when withdraw originates from different segment", async () => {
    const { routeManager } = createRouteManager(["segment-a", "segment-b"]);
    const routingNode = createRoutingNode();
    const handler = new CapabilityFrameHandler({
      routingNode,
      routeManager,
      upstreamConnector: () => ({}) as FameConnector,
    });

    const address = new FameAddress("svc@/alpha");
    const advertise = createAdvertiseEnvelope({ capabilities: ["cap.alpha"], address });
    await handler.acceptCapabilityAdvertise(advertise, createContext("segment-a"));

    routingNode.forwardUpstream.mockClear();

    const withdrawEnvelope = createWithdrawEnvelope({ capabilities: ["cap.alpha"], address });
    await handler.acceptCapabilityWithdraw(withdrawEnvelope, createContext("segment-b"));

    expect(routingNode.forwardUpstream).not.toHaveBeenCalled();
    expect(handler.capRoutes).toEqual({
      "cap.alpha": {
        [address.toString()]: "segment-a",
      },
    });
  });

  it("logs warning when envelope factory is missing for ack delivery", async () => {
    const { routeManager } = createRouteManager(["segment-a"]);
    const routingNode = createRoutingNode();
    delete (routingNode as { envelopeFactory?: unknown }).envelopeFactory;
    const handler = new CapabilityFrameHandler({
      routingNode,
      routeManager,
      upstreamConnector: () => ({}) as FameConnector,
    });

    const envelope = createAdvertiseEnvelope({ capabilities: ["cap.alpha"] });
    const context = createContext("segment-a");

    await handler.acceptCapabilityAdvertise(envelope, context);

    expect(loggerMock.warning).toHaveBeenCalledWith("missing_envelope_factory_for_capability_ack");
    expect(routingNode.forwardToRoute).not.toHaveBeenCalled();
  });
});
