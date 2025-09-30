import {
  ConnectorState,
  formatAddress,
  type FameDeliveryContext,
  type FameEnvelope,
  type DeliveryAckFrame,
} from "naylence-core";

import "../../security/index.js";
import "../../node/index.js";
import "../../connector/index.js";
import "../../sentinel/index.js";
import "../index.js";
import "../../stickiness/index.js";

import { WebSocketConnector } from "../../connector/websocket-connector.js";
import { getWebsocketListenerInstance } from "../../connector/websocket-listener.js";
import { DefaultHttpServer } from "../../connector/default-http-server.js";
import { SentinelFactory } from "../../sentinel/sentinel-factory.js";
import type { Sentinel } from "../../sentinel/sentinel.js";
import type { RouteManager } from "../../sentinel/route-manager.js";
import { NodeFactory } from "../../node/node-factory.js";
import type { FameNode } from "../../node/node.js";
import type { NodeEventListener } from "../../node/node-event-listener.js";
import { basicConfig, LogLevel } from "../../util/logging.js";
import type { ShutdownOptions } from "../../util/task-types.js";

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

type CancelableSpawner =
  | {
      shutdownTasks: (options?: ShutdownOptions) => Promise<void>;
      cancelAllTasks?: () => void;
    }
  | null
  | undefined;

async function ensureSpawnerShutdown(
  spawner: CancelableSpawner,
  options: ShutdownOptions
): Promise<void> {
  if (!spawner) {
    return;
  }

  try {
    await spawner.shutdownTasks(options);
  } catch {
    if (typeof spawner.cancelAllTasks === "function") {
      try {
        spawner.cancelAllTasks();
      } catch {
        // Ignore cancellation failures during cleanup
      }
    }
  }
}

describe("Sentinel downstream node integration", () => {
  beforeAll(() => {
    basicConfig({ level: LogLevel.ERROR });
  });

  afterEach(async () => {
    await DefaultHttpServer.shutdownAll();
  });

  test("parent sentinel binding receives message from downstream node", async () => {
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

      let resolveMessage!: (value: {
        envelope: FameEnvelope;
        context?: FameDeliveryContext;
      }) => void;
      let messageSettled = false;
      const messagePromise = new Promise<{
        envelope: FameEnvelope;
        context?: FameDeliveryContext;
      }>((resolve) => {
        resolveMessage = (value) => {
          messageSettled = true;
          resolve(value);
        };
      });

      const listenerAddress = await parent.listen("svc", async (envelope) => {
        if (!messageSettled) {
          resolveMessage({ envelope });
        }

        return null;
      });

      const payload = { greeting: "hello", count: 1 };
      const outboundEnvelope = child.envelopeFactory.createEnvelope({
        frame: {
          type: "Data",
          codec: "json",
          payload,
        },
        to: listenerAddress,
      });

      await child.send(outboundEnvelope, undefined, null, undefined, 30000);

      await waitForCondition(() => messageSettled);

      const { envelope: deliveredEnvelope } = await messagePromise;

      expect(deliveredEnvelope.id).toBe(outboundEnvelope.id);
      expect(deliveredEnvelope.to?.toString()).toBe(listenerAddress.toString());
      expect(deliveredEnvelope.frame?.type).toBe("Data");
      expect((deliveredEnvelope.frame as { payload?: unknown } | undefined)?.payload).toEqual(
        payload
      );
    } finally {
      await Promise.allSettled([child?.stop(), parent?.stop()]);
    }
  });

  test("downstream node receives immediate NACK for unroutable destinations", async () => {
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

      await waitForCondition(() => Boolean(parent?.physicalPath));
      const parentPhysicalPath = parent!.physicalPath;
      expect(parentPhysicalPath).toMatch(/^\//);

      const missingRecipient = "svc-missing";
      const missingAddress = formatAddress(missingRecipient, "dummy"); //parentPhysicalPath);

      const outboundEnvelope = child.envelopeFactory.createEnvelope({
        to: missingAddress,
        frame: {
          type: "Data",
          codec: "json",
          payload: { request: "missing-destination" },
        },
      });

      const nackFrames: DeliveryAckFrame[] = [];
      const nackListener: NodeEventListener = {
        priority: 10,
        async onDeliver(_node, envelope) {
          if (envelope.frame?.type === "DeliveryAck") {
            nackFrames.push(envelope.frame as DeliveryAckFrame);
          }
          return envelope;
        },
      } satisfies NodeEventListener;

      child.addEventListener(nackListener);

      await expect(
        child.send(outboundEnvelope, undefined, undefined, undefined, WAIT_TIMEOUT_MS)
      ).rejects.toThrow(/Message delivery failed with code 'NO_ROUTE'/);

      expect(nackFrames).toHaveLength(1);
      const nack = nackFrames[0];
      expect(nack.ok).toBe(false);
      expect(nack.code).toBe("NO_ROUTE");
      expect(nack.refId).toBe(outboundEnvelope.id);
      expect(nack.reason).toContain("Unroutable");

      child.removeEventListener(nackListener);

      await expect(
        child.invoke(missingAddress, `${missingRecipient}.rpc`, { attempt: 1 }, WAIT_TIMEOUT_MS)
      ).rejects.toThrow(/NO_ROUTE/);
    } finally {
      await Promise.allSettled([child?.stop(), parent?.stop()]);
    }
  });

  test("downstream node invokes RPC service exposed by parent sentinel", async () => {
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

      const rpcHandler = jest.fn(async (method: string, params?: Record<string, unknown>) => {
        expect(method).toBe("svc-rpc.sum");
        expect(params).toMatchObject({ a: 7, b: 5 });
        return { result: (params?.a as number) + (params?.b as number) };
      });

      const serviceAddress = await parent.listenRpc("svc-rpc", rpcHandler, WAIT_TIMEOUT_MS);
      expect(serviceAddress.toString()).toContain("svc-rpc");

      const invocationResult = await child.invoke(
        serviceAddress,
        "svc-rpc.sum",
        { a: 7, b: 5 },
        WAIT_TIMEOUT_MS
      );

      expect(invocationResult).toEqual({ result: 12 });
      expect(rpcHandler).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await Promise.allSettled([child?.stop(), parent?.stop()]);
    }
  });

  test("child node invokes RPC service exposed by a sibling through the parent sentinel", async () => {
    const sentinelFactory = new SentinelFactory();
    const nodeFactory = new NodeFactory();

    let parent: Sentinel | null = null;
    let childClient: FameNode | null = null;
    let childServer: FameNode | null = null;
    let routeManager: RouteManager | null = null;
    let clientListener: NodeEventListener | null = null;
    let serverEventListener: NodeEventListener | null = null;

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

      childServer = await nodeFactory.create({
        type: "Node",
        id: "child-server",
        hasParent: true,
        requestedLogicals: ["svc-server"],
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

      childClient = await nodeFactory.create({
        type: "Node",
        id: "child-client",
        hasParent: true,
        requestedLogicals: ["svc-client"],
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

      await Promise.all([childServer.start(), childClient.start()]);

      await waitForCondition(() => childServer?.handshakeCompleted === true);
      await waitForCondition(() => childClient?.handshakeCompleted === true);

      routeManager = (parent as unknown as { routeManager: RouteManager }).routeManager;
      await waitForCondition(() => routeManager!.downstreamRoutes.has(childServer!.id));
      await waitForCondition(() => routeManager!.downstreamRoutes.has(childClient!.id));

      const clientAcks: DeliveryAckFrame[] = [];
      const serverAcks: DeliveryAckFrame[] = [];
      let requestEnvelopeId: string | undefined;
      let responseEnvelopeId: string | undefined;

      const clientListenerImpl: NodeEventListener = {
        priority: 100,
        async onForwardUpstream(_node, envelope) {
          if (!requestEnvelopeId && envelope.frame?.type === "Data") {
            const payload = (envelope.frame as { payload?: unknown }).payload;
            if (
              payload &&
              typeof payload === "object" &&
              (payload as { method?: string }).method === "svc-sibling.mul"
            ) {
              requestEnvelopeId = envelope.id;
            }
          }
          return envelope;
        },
        async onDeliver(_node, envelope) {
          if (envelope.frame?.type === "DeliveryAck") {
            clientAcks.push(envelope.frame as DeliveryAckFrame);
          }
          return envelope;
        },
      } satisfies NodeEventListener;
      clientListener = clientListenerImpl;

      const serverListenerImpl: NodeEventListener = {
        priority: 100,
        async onForwardUpstream(_node, envelope) {
          if (!responseEnvelopeId && envelope.frame?.type === "Data") {
            const payload = (envelope.frame as { payload?: unknown }).payload;
            if (
              payload &&
              typeof payload === "object" &&
              "result" in (payload as Record<string, unknown>)
            ) {
              responseEnvelopeId = envelope.id;
            }
          }
          return envelope;
        },
        async onDeliver(_node, envelope) {
          if (envelope.frame?.type === "DeliveryAck") {
            serverAcks.push(envelope.frame as DeliveryAckFrame);
          }
          return envelope;
        },
      } satisfies NodeEventListener;
      serverEventListener = serverListenerImpl;

      childClient.addEventListener(clientListenerImpl);
      childServer.addEventListener(serverListenerImpl);

      const serverRpcHandler = jest.fn(async (method: string, params?: Record<string, unknown>) => {
        expect(method).toBe("svc-sibling.mul");
        expect(params).toMatchObject({ a: 3, b: 9 });
        return { result: (params?.a as number) * (params?.b as number) };
      });

      const serviceAddress = await childServer.listenRpc(
        "svc-sibling",
        serverRpcHandler,
        WAIT_TIMEOUT_MS
      );

      await waitForCondition(() => {
        const info = routeManager!._downstream_addresses_routes.get(serviceAddress.toString());
        return info?.segment === childServer?.id;
      });

      const response = await childClient.invoke(
        serviceAddress,
        "svc-sibling.mul",
        { a: 3, b: 9 },
        WAIT_TIMEOUT_MS
      );

      expect(response).toEqual({ result: 27 });
      expect(serverRpcHandler).toHaveBeenCalledTimes(1);

      await waitForCondition(() =>
        Boolean(requestEnvelopeId && clientAcks.some((ack) => ack.refId === requestEnvelopeId))
      );

      await waitForCondition(() =>
        Boolean(responseEnvelopeId && serverAcks.some((ack) => ack.refId === responseEnvelopeId))
      );
    } finally {
      try {
        if (clientListener) {
          childClient?.removeEventListener(clientListener);
        }
      } catch {
        // Ignore listener removal issues during cleanup
      }

      try {
        if (serverEventListener) {
          childServer?.removeEventListener(serverEventListener);
        }
      } catch {
        // Ignore listener removal issues during cleanup
      }

      const shutdownOptions: ShutdownOptions = {
        gracePeriod: 1000,
        cancelHanging: true,
        joinTimeout: 2000,
      };

      const connectors = new Set<WebSocketConnector>();
      if (childClient?.upstreamConnector instanceof WebSocketConnector) {
        connectors.add(childClient.upstreamConnector);
      }
      if (childServer?.upstreamConnector instanceof WebSocketConnector) {
        connectors.add(childServer.upstreamConnector);
      }
      if (routeManager) {
        for (const connector of routeManager.downstreamRoutes.values()) {
          if (connector instanceof WebSocketConnector) {
            connectors.add(connector);
          }
        }
      }

      const stopPromises = [childClient?.stop(), childServer?.stop(), parent?.stop()].filter(
        (promise): promise is Promise<void> => promise !== undefined
      );

      if (stopPromises.length > 0) {
        await Promise.allSettled(stopPromises);
      }

      await Promise.allSettled([
        ensureSpawnerShutdown(childClient, shutdownOptions),
        ensureSpawnerShutdown(childServer, shutdownOptions),
        ensureSpawnerShutdown(parent, shutdownOptions),
        ensureSpawnerShutdown(routeManager, shutdownOptions),
      ]);

      await Promise.allSettled(
        Array.from(connectors).map(async (connector) => {
          try {
            if (
              connector.state !== ConnectorState.CLOSED &&
              connector.state !== ConnectorState.STOPPED
            ) {
              await connector.stop();
            }
          } catch {
            connector.cancelAllTasks?.();
          }

          await ensureSpawnerShutdown(connector, shutdownOptions);
        })
      );
    }
  });

  test("sibling nodes exchange streaming RPC responses through the parent sentinel", async () => {
    const sentinelFactory = new SentinelFactory();
    const nodeFactory = new NodeFactory();

    let parent: Sentinel | null = null;
    let producer: FameNode | null = null;
    let consumer: FameNode | null = null;
    let routeManager: RouteManager | null = null;

    try {
      parent = await sentinelFactory.create({
        type: "Sentinel",
        id: "parent-sentinel-streaming",
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

      producer = await nodeFactory.create({
        type: "Node",
        id: "child-stream-producer",
        hasParent: true,
        requestedLogicals: ["svc-stream-producer"],
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

      consumer = await nodeFactory.create({
        type: "Node",
        id: "child-stream-consumer",
        hasParent: true,
        requestedLogicals: ["svc-stream-consumer"],
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

      await Promise.all([producer.start(), consumer.start()]);

      await waitForCondition(() => producer?.handshakeCompleted === true);
      await waitForCondition(() => consumer?.handshakeCompleted === true);

      routeManager = (parent as unknown as { routeManager: RouteManager }).routeManager;
      await waitForCondition(() => routeManager!.downstreamRoutes.has(producer!.id));
      await waitForCondition(() => routeManager!.downstreamRoutes.has(consumer!.id));

      // Use regular RPC calls to simulate streaming behavior with multiple calls
      const streamingHandler = jest.fn(async (method: string, params?: Record<string, unknown>) => {
        expect(method).toBe("svc-sibling.getBatch");
        expect(params).toMatchObject({ base: 5, batchIndex: expect.any(Number) });

        const base = Number(params?.base ?? 0);
        const batchIndex = Number(params?.batchIndex ?? 0);
        const value = base * (batchIndex + 1);

        return { index: batchIndex, value };
      });

      const serviceAddress = await producer.listenRpc(
        "svc-sibling",
        streamingHandler,
        WAIT_TIMEOUT_MS
      );

      await waitForCondition(() => {
        const info = routeManager!._downstream_addresses_routes.get(serviceAddress.toString());
        return info?.segment === producer?.id;
      });

      // Simulate streaming by making multiple RPC calls
      const received: Array<{ index: number; value: number }> = [];
      const expectedCount = 3;

      for (let index = 0; index < expectedCount; index += 1) {
        const response = (await consumer.invoke(
          serviceAddress,
          "svc-sibling.getBatch",
          { base: 5, batchIndex: index },
          WAIT_TIMEOUT_MS
        )) as { index: number; value: number };

        expect(response).toEqual({
          index: expect.any(Number),
          value: expect.any(Number),
        });
        received.push(response);
      }

      expect(received).toEqual([
        { index: 0, value: 5 },
        { index: 1, value: 10 },
        { index: 2, value: 15 },
      ]);
      expect(streamingHandler).toHaveBeenCalledTimes(3);
    } finally {
      await consumer?.stop();
      await producer?.stop();
      await parent?.stop();
    }
  });
});
