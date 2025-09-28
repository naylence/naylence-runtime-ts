import {
  ConnectorState,
  DeliveryOriginType,
  extractEnvelopeAndContext,
  formatAddress,
  type AuthorizationContext,
  type FameDeliveryContext,
  type FameEnvelope,
} from 'naylence-core';

import { SignJWT } from 'jose';

import '../../security/index.js';
import '../../node/index.js';
import '../../connector/index.js';
import '../../sentinel/index.js';
import '../../delivery/index.js';
import '../../stickiness/index.js';

import { WebSocketConnector } from '../../connector/websocket-connector.js';
import { getWebsocketListenerInstance } from '../../connector/websocket-listener.js';
import { DefaultHttpServer } from '../../connector/default-http-server.js';
import { SentinelFactory } from '../sentinel-factory.js';
import type { Sentinel } from '../sentinel.js';
import type { RouteManager } from '../route-manager.js';
import { NodeFactory } from '../../node/node-factory.js';
import type { FameNode } from '../../node/node.js';
import type { NodeEventListener } from '../../node/node-event-listener.js';
import { UpstreamSessionManager } from '../../node/upstream-session-manager.js';
import { basicConfig, LogLevel } from '../../util/logging.js';
import { TaskSpawner } from '../../util/task-spawner.js';
import { DefaultSecurityManager } from '../../security/default-security-manager.js';
import { OAuth2Authorizer } from '../../security/auth/oauth2-authorizer.js';
import { DefaultCryptoProvider } from '../../security/crypto/providers/default-crypto-provider.js';
import type { CryptoProvider } from '../../security/crypto/providers/crypto-provider.js';
import { getKeyStore } from '../../security/keys/key-store.js';
import type { KeyManager } from '../../security/keys/key-manager.js';
import type { KeyRecord } from '../../security/keys/key-store.js';

jest.mock('fastify', () => {
  const actual = jest.requireActual('fastify');
  return (...args: unknown[]) => {
    const instance = actual(...args);
    Object.defineProperty(instance, 'version', {
      value: '4.99.0',
      configurable: true,
    });
    return instance;
  };
});

jest.setTimeout(20000);

const SOCKET_HOST = '127.0.0.1';
const WAIT_TIMEOUT_MS = 10_000;
const WAIT_INTERVAL_MS = 50;
const SYSTEM_INBOX = '__sys__';

interface SecurityConfigOverrides {
  cryptoProvider?: CryptoProvider | null;
}

function createSecurityConfig(): Record<string, unknown> {
  return {
    type: 'DefaultSecurityManager',
    authorizer: { type: 'NoopAuthorizer' },
    security_policy: {
      type: 'NoSecurityPolicy',
    },
  } satisfies Record<string, unknown>;
}

function applySecurityConfigOverrides(
  config: Record<string, unknown>,
  overrides?: SecurityConfigOverrides
): Record<string, unknown> {
  if (!overrides) {
    return config;
  }

  if ('cryptoProvider' in overrides) {
    (config as Record<string, unknown>).cryptoProvider = overrides.cryptoProvider ?? null;
    (config as Record<string, unknown>).crypto_provider = overrides.cryptoProvider ?? null;
  }

  return config;
}

function createOverlaySecurityConfig(overrides?: SecurityConfigOverrides): Record<string, unknown> {
  const baseConfig = {
    type: 'DefaultSecurityManager',
    authorizer: { type: 'NoopAuthorizer' },
    security_policy: {
      type: 'DefaultSecurityPolicy',
      signing: {
        outbound: {
          defaultSigning: true,
          signSensitiveOperations: true,
          signIfRecipientExpects: true,
        },
        response: {
          mirrorRequestSigning: true,
          alwaysSignResponses: true,
          signErrorResponses: true,
        },
        inbound: {
          signaturePolicy: 'optional',
          unsignedViolationAction: 'nack',
          missingKeyAction: 'nack',
          invalidSignatureAction: 'reject',
        },
        signingMaterial: 'raw-key',
      },
      encryption: {
        outbound: {
          defaultLevel: 'channel',
          escalateIfPeerSupports: true,
          preferSealedForSensitive: true,
        },
        response: {
          minimumResponseLevel: 'channel',
          mirrorRequestLevel: true,
          escalateSealedResponses: true,
        },
        inbound: {
          allowPlaintext: false,
          allowChannel: true,
          allowSealed: true,
          plaintextViolationAction: 'nack',
        },
      },
    },
    key_manager_config: {
      type: 'DefaultKeyManager',
    },
    key_validator: { type: 'NoopKeyValidator' },
  } satisfies Record<string, unknown>;

  return applySecurityConfigOverrides(baseConfig, overrides);
}

function createSigningOverlaySecurityConfig(overrides?: SecurityConfigOverrides): Record<string, unknown> {
  const config = createOverlaySecurityConfig(overrides);
  const securityPolicy = (config.security_policy ?? {}) as Record<string, unknown>;
  const encryption = { ...(securityPolicy.encryption as Record<string, unknown> | undefined) };

  encryption.outbound = {
    ...((encryption.outbound as Record<string, unknown> | undefined) ?? {}),
    defaultLevel: 'plaintext',
    escalateIfPeerSupports: false,
    preferSealedForSensitive: false,
  } satisfies Record<string, unknown>;

  encryption.response = {
    ...((encryption.response as Record<string, unknown> | undefined) ?? {}),
    minimumResponseLevel: 'plaintext',
    mirrorRequestLevel: false,
    escalateSealedResponses: false,
  } satisfies Record<string, unknown>;

  encryption.inbound = {
    ...((encryption.inbound as Record<string, unknown> | undefined) ?? {}),
    allowPlaintext: true,
    plaintextViolationAction: 'allow',
  } satisfies Record<string, unknown>;

  securityPolicy.encryption = encryption;
  config.security_policy = securityPolicy;

  return applySecurityConfigOverrides(config, overrides);
}

interface GatedSecurityConfigOptions extends SecurityConfigOverrides {
  issuer: string;
  hmacSecret: string;
  audience?: string;
  requiredScopes?: string[];
}

function createGatedSecurityConfig(options: GatedSecurityConfigOptions): Record<string, unknown> {
  const {
    issuer,
    hmacSecret,
    audience,
    requiredScopes = ['node.connect'],
    cryptoProvider,
  } = options;

  const securityPolicy: Record<string, unknown> = {
    type: 'DefaultSecurityPolicy',
    signing: {
      inbound: {
        signaturePolicy: 'disabled',
        unsignedViolationAction: 'allow',
        invalidSignatureAction: 'allow',
      },
      response: {
        mirrorRequestSigning: false,
        alwaysSignResponses: false,
        signErrorResponses: false,
      },
      outbound: {
        defaultSigning: false,
        signSensitiveOperations: false,
        signIfRecipientExpects: false,
      },
    },
    encryption: {
      inbound: {
        allowPlaintext: true,
        allowChannel: false,
        allowSealed: false,
        plaintextViolationAction: 'allow',
        channelViolationAction: 'nack',
        sealedViolationAction: 'nack',
      },
      response: {
        mirrorRequestLevel: true,
        minimumResponseLevel: 'plaintext',
        escalateSealedResponses: false,
      },
      outbound: {
        defaultLevel: 'plaintext',
        escalateIfPeerSupports: false,
        preferSealedForSensitive: false,
      },
    },
  } satisfies Record<string, unknown>;

  const authorizer: Record<string, unknown> = {
    type: 'OAuth2Authorizer',
    issuer,
    required_scopes: requiredScopes,
    require_scope: true,
    algorithm: 'HS256',
    token_verifier_config: {
      type: 'JWTTokenVerifier',
      issuer,
      algorithms: ['HS256'],
      hmac_secret: hmacSecret,
      ttl_sec: 3600,
    },
  } satisfies Record<string, unknown>;

  if (audience) {
    authorizer.audience = audience;
  }

  const config: Record<string, unknown> = {
    type: 'DefaultSecurityManager',
    security_policy: securityPolicy,
    authorizer,
  };

  const overrides = cryptoProvider !== undefined ? { cryptoProvider } : undefined;
  return applySecurityConfigOverrides(config, overrides);
}

async function waitForCondition(predicate: () => boolean, timeoutMs = WAIT_TIMEOUT_MS): Promise<void> {
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

  throw new Error('Timed out waiting for condition');
}

async function ensureTaskSpawnerShutdown(spawner: TaskSpawner | null | undefined): Promise<void> {
  if (!spawner) {
    return;
  }

  try {
    await spawner.shutdownTasks({
      gracePeriod: 200,
      joinTimeout: 200,
      cancelHanging: true,
    });
  } catch {
    spawner.cancelAllTasks();
  }

  try {
    await waitForCondition(() => spawner.taskCount === 0, WAIT_TIMEOUT_MS);
  } catch {
    spawner.cancelAllTasks();
  }
}

function toKeyArray(candidate: Record<string, unknown> | Array<Record<string, unknown>> | undefined | null): Array<Record<string, unknown>> {
  if (!candidate) {
    return [];
  }
  return Array.isArray(candidate) ? candidate : [candidate];
}

async function waitForKeysForPath(
  manager: { getKeysForPath(path: string): Promise<Iterable<KeyRecord>> },
  path: string,
  minimumCount = 1,
  timeoutMs = WAIT_TIMEOUT_MS
): Promise<Array<KeyRecord>> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const iterable = await manager.getKeysForPath(path);
    const keys = Array.from(iterable) as Array<KeyRecord>;
    if (keys.length >= minimumCount) {
      return keys;
    }

    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      setTimeout(resolve, WAIT_INTERVAL_MS);
    });
  }

  const keyStore = getKeyStore();
  const allKeys = Array.from(await keyStore.getKeys());
  // eslint-disable-next-line no-console
  console.error('waitForKeysForPath timeout debug', {
    path,
    available: allKeys.map((key) => ({
      kid: key.kid,
      physical_path: key.physical_path,
      use: key.use,
    })),
  });

  throw new Error(`Timed out waiting for keys at path ${path}`);
}

type UpstreamTimingOverrideKey =
  | 'HEARTBEAT_INTERVAL'
  | 'HEARTBEAT_GRACE'
  | 'BACKOFF_INITIAL'
  | 'BACKOFF_CAP';

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

describe('Sentinel downstream node integration', () => {
  beforeAll(() => {
    basicConfig({ level: LogLevel.DEBUG, format: 'json' });
  });

  afterEach(async () => {
    await DefaultHttpServer.shutdownAll();
  });

  test('downstream node binds logical address and propagates upstream', async () => {
    const sentinelFactory = new SentinelFactory();
    const nodeFactory = new NodeFactory();

    let parent: Sentinel | null = null;
    let child: FameNode | null = null;

    try {
      parent = await sentinelFactory.create({
        type: 'Sentinel',
        id: 'parent-sentinel',
        security: createSecurityConfig(),
        admission: {
          type: 'NoopAdmissionClient',
          autoAcceptLogicals: true,
        },
        delivery: {
          type: 'AtLeastOnceDeliveryPolicy',
        },
        routingPolicy: {
          type: 'CompositeRoutingPolicy',
        },
        listeners: [
          {
            type: 'WebSocketListener',
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

      const wsBaseUrl = baseUrl!.startsWith('https://')
        ? baseUrl!.replace('https://', 'wss://')
        : baseUrl!.replace('http://', 'ws://');
      const downstreamAttachUrl = `${wsBaseUrl}${serverListener!.attachPrefix}/ws/downstream`;

      child = await nodeFactory.create({
        type: 'Node',
        id: 'child-node',
        hasParent: true,
        requestedLogicals: ['svc'],
        security: createSecurityConfig(),
        delivery: {
          type: 'AtLeastOnceDeliveryPolicy',
        },
        admission: {
          type: 'DirectAdmissionClient',
          connectionGrants: [
            {
              type: 'WebSocketConnectionGrant',
              purpose: 'node.attach',
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

      const binding = await child.bind('svc');
      const addressKey = binding.address.toString();

      await waitForCondition(() => routeManager._downstream_addresses_routes.has(addressKey));

      const routeInfo = routeManager._downstream_addresses_routes.get(addressKey);
      expect(routeInfo).toBeTruthy();
      expect(routeInfo?.segment).toBe(child.id);
    } finally {
      await Promise.allSettled([
        child?.stop(),
        parent?.stop(),
      ]);
    }
  });

  test('parent sentinel binding receives message from downstream node', async () => {
    const sentinelFactory = new SentinelFactory();
    const nodeFactory = new NodeFactory();

    let parent: Sentinel | null = null;
    let child: FameNode | null = null;

    try {
      parent = await sentinelFactory.create({
        type: 'Sentinel',
        id: 'parent-sentinel',
        security: createSecurityConfig(),
        admission: {
          type: 'NoopAdmissionClient',
          autoAcceptLogicals: true,
        },
        delivery: {
          type: 'AtLeastOnceDeliveryPolicy',
        },
        routingPolicy: {
          type: 'CompositeRoutingPolicy',
        },
        listeners: [
          {
            type: 'WebSocketListener',
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

      const wsBaseUrl = baseUrl!.startsWith('https://')
        ? baseUrl!.replace('https://', 'wss://')
        : baseUrl!.replace('http://', 'ws://');
      const downstreamAttachUrl = `${wsBaseUrl}${serverListener!.attachPrefix}/ws/downstream`;

      child = await nodeFactory.create({
        type: 'Node',
        id: 'child-node',
        hasParent: true,
        requestedLogicals: ['svc'],
        security: createSecurityConfig(),
        delivery: {
          type: 'AtLeastOnceDeliveryPolicy',
        },
        admission: {
          type: 'DirectAdmissionClient',
          connectionGrants: [
            {
              type: 'WebSocketConnectionGrant',
              purpose: 'node.attach',
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

      const binding = await parent.bind('svc');

      const payload = { greeting: 'hello', count: 1 };
      const outboundEnvelope = child.envelopeFactory.createEnvelope({
        frame: {
          type: 'Data',
          codec: 'json',
          payload,
        },
        to: binding.address,
      });

      await child.send(outboundEnvelope);

      const received = await binding.channel.receive(WAIT_TIMEOUT_MS);
      const [deliveredEnvelope, deliveredContext] = extractEnvelopeAndContext(received);

      expect(deliveredEnvelope.id).toBe(outboundEnvelope.id);
      expect(deliveredEnvelope.to?.toString()).toBe(binding.address.toString());
      expect(deliveredEnvelope.frame?.type).toBe('Data');
      expect((deliveredEnvelope.frame as { payload?: unknown } | undefined)?.payload).toEqual(payload);
      expect(deliveredContext?.originType).toBe(DeliveryOriginType.DOWNSTREAM);
    } finally {
      await Promise.allSettled([
        child?.stop(),
        parent?.stop(),
      ]);
    }
  });

  test('downstream node invokes RPC service exposed by parent sentinel', async () => {
    const sentinelFactory = new SentinelFactory();
    const nodeFactory = new NodeFactory();

    let parent: Sentinel | null = null;
    let child: FameNode | null = null;

    try {
      parent = await sentinelFactory.create({
        type: 'Sentinel',
        id: 'parent-sentinel',
        security: createSecurityConfig(),
        admission: {
          type: 'NoopAdmissionClient',
          autoAcceptLogicals: true,
        },
        delivery: {
          type: 'AtLeastOnceDeliveryPolicy',
        },
        routingPolicy: {
          type: 'CompositeRoutingPolicy',
        },
        listeners: [
          {
            type: 'WebSocketListener',
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

      const wsBaseUrl = baseUrl!.startsWith('https://')
        ? baseUrl!.replace('https://', 'wss://')
        : baseUrl!.replace('http://', 'ws://');
      const downstreamAttachUrl = `${wsBaseUrl}${serverListener!.attachPrefix}/ws/downstream`;

      child = await nodeFactory.create({
        type: 'Node',
        id: 'child-node',
        hasParent: true,
        requestedLogicals: ['svc'],
        security: createSecurityConfig(),
        delivery: {
          type: 'AtLeastOnceDeliveryPolicy',
        },
        admission: {
          type: 'DirectAdmissionClient',
          connectionGrants: [
            {
              type: 'WebSocketConnectionGrant',
              purpose: 'node.attach',
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
        expect(method).toBe('svc-rpc.sum');
        expect(params).toMatchObject({ a: 7, b: 5 });
        return { result: (params?.a as number) + (params?.b as number) };
      });

      const serviceAddress = await parent.listenRpc('svc-rpc', rpcHandler, WAIT_TIMEOUT_MS);
      expect(serviceAddress.toString()).toContain('svc-rpc');

      const invocationResult = await child.invoke(
        serviceAddress,
        'svc-rpc.sum',
        { a: 7, b: 5 },
        WAIT_TIMEOUT_MS
      );

      expect(invocationResult).toEqual({ result: 12 });
      expect(rpcHandler).toHaveBeenCalledTimes(1);
    } finally {
      await Promise.allSettled([
        child?.stop(),
        parent?.stop(),
      ]);
    }
  });

  test('downstream node automatically reconnects after parent disconnect', async () => {
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
        type: 'Sentinel',
        id: 'parent-sentinel',
        security: createSecurityConfig(),
        admission: {
          type: 'NoopAdmissionClient',
          autoAcceptLogicals: true,
        },
        delivery: {
          type: 'AtLeastOnceDeliveryPolicy',
        },
        routingPolicy: {
          type: 'CompositeRoutingPolicy',
        },
        listeners: [
          {
            type: 'WebSocketListener',
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

      const wsBaseUrl = baseUrl!.startsWith('https://')
        ? baseUrl!.replace('https://', 'wss://')
        : baseUrl!.replace('http://', 'ws://');
      const downstreamAttachUrl = `${wsBaseUrl}${serverListener!.attachPrefix}/ws/downstream`;

      child = await nodeFactory.create({
        type: 'Node',
        id: 'child-node',
        hasParent: true,
        requestedLogicals: ['svc'],
        security: createSecurityConfig(),
        delivery: {
          type: 'AtLeastOnceDeliveryPolicy',
        },
        admission: {
          type: 'DirectAdmissionClient',
          connectionGrants: [
            {
              type: 'WebSocketConnectionGrant',
              purpose: 'node.attach',
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
      expect((initialChildConnector as WebSocketConnector | null)?.state).toBe(ConnectorState.STARTED);

      await routeManager.unregisterDownstreamRoute(childId);

      await waitForCondition(() => !routeManager.downstreamRoutes.has(childId));

      await waitForCondition(
        () => child?.upstreamConnector !== initialChildConnector,
        FAST_RECONNECT_TIMEOUT_MS
      );

      await waitForCondition(
        () => {
          const connector = routeManager.downstreamRoutes.get(childId);
          return Boolean(connector && connector !== initialParentConnector);
        },
        FAST_RECONNECT_TIMEOUT_MS
      );

      const reconnectedParentConnector = routeManager.downstreamRoutes.get(childId);
      expect(reconnectedParentConnector).toBeInstanceOf(WebSocketConnector);
      expect(reconnectedParentConnector).not.toBe(initialParentConnector);

      await waitForCondition(
        () => {
          const connector = child?.upstreamConnector as WebSocketConnector | null;
          return Boolean(
            connector &&
              connector !== initialChildConnector &&
              connector.state === ConnectorState.STARTED
          );
        },
        FAST_RECONNECT_TIMEOUT_MS
      );

      const reconnectedChildConnector = child!.upstreamConnector as WebSocketConnector;
      expect(reconnectedChildConnector).not.toBe(initialChildConnector);
      expect(reconnectedChildConnector.state).toBe(ConnectorState.STARTED);
    } finally {
      restoreUpstreamTiming();
      await Promise.allSettled([
        child?.stop(),
        parent?.stop(),
      ]);
    }
  });

  test('downstream node sends heartbeat and receives ack from parent sentinel', async () => {
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

    const captureEnvelope = (
      first?: unknown,
      second?: unknown
    ): FameEnvelope | undefined => {
      const candidates = [first, second];
      for (const candidate of candidates) {
        if (candidate && typeof candidate === 'object' && 'frame' in candidate) {
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
        type: 'Sentinel',
        id: 'parent-sentinel',
        security: createSecurityConfig(),
        admission: {
          type: 'NoopAdmissionClient',
          autoAcceptLogicals: true,
        },
        delivery: {
          type: 'AtLeastOnceDeliveryPolicy',
        },
        routingPolicy: {
          type: 'CompositeRoutingPolicy',
        },
        listeners: [
          {
            type: 'WebSocketListener',
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

      const wsBaseUrl = baseUrl!.startsWith('https://')
        ? baseUrl!.replace('https://', 'wss://')
        : baseUrl!.replace('http://', 'ws://');
      const downstreamAttachUrl = `${wsBaseUrl}${serverListener!.attachPrefix}/ws/downstream`;

      child = await nodeFactory.create({
        type: 'Node',
        id: 'child-node',
        hasParent: true,
        requestedLogicals: ['svc'],
        security: createSecurityConfig(),
        delivery: {
          type: 'AtLeastOnceDeliveryPolicy',
        },
        admission: {
          type: 'DirectAdmissionClient',
          connectionGrants: [
            {
              type: 'WebSocketConnectionGrant',
              purpose: 'node.attach',
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
      expect(sentHeartbeat.frame?.type).toBe('NodeHeartbeat');

      const ackEnvelope =
        heartbeatAcks.find((ack) => ack.corrId && ack.corrId === sentHeartbeat.corrId) ??
        heartbeatAcks[heartbeatAcks.length - 1];
      expect(ackEnvelope).toBeTruthy();

      const ackFrame = ackEnvelope!.frame as { type?: string; ok?: boolean; refId?: string | null } | undefined;
      expect(ackFrame?.type).toBe('NodeHeartbeatAck');
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
      await Promise.allSettled([
        child?.stop(),
        parent?.stop(),
      ]);
    }
  });

  test('child node invokes RPC service exposed by a sibling through the parent sentinel', async () => {
    const sentinelFactory = new SentinelFactory();
    const nodeFactory = new NodeFactory();

    let parent: Sentinel | null = null;
    let childClient: FameNode | null = null;
    let childServer: FameNode | null = null;

    try {
      parent = await sentinelFactory.create({
        type: 'Sentinel',
        id: 'parent-sentinel',
        security: createSecurityConfig(),
        admission: {
          type: 'NoopAdmissionClient',
          autoAcceptLogicals: true,
        },
        delivery: {
          type: 'AtLeastOnceDeliveryPolicy',
        },
        routingPolicy: {
          type: 'CompositeRoutingPolicy',
        },
        listeners: [
          {
            type: 'WebSocketListener',
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

      const wsBaseUrl = baseUrl!.startsWith('https://')
        ? baseUrl!.replace('https://', 'wss://')
        : baseUrl!.replace('http://', 'ws://');
      const downstreamAttachUrl = `${wsBaseUrl}${serverListener!.attachPrefix}/ws/downstream`;

      childServer = await nodeFactory.create({
        type: 'Node',
        id: 'child-server',
        hasParent: true,
        requestedLogicals: ['svc-server'],
        security: createSecurityConfig(),
        delivery: {
          type: 'AtLeastOnceDeliveryPolicy',
        },
        admission: {
          type: 'DirectAdmissionClient',
          connectionGrants: [
            {
              type: 'WebSocketConnectionGrant',
              purpose: 'node.attach',
              url: downstreamAttachUrl,
            },
          ],
          ttlSec: 60,
        },
      });

      childClient = await nodeFactory.create({
        type: 'Node',
        id: 'child-client',
        hasParent: true,
        requestedLogicals: ['svc-client'],
        security: createSecurityConfig(),
        delivery: {
          type: 'AtLeastOnceDeliveryPolicy',
        },
        admission: {
          type: 'DirectAdmissionClient',
          connectionGrants: [
            {
              type: 'WebSocketConnectionGrant',
              purpose: 'node.attach',
              url: downstreamAttachUrl,
            },
          ],
          ttlSec: 60,
        },
      });

      await Promise.all([childServer.start(), childClient.start()]);

      await waitForCondition(() => childServer?.handshakeCompleted === true);
      await waitForCondition(() => childClient?.handshakeCompleted === true);

      const routeManager = (parent as unknown as { routeManager: RouteManager }).routeManager;
      await waitForCondition(() => routeManager.downstreamRoutes.has(childServer!.id));
      await waitForCondition(() => routeManager.downstreamRoutes.has(childClient!.id));

      const serverRpcHandler = jest.fn(async (method: string, params?: Record<string, unknown>) => {
        expect(method).toBe('svc-sibling.mul');
        expect(params).toMatchObject({ a: 3, b: 9 });
        return { result: (params?.a as number) * (params?.b as number) };
      });

      const serviceAddress = await childServer.listenRpc('svc-sibling', serverRpcHandler, WAIT_TIMEOUT_MS);

      await waitForCondition(() => {
        const info = routeManager._downstream_addresses_routes.get(serviceAddress.toString());
        return info?.segment === childServer?.id;
      });

      const response = await childClient.invoke(
        serviceAddress,
        'svc-sibling.mul',
        { a: 3, b: 9 },
        WAIT_TIMEOUT_MS
      );

      expect(response).toEqual({ result: 27 });
      expect(serverRpcHandler).toHaveBeenCalledTimes(1);
    } finally {
      await Promise.allSettled([
        childClient?.stop(),
        childServer?.stop(),
        parent?.stop(),
      ]);
    }
  });

  test('sibling nodes exchange streaming RPC responses through the parent sentinel', async () => {
    const sentinelFactory = new SentinelFactory();
    const nodeFactory = new NodeFactory();

    let parent: Sentinel | null = null;
    let producer: FameNode | null = null;
    let consumer: FameNode | null = null;
    let producerConnector: WebSocketConnector | null = null;
    let consumerConnector: WebSocketConnector | null = null;
    let routeManager: RouteManager | null = null;
    const stoppableResources = new Set<unknown>();
    const taskSpawners = new Set<TaskSpawner>();

    const trackTaskSpawner = (candidate: unknown) => {
      if (candidate && typeof candidate === 'object') {
        stoppableResources.add(candidate);
      }

      if (candidate instanceof TaskSpawner) {
        taskSpawners.add(candidate);
      }
    };

    const captureSessionManager = (node: FameNode | null) => {
      if (!node) {
        return;
      }

  const internal = (node as unknown as { _sessionManager?: unknown })._sessionManager;
      trackTaskSpawner(internal);
    };

    try {
      parent = await sentinelFactory.create({
        type: 'Sentinel',
        id: 'parent-sentinel-streaming',
        security: createSecurityConfig(),
        admission: {
          type: 'NoopAdmissionClient',
          autoAcceptLogicals: true,
        },
        delivery: {
          type: 'AtLeastOnceDeliveryPolicy',
        },
        routingPolicy: {
          type: 'CompositeRoutingPolicy',
        },
        listeners: [
          {
            type: 'WebSocketListener',
            host: SOCKET_HOST,
            port: 0,
          },
        ],
      });

      await parent.start();
    captureSessionManager(parent);

      const serverListener = getWebsocketListenerInstance();
      expect(serverListener).toBeTruthy();

      await waitForCondition(() => Boolean(serverListener?.baseUrl));

      const baseUrl = serverListener?.baseUrl;
      expect(baseUrl).toBeTruthy();

      const wsBaseUrl = baseUrl!.startsWith('https://')
        ? baseUrl!.replace('https://', 'wss://')
        : baseUrl!.replace('http://', 'ws://');
      const downstreamAttachUrl = `${wsBaseUrl}${serverListener!.attachPrefix}/ws/downstream`;

      producer = await nodeFactory.create({
        type: 'Node',
        id: 'child-stream-producer',
        hasParent: true,
        requestedLogicals: ['svc-stream-producer'],
        security: createSecurityConfig(),
        delivery: {
          type: 'AtLeastOnceDeliveryPolicy',
        },
        admission: {
          type: 'DirectAdmissionClient',
          connectionGrants: [
            {
              type: 'WebSocketConnectionGrant',
              purpose: 'node.attach',
              url: downstreamAttachUrl,
            },
          ],
          ttlSec: 60,
        },
      });

      consumer = await nodeFactory.create({
        type: 'Node',
        id: 'child-stream-consumer',
        hasParent: true,
        requestedLogicals: ['svc-stream-consumer'],
        security: createSecurityConfig(),
        delivery: {
          type: 'AtLeastOnceDeliveryPolicy',
        },
        admission: {
          type: 'DirectAdmissionClient',
          connectionGrants: [
            {
              type: 'WebSocketConnectionGrant',
              purpose: 'node.attach',
              url: downstreamAttachUrl,
            },
          ],
          ttlSec: 60,
        },
      });

      await Promise.all([producer.start(), consumer.start()]);
      captureSessionManager(producer);
      captureSessionManager(consumer);

      await waitForCondition(() => producer?.handshakeCompleted === true);
      await waitForCondition(() => consumer?.handshakeCompleted === true);

      routeManager = (parent as unknown as { routeManager: RouteManager }).routeManager;
  trackTaskSpawner(routeManager);
      await waitForCondition(() => routeManager!.downstreamRoutes.has(producer!.id));
      await waitForCondition(() => routeManager!.downstreamRoutes.has(consumer!.id));

      const streamingHandler = jest.fn(async (method: string, params?: Record<string, unknown>) => {
        expect(method).toBe('svc-sibling.stream');
        expect(params).toMatchObject({ base: 5, count: 3 });

        const base = Number(params?.base ?? 0);
        const count = Number(params?.count ?? 0);

        async function* generateResponses(): AsyncGenerator<{ index: number; value: number }> {
          for (let index = 0; index < count; index += 1) {
            const value = base * (index + 1);
            yield { index, value };
          }
        }

        return generateResponses();
      });

      const serviceAddress = await producer.listenRpc('svc-sibling', streamingHandler, WAIT_TIMEOUT_MS);

      await waitForCondition(() => {
        const info = routeManager!._downstream_addresses_routes.get(serviceAddress.toString());
        return info?.segment === producer?.id;
      });

      producerConnector =
        producer?.upstreamConnector instanceof WebSocketConnector ? producer.upstreamConnector : null;
      consumerConnector =
        consumer?.upstreamConnector instanceof WebSocketConnector ? consumer.upstreamConnector : null;

      const streamIterator = consumer.invokeStream(
        serviceAddress,
        'svc-sibling.stream',
        { base: 5, count: 3 },
        WAIT_TIMEOUT_MS
      );

      const received: Array<{ index: number; value: number }> = [];
      const expectedCount = 3;

      for (let index = 0; index < expectedCount; index += 1) {
        const { value, done } = await streamIterator.next();
        expect(done).toBe(false);
        expect(value).toEqual({
          index: expect.any(Number),
          value: expect.any(Number),
        });
        received.push(value as { index: number; value: number });
      }

      const completion = await streamIterator.next();
      expect(completion.done).toBe(true);

      if (typeof streamIterator.return === 'function') {
        await streamIterator.return();
      }

      expect(received).toEqual([
        { index: 0, value: 5 },
        { index: 1, value: 10 },
        { index: 2, value: 15 },
      ]);
      expect(streamingHandler).toHaveBeenCalledTimes(1);
    } finally {
      const connectors = new Set<WebSocketConnector>();
      if (consumerConnector) {
        connectors.add(consumerConnector);
      }
      if (producerConnector) {
        connectors.add(producerConnector);
      }
      if (consumer?.upstreamConnector instanceof WebSocketConnector) {
        connectors.add(consumer.upstreamConnector);
      }
      if (producer?.upstreamConnector instanceof WebSocketConnector) {
        connectors.add(producer.upstreamConnector);
      }
      if (routeManager) {
        for (const connector of routeManager.downstreamRoutes.values()) {
          if (connector instanceof WebSocketConnector) {
            connectors.add(connector);
          }
        }
      }

      const nodes: Array<FameNode> = [];
      if (consumer) {
        nodes.push(consumer);
      }
      if (producer) {
        nodes.push(producer);
      }

      for (const node of nodes) {
        try {
          await node.stop();
        } catch {
          node.cancelAllTasks();
        }
        await ensureTaskSpawnerShutdown(node).catch(() => undefined);
      }

      if (parent) {
        try {
          await parent.stop();
        } catch {
          parent.cancelAllTasks();
        }
        await ensureTaskSpawnerShutdown(parent).catch(() => undefined);
      }

      if (routeManager) {
        try {
          await waitForCondition(
            () => routeManager!.downstreamRoutes.size === 0,
            WAIT_TIMEOUT_MS
          );
        } catch {
          // Best effort – sentinel shutdown handles lingering routes
        }
      }

      await Promise.allSettled(
        [...stoppableResources].map(async (resource) => {
          const stop = (resource as { stop?: () => unknown }).stop;
          if (typeof stop === 'function') {
            try {
              await stop.call(resource);
            } catch {
              // Best effort – shutdown helpers below handle lingering tasks
            }
          }
        })
      );

      await Promise.allSettled(
        [...taskSpawners].map(async (manager) => {
          await ensureTaskSpawnerShutdown(manager).catch(() => undefined);
        })
      );

      await Promise.allSettled(
        [...connectors].map(async (connector) => {
          try {
            await connector.stop();
          } catch {
            connector.cancelAllTasks();
          }

          await ensureTaskSpawnerShutdown(connector).catch(() => undefined);

          try {
            await waitForCondition(
              () =>
                connector.state === ConnectorState.CLOSED ||
                connector.state === ConnectorState.STOPPED,
              WAIT_TIMEOUT_MS
            );
          } catch {
            // Best effort – leave connector teardown to afterEach fallbacks
          }
        })
      );
    }
  });

  test('downstream node exchanges overlay security keys during attach', async () => {
    const sentinelFactory = new SentinelFactory();
    const nodeFactory = new NodeFactory();

    let parent: Sentinel | null = null;
    let child: FameNode | null = null;

    try {
      const parentCryptoProvider = await DefaultCryptoProvider.create({
        issuer: 'test.naylence.runtime.parent',
        audience: 'integration-tests-parent',
        ttlSec: 600,
      });

      parent = await sentinelFactory.create({
        type: 'Sentinel',
        id: 'parent-overlay-sentinel',
  security: createOverlaySecurityConfig({ cryptoProvider: parentCryptoProvider }),
        admission: {
          type: 'NoopAdmissionClient',
          autoAcceptLogicals: true,
        },
        delivery: {
          type: 'AtLeastOnceDeliveryPolicy',
        },
        routingPolicy: {
          type: 'CompositeRoutingPolicy',
        },
        listeners: [
          {
            type: 'WebSocketListener',
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

      const wsBaseUrl = baseUrl!.startsWith('https://')
        ? baseUrl!.replace('https://', 'wss://')
        : baseUrl!.replace('http://', 'ws://');
      const downstreamAttachUrl = `${wsBaseUrl}${serverListener!.attachPrefix}/ws/downstream`;

      const childCryptoProvider = await DefaultCryptoProvider.create({
        issuer: 'test.naylence.runtime.child',
        audience: 'integration-tests-child',
        ttlSec: 600,
      });

      child = await nodeFactory.create({
        type: 'Node',
        id: 'child-overlay-node',
        hasParent: true,
        requestedLogicals: ['svc'],
  security: createOverlaySecurityConfig({ cryptoProvider: childCryptoProvider }),
        delivery: {
          type: 'AtLeastOnceDeliveryPolicy',
        },
        admission: {
          type: 'DirectAdmissionClient',
          connectionGrants: [
            {
              type: 'WebSocketConnectionGrant',
              purpose: 'node.attach',
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

      expect(child?.physicalPath).toMatch(/^\//);

      const parentSecurity = parent.securityManager;
      const childSecurity = child.securityManager;

      expect(parentSecurity).toBeInstanceOf(DefaultSecurityManager);
      expect(childSecurity).toBeInstanceOf(DefaultSecurityManager);

      const parentOverlayManager = parentSecurity as DefaultSecurityManager;
      const childOverlayManager = childSecurity as DefaultSecurityManager;

      expect(parentOverlayManager.supportsOverlaySecurity).toBe(true);
      expect(childOverlayManager.supportsOverlaySecurity).toBe(true);

      const parentShareableKeys = toKeyArray(parentOverlayManager.getShareableKeys());
      const childShareableKeys = toKeyArray(childOverlayManager.getShareableKeys());

      expect(parentShareableKeys.length).toBeGreaterThan(0);
      expect(childShareableKeys.length).toBeGreaterThan(0);

      const parentKeyManager = parentOverlayManager.keyManager as KeyManager | null;
      const childKeyManager = childOverlayManager.keyManager as KeyManager | null;

      expect(parentKeyManager).toBeTruthy();
      expect(childKeyManager).toBeTruthy();

      if (!parentKeyManager || !childKeyManager) {
        throw new Error('Overlay security key managers must be available');
      }

      const childInternalStore = (childKeyManager as unknown as { keyStore?: unknown }).keyStore ?? null;
      if (childInternalStore && typeof (childInternalStore as { getKeys?: () => Promise<Iterable<KeyRecord>> }).getKeys === 'function') {
        const rawKeysIterable = await (childInternalStore as { getKeys: () => Promise<Iterable<KeyRecord>> }).getKeys();
        // eslint-disable-next-line no-console
        console.log('child key store snapshot', Array.from(rawKeysIterable));
      } else {
        // eslint-disable-next-line no-console
        console.log('child key store snapshot unavailable');
      }

      // eslint-disable-next-line no-console
      console.log('overlay key debug', {
        parentPath: parent!.physicalPath,
        childPath: child!.physicalPath,
        parentShareable: parentShareableKeys.map((key) => key.kid).filter((kid): kid is string => typeof kid === 'string'),
        childShareable: childShareableKeys.map((key) => key.kid).filter((kid): kid is string => typeof kid === 'string'),
      });

      // eslint-disable-next-line no-console
      console.log('child keys for parent path (immediate)', Array.from(await childKeyManager.getKeysForPath(parent!.physicalPath)));

      const parentStoredKeys = await waitForKeysForPath(parentKeyManager, child!.physicalPath);
      const childStoredKeys = await waitForKeysForPath(childKeyManager, parent!.physicalPath);

      expect(parentStoredKeys.length).toBeGreaterThanOrEqual(2);
      expect(childStoredKeys.length).toBeGreaterThanOrEqual(2);

      const parentHasSigningKey = parentStoredKeys.some((key) => key.crv === 'Ed25519');
      const parentHasEncryptionKey = parentStoredKeys.some((key) => key.crv === 'X25519');
      const childHasSigningKey = childStoredKeys.some((key) => key.crv === 'Ed25519');
      const childHasEncryptionKey = childStoredKeys.some((key) => key.crv === 'X25519');

      expect(parentHasSigningKey).toBe(true);
      expect(parentHasEncryptionKey).toBe(true);
      expect(childHasSigningKey).toBe(true);
      expect(childHasEncryptionKey).toBe(true);

      const parentStoredKeysMatch = parentStoredKeys.every((key) => {
        return (
          typeof key.physical_path === 'string' &&
          key.physical_path === child!.physicalPath
        );
      });
      const childStoredKeysMatch = childStoredKeys.every((key) => {
        return (
          typeof key.physical_path === 'string' &&
          key.physical_path === parent!.physicalPath
        );
      });

      expect(parentStoredKeysMatch).toBe(true);
      expect(childStoredKeysMatch).toBe(true);

      const parentKeyIds = parentShareableKeys
        .map((key) => key.kid)
        .filter((kid): kid is string => typeof kid === 'string');
      const childKeyIds = childShareableKeys
        .map((key) => key.kid)
        .filter((kid): kid is string => typeof kid === 'string');

      for (const kid of parentKeyIds) {
        // eslint-disable-next-line no-await-in-loop
        expect(await childKeyManager.hasKey(kid)).toBe(true);
      }

      for (const kid of childKeyIds) {
        // eslint-disable-next-line no-await-in-loop
        expect(await parentKeyManager.hasKey(kid)).toBe(true);
      }
    } finally {
      await Promise.allSettled([
        child?.stop(),
        parent?.stop(),
      ]);
    }
  });

  test('downstream node sends signed message to parent system inbox with overlay security', async () => {
    const sentinelFactory = new SentinelFactory();
    const nodeFactory = new NodeFactory();

    let parent: Sentinel | null = null;
    let child: FameNode | null = null;
    let systemInboxListener: NodeEventListener | null = null;
    const restoreSpies: Array<() => void> = [];
    const inboxDeliveries: Array<{ envelope: FameEnvelope; context: FameDeliveryContext | null }> = [];

    try {
      const parentCryptoProvider = await DefaultCryptoProvider.create({
        issuer: 'test.naylence.runtime.parent',
        audience: 'integration-tests-parent',
        ttlSec: 600,
      });

      parent = await sentinelFactory.create({
        type: 'Sentinel',
        id: 'parent-overlay-sentinel',
        security: createSigningOverlaySecurityConfig({ cryptoProvider: parentCryptoProvider }),
        admission: {
          type: 'NoopAdmissionClient',
          autoAcceptLogicals: true,
        },
        delivery: {
          type: 'AtLeastOnceDeliveryPolicy',
        },
        routingPolicy: {
          type: 'CompositeRoutingPolicy',
        },
        listeners: [
          {
            type: 'WebSocketListener',
            host: SOCKET_HOST,
            port: 0,
          },
        ],
      });

      await parent.start();

      await waitForCondition(() => Boolean(parent?.physicalPath));

      const systemInboxAddress = formatAddress(SYSTEM_INBOX, parent!.physicalPath);
      const systemInboxAddressString = systemInboxAddress.toString();

      systemInboxListener = {
        priority: 2500,
        async onDeliverLocal(_node, address, envelope, context) {
          if (address.toString() === systemInboxAddressString) {
            inboxDeliveries.push({ envelope, context: context ?? null });
          }
          return envelope;
        },
      } satisfies NodeEventListener;

      parent.addEventListener(systemInboxListener);

      const serverListener = getWebsocketListenerInstance();
      expect(serverListener).toBeTruthy();

      await waitForCondition(() => Boolean(serverListener?.baseUrl));

      const baseUrl = serverListener?.baseUrl;
      expect(baseUrl).toBeTruthy();

      const wsBaseUrl = baseUrl!.startsWith('https://')
        ? baseUrl!.replace('https://', 'wss://')
        : baseUrl!.replace('http://', 'ws://');
      const downstreamAttachUrl = `${wsBaseUrl}${serverListener!.attachPrefix}/ws/downstream`;

      const childCryptoProvider = await DefaultCryptoProvider.create({
        issuer: 'test.naylence.runtime.child',
        audience: 'integration-tests-child',
        ttlSec: 600,
      });

      child = await nodeFactory.create({
        type: 'Node',
        id: 'child-overlay-node',
        hasParent: true,
        requestedLogicals: ['svc'],
        security: createSigningOverlaySecurityConfig({ cryptoProvider: childCryptoProvider }),
        delivery: {
          type: 'AtLeastOnceDeliveryPolicy',
        },
        admission: {
          type: 'DirectAdmissionClient',
          connectionGrants: [
            {
              type: 'WebSocketConnectionGrant',
              purpose: 'node.attach',
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

      await waitForCondition(() => Boolean(child?.physicalPath));
      const childPhysicalPath = child!.physicalPath;
      expect(childPhysicalPath).toMatch(/^\//);

      const parentSecurity = parent.securityManager;
      const childSecurity = child.securityManager;

      expect(parentSecurity).toBeInstanceOf(DefaultSecurityManager);
      expect(childSecurity).toBeInstanceOf(DefaultSecurityManager);

      const parentOverlayManager = parentSecurity as DefaultSecurityManager;
      const childOverlayManager = childSecurity as DefaultSecurityManager;
      const verifier = parentOverlayManager.envelopeVerifier;
      expect(verifier).toBeTruthy();
      if (!verifier) {
        throw new Error('Overlay security requires envelope verifier');
      }

      const verifySpy = jest.spyOn(verifier, 'verifyEnvelope');
      restoreSpies.push(() => verifySpy.mockRestore());

      const parentKeyManager = parentOverlayManager.keyManager as KeyManager | null;
      expect(parentKeyManager).toBeTruthy();
      if (!parentKeyManager) {
        throw new Error('Parent overlay key manager missing');
      }

      const childKeyManager = childOverlayManager.keyManager as KeyManager | null;
      expect(childKeyManager).toBeTruthy();
      if (!childKeyManager) {
        throw new Error('Child overlay key manager missing');
      }

      await waitForKeysForPath(parentKeyManager, childPhysicalPath);
      await waitForKeysForPath(childKeyManager, parent!.physicalPath);

      const payload = { greeting: 'signed-hello', sequence: 1 };
      const outboundEnvelope = child.envelopeFactory.createEnvelope({
        frame: {
          type: 'Data',
          codec: 'json',
          payload,
        },
        to: systemInboxAddress,
      });

      const initialVerifyCount = verifySpy.mock.calls.length;

      await child.send(outboundEnvelope);

      await waitForCondition(() => inboxDeliveries.length > 0);

    const { envelope: deliveredEnvelope, context: deliveredContext } = inboxDeliveries[0];

      expect(deliveredEnvelope.id).toBe(outboundEnvelope.id);
      expect(deliveredEnvelope.to?.toString()).toBe(systemInboxAddressString);
      expect(deliveredEnvelope.frame?.type).toBe('Data');
      expect((deliveredEnvelope.frame as { payload?: unknown } | undefined)?.payload).toEqual(payload);
      expect(deliveredEnvelope.sec?.sig?.val).toEqual(expect.any(String));
      expect(deliveredEnvelope.sec?.sig?.kid).toEqual(expect.any(String));
      expect(deliveredContext?.originType).toBe(DeliveryOriginType.DOWNSTREAM);

      await waitForCondition(() => verifySpy.mock.calls.length > initialVerifyCount);

      const verificationCall = verifySpy.mock.calls.find(([envelope]) => envelope?.id === outboundEnvelope.id);
      expect(verificationCall).toBeTruthy();
      expect(verificationCall?.[0]?.sec?.sig?.val).toBe(deliveredEnvelope.sec?.sig?.val);
    } finally {
      if (systemInboxListener && parent) {
        parent.removeEventListener(systemInboxListener);
      }
      for (const restore of restoreSpies) {
        restore();
      }
      await Promise.allSettled([
        child?.stop(),
        parent?.stop(),
      ]);
    }
  });

  test('downstream node attaches to gated sentinel using bearer token admission', async () => {
    const sentinelFactory = new SentinelFactory();
    const nodeFactory = new NodeFactory();

    const issuer = 'https://auth.integration.test';
    const audience = 'parent-gated-sentinel';
    const hmacSecret = 'integration-test-hmac-secret';

    let parent: Sentinel | null = null;
    let child: FameNode | null = null;
    const restoreSpies: Array<() => void> = [];

    try {
      parent = await sentinelFactory.create({
        type: 'Sentinel',
        id: audience,
        security: createGatedSecurityConfig({ issuer, audience, hmacSecret }),
        admission: {
          type: 'NoopAdmissionClient',
          autoAcceptLogicals: true,
        },
        delivery: {
          type: 'AtLeastOnceDeliveryPolicy',
        },
        routingPolicy: {
          type: 'CompositeRoutingPolicy',
        },
        listeners: [
          {
            type: 'WebSocketListener',
            host: SOCKET_HOST,
            port: 0,
          },
        ],
      });

      await parent.start();

      const parentSecurity = parent.securityManager;
      if (!(parentSecurity instanceof DefaultSecurityManager)) {
        throw new Error('Parent security manager missing');
      }

      const oauthAuthorizer = parentSecurity.authorizer;
      if (!(oauthAuthorizer instanceof OAuth2Authorizer)) {
        throw new Error('Parent OAuth2 authorizer missing');
      }

      type AuthSpyInstance = jest.SpyInstance<
        ReturnType<OAuth2Authorizer['authenticate']>,
        Parameters<OAuth2Authorizer['authenticate']>
      >;
      type ValidateSpyInstance = jest.SpyInstance<
        ReturnType<OAuth2Authorizer['validateNodeAttachRequest']>,
        Parameters<OAuth2Authorizer['validateNodeAttachRequest']>
      >;

      let authSpy: AuthSpyInstance | null = null;
      let validateSpy: ValidateSpyInstance | null = null;

      authSpy = jest.spyOn(oauthAuthorizer, 'authenticate');
      validateSpy = jest.spyOn(oauthAuthorizer, 'validateNodeAttachRequest');
      restoreSpies.push(() => authSpy?.mockRestore());
      restoreSpies.push(() => validateSpy?.mockRestore());

      const collectContexts = async (
        spy: AuthSpyInstance | ValidateSpyInstance | null
      ): Promise<AuthorizationContext[]> => {
        if (!spy) {
          return [];
        }

        const contexts: AuthorizationContext[] = [];
        for (const result of spy.mock.results) {
          if (result.type === 'return' && result.value) {
            try {
              // eslint-disable-next-line no-await-in-loop
              const resolved = await (result.value as Promise<AuthorizationContext | undefined>);
              if (resolved) {
                contexts.push(resolved);
              }
            } catch {
              // Ignore failed attempts while aggregating contexts
            }
          }
        }

        return contexts;
      };

      const serverListener = getWebsocketListenerInstance();
      expect(serverListener).toBeTruthy();

      await waitForCondition(() => Boolean(serverListener?.baseUrl));

      const baseUrl = serverListener?.baseUrl;
      expect(baseUrl).toBeTruthy();

      const wsBaseUrl = baseUrl!.startsWith('https://')
        ? baseUrl!.replace('https://', 'wss://')
        : baseUrl!.replace('http://', 'ws://');
      const downstreamAttachUrl = `${wsBaseUrl}${serverListener!.attachPrefix}/ws/downstream`;

      const token = await new SignJWT({
        scope: 'node.connect',
        scopes: ['node.connect'],
        capabilities: ['node.connect'],
      })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject('child-gated-node')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(new TextEncoder().encode(hmacSecret));

      child = await nodeFactory.create({
        type: 'Node',
        id: 'child-gated-node',
        hasParent: true,
        requestedLogicals: ['svc-gated'],
        security: createSecurityConfig(),
        delivery: {
          type: 'AtLeastOnceDeliveryPolicy',
        },
        admission: {
          type: 'DirectAdmissionClient',
          connectionGrants: [
            {
              type: 'WebSocketConnectionGrant',
              purpose: 'node.attach',
              url: downstreamAttachUrl,
              auth: {
                type: 'BearerTokenHeaderAuth',
                tokenProvider: {
                  type: 'StaticTokenProvider',
                  token,
                },
              },
            },
          ],
          ttlSec: 60,
        },
      });

      await child.start();

      if (!child) {
        throw new Error('Child node missing');
      }

      const childNode = child;

      await waitForCondition(() => childNode.handshakeCompleted === true);

      const routeManager = (parent as unknown as { routeManager: RouteManager }).routeManager;
      await waitForCondition(() => routeManager.downstreamRoutes.has(childNode.id));

      expect(childNode.physicalPath).toMatch(/^\//);

      if (authSpy) {
        await waitForCondition(() => (authSpy?.mock.calls.length ?? 0) > 0);
        const contexts = await collectContexts(authSpy);
        expect(contexts.some((ctx) => ctx.grantedScopes?.includes('node.connect'))).toBe(true);
      }

      if (validateSpy) {
        await waitForCondition(() => (validateSpy?.mock.calls.length ?? 0) > 0);
        const validatedContexts = await collectContexts(validateSpy);
        expect(validatedContexts.some((ctx) => ctx.grantedScopes?.includes('node.connect'))).toBe(true);
      }
    } finally {
      for (const restore of restoreSpies) {
        try {
          restore();
        } catch {
          // Ignore restoration issues in cleanup
        }
      }

      await Promise.allSettled([
        child?.stop(),
        parent?.stop(),
      ]);
    }
  });

  test('sibling nodes invoke RPC via sentinel with overlay security key resolution', async () => {
    const sentinelFactory = new SentinelFactory();
    const nodeFactory = new NodeFactory();

    let parent: Sentinel | null = null;
    let clientNode: FameNode | null = null;
    let serverNode: FameNode | null = null;
    const restoreSpies: Array<() => void> = [];

    try {
      const parentCryptoProvider = await DefaultCryptoProvider.create({
        issuer: 'test.naylence.runtime.parent.overlay.mesh',
        audience: 'integration-tests-parent-overlay-mesh',
        ttlSec: 600,
      });

      parent = await sentinelFactory.create({
        type: 'Sentinel',
        id: 'parent-overlay-sentinel-mesh',
        security: createSigningOverlaySecurityConfig({ cryptoProvider: parentCryptoProvider }),
        admission: {
          type: 'NoopAdmissionClient',
          autoAcceptLogicals: true,
        },
        delivery: {
          type: 'AtLeastOnceDeliveryPolicy',
        },
        routingPolicy: {
          type: 'CompositeRoutingPolicy',
        },
        listeners: [
          {
            type: 'WebSocketListener',
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

      const wsBaseUrl = baseUrl!.startsWith('https://')
        ? baseUrl!.replace('https://', 'wss://')
        : baseUrl!.replace('http://', 'ws://');
      const downstreamAttachUrl = `${wsBaseUrl}${serverListener!.attachPrefix}/ws/downstream`;

      const clientCryptoProvider = await DefaultCryptoProvider.create({
        issuer: 'test.naylence.runtime.client.overlay.mesh',
        audience: 'integration-tests-client-overlay-mesh',
        ttlSec: 600,
      });

      const serverCryptoProvider = await DefaultCryptoProvider.create({
        issuer: 'test.naylence.runtime.server.overlay.mesh',
        audience: 'integration-tests-server-overlay-mesh',
        ttlSec: 600,
      });

      clientNode = await nodeFactory.create({
        type: 'Node',
        id: 'child-client-overlay-node',
        hasParent: true,
        requestedLogicals: ['svc-client-overlay'],
        security: createSigningOverlaySecurityConfig({ cryptoProvider: clientCryptoProvider }),
        delivery: {
          type: 'AtLeastOnceDeliveryPolicy',
        },
        admission: {
          type: 'DirectAdmissionClient',
          connectionGrants: [
            {
              type: 'WebSocketConnectionGrant',
              purpose: 'node.attach',
              url: downstreamAttachUrl,
            },
          ],
          ttlSec: 60,
        },
      });

      serverNode = await nodeFactory.create({
        type: 'Node',
        id: 'child-server-overlay-node',
        hasParent: true,
        requestedLogicals: ['svc-server-overlay'],
        security: createSigningOverlaySecurityConfig({ cryptoProvider: serverCryptoProvider }),
        delivery: {
          type: 'AtLeastOnceDeliveryPolicy',
        },
        admission: {
          type: 'DirectAdmissionClient',
          connectionGrants: [
            {
              type: 'WebSocketConnectionGrant',
              purpose: 'node.attach',
              url: downstreamAttachUrl,
            },
          ],
          ttlSec: 60,
        },
      });

      await Promise.all([clientNode.start(), serverNode.start()]);

      await waitForCondition(() => clientNode?.handshakeCompleted === true);
      await waitForCondition(() => serverNode?.handshakeCompleted === true);

      if (!clientNode || !serverNode) {
        throw new Error('Overlay child nodes must be available');
      }

      const client = clientNode;
      const server = serverNode;

      await waitForCondition(() => Boolean(client.physicalPath));
      await waitForCondition(() => Boolean(server.physicalPath));

      const clientPhysicalPath = client.physicalPath;
      const serverPhysicalPath = server.physicalPath;
      expect(clientPhysicalPath).toMatch(/^\//);
      expect(serverPhysicalPath).toMatch(/^\//);

      const routeManager = (parent as unknown as { routeManager: RouteManager }).routeManager;
      await waitForCondition(() => routeManager.downstreamRoutes.has(client.id));
      await waitForCondition(() => routeManager.downstreamRoutes.has(server.id));

      const parentSecurity = parent.securityManager;
      expect(parentSecurity).toBeInstanceOf(DefaultSecurityManager);

      const clientSecurity = client.securityManager;
      const serverSecurity = server.securityManager;

      expect(clientSecurity).toBeInstanceOf(DefaultSecurityManager);
      expect(serverSecurity).toBeInstanceOf(DefaultSecurityManager);

      const parentOverlayManager = parentSecurity as DefaultSecurityManager;
      const clientOverlayManager = clientSecurity as DefaultSecurityManager;
      const serverOverlayManager = serverSecurity as DefaultSecurityManager;

      const parentKeyManager = parentOverlayManager.keyManager as KeyManager | null;
      const clientKeyManager = clientOverlayManager.keyManager as KeyManager | null;
      const serverKeyManager = serverOverlayManager.keyManager as KeyManager | null;

      expect(parentKeyManager).toBeTruthy();
      expect(clientKeyManager).toBeTruthy();
      expect(serverKeyManager).toBeTruthy();

      if (!parentKeyManager || !clientKeyManager || !serverKeyManager) {
        throw new Error('Overlay key managers must be available');
      }

      const parentKeyRequestSpy = jest.spyOn(parentKeyManager, 'handleKeyRequest');
      restoreSpies.push(() => parentKeyRequestSpy.mockRestore());

      const clientVerifier = clientOverlayManager.envelopeVerifier;
      const serverVerifier = serverOverlayManager.envelopeVerifier;

      expect(clientVerifier).toBeTruthy();
      expect(serverVerifier).toBeTruthy();

      if (!clientVerifier || !serverVerifier) {
        throw new Error('Overlay security requires envelope verifier for both nodes');
      }

      const clientVerifySpy = jest.spyOn(clientVerifier, 'verifyEnvelope');
      const serverVerifySpy = jest.spyOn(serverVerifier, 'verifyEnvelope');
      restoreSpies.push(() => clientVerifySpy.mockRestore());
      restoreSpies.push(() => serverVerifySpy.mockRestore());

      const initialClientKeys = Array.from(await clientKeyManager.getKeysForPath(serverPhysicalPath));
      const initialServerKeys = Array.from(await serverKeyManager.getKeysForPath(clientPhysicalPath));

      expect(initialClientKeys.length).toBe(0);
      expect(initialServerKeys.length).toBe(0);

      const rpcHandler = jest.fn(async (method: string, params?: Record<string, unknown>) => {
        expect(method).toBe('svc-overlay.echo');
        expect(params).toMatchObject({ message: 'overlay-hello', counter: 99 });
        return {
          echo: params?.message,
          counter: params?.counter,
          from: server.id,
        } satisfies Record<string, unknown>;
      });

      const serviceAddress = await server.listenRpc('svc-overlay', rpcHandler, WAIT_TIMEOUT_MS);

      await waitForCondition(() => {
        const info = routeManager._downstream_addresses_routes.get(serviceAddress.toString());
        return info?.segment === server.id;
      });

      const initialClientVerifyCount = clientVerifySpy.mock.calls.length;
      const initialServerVerifyCount = serverVerifySpy.mock.calls.length;

      const rpcResult = await client.invoke(
        serviceAddress,
        'svc-overlay.echo',
        { message: 'overlay-hello', counter: 99 },
        WAIT_TIMEOUT_MS
      );

      expect(rpcResult).toEqual({ echo: 'overlay-hello', counter: 99, from: server.id });
      expect(rpcHandler).toHaveBeenCalledTimes(1);

      await waitForCondition(() => clientVerifySpy.mock.calls.length > initialClientVerifyCount);
      await waitForCondition(() => serverVerifySpy.mock.calls.length > initialServerVerifyCount);

      const clientKeysAfter = await waitForKeysForPath(clientKeyManager, serverPhysicalPath, 1);
      const serverKeysAfter = await waitForKeysForPath(serverKeyManager, clientPhysicalPath, 1);

      expect(clientKeysAfter.length).toBeGreaterThanOrEqual(1);
      expect(serverKeysAfter.length).toBeGreaterThanOrEqual(1);

      await waitForCondition(() => {
        const segments = new Set(
          parentKeyRequestSpy.mock.calls
            .map(([options]) => options?.fromSegment)
            .filter((segment): segment is string => typeof segment === 'string')
        );
        return segments.has(client.id) && segments.has(server.id);
      });
    } finally {
      for (const restore of restoreSpies) {
        try {
          restore();
        } catch {
          // Ignore restoration errors during cleanup
        }
      }

      await Promise.allSettled([
        clientNode?.stop(),
        serverNode?.stop(),
        parent?.stop(),
      ]);
    }
  });
});
