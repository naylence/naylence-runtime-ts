import { ConnectorState, type FameEnvelope } from "naylence-core";

import "../../security/index.js";
import "../../node/index.js";
import "../../connector/index.js";
import "../../sentinel/index.js";
import "../../delivery/index.js";
import "../../stickiness/index.js";

import { WebSocketConnector } from "../../connector/websocket-connector.js";
import { getWebsocketListenerInstance } from "../../connector/websocket-listener.js";
import { DefaultHttpServer } from "../../connector/default-http-server.js";
import { SentinelFactory } from "../sentinel-factory.js";
import type { Sentinel } from "../sentinel.js";
import type { RouteManager } from "../route-manager.js";
import { NodeFactory } from "../../node/node-factory.js";
import type { FameNode } from "../../node/node.js";
import type { NodeEventListener } from "../../node/node-event-listener.js";
import { UpstreamSessionManager } from "../../node/upstream-session-manager.js";
import { basicConfig, LogLevel } from "../../util/logging.js";

jest.mock("fastify", () => {
  const actual = jest.requireActual("fastify");
  return (...args: unknown[]) => {
    const instance = actual(...args);
    Object.defineProperty(instance, "version", {
      value: actual.version ?? instance.version ?? "5.6.1",
      configurable: true,
    });
    return instance;
  };
});

jest.setTimeout(20000);

const SOCKET_HOST = "127.0.0.1";
const WAIT_TIMEOUT_MS = 10_000;
const WAIT_INTERVAL_MS = 50;

function createSecurityConfig(): Record<string, unknown> {
  return {
    type: "DefaultSecurityManager",
    authorizer: { type: "NoopAuthorizer" },
    security_policy: {
      type: "NoSecurityPolicy",
    },
  } satisfies Record<string, unknown>;
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = WAIT_TIMEOUT_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      if (predicate()) {
        return;
      }
    } catch {
      // Ignore transient predicate errors while waiting.
    }

    await new Promise((resolve) => {
      setTimeout(resolve, WAIT_INTERVAL_MS);
    });
  }

  throw new Error("Timed out waiting for condition");
}

type UpstreamTimingOverrideKey =
  | "HEARTBEAT_INTERVAL"
  | "HEARTBEAT_GRACE"
  | "BACKOFF_INITIAL"
  | "BACKOFF_CAP";

function overrideUpstreamSessionManagerTiming(
  overrides: Partial<Record<UpstreamTimingOverrideKey, number>>
): () => void {
  const manager = UpstreamSessionManager as unknown as Record<UpstreamTimingOverrideKey, number>;
  const previous = new Map<UpstreamTimingOverrideKey, number>();

  for (const [key, value] of Object.entries(overrides) as Array<
    [UpstreamTimingOverrideKey, number | undefined]
  >) {
    if (value === undefined) {
      continue;
    }
    previous.set(key, manager[key]);
    manager[key] = value;
  }

  return () => {
    for (const [key, value] of previous.entries()) {
      manager[key] = value;
    }
  };
}

describe("Sentinel downstream node integration", () => {
  beforeAll(() => {
    basicConfig({ level: LogLevel.ERROR });
  });

  afterEach(async () => {
    await DefaultHttpServer.shutdownAll();
  });

  test("downstream node binds logical address and propagates upstream", async () => {
    const sentinelFactory = new SentinelFactory();
    const nodeFactory = new NodeFactory();

    let parent: Sentinel | null = null;
    let child: FameNode | null = null;

    try {
      parent = await sentinelFactory.create({
        type: "Sentinel",
        id: "parent-sentinel",
        security: createSecurityConfig(),
        admission: {
          type: "NoopAdmissionClient",
          autoAcceptLogicals: true,
        },
        delivery: {
          type: "AtLeastOnceDeliveryPolicy",
        },
        routingPolicy: {
          type: "CompositeRoutingPolicy",
        },
        listeners: [
          {
            type: "WebSocketListener",
            host: SOCKET_HOST,
            port: 0,
          },
        ],
      });

      await parent.start();

      const serverListener = getWebsocketListenerInstance();
      expect(serverListener).toBeTruthy();

      await waitForCondition(() => Boolean(serverListener?.baseUrl));

      const baseUrl = serverListener?.baseUrl;
      expect(baseUrl).toBeTruthy();

      const wsBaseUrl = baseUrl!.startsWith("https://")
        ? baseUrl!.replace("https://", "wss://")
        : baseUrl!.replace("http://", "ws://");
      const downstreamAttachUrl = `${wsBaseUrl}${serverListener!.attachPrefix}/ws/downstream`;

      child = await nodeFactory.create({
        type: "Node",
        id: "child-node",
        hasParent: true,
        requestedLogicals: ["svc"],
        security: createSecurityConfig(),
        delivery: {
          type: "AtLeastOnceDeliveryPolicy",
        },
        admission: {
          type: "DirectAdmissionClient",
          connectionGrants: [
            {
              type: "WebSocketConnectionGrant",
              purpose: "node.attach",
              url: downstreamAttachUrl,
            },
          ],
          ttlSec: 60,
        },
      });

      await child.start();

      await waitForCondition(() => child?.handshakeCompleted === true);

      const routeManager = (parent as unknown as { routeManager: RouteManager }).routeManager;
      await waitForCondition(() => routeManager.downstreamRoutes.has(child!.id));

      const upstreamConnector = child.upstreamConnector;
      expect(upstreamConnector).toBeInstanceOf(WebSocketConnector);
      expect(upstreamConnector?.state).toBe(ConnectorState.STARTED);

      const binding = await child.bind("svc");
      const addressKey = binding.address.toString();

      await waitForCondition(() => routeManager._downstream_addresses_routes.has(addressKey));

      const routeInfo = routeManager._downstream_addresses_routes.get(addressKey);
      expect(routeInfo).toBeTruthy();
      expect(routeInfo?.segment).toBe(child.id);
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await Promise.allSettled([child?.stop(), parent?.stop()]);
    }
  });

  test("downstream node automatically reconnects after parent disconnect", async () => {
    const sentinelFactory = new SentinelFactory();
    const nodeFactory = new NodeFactory();

    const restoreUpstreamTiming = overrideUpstreamSessionManagerTiming({
      HEARTBEAT_INTERVAL: 0.5,
      HEARTBEAT_GRACE: 0.5,
      BACKOFF_INITIAL: 0.05,
      BACKOFF_CAP: 0.5,
    });
    const FAST_RECONNECT_TIMEOUT_MS = 4_000;

    let parent: Sentinel | null = null;
    let child: FameNode | null = null;

    try {
      parent = await sentinelFactory.create({
        type: "Sentinel",
        id: "parent-sentinel",
        security: createSecurityConfig(),
        admission: {
          type: "NoopAdmissionClient",
          autoAcceptLogicals: true,
        },
        delivery: {
          type: "AtLeastOnceDeliveryPolicy",
        },
        routingPolicy: {
          type: "CompositeRoutingPolicy",
        },
        listeners: [
          {
            type: "WebSocketListener",
            host: SOCKET_HOST,
            port: 0,
          },
        ],
      });

      await parent.start();

      const serverListener = getWebsocketListenerInstance();
      expect(serverListener).toBeTruthy();

      await waitForCondition(() => Boolean(serverListener?.baseUrl));

      const baseUrl = serverListener?.baseUrl;
      expect(baseUrl).toBeTruthy();

      const wsBaseUrl = baseUrl!.startsWith("https://")
        ? baseUrl!.replace("https://", "wss://")
        : baseUrl!.replace("http://", "ws://");
      const downstreamAttachUrl = `${wsBaseUrl}${serverListener!.attachPrefix}/ws/downstream`;

      child = await nodeFactory.create({
        type: "Node",
        id: "child-node",
        hasParent: true,
        requestedLogicals: ["svc"],
        security: createSecurityConfig(),
        delivery: {
          type: "AtLeastOnceDeliveryPolicy",
        },
        admission: {
          type: "DirectAdmissionClient",
          connectionGrants: [
            {
              type: "WebSocketConnectionGrant",
              purpose: "node.attach",
              url: downstreamAttachUrl,
            },
          ],
          ttlSec: 60,
        },
      });

      await child.start();

      await waitForCondition(() => child?.handshakeCompleted === true);

      const routeManager = (parent as unknown as { routeManager: RouteManager }).routeManager;
      const childId = child!.id;

      await waitForCondition(() => routeManager.downstreamRoutes.has(childId));

      const initialParentConnector = routeManager.downstreamRoutes.get(childId);
      const initialChildConnector = child!.upstreamConnector;

      expect(initialParentConnector).toBeInstanceOf(WebSocketConnector);
      expect(initialChildConnector).toBeInstanceOf(WebSocketConnector);
      expect((initialChildConnector as WebSocketConnector | null)?.state).toBe(
        ConnectorState.STARTED
      );

      await routeManager.unregisterDownstreamRoute(childId);

      await waitForCondition(() => !routeManager.downstreamRoutes.has(childId));

      await waitForCondition(
        () => child?.upstreamConnector !== initialChildConnector,
        FAST_RECONNECT_TIMEOUT_MS
      );

      await waitForCondition(() => {
        const connector = routeManager.downstreamRoutes.get(childId);
        return Boolean(connector && connector !== initialParentConnector);
      }, FAST_RECONNECT_TIMEOUT_MS);

      const reconnectedParentConnector = routeManager.downstreamRoutes.get(childId);
      expect(reconnectedParentConnector).toBeInstanceOf(WebSocketConnector);
      expect(reconnectedParentConnector).not.toBe(initialParentConnector);

      await waitForCondition(() => {
        const connector = child?.upstreamConnector as WebSocketConnector | null;
        return Boolean(
          connector &&
            connector !== initialChildConnector &&
            connector.state === ConnectorState.STARTED
        );
      }, FAST_RECONNECT_TIMEOUT_MS);

      const reconnectedChildConnector = child!.upstreamConnector as WebSocketConnector;
      expect(reconnectedChildConnector).not.toBe(initialChildConnector);
      expect(reconnectedChildConnector.state).toBe(ConnectorState.STARTED);
    } finally {
      restoreUpstreamTiming();
      await new Promise((resolve) => setTimeout(resolve, 300));
      await Promise.allSettled([child?.stop(), parent?.stop()]);
    }
  });

  test("downstream node sends heartbeat and receives ack from parent sentinel", async () => {
    const sentinelFactory = new SentinelFactory();
    const nodeFactory = new NodeFactory();

    const restoreUpstreamTiming = overrideUpstreamSessionManagerTiming({
      HEARTBEAT_INTERVAL: 0.2,
      HEARTBEAT_GRACE: 5,
    });
    const HEARTBEAT_WAIT_TIMEOUT_MS = 4_000;

    const heartbeatsSent: FameEnvelope[] = [];
    const heartbeatAcks: FameEnvelope[] = [];

    let parent: Sentinel | null = null;
    let child: FameNode | null = null;

    const captureEnvelope = (first?: unknown, second?: unknown): FameEnvelope | undefined => {
      const candidates = [first, second];
      for (const candidate of candidates) {
        if (candidate && typeof candidate === "object" && "frame" in candidate) {
          return candidate as FameEnvelope;
        }
      }
      return undefined;
    };

    const heartbeatListener: NodeEventListener = {
      priority: 100,
      async onHeartbeatSent(firstArg?: unknown, secondArg?: unknown) {
        const envelope = captureEnvelope(firstArg, secondArg);
        if (envelope) {
          heartbeatsSent.push(envelope);
        }
      },
      async onHeartbeatReceived(firstArg?: unknown, secondArg?: unknown) {
        const envelope = captureEnvelope(firstArg, secondArg);
        if (envelope) {
          heartbeatAcks.push(envelope);
        }
      },
    };

    try {
      parent = await sentinelFactory.create({
        type: "Sentinel",
        id: "parent-sentinel",
        security: createSecurityConfig(),
        admission: {
          type: "NoopAdmissionClient",
          autoAcceptLogicals: true,
        },
        delivery: {
          type: "AtLeastOnceDeliveryPolicy",
        },
        routingPolicy: {
          type: "CompositeRoutingPolicy",
        },
        listeners: [
          {
            type: "WebSocketListener",
            host: SOCKET_HOST,
            port: 0,
          },
        ],
      });

      await parent.start();

      const serverListener = getWebsocketListenerInstance();
      expect(serverListener).toBeTruthy();

      await waitForCondition(() => Boolean(serverListener?.baseUrl));

      const baseUrl = serverListener?.baseUrl;
      expect(baseUrl).toBeTruthy();

      const wsBaseUrl = baseUrl!.startsWith("https://")
        ? baseUrl!.replace("https://", "wss://")
        : baseUrl!.replace("http://", "ws://");
      const downstreamAttachUrl = `${wsBaseUrl}${serverListener!.attachPrefix}/ws/downstream`;

      child = await nodeFactory.create({
        type: "Node",
        id: "child-node",
        hasParent: true,
        requestedLogicals: ["svc"],
        security: createSecurityConfig(),
        delivery: {
          type: "AtLeastOnceDeliveryPolicy",
        },
        admission: {
          type: "DirectAdmissionClient",
          connectionGrants: [
            {
              type: "WebSocketConnectionGrant",
              purpose: "node.attach",
              url: downstreamAttachUrl,
            },
          ],
          ttlSec: 60,
        },
      });

      child.addEventListener(heartbeatListener);

      await child.start();

      await waitForCondition(() => child?.handshakeCompleted === true);

      const routeManager = (parent as unknown as { routeManager: RouteManager }).routeManager;
      await waitForCondition(() => routeManager.downstreamRoutes.has(child!.id));

      await waitForCondition(() => heartbeatsSent.length > 0, HEARTBEAT_WAIT_TIMEOUT_MS);
      await waitForCondition(() => heartbeatAcks.length > 0, HEARTBEAT_WAIT_TIMEOUT_MS);

      const sentHeartbeat = heartbeatsSent[heartbeatsSent.length - 1];
      expect(sentHeartbeat.frame?.type).toBe("NodeHeartbeat");

      const ackEnvelope =
        heartbeatAcks.find((ack) => ack.corrId && ack.corrId === sentHeartbeat.corrId) ??
        heartbeatAcks[heartbeatAcks.length - 1];
      expect(ackEnvelope).toBeTruthy();

      const ackFrame = ackEnvelope!.frame as
        | { type?: string; ok?: boolean; refId?: string | null }
        | undefined;
      expect(ackFrame?.type).toBe("NodeHeartbeatAck");
      expect(ackFrame?.ok).not.toBe(false);
      expect(ackFrame?.refId).toBe(sentHeartbeat.id);
      expect(ackEnvelope!.corrId).toBe(sentHeartbeat.corrId);
    } finally {
      try {
        child?.removeEventListener(heartbeatListener);
      } catch {
        // Ignore listener removal issues during cleanup
      }
      restoreUpstreamTiming();
      await new Promise((resolve) => setTimeout(resolve, 300));
      await Promise.allSettled([child?.stop(), parent?.stop()]);
    }
  });
});
