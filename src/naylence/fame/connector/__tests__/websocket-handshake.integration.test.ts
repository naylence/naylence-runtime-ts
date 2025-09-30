import { ConnectorState } from "naylence-core";

import "../../security/index.js";
import "../../node/index.js";
import "../../connector/index.js";
import "../../sentinel/index.js";
import "../../delivery/index.js";
import "../../stickiness/index.js";

import { WebSocketConnector } from "../websocket-connector.js";
import { getWebsocketListenerInstance } from "../websocket-listener.js";
import { DefaultHttpServer } from "../default-http-server.js";
import { SentinelFactory } from "../../sentinel/sentinel-factory.js";
import type { Sentinel } from "../../sentinel/sentinel.js";
import type { RouteManager } from "../../sentinel/route-manager.js";
import { basicConfig, LogLevel } from "../../util/logging.js";

jest.mock("fastify", () => {
  const actual = jest.requireActual("fastify");
  return (...args: unknown[]) => {
    const instance = actual(...args);
    Object.defineProperty(instance, "version", {
      value: "4.99.0",
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

describe("WebSocket Sentinel integration", () => {
  beforeAll(() => {
    basicConfig({ level: LogLevel.DEBUG, format: "json" });
  });

  afterEach(async () => {
    await DefaultHttpServer.shutdownAll();
  });

  test("downstream sentinel performs a real WebSocket attach", async () => {
    const sentinelFactory = new SentinelFactory();
    let server: Sentinel | null = null;
    let child: Sentinel | null = null;

    try {
      server = await sentinelFactory.create({
        type: "Sentinel",
        id: "parent-node",
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

      await server.start();

      const serverListener = getWebsocketListenerInstance();
      expect(serverListener).toBeTruthy();

      await waitForCondition(() => Boolean(serverListener?.baseUrl));

      const baseUrl = serverListener?.baseUrl;
      expect(baseUrl).toBeTruthy();

      const wsBaseUrl = baseUrl!.startsWith("https://")
        ? baseUrl!.replace("https://", "wss://")
        : baseUrl!.replace("http://", "ws://");
      const downstreamAttachUrl = `${wsBaseUrl}${serverListener!.attachPrefix}/ws/downstream`;

      child = await sentinelFactory.create({
        type: "Sentinel",
        id: "child-node",
        hasParent: true,
        security: createSecurityConfig(),
        delivery: {
          type: "AtLeastOnceDeliveryPolicy",
        },
        routingPolicy: {
          type: "CompositeRoutingPolicy",
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

      expect(child.admissionClient).toBeTruthy();

      await child.start();

      await waitForCondition(() => child?.handshakeCompleted === true);

      const routeManager = (server as unknown as { routeManager: RouteManager }).routeManager;
      await waitForCondition(() => routeManager.downstreamRoutes.has(child!.id));

      const serverConnector = routeManager.downstreamRoutes.get(child.id);
      expect(serverConnector).toBeInstanceOf(WebSocketConnector);

      const childConnector = child.upstreamConnector;
      expect(childConnector).toBeInstanceOf(WebSocketConnector);
      expect(childConnector?.state).toBe(ConnectorState.STARTED);
    } finally {
      await Promise.allSettled([child?.stop(), server?.stop()]);
    }
  });
});
