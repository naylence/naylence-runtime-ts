import * as core from '@naylence/core';
import {
  DeliveryOriginType,
  FameAddress,
  FameResponseType,
  FlowFlags,
  type FameConnector,
  type FameDeliveryContext,
  type FameEnvelope,
  type FameFabric,
} from '@naylence/core';

import { Sentinel, type SentinelOptions } from '../sentinel.js';
import type { RoutingPolicy } from '../routing-policy.js';
import * as routeStore from '../store/route-store.js';
import type { RouteStore } from '../store/route-store.js';
import type { UpstreamSessionManager } from '../../node/upstream-session-manager.js';
import type { SecurityManager } from '../../security/security-manager.js';
import type { RouteManager } from '../route-manager.js';
import { createResource } from '../../connector/connector-factory.js';
import type { AddressRouteInfo } from '../key-frame-handler.js';
import { Peer } from '../peer.js';
import * as envelopeContext from '../../util/envelope-context.js';
import * as taskUtils from '../../util/task-utils.js';
import * as logging from '../../util/logging.js';
import type { AttachmentKeyValidator } from '../../security/keys/attachment-key-validator.js';
import type { LoadBalancerStickinessManager } from '../../stickiness/load-balancer-stickiness-manager.js';
import type { NodeAttachClient } from '../../node/admission/node-attach-client.js';
import type { OriginConnectorOptions } from '../../node/routing-node-like.js';

function confirmNode(node: Sentinel, id: string = 'test-sentinel') {
  (node as any)._confirmedId = id;
}

jest.mock('../../connector/connector-factory.js', () => ({
  createResource: jest.fn(),
}));

jest.mock('../../node/upstream-session-manager.js', () => {
  const mockClass = jest.fn().mockImplementation((options) => ({
    start: jest.fn(async () => undefined),
    stop: jest.fn(async () => undefined),
    systemId: 'peer-system',
    send: jest.fn(async () => undefined),
    options,
  }));
  return { UpstreamSessionManager: mockClass };
});

describe('Sentinel', () => {
  const createdSentinels: Sentinel[] = [];

  afterEach(async () => {
    jest.useRealTimers();
    jest.restoreAllMocks();

    const fastShutdown = {
      cancelHanging: true,
      gracePeriod: 0,
      joinTimeout: 0,
    } as const;

    const sentinels = createdSentinels.splice(0);
    await Promise.all(
      sentinels.map(async (sentinel) => {
        const sentinelAny = sentinel as unknown as {
          lifecycleTasks?: {
            shutdownTasks?: (options?: unknown) => Promise<void>;
          };
          routeManager?: RouteManager;
        };

        try {
          await sentinel.shutdownTasks(fastShutdown);
        } catch {
          // Ignore test cleanup errors
        }

        const lifecycleTasks = sentinelAny.lifecycleTasks;
        if (lifecycleTasks?.shutdownTasks) {
          try {
            await lifecycleTasks.shutdownTasks(fastShutdown);
          } catch {
            // Ignore test cleanup errors
          }
        }

        const routeManager = sentinelAny.routeManager;
        if (routeManager) {
          try {
            if (typeof routeManager.shutdownTasks === 'function') {
              await routeManager
                .shutdownTasks(fastShutdown)
                .catch(() => undefined);
            }
            await routeManager.stop();
          } catch {
            // Ignore test cleanup errors
          }
        }
      })
    );
  });

  function createMockConnector(): FameConnector {
    return {
      id: 'mock-connector',
      start: jest.fn(async () => undefined),
      stop: jest.fn(async () => undefined),
      send: jest.fn().mockResolvedValue(undefined),
      replaceHandler: jest.fn(),
      close: jest.fn(),
      isClosed: () => false,
    } as unknown as FameConnector;
  }

  function attachMockUpstreamManager(sentinel: Sentinel) {
    const manager = {
      send: jest.fn().mockResolvedValue(undefined),
    } as unknown as UpstreamSessionManager;
    (
      sentinel as unknown as { _sessionManager: UpstreamSessionManager | null }
    )._sessionManager = manager;
    return manager;
  }

  function createMockSecurityManager(): SecurityManager {
    const authorizer = {
      authorize: jest.fn(),
    } as unknown as SecurityManager['authorizer'];
    return {
      priority: 1000,
      policy: {} as SecurityManager['policy'],
      envelopeSigner: null,
      envelopeVerifier: null,
      encryption: null,
      keyManager: null,
      supportsOverlaySecurity: false,
      authorizer,
      certificateManager: null,
      envelopeSecurityHandler: null,
      secureChannelFrameHandler: null,
      getEncryptionKeyId: () => undefined,
      getShareableKeys: () => undefined,
      onDeliver: jest.fn(async (_node, envelope) => envelope),
    } as unknown as SecurityManager;
  }

  function createRouteStoreStub(): RouteStore {
    return {
      set: jest.fn(async () => undefined),
      update: jest.fn(async () => undefined),
      get: jest.fn(async () => undefined),
      delete: jest.fn(async () => undefined),
      list: jest.fn(async () => ({})),
    } as RouteStore;
  }

  function createSentinel(options: SentinelOptions = {}): Sentinel {
    const securityManager =
      options.securityManager ?? createMockSecurityManager();
    const sentinel = new Sentinel({ ...options, securityManager });
    confirmNode(sentinel, options.systemId ?? 'sentinel-test');
    createdSentinels.push(sentinel);
    return sentinel;
  }

  function createEnvelope(
    sentinel: Sentinel,
    frameType: string,
    options: {
      corrId?: string;
      flowId?: string;
      flowFlags?: FlowFlags;
      frameOverrides?: Record<string, unknown>;
    } = {}
  ): FameEnvelope {
    let frame: Record<string, unknown>;

    switch (frameType) {
      case 'NodeAttach':
        frame = {
          type: 'NodeAttach',
          systemId: 'child-system',
          instanceId: 'instance-1',
        };
        break;
      case 'AddressBind':
        frame = {
          type: 'AddressBind',
          address: 'svc@/child',
        };
        break;
      case 'AddressUnbind':
        frame = {
          type: 'AddressUnbind',
          address: 'svc@/child',
        };
        break;
      case 'AddressBindAck':
        frame = {
          type: 'AddressBindAck',
          address: 'svc@/child',
          ok: true,
        };
        break;
      case 'AddressUnbindAck':
        frame = {
          type: 'AddressUnbindAck',
          address: 'svc@/child',
          ok: true,
        };
        break;
      case 'CapabilityAdvertise':
        frame = {
          type: 'CapabilityAdvertise',
          capabilities: ['svc.capability'],
          address: 'svc@/child',
        };
        break;
      case 'CapabilityWithdraw':
        frame = {
          type: 'CapabilityWithdraw',
          capabilities: ['svc.capability'],
          address: 'svc@/child',
        };
        break;
      case 'CapabilityAdvertiseAck':
        frame = {
          type: 'CapabilityAdvertiseAck',
          capabilities: ['svc.capability'],
          address: 'svc@/child',
          ok: true,
        };
        break;
      case 'CapabilityWithdrawAck':
        frame = {
          type: 'CapabilityWithdrawAck',
          capabilities: ['svc.capability'],
          address: 'svc@/child',
          ok: true,
        };
        break;
      case 'CreditUpdate':
        frame = {
          type: 'CreditUpdate',
          flowId: 'flow-credits',
          credits: 1,
        };
        break;
      case 'NodeHeartbeat':
        frame = {
          type: 'NodeHeartbeat',
          systemId: 'node-heartbeat',
        };
        break;
      case 'Data':
        frame = {
          type: 'Data',
          payload: { message: 'test' },
        };
        break;
      default:
        frame = { type: frameType };
        break;
    }

    frame = { ...frame, ...(options.frameOverrides ?? {}) };

    const envelope = sentinel.envelopeFactory.createEnvelope({
      frame: frame as any,
      ...(options.corrId ? { corrId: options.corrId } : {}),
    });

    if (options.flowId) {
      envelope.flowId = options.flowId;
    }
    if (options.flowFlags !== undefined) {
      envelope.flowFlags = options.flowFlags;
    }

    return envelope;
  }

  it('buffers non-handshake frames until attach completes', async () => {
    const sentinel = createSentinel();
    const deliverSpy = jest
      .spyOn(sentinel, 'deliver')
      .mockResolvedValue(undefined);

    let storedHandler:
      | ((
          env: FameEnvelope,
          context?: FameDeliveryContext | null
        ) => Promise<unknown> | null)
      | null = null;

    const fakeConnector: FameConnector = {
      id: 'fake',
      start: jest.fn(async (handler) => {
        storedHandler = handler;
      }),
      stop: jest.fn(),
      send: jest.fn().mockResolvedValue(undefined),
      isClosed: () => false,
    } as unknown as FameConnector;

    (createResource as jest.Mock).mockResolvedValue(fakeConnector);

    const websocket = {
      readyState: 1,
      send: jest.fn(),
      close: jest.fn(),
    };

    await sentinel.createOriginConnector({
      originType: DeliveryOriginType.DOWNSTREAM,
      systemId: 'child-1',
      connectorConfig: { type: 'websocket', url: 'ws://test' } as any,
      websocket,
    });

    expect(fakeConnector.start).toHaveBeenCalledTimes(1);
    expect(storedHandler).toBeInstanceOf(Function);
    const handler = storedHandler!;

    const context = {
      expectedResponseType: FameResponseType.NONE,
    } as FameDeliveryContext;
    const bufferedEnvelope = createEnvelope(sentinel, 'Data');
    await handler(bufferedEnvelope, context);
    expect(deliverSpy).not.toHaveBeenCalled();

    const attachEnvelope = createEnvelope(sentinel, 'NodeAttach');
    await handler(attachEnvelope, context);
    expect(deliverSpy).toHaveBeenCalledTimes(1);
    expect(deliverSpy.mock.calls[0][0].frame?.type).toBe('NodeAttach');

    const routeManager = (sentinel as any).routeManager as RouteManager;
    const pendingEntry = routeManager._pending_routes.get('child-1');
    pendingEntry?.attached.set();

    const secondEnvelope = createEnvelope(sentinel, 'Data');
    await handler(secondEnvelope, context);

    expect(deliverSpy).toHaveBeenCalledTimes(3);
    expect(deliverSpy.mock.calls[1][0].frame?.type).toBe('Data');
    expect(deliverSpy.mock.calls[2][0].frame?.type).toBe('Data');
    expect(pendingEntry?.buffer).toHaveLength(0);
  });

  it('accepts snake_case Sentinel options', () => {
    const customRouteStore = createRouteStoreStub();
    const customPolicy: RoutingPolicy = {
      decide: jest.fn(async () => {
        throw new Error('not-used');
      }),
    } as RoutingPolicy;
    const attachmentValidator = {} as AttachmentKeyValidator;
    const stickinessManager = {} as LoadBalancerStickinessManager;
    const attachClient = {} as NodeAttachClient;

    const sentinel = createSentinel({
      route_store: customRouteStore,
      routing_policy: customPolicy,
      attach_timeout_sec: 1,
      max_attach_ttl_sec: 10,
      binding_ack_timeout_ms: 321,
      attachment_key_validator: attachmentValidator,
      stickiness_manager: stickinessManager,
      requested_logicals: ['alpha'],
      attach_client: attachClient,
      cleanup_delay_ms: 50,
      rebind_on_attach: true,
    } as unknown as SentinelOptions);

    const sentinelAny = sentinel as unknown as Record<string, any>;
    expect(sentinelAny.routingPolicy).toBe(customPolicy);
    expect(sentinelAny.attachmentKeyValidator).toBe(attachmentValidator);
    expect(sentinelAny.stickinessManager).toBe(stickinessManager);
    expect(sentinelAny.ackTimeoutMs).toBe(321);
    expect(sentinelAny.maxAttachTtlSec).toBe(10);
    expect(sentinelAny.requestedLogicals).toEqual(['alpha']);
    expect(sentinelAny.attachClient).toBe(attachClient);
    expect(sentinelAny.attachTimeoutMs).toBe(1000);
    expect(sentinelAny.cleanupDelayMs).toBe(50);
    expect(sentinelAny.rebindOnAttach).toBe(true);

    const routeManager = sentinelAny.routeManager as RouteManager;
    expect(routeManager._downstream_route_store).toBe(customRouteStore);
    expect((routeManager as any).cleanupDelayMs).toBe(50);
  });

  it('accepts snake_case origin connector options', async () => {
    const sentinel = createSentinel();
    const deliverSpy = jest
      .spyOn(sentinel, 'deliver')
      .mockResolvedValue(undefined);

    let storedHandler:
      | ((
          envelope: FameEnvelope,
          context?: FameDeliveryContext | null
        ) => Promise<unknown> | null)
      | null = null;

    const fakeConnector: FameConnector = {
      id: 'snake-origin',
      start: jest.fn(async (handler) => {
        storedHandler = handler;
      }),
      stop: jest.fn(),
      send: jest.fn().mockResolvedValue(undefined),
      isClosed: () => false,
    } as unknown as FameConnector;

    (createResource as jest.Mock).mockResolvedValueOnce(fakeConnector);

    const authorization = { roles: ['alias'] } as any;

    await sentinel.createOriginConnector({
      origin_type: DeliveryOriginType.DOWNSTREAM,
      system_id: 'snake-child',
      connector_config: { type: 'websocket', url: 'ws://alias' } as any,
      authorization_context: authorization,
    } as unknown as OriginConnectorOptions);

    const handler = storedHandler!;
    const routeManager = (sentinel as any).routeManager as RouteManager;
    const pendingEntry = routeManager._pending_routes.get('snake-child');
    pendingEntry?.attached.set();

    await handler(createEnvelope(sentinel, 'Data'), null);

    expect(deliverSpy).toHaveBeenCalledTimes(1);
    const deliveredContext = deliverSpy.mock.calls[0][1];
    expect(deliveredContext?.security?.authorization).toBe(authorization);
  });

  it('forwards transport options to the origin connector factory', async () => {
    const sentinel = createSentinel();
    const createResourceMock = createResource as jest.Mock;
    createResourceMock.mockReset();

    const connector = createMockConnector();
    createResourceMock.mockResolvedValue(connector);

    const websocket = {
      readyState: 1,
      send: jest.fn(),
      close: jest.fn(),
    };

    const extraOption = { handshake: 'open-profile' };

    await sentinel.createOriginConnector({
      originType: DeliveryOriginType.DOWNSTREAM,
      systemId: 'child-options',
      connectorConfig: { type: 'websocket', url: 'ws://options' } as any,
      websocket,
      extraOption,
      authorization: { roles: ['internal'] } as any,
    });

    expect(createResourceMock).toHaveBeenCalledTimes(1);
    const [configArg, factoryArgs] = createResourceMock.mock.calls[0];
    expect(configArg).toEqual({ type: 'websocket', url: 'ws://options' });
    expect(factoryArgs).toMatchObject({ websocket, extraOption });
    expect(factoryArgs.authorization).toBeUndefined();
  });

  it('validates origin connector context invariants before delivery', async () => {
    const sentinel = createSentinel();

    let storedHandler:
      | ((
          env: FameEnvelope,
          context?: FameDeliveryContext | null
        ) => Promise<unknown> | null)
      | null = null;

    const fakeConnector: FameConnector = {
      id: 'fake',
      start: jest.fn(async (handler) => {
        storedHandler = handler;
      }),
      stop: jest.fn(),
      send: jest.fn(),
      isClosed: () => false,
    } as unknown as FameConnector;

    (createResource as jest.Mock).mockResolvedValue(fakeConnector);

    await sentinel.createOriginConnector({
      originType: DeliveryOriginType.DOWNSTREAM,
      systemId: 'child-ctx',
      connectorConfig: { type: 'websocket', url: 'ws://test' } as any,
      websocket: { readyState: 1, send: jest.fn(), close: jest.fn() },
    });

    const handler = storedHandler!;
    const envelope = createEnvelope(sentinel, 'Data');

    const wrongConnector: FameConnector = {
      id: 'wrong',
      start: jest.fn(),
      stop: jest.fn(),
      send: jest.fn(),
      isClosed: () => false,
    } as unknown as FameConnector;

    await expect(
      handler(envelope, {
        fromConnector: wrongConnector,
        expectedResponseType: FameResponseType.NONE,
      } as FameDeliveryContext)
    ).rejects.toThrow('Context connector mismatch for origin connector');

    await expect(
      handler(envelope, {
        fromConnector: fakeConnector,
        fromSystemId: 'different',
        expectedResponseType: FameResponseType.NONE,
      } as FameDeliveryContext)
    ).rejects.toThrow('Context system id mismatch for origin connector');

    await expect(
      handler(envelope, {
        fromConnector: fakeConnector,
        fromSystemId: 'child-ctx',
        originType: DeliveryOriginType.PEER,
        expectedResponseType: FameResponseType.NONE,
      } as FameDeliveryContext)
    ).rejects.toThrow('Context origin type mismatch for origin connector');
  });

  it('enforces attach timeout for pending origin connectors', async () => {
    jest.useFakeTimers();
    const sentinel = createSentinel({ attachTimeoutSec: 0.05 });
    let routeManager: RouteManager | null = null;
    try {
      const connector = createMockConnector();
      (createResource as jest.Mock).mockResolvedValueOnce(connector);

      await sentinel.createOriginConnector({
        originType: DeliveryOriginType.DOWNSTREAM,
        systemId: 'timeout-child',
        connectorConfig: { type: 'websocket', url: 'ws://timeout' } as any,
        websocket: { readyState: 1, send: jest.fn(), close: jest.fn() },
      });

      routeManager = (sentinel as any).routeManager as RouteManager;
      expect(routeManager._pending_routes.has('timeout-child')).toBe(true);

      await jest.advanceTimersByTimeAsync(60);
      await Promise.resolve();
      await Promise.resolve();

      expect(connector.stop).toHaveBeenCalledTimes(1);
      expect(routeManager._pending_routes.has('timeout-child')).toBe(false);
    } finally {
      jest.useRealTimers();
      if (routeManager) {
        await routeManager
          .shutdownTasks({ cancelHanging: true })
          .catch(() => undefined);
      }
      const lifecycleTasks = (sentinel as any).lifecycleTasks as
        | { shutdownTasks: (options?: unknown) => Promise<void> }
        | undefined;
      await lifecycleTasks
        ?.shutdownTasks({ cancelHanging: true })
        .catch(() => undefined);
    }
  });

  it('merges authorization into security context for origin connectors', async () => {
    const sentinel = createSentinel();
    const deliverSpy = jest
      .spyOn(sentinel, 'deliver')
      .mockResolvedValue(undefined);

    let storedHandler:
      | ((
          env: FameEnvelope,
          context?: FameDeliveryContext | null
        ) => Promise<unknown> | null)
      | null = null;

    const fakeConnector: FameConnector = {
      id: 'secure',
      start: jest.fn(async (handler) => {
        storedHandler = handler;
      }),
      stop: jest.fn(),
      send: jest.fn().mockResolvedValue(undefined),
      isClosed: () => false,
    } as unknown as FameConnector;

    (createResource as jest.Mock).mockResolvedValue(fakeConnector);

    await sentinel.createOriginConnector({
      originType: DeliveryOriginType.DOWNSTREAM,
      systemId: 'secure-child',
      connectorConfig: { type: 'websocket', url: 'ws://secure' } as any,
      websocket: { readyState: 1, send: jest.fn(), close: jest.fn() },
      authorization: { roles: ['agent'] } as any,
    });

    const handler = storedHandler!;
    const routeManager = (sentinel as any).routeManager as RouteManager;
    const pendingEntry = routeManager._pending_routes.get('secure-child');
    pendingEntry?.attached.set();

    await handler(createEnvelope(sentinel, 'Data'), {
      security: { token: 'abc' } as any,
    } as FameDeliveryContext);

    const callArgs = deliverSpy.mock.calls[deliverSpy.mock.calls.length - 1];
    const [, ctx] = callArgs;
    expect(ctx?.security).toEqual({
      token: 'abc',
      authorization: { roles: ['agent'] },
    });
  });

  it('resolves pending binds when receiving acknowledgements', async () => {
    const sentinel = createSentinel();
    const sentinelAny = sentinel as any;

    jest
      .spyOn(sentinelAny.deliveryTracker, 'onEnvelopeDelivered')
      .mockResolvedValue(undefined);

    const pendingResolve = jest.fn();
    const pendingReject = jest.fn();

    sentinelAny.pendingBinds.set('corr-ok', {
      promise: Promise.resolve(true),
      resolve: pendingResolve,
      reject: pendingReject,
    });

    const okAck = createEnvelope(sentinel, 'AddressBindAck', {
      corrId: 'corr-ok',
    });
    await sentinel.deliver(okAck);
    expect(pendingResolve).toHaveBeenCalledWith(true);
    expect(sentinelAny.pendingBinds.has('corr-ok')).toBe(false);

    const pendingRejectOnly = jest.fn();
    sentinelAny.pendingBinds.set('corr-fail', {
      promise: Promise.resolve(false),
      resolve: jest.fn(),
      reject: pendingRejectOnly,
    });

    const failAck = createEnvelope(sentinel, 'AddressBindAck', {
      corrId: 'corr-fail',
      frameOverrides: { ok: false, reason: 'denied' },
    });
    await sentinel.deliver(failAck);
    expect(pendingRejectOnly).toHaveBeenCalled();
    expect(sentinelAny.pendingBinds.has('corr-fail')).toBe(false);
  });

  it('handles delivery acknowledgements from upstream', async () => {
    const sentinel = createSentinel();
    const sentinelAny = sentinel as any;

    const deliverySpy = jest
      .spyOn(sentinelAny.deliveryTracker, 'onEnvelopeDelivered')
      .mockResolvedValue(undefined);
    const rejectSpy = jest.fn();

    sentinelAny.pendingBinds.set('corr-delivery', {
      promise: Promise.resolve(false),
      resolve: jest.fn(),
      reject: rejectSpy,
    });

    const ack = createEnvelope(sentinel, 'DeliveryAck', {
      corrId: 'corr-delivery',
      frameOverrides: { ok: false },
    });

    await sentinelAny.handleSystemFrame(ack, undefined);

    expect(deliverySpy).toHaveBeenCalledWith('__sys__', ack, undefined);
    expect(rejectSpy).toHaveBeenCalledWith(expect.any(Error));
  });

  it('handles additional acknowledgement frames and missing pending entries', async () => {
    const sentinel = createSentinel();
    const sentinelAny = sentinel as any;

    jest
      .spyOn(sentinelAny.deliveryTracker, 'onEnvelopeDelivered')
      .mockResolvedValue(undefined);

    const ackResolve = jest.fn();
    sentinelAny.pendingBinds.set('corr-unbind', {
      promise: Promise.resolve(true),
      resolve: ackResolve,
      reject: jest.fn(),
    });

    const unbindAck = createEnvelope(sentinel, 'AddressUnbindAck', {
      corrId: 'corr-unbind',
    });
    await sentinel.deliver(unbindAck);
    expect(
      sentinelAny.deliveryTracker.onEnvelopeDelivered
    ).toHaveBeenCalledWith('__sys__', unbindAck, undefined);
    expect(ackResolve).not.toHaveBeenCalled();

    await expect(
      sentinel.deliver(
        createEnvelope(sentinel, 'CapabilityAdvertiseAck', {
          corrId: 'unknown-ack',
        })
      )
    ).resolves.toBeUndefined();
  });

  it('ignores bind acknowledgements for unknown correlation ids', async () => {
    const sentinel = createSentinel();
    const sentinelAny = sentinel as any;

    const deliverySpy = jest
      .spyOn(sentinelAny.deliveryTracker, 'onEnvelopeDelivered')
      .mockResolvedValue(undefined);

    await expect(
      sentinel.deliver(
        createEnvelope(sentinel, 'AddressBindAck', { corrId: 'missing' })
      )
    ).resolves.toBeUndefined();

    expect(deliverySpy).toHaveBeenCalled();
    expect(sentinelAny.pendingBinds.size).toBe(0);
  });

  it('swallows errors from completion dispatch handlers during forwarding', async () => {
    const sentinel = createSentinel();
    const sentinelAny = sentinel as any;

    const envelope = createEnvelope(sentinel, 'Data');
    const peerConnector = createMockConnector();

    sentinelAny.routeManager._peer_routes.set('peer-a', peerConnector);
    jest
      .spyOn(sentinelAny, 'trackFlowRoute')
      .mockImplementation(() => undefined);
    jest
      .spyOn(sentinelAny, 'maybeForgetFlow')
      .mockImplementation(() => undefined);

    attachMockUpstreamManager(sentinel);
    sentinel.setUpstreamConnector(createMockConnector());

    const dispatchMock = jest
      .spyOn(sentinelAny, 'dispatchEnvelopeEvent')
      .mockImplementation(async (...args: any[]) => {
        const [eventName, ...rest] = args;
        if (typeof eventName === 'string' && eventName.endsWith('Complete')) {
          throw new Error(`boom-${eventName}`);
        }
        if (eventName === 'onForwardToPeer') {
          return rest[2];
        }
        if (eventName === 'onForwardToPeers') {
          return rest[1];
        }
        if (eventName === 'onForwardUpstream') {
          return rest[1];
        }
        return rest[1] ?? null;
      });

    await expect(
      sentinel.forwardToPeer('peer-a', envelope)
    ).resolves.toBeUndefined();
    await expect(
      sentinel.forwardToPeers(envelope, ['peer-a'])
    ).resolves.toBeUndefined();
    await expect(
      sentinel.forwardUpstream(envelope, {
        originType: DeliveryOriginType.DOWNSTREAM,
      } as FameDeliveryContext)
    ).resolves.toBeUndefined();

    expect(
      (peerConnector.send as jest.Mock).mock.calls.length
    ).toBeGreaterThanOrEqual(2);
    const manager = (
      sentinel as unknown as { _sessionManager: UpstreamSessionManager }
    )._sessionManager;
    expect((manager.send as jest.Mock).mock.calls.length).toBe(1);
    expect(dispatchMock).toHaveBeenCalledWith(
      'onForwardUpstreamComplete',
      sentinel,
      envelope,
      undefined,
      undefined,
      {
        originType: DeliveryOriginType.DOWNSTREAM,
      }
    );
    dispatchMock.mockRestore();
  });

  it('skips forwarding to a peer when dispatch vetoes forwarding', async () => {
    const sentinel = createSentinel();
    const sentinelAny = sentinel as any;
    const envelope = createEnvelope(sentinel, 'Data');
    const connector = createMockConnector();

    sentinelAny.routeManager._peer_routes.set('peer-a', connector);

    const dispatchMock = jest
      .spyOn(sentinelAny, 'dispatchEnvelopeEvent')
      .mockImplementation(async (...args: unknown[]) => {
        const [eventName, ...rest] = args as [string, ...unknown[]];
        if (eventName === 'onForwardToPeer') {
          return null;
        }
        return rest[0] ?? null;
      });

    await sentinel.forwardToPeer('peer-a', envelope);

    expect(connector.send).not.toHaveBeenCalled();
    expect(dispatchMock).toHaveBeenCalledWith(
      'onForwardToPeer',
      sentinel,
      'peer-a',
      envelope,
      undefined
    );
    dispatchMock.mockRestore();
  });

  it('skips forwarding to peers when dispatch vetoes the request', async () => {
    const sentinel = createSentinel();
    const sentinelAny = sentinel as any;
    const envelope = createEnvelope(sentinel, 'Data');
    const connector = createMockConnector();

    sentinelAny.routeManager._peer_routes.set('peer-a', connector);

    const dispatchMock = jest
      .spyOn(sentinelAny, 'dispatchEnvelopeEvent')
      .mockImplementation(async (...args: unknown[]) => {
        const [eventName, ...rest] = args as [string, ...unknown[]];
        if (eventName === 'onForwardToPeers') {
          return null;
        }
        return rest[0] ?? null;
      });

    await sentinel.forwardToPeers(envelope, ['peer-a']);

    expect(connector.send).not.toHaveBeenCalled();
    expect(dispatchMock).toHaveBeenCalledWith(
      'onForwardToPeers',
      sentinel,
      envelope,
      ['peer-a'],
      undefined,
      undefined
    );
    dispatchMock.mockRestore();
  });

  it('skips forwarding upstream when dispatch vetoes the request', async () => {
    const sentinel = createSentinel();
    const sentinelAny = sentinel as any;
    const envelope = createEnvelope(sentinel, 'Data');

    const manager = attachMockUpstreamManager(sentinel);
    sentinel.setUpstreamConnector(createMockConnector());

    const dispatchMock = jest
      .spyOn(sentinelAny, 'dispatchEnvelopeEvent')
      .mockImplementation(async (...args: unknown[]) => {
        const [eventName, ...rest] = args as [string, ...unknown[]];
        if (eventName === 'onForwardUpstream') {
          return null;
        }
        return rest[0] ?? null;
      });

    const context = {
      originType: DeliveryOriginType.DOWNSTREAM,
    } as FameDeliveryContext;

    await sentinel.forwardUpstream(envelope, context);

    expect(manager.send as jest.Mock).not.toHaveBeenCalled();
    expect(dispatchMock).toHaveBeenCalledWith(
      'onForwardUpstream',
      sentinel,
      envelope,
      context
    );
    dispatchMock.mockRestore();
  });

  it('skips forwarding upstream when origin already upstream', async () => {
    const sentinel = createSentinel();
    const envelope = createEnvelope(sentinel, 'Data');
    const context = {
      originType: DeliveryOriginType.UPSTREAM,
    } as FameDeliveryContext;

    const manager = attachMockUpstreamManager(sentinel);
    const connector = createMockConnector();
    const sendSpy = manager.send as jest.Mock;
    sentinel.setUpstreamConnector(connector);

    await sentinel.forwardUpstream(envelope, context);

    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('allows forwarding when origin matches peer segment', async () => {
    const sentinel = createSentinel();
    const sentinelAny = sentinel as any;
    const envelope = createEnvelope(sentinel, 'Data');
    const connector = createMockConnector();

    sentinelAny.routeManager._peer_routes.set('peer-a', connector);

    await sentinel.forwardToPeer('peer-a', envelope, {
      originType: DeliveryOriginType.PEER,
      fromSystemId: 'peer-a',
    } as FameDeliveryContext);

    expect(connector.send).toHaveBeenCalled();
  });

  it('completes upstream forwarding without connector', async () => {
    const sentinel = createSentinel();
    const sentinelAny = sentinel as any;
    const dispatchMock = jest
      .spyOn(sentinelAny, 'dispatchEnvelopeEvent')
      .mockImplementation(async (...args: unknown[]) => {
        const [eventName, ...rest] = args as [string, ...unknown[]];
        if (eventName.endsWith('Complete')) {
          return rest[0];
        }
        return rest[0] ?? null;
      });

    await sentinel.forwardUpstream(createEnvelope(sentinel, 'Data'));

    expect(dispatchMock).toHaveBeenCalledWith(
      'onForwardUpstreamComplete',
      sentinel,
      expect.any(Object),
      undefined,
      undefined,
      undefined
    );
    dispatchMock.mockRestore();
  });

  it('routes non-local frames to the appropriate handlers', async () => {
    const sentinel = createSentinel();
    const sentinelAny = sentinel as any;

    const nodeAttachSpy = jest
      .spyOn(sentinelAny.nodeAttachFrameHandler, 'acceptNodeAttach')
      .mockResolvedValue(undefined);
    const addressBindSpy = jest
      .spyOn(sentinelAny.addressBindFrameHandler, 'acceptAddressBind')
      .mockResolvedValue(undefined);
    const addressUnbindSpy = jest
      .spyOn(sentinelAny.addressBindFrameHandler, 'acceptAddressUnbind')
      .mockResolvedValue(undefined);
    const capabilityAdvertiseSpy = jest
      .spyOn(sentinelAny.capabilityFrameHandler, 'acceptCapabilityAdvertise')
      .mockResolvedValue(undefined);
    const capabilityWithdrawSpy = jest
      .spyOn(sentinelAny.capabilityFrameHandler, 'acceptCapabilityWithdraw')
      .mockResolvedValue(undefined);
    const creditUpdateSpy = jest
      .spyOn(sentinelAny.creditUpdateFrameHandler, 'acceptCreditUpdate')
      .mockResolvedValue(undefined);
    const nodeHeartbeatSpy = jest
      .spyOn(sentinelAny.nodeHeartbeatFrameHandler, 'acceptNodeHeartbeat')
      .mockResolvedValue(undefined);

    const context = {
      originType: DeliveryOriginType.DOWNSTREAM,
      expectedResponseType: FameResponseType.NONE,
    } as FameDeliveryContext;

    await sentinel.deliver(createEnvelope(sentinel, 'NodeAttach'), context);
    expect(nodeAttachSpy).toHaveBeenCalled();

    await sentinel.deliver(createEnvelope(sentinel, 'AddressBind'), context);
    expect(addressBindSpy).toHaveBeenCalled();

    await sentinel.deliver(createEnvelope(sentinel, 'AddressUnbind'), context);
    expect(addressUnbindSpy).toHaveBeenCalled();

    const advertiseEnvelope = createEnvelope(sentinel, 'CapabilityAdvertise');
    await sentinel.deliver(advertiseEnvelope, context);
    expect(capabilityAdvertiseSpy).toHaveBeenCalled();

    const withdrawEnvelope = createEnvelope(sentinel, 'CapabilityWithdraw');
    await sentinel.deliver(withdrawEnvelope, context);
    expect(capabilityWithdrawSpy).toHaveBeenCalled();

    await sentinel.deliver(createEnvelope(sentinel, 'CreditUpdate'), context);
    expect(creditUpdateSpy).toHaveBeenCalled();

    await sentinel.deliver(createEnvelope(sentinel, 'NodeHeartbeat'), context);
    expect(nodeHeartbeatSpy).toHaveBeenCalled();
  });

  it('skips remote handlers for local deliveries', async () => {
    const sentinel = createSentinel();
    const sentinelAny = sentinel as any;
    const addressBindSpy = jest
      .spyOn(sentinelAny.addressBindFrameHandler, 'acceptAddressBind')
      .mockResolvedValue(undefined);

    await sentinel.deliver(createEnvelope(sentinel, 'AddressBind'), {
      originType: DeliveryOriginType.LOCAL,
      expectedResponseType: FameResponseType.NONE,
    } as FameDeliveryContext);

    expect(addressBindSpy).not.toHaveBeenCalled();
  });

  it('forwards traffic to downstream routes and clears reset flows', async () => {
    const sentinel = createSentinel();
    const routeManager = (sentinel as any).routeManager as RouteManager;

    const connector: FameConnector = {
      id: 'downstream',
      start: jest.fn(),
      stop: jest.fn(),
      send: jest.fn().mockResolvedValue(undefined),
      isClosed: () => false,
    } as unknown as FameConnector;

    await routeManager.registerDownstreamRoute('child', connector);

    const first = createEnvelope(sentinel, 'Data', { flowId: 'flow-1' });
    await sentinel.forwardToRoute('child', first);
    expect(connector.send).toHaveBeenCalledWith(first);
    expect(routeManager.getFlowRoute('flow-1')).toBe(connector);

    const reset = createEnvelope(sentinel, 'Data', {
      flowId: 'flow-1',
      flowFlags: FlowFlags.RESET,
    });
    await sentinel.forwardToRoute('child', reset);
    expect(routeManager.getFlowRoute('flow-1')).toBeUndefined();
  });

  it('avoids re-tracking flows when route already known', async () => {
    const sentinel = createSentinel();
    const routeManager = (sentinel as any).routeManager as RouteManager;

    const connector: FameConnector = {
      id: 'downstream',
      start: jest.fn(),
      stop: jest.fn(),
      send: jest.fn().mockResolvedValue(undefined),
      isClosed: () => false,
    } as unknown as FameConnector;

    await routeManager.registerDownstreamRoute('child', connector);

    const trackSpy = jest.spyOn(routeManager, 'trackFlowRoute');

    await sentinel.forwardToRoute(
      'child',
      createEnvelope(sentinel, 'Data', { flowId: 'dup-flow' }),
      {
        originType: DeliveryOriginType.DOWNSTREAM,
        fromSystemId: 'child',
        expectedResponseType: FameResponseType.NONE,
      } as FameDeliveryContext
    );

    await sentinel.forwardToRoute(
      'child',
      createEnvelope(sentinel, 'Data', { flowId: 'dup-flow' })
    );

    expect(trackSpy).toHaveBeenCalledTimes(1);
  });

  it('emits delivery NACK when downstream route is missing', async () => {
    const sentinel = createSentinel();
    const nackSpy = jest
      .spyOn(sentinel, 'emitDeliveryNack')
      .mockResolvedValue(undefined);
    const envelope = createEnvelope(sentinel, 'Data');
    await sentinel.forwardToRoute('missing', envelope);
    expect(nackSpy).toHaveBeenCalledWith(
      envelope,
      expect.objectContaining({ code: 'CHILD_UNREACHABLE' })
    );
  });

  it('routes peer traffic and handles missing peer connectors', async () => {
    const sentinel = createSentinel();
    const routeManager = (sentinel as any).routeManager as RouteManager;

    const peerConnector: FameConnector = {
      id: 'peer',
      start: jest.fn(),
      stop: jest.fn(),
      send: jest.fn().mockResolvedValue(undefined),
      isClosed: () => false,
    } as unknown as FameConnector;

    await routeManager.registerPeerRoute('peer-1', peerConnector);

    const envelope = createEnvelope(sentinel, 'Data');
    await sentinel.forwardToPeer('peer-1', envelope);
    expect(peerConnector.send).toHaveBeenCalledWith(envelope);

    const nackSpy = jest
      .spyOn(sentinel, 'emitDeliveryNack')
      .mockResolvedValue(undefined);
    await sentinel.forwardToPeer('peer-missing', envelope);
    expect(nackSpy).toHaveBeenCalledWith(
      envelope,
      expect.objectContaining({ code: 'PEER_UNREACHABLE' })
    );
  });

  it('throws when broadcasting to a peer without a connector', async () => {
    const sentinel = createSentinel();
    await expect(
      sentinel.forwardToPeers(createEnvelope(sentinel, 'Data'), ['unknown'])
    ).rejects.toThrow("No route for peer segment 'unknown'");
  });

  it('broadcasts to peers respecting exclusions', async () => {
    const sentinel = createSentinel();
    const routeManager = (sentinel as any).routeManager as RouteManager;

    const peerOne: FameConnector = {
      id: 'peer-1',
      start: jest.fn(),
      stop: jest.fn(),
      send: jest.fn().mockResolvedValue(undefined),
      isClosed: () => false,
    } as unknown as FameConnector;
    const peerTwo: FameConnector = {
      id: 'peer-2',
      start: jest.fn(),
      stop: jest.fn(),
      send: jest.fn().mockResolvedValue(undefined),
      isClosed: () => false,
    } as unknown as FameConnector;

    await routeManager.registerPeerRoute('peer-1', peerOne);
    await routeManager.registerPeerRoute('peer-2', peerTwo);

    const envelope = createEnvelope(sentinel, 'Data', {
      flowId: 'broadcast-flow',
    });

    await sentinel.forwardToPeers(envelope, null, ['peer-2']);

    expect(peerOne.send).toHaveBeenCalledWith(envelope);
    expect(peerTwo.send).not.toHaveBeenCalled();
  });

  it('forwards upstream only when not already originating upstream', async () => {
    const sentinel = createSentinel();
    const upstreamConnector: FameConnector = {
      id: 'upstream',
      start: jest.fn(),
      stop: jest.fn(),
      send: jest.fn().mockResolvedValue(undefined),
      isClosed: () => false,
    } as unknown as FameConnector;

    sentinel.setUpstreamConnector(upstreamConnector);
    const manager = attachMockUpstreamManager(sentinel);

    const envelope = createEnvelope(sentinel, 'Data');

    await sentinel.forwardUpstream(envelope, {
      originType: DeliveryOriginType.UPSTREAM,
      expectedResponseType: FameResponseType.NONE,
    });
    expect(manager.send as jest.Mock).not.toHaveBeenCalled();

    await sentinel.forwardUpstream(envelope, {
      originType: DeliveryOriginType.DOWNSTREAM,
      expectedResponseType: FameResponseType.NONE,
    });
    expect(manager.send as jest.Mock).toHaveBeenCalledWith(envelope);
  });

  it('builds router state and resolves capabilities', async () => {
    const sentinel = createSentinel({
      hasParent: true,
      bindingAckTimeoutMs: 10,
    });
    const sentinelAny = sentinel as any;
    const routeManager = sentinelAny.routeManager as RouteManager;

    const downstreamConnector: FameConnector = {
      id: 'child',
      start: jest.fn(),
      stop: jest.fn(),
      send: jest.fn(),
      isClosed: () => false,
    } as unknown as FameConnector;

    await routeManager.registerDownstreamRoute('child', downstreamConnector);
    routeManager._downstream_addresses_routes.set('svc@/child', {
      segment: 'child',
      physicalPath: '/child',
    });

    const peerConnector: FameConnector = {
      id: 'peer',
      start: jest.fn(),
      stop: jest.fn(),
      send: jest.fn(),
      isClosed: () => false,
    } as unknown as FameConnector;
    await routeManager.registerPeerRoute('peer', peerConnector);
    routeManager._peer_addresses_routes.set('svc@/peer', 'peer');

    const bindingManager = sentinelAny.bindingManager;
    jest
      .spyOn(bindingManager, 'getAddresses')
      .mockReturnValue([new FameAddress('svc@/local')]);

    const capabilityHandler = sentinelAny.capabilityFrameHandler;
    (capabilityHandler as any).capabilityRoutes.set(
      'capability/service',
      new Map([
        [
          'not-an-address',
          { address: new FameAddress('svc@/child'), segment: 'child' },
        ],
        [
          'svc@/child',
          { address: new FameAddress('svc@/child'), segment: 'child' },
        ],
      ])
    );

    const addressBindHandler = sentinelAny.addressBindFrameHandler;
    addressBindHandler.pools.set(
      { name: 'pool', pattern: '/svc' },
      new Set(['child'])
    );

    const state = sentinel.buildRouterState();
    expect(state.local.has('svc@/local')).toBe(true);
    expect(state.downstreamAddressRoutes.get('svc@/child')).toBe('child');
    expect(Array.from(state.pools.keys())).toContainEqual(['pool', '/svc']);

    const resolved = await state.resolveAddressByCapability?.([
      'capability/service',
    ]);
    expect(resolved?.toString()).toBe('svc@/child');
  });

  it('continues capability resolution when encountering invalid addresses', async () => {
    const sentinel = createSentinel({ hasParent: true });
    const sentinelAny = sentinel as any;
    const capabilityHandler = sentinelAny.capabilityFrameHandler;
    const routes = new Map<
      string,
      Map<string, { address: FameAddress; segment: string }>
    >();
    routes.set(
      'capability/chain',
      new Map([
        [
          'invalid-address',
          { address: new FameAddress('svc@/child'), segment: 'child' },
        ],
        [
          'svc@/child',
          { address: new FameAddress('svc@/child'), segment: 'child' },
        ],
      ])
    );

    (capabilityHandler as any).capabilityRoutes = routes;

    const found = await sentinelAny.resolveAddressByCapability([
      'capability/chain',
    ]);
    expect(found?.toString()).toBe('svc@/child');
  });

  it('uses persistent route store when creation succeeds', () => {
    const persistentStore = createRouteStoreStub();
    const persistentSpy = jest
      .spyOn(routeStore, 'createPersistentRouteStore')
      .mockReturnValue(persistentStore);
    const defaultSpy = jest
      .spyOn(routeStore, 'getDefaultRouteStore')
      .mockImplementation(() => {
        throw new Error('should not be called');
      });

    try {
      const sentinel = createSentinel();
      const sentinelAny = sentinel as any;

      expect(persistentSpy).toHaveBeenCalledTimes(1);
      expect(defaultSpy).not.toHaveBeenCalled();
      expect(sentinelAny.routeManager._downstream_route_store).toBe(
        persistentStore
      );
      expect(persistentSpy.mock.calls[0]?.[0]).toBe(sentinel.storageProvider);
    } finally {
      persistentSpy.mockRestore();
      defaultSpy.mockRestore();
    }
  });

  it('falls back to default route store when persistent creation fails', () => {
    const defaultStore = createRouteStoreStub();
    const persistentSpy = jest
      .spyOn(routeStore, 'createPersistentRouteStore')
      .mockImplementation(() => {
        throw new Error('no provider');
      });
    const defaultSpy = jest
      .spyOn(routeStore, 'getDefaultRouteStore')
      .mockReturnValue(defaultStore);

    try {
      const sentinel = createSentinel();
      const sentinelAny = sentinel as any;

      expect(defaultSpy).toHaveBeenCalledTimes(1);
      expect(sentinelAny.routeManager._downstream_route_store).toBe(
        defaultStore
      );
    } finally {
      persistentSpy.mockRestore();
      defaultSpy.mockRestore();
    }
  });

  it('propagates downstream bindings upstream when parent exists', async () => {
    const sentinel = createSentinel({ hasParent: true });
    const sentinelAny = sentinel as any;
    const routeManager = sentinelAny.routeManager as RouteManager;

    routeManager._downstream_addresses_routes.set('svc@/child', {
      segment: 'child',
    });
    routeManager._downstream_addresses_routes.set('svc@/other', null as any);
    routeManager._downstream_addresses_routes.set('__sys__@/child', {
      segment: 'child',
    } as AddressRouteInfo);

    const bindSpy = jest
      .spyOn(sentinelAny, 'bindAddressUpstream')
      .mockResolvedValue(undefined);
    await sentinelAny.propagateAddressBindingsUpstream();
    expect(bindSpy).toHaveBeenCalledTimes(1);
    const [[addressArg, infoArg]] = bindSpy.mock.calls as Array<
      [FameAddress, AddressRouteInfo]
    >;
    expect(addressArg.toString()).toBe('svc@/child');
    expect(infoArg).toEqual({ segment: 'child' });
  });

  it('does not propagate bindings when parent is absent', async () => {
    const sentinel = createSentinel({ hasParent: false });
    const sentinelAny = sentinel as any;
    const bindSpy = jest.spyOn(sentinelAny, 'bindAddressUpstream');
    await sentinelAny.propagateAddressBindingsUpstream();
    expect(bindSpy).not.toHaveBeenCalled();
  });

  it('replays downstream bindings upstream when attaching to parent and rebind is enabled', async () => {
    const sentinel = createSentinel({ hasParent: true, rebindOnAttach: true });
    const sentinelAny = sentinel as any;
    const routeManager = sentinelAny.routeManager as RouteManager;

    routeManager._downstream_addresses_routes.set('svc@/child', {
      segment: 'child',
    });

    const bindSpy = jest
      .spyOn(sentinelAny, 'bindAddressUpstream')
      .mockResolvedValue(undefined);

    await sentinel.dispatchEvent(
      'onNodeAttachToUpstream',
      sentinel,
      {} as unknown
    );

    expect(bindSpy).toHaveBeenCalledTimes(1);
    const [firstCall] = bindSpy.mock.calls as Array<
      [FameAddress, AddressRouteInfo]
    >;
    expect(firstCall?.[0]?.toString()).toBe('svc@/child');
  });

  it('does not replay downstream bindings upstream on attach when rebind is disabled', async () => {
    const sentinel = createSentinel({ hasParent: true, rebindOnAttach: false });
    const sentinelAny = sentinel as any;
    const routeManager = sentinelAny.routeManager as RouteManager;

    routeManager._downstream_addresses_routes.set('svc@/child', {
      segment: 'child',
    });

    const bindSpy = jest.spyOn(sentinelAny, 'bindAddressUpstream');

    await sentinel.dispatchEvent(
      'onNodeAttachToUpstream',
      sentinel,
      {} as unknown
    );

    expect(bindSpy).not.toHaveBeenCalled();
  });

  it('removes downstream routes without stopping connectors when requested', async () => {
    const sentinel = createSentinel();
    const routeManager = (sentinel as any).routeManager as RouteManager;
    const connector: FameConnector = {
      id: 'downstream',
      start: jest.fn(),
      stop: jest.fn(),
      send: jest.fn(),
      isClosed: () => false,
    } as unknown as FameConnector;

    await routeManager.registerDownstreamRoute('child', connector);
    const unregisterSpy = jest.spyOn(routeManager, 'unregisterDownstreamRoute');

    await sentinel.removeDownstreamRoute('child', { stop: false });

    expect(unregisterSpy).toHaveBeenCalledWith(
      'child',
      expect.objectContaining({ stop: false })
    );
    expect(routeManager.downstreamRoutes.has('child')).toBe(false);
  });

  it('delays connector cleanup before stopping downstream routes', async () => {
    jest.useFakeTimers();
    const sentinel = createSentinel({ cleanupDelayMs: 50 });
    const routeManager = (sentinel as any).routeManager as RouteManager;
    const connector = createMockConnector();
    try {
      await routeManager.registerDownstreamRoute('child-delay', connector);

      await sentinel.removeDownstreamRoute('child-delay');
      expect(connector.stop).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(60);
      await Promise.resolve();
      await Promise.resolve();

      expect(connector.stop).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
      await routeManager
        .shutdownTasks({ cancelHanging: true })
        .catch(() => undefined);
    }
  });

  it('cancels pending connector cleanup when route re-registers quickly', async () => {
    jest.useFakeTimers();
    const sentinel = createSentinel({ cleanupDelayMs: 100 });
    const routeManager = (sentinel as any).routeManager as RouteManager;
    const firstConnector = createMockConnector();
    const secondConnector = createMockConnector();
    try {
      await routeManager.registerDownstreamRoute(
        'child-cancel',
        firstConnector
      );
      await sentinel.removeDownstreamRoute('child-cancel');

      await routeManager.registerDownstreamRoute(
        'child-cancel',
        secondConnector
      );

      await jest.advanceTimersByTimeAsync(200);
      await Promise.resolve();

      expect(firstConnector.stop).not.toHaveBeenCalled();

      await sentinel.removeDownstreamRoute('child-cancel', { stop: false });
    } finally {
      jest.useRealTimers();
      await routeManager
        .shutdownTasks({ cancelHanging: true })
        .catch(() => undefined);
    }
  });

  it('removes peer routes without stopping connectors when requested', async () => {
    const sentinel = createSentinel();
    const routeManager = (sentinel as any).routeManager as RouteManager;
    const connector: FameConnector = {
      id: 'peer',
      start: jest.fn(),
      stop: jest.fn(),
      send: jest.fn(),
      isClosed: () => false,
    } as unknown as FameConnector;

    await routeManager.registerPeerRoute('peer', connector);
    const unregisterSpy = jest.spyOn(routeManager, 'unregisterPeerRoute');

    await sentinel.removePeerRoute('peer', { stop: false });

    expect(unregisterSpy).toHaveBeenCalledWith(
      'peer',
      expect.objectContaining({ stop: false })
    );
    expect(routeManager._peer_routes.has('peer')).toBe(false);
  });

  it('connects configured peers through the upstream session manager', async () => {
    const sentinel = createSentinel({
      attachClient: {} as any,
      peers: [new Peer({ admissionClient: {} as any })],
    });
    const sentinelAny = sentinel as any;
    const routeManager = sentinelAny.routeManager as RouteManager;
    const registerSpy = jest
      .spyOn(routeManager, 'registerPeerRoute')
      .mockResolvedValue(undefined);

    await sentinelAny.connectToPeers();

    const { UpstreamSessionManager } = jest.requireMock(
      '../../node/upstream-session-manager.js'
    ) as {
      UpstreamSessionManager: jest.Mock;
    };
    const sessionInstance = UpstreamSessionManager.mock.results[0]?.value;

    expect(UpstreamSessionManager).toHaveBeenCalledWith(
      expect.objectContaining({
        node: sentinel,
        inboundOriginType: DeliveryOriginType.PEER,
        outboundOriginType: DeliveryOriginType.PEER,
      })
    );
    expect(sessionInstance).toBeDefined();
    expect(sessionInstance?.start).toHaveBeenCalledTimes(1);
    expect(registerSpy).toHaveBeenCalledWith('peer-system', sessionInstance);
    expect(sentinelAny.peerSessionManagers.get('peer-system')).toBe(
      sessionInstance
    );

    registerSpy.mockRestore();
  });

  it('requires an attach client before connecting to peers', async () => {
    const sentinel = createSentinel({ attachClient: null });
    const peer = { admissionClient: {} as any } as Peer;

    await expect((sentinel as any).connectToPeer(peer)).rejects.toThrow(
      'Missing attach client'
    );
  });

  it('requires an admission client before connecting to peers', async () => {
    const sentinel = createSentinel({ attachClient: {} as any });
    const peer = { admissionClient: undefined } as unknown as Peer;

    await expect((sentinel as any).connectToPeer(peer)).rejects.toThrow(
      'Missing admission client'
    );
  });

  it('handles inbound peer envelopes with normalized context', async () => {
    const sentinel = createSentinel();
    const deliverSpy = jest
      .spyOn(sentinel, 'deliver')
      .mockResolvedValue(undefined);

    const response = await (sentinel as any).handleInboundFromPeer(
      createEnvelope(sentinel, 'Data'),
      {
        originType: DeliveryOriginType.DOWNSTREAM,
        fromSystemId: 'peer-1',
        expectedResponseType: FameResponseType.ACK,
        security: { token: 'abc' },
        stickinessRequired: true,
        stickySid: 'sticky',
      } as FameDeliveryContext
    );

    expect(response).toBeNull();
    expect(deliverSpy).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        originType: DeliveryOriginType.PEER,
        expectedResponseType: FameResponseType.ACK,
        stickinessRequired: true,
        stickySid: 'sticky',
      })
    );
  });

  it('stops delivery when dispatch vetoes the envelope', async () => {
    const sentinel = createSentinel();
    const sentinelAny = sentinel as any;
    const dispatchMock = jest
      .spyOn(sentinelAny, 'dispatchEnvelopeEvent')
      .mockImplementation(async (...args: unknown[]) => {
        const [eventName] = args as [string, ...unknown[]];
        if (eventName === 'onDeliver') {
          return null;
        }
        return args[3] ?? null;
      });
    const routeDecisionSpy = jest.spyOn(sentinelAny.routingPolicy, 'decide');

    await sentinel.deliver(createEnvelope(sentinel, 'Data'));

    expect(routeDecisionSpy).not.toHaveBeenCalled();
    dispatchMock.mockRestore();
    routeDecisionSpy.mockRestore();
  });

  it('skips propagating downstream bindings when no parent is configured', async () => {
    const sentinel = createSentinel({ hasParent: false });
    const sentinelAny = sentinel as any;
    const bindSpy = jest.spyOn(sentinelAny, 'bindAddressUpstream');

    await sentinelAny.propagateAddressBindingsUpstream();

    expect(bindSpy).not.toHaveBeenCalled();
    bindSpy.mockRestore();
  });

  it('ignores downstream address entries without routing info during propagation', async () => {
    const sentinel = createSentinel({ hasParent: true });
    const sentinelAny = sentinel as any;
    const bindSpy = jest
      .spyOn(sentinelAny, 'bindAddressUpstream')
      .mockResolvedValue(undefined);

    sentinelAny.routeManager._downstream_addresses_routes.set(
      'svc@/child',
      undefined
    );

    await sentinelAny.propagateAddressBindingsUpstream();

    expect(bindSpy).not.toHaveBeenCalled();
    bindSpy.mockRestore();
  });

  it('continues propagation when individual upstream binding fails', async () => {
    const sentinel = createSentinel({ hasParent: true });
    const sentinelAny = sentinel as any;
    const bindSpy = jest
      .spyOn(sentinelAny, 'bindAddressUpstream')
      .mockRejectedValue(new Error('upstream-failure'));

    sentinelAny.routeManager._downstream_addresses_routes.set('svc@/child', {
      segment: 'child',
    });

    await expect(
      sentinelAny.propagateAddressBindingsUpstream()
    ).resolves.toBeUndefined();

    expect(bindSpy).toHaveBeenCalledTimes(1);
    bindSpy.mockRestore();
  });

  it('does not attempt to bind addresses upstream when parent is absent', async () => {
    const sentinel = createSentinel({ hasParent: false });
    const sentinelAny = sentinel as any;
    const forwardSpy = jest.spyOn(sentinel, 'forwardUpstream');
    const idSpy = jest.spyOn(core, 'generateId');

    await sentinelAny.bindAddressUpstream(new FameAddress('svc@/child'), {
      segment: 'child',
    } as AddressRouteInfo);

    expect(forwardSpy).not.toHaveBeenCalled();
    expect(idSpy).not.toHaveBeenCalled();
    forwardSpy.mockRestore();
    idSpy.mockRestore();
  });

  it('times out when bind acknowledgement never arrives', async () => {
    jest.useFakeTimers();
    const sentinel = createSentinel({
      hasParent: true,
      bindingAckTimeoutMs: 10,
    });
    const sentinelAny = sentinel as any;
    const idSpy = jest
      .spyOn(core, 'generateId')
      .mockReturnValueOnce('corr-timeout');
    const delaySpy = jest
      .spyOn(taskUtils, 'delay')
      .mockResolvedValue(undefined);
    const forwardSpy = jest
      .spyOn(sentinel, 'forwardUpstream')
      .mockResolvedValue(undefined);

    try {
      const bindPromise = sentinelAny.bindAddressUpstream(
        new FameAddress('svc@/child'),
        {
          segment: 'child',
        } as AddressRouteInfo
      );
      const caughtPromise = bindPromise.catch((error: unknown) => error);

      await jest.advanceTimersByTimeAsync(10);

      const error = await caughtPromise;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        'Timeout waiting for bind ack for svc@/child'
      );

      expect(forwardSpy).toHaveBeenCalledTimes(1);
      expect(sentinelAny.pendingBinds.has('corr-timeout')).toBe(false);
    } finally {
      idSpy.mockRestore();
      delaySpy.mockRestore();
      forwardSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  it('skips forwarding to a route when dispatch vetoes forwarding', async () => {
    const sentinel = createSentinel();
    const sentinelAny = sentinel as any;
    const connector = createMockConnector();
    await sentinelAny.routeManager.registerDownstreamRoute('child', connector);

    const dispatchMock = jest
      .spyOn(sentinelAny, 'dispatchEnvelopeEvent')
      .mockImplementation(async (...args: unknown[]) => {
        const [eventName] = args as [string, ...unknown[]];
        if (eventName === 'onForwardToRoute') {
          return null;
        }
        return args[3] ?? null;
      });

    await sentinel.forwardToRoute('child', createEnvelope(sentinel, 'Data'));

    expect(connector.send).not.toHaveBeenCalled();
    dispatchMock.mockRestore();
  });

  it('returns child segment when downstream route exists', async () => {
    const sentinel = createSentinel();
    const sentinelAny = sentinel as any;
    sentinelAny.routeManager._downstream_addresses_routes.set('svc@/child', {
      segment: 'child-seg',
    });

    const segment = sentinel.childFor(new FameAddress('svc@/child'));

    expect(segment).toBe('child-seg');
  });

  it('returns null for unknown child address', () => {
    const sentinel = createSentinel();

    expect(sentinel.childFor(new FameAddress('svc@/missing'))).toBeNull();
  });

  it('binds addresses upstream and clears pending entries when acked', async () => {
    const sentinel = createSentinel({ hasParent: true });
    const sentinelAny = sentinel as any;

    const forwardSpy = jest
      .spyOn(sentinel, 'forwardUpstream')
      .mockImplementation(async (env) => {
        setImmediate(() => {
          void sentinelAny.resolvePendingBind(env, true);
        });
      });

    const delaySpy = jest
      .spyOn(taskUtils, 'delay')
      .mockImplementation(() => new Promise(() => undefined));
    const idSpy = jest
      .spyOn(core, 'generateId')
      .mockReturnValueOnce('corr-bind');
    const traceSpy = jest
      .spyOn(envelopeContext, 'currentTraceId')
      .mockReturnValueOnce('trace-test');

    const info: AddressRouteInfo = {
      segment: 'child',
      physicalPath: '/child',
      encryptionKeyId: 'enc-key',
    } as AddressRouteInfo;

    await sentinelAny.bindAddressUpstream(new FameAddress('svc@/child'), info);

    expect(forwardSpy).toHaveBeenCalledTimes(1);
    const [forwardedEnvelope, forwardedContext] = forwardSpy.mock.calls[0];
    const frame = forwardedEnvelope.frame as any;

    expect(forwardedEnvelope.corrId).toBe('corr-bind');
    expect(forwardedEnvelope.traceId).toBe('trace-test');
    expect(frame?.type).toBe('AddressBind');
    expect(frame?.physicalPath).toBe('/child');
    expect(frame?.encryptionKeyId).toBe('enc-key');
    expect(forwardedContext).toEqual(
      expect.objectContaining({ originType: DeliveryOriginType.LOCAL })
    );
    expect(sentinelAny.pendingBinds.has('corr-bind')).toBe(false);

    forwardSpy.mockRestore();
    delaySpy.mockRestore();
    idSpy.mockRestore();
    traceSpy.mockRestore();
  });

  it('throws when bind acknowledgements reject upstream', async () => {
    const sentinel = createSentinel({ hasParent: true });
    const sentinelAny = sentinel as any;

    const idSpy = jest
      .spyOn(core, 'generateId')
      .mockReturnValueOnce('corr-fail-bind');
    const forwardSpy = jest
      .spyOn(sentinel, 'forwardUpstream')
      .mockImplementation(async (env) => {
        setImmediate(() => {
          void sentinelAny.resolvePendingBind(env, false, 'denied');
        });
      });

    const delaySpy = jest
      .spyOn(taskUtils, 'delay')
      .mockImplementation(() => new Promise(() => undefined));

    await expect(
      sentinelAny.bindAddressUpstream(new FameAddress('svc@/child'), {
        segment: 'child',
      } as AddressRouteInfo)
    ).rejects.toThrow('denied');

    expect(sentinelAny.pendingBinds.has('corr-fail-bind')).toBe(false);

    forwardSpy.mockRestore();
    delaySpy.mockRestore();
    idSpy.mockRestore();
  });

  describe('aserve', () => {
    function createFabricStub(): { enter: jest.Mock; exit: jest.Mock } & Record<
      string,
      unknown
    > {
      const stub: Record<string, unknown> = {};
      stub.enter = jest.fn().mockResolvedValue(stub as unknown as FameFabric);
      stub.exit = jest.fn().mockResolvedValue(undefined);
      return stub as { enter: jest.Mock; exit: jest.Mock } & Record<
        string,
        unknown
      >;
    }

    it('configures logging and resolves on abort signal', async () => {
      const fabric = createFabricStub();
      const controller = new AbortController();

      fabric.enter.mockImplementation(async () => {
        setImmediate(() => controller.abort());
        return fabric as unknown as FameFabric;
      });

      const basicConfigSpy = jest
        .spyOn(logging, 'basicConfig')
        .mockImplementation(() => undefined);

      await Sentinel.aserve({
        fabric: fabric as unknown as FameFabric,
        signal: controller.signal,
        signals: [],
      });

      expect(basicConfigSpy).toHaveBeenCalledWith({
        level: logging.LogLevel.INFO,
      });
      expect(fabric.enter).toHaveBeenCalledTimes(1);
      expect(fabric.exit).toHaveBeenCalledTimes(1);
    });

    it('accepts string log level values', async () => {
      const fabric = createFabricStub();
      const controller = new AbortController();

      fabric.enter.mockImplementation(async () => {
        setImmediate(() => controller.abort());
        return fabric as unknown as FameFabric;
      });

      const basicConfigSpy = jest
        .spyOn(logging, 'basicConfig')
        .mockImplementation(() => undefined);

      await Sentinel.aserve({
        fabric: fabric as unknown as FameFabric,
        signal: controller.signal,
        signals: [],
        logLevel: 'debug',
      });

      expect(basicConfigSpy).toHaveBeenCalledWith({
        level: logging.LogLevel.DEBUG,
      });
      expect(fabric.enter).toHaveBeenCalledTimes(1);
      expect(fabric.exit).toHaveBeenCalledTimes(1);
    });

    it('waits for configured process signals and cleans up listeners', async () => {
      const fabric = createFabricStub();
      const handlers = new Map<string, (...args: unknown[]) => void>();

      jest.spyOn(logging, 'basicConfig').mockImplementation(() => undefined);

      const onceSpy = jest
        .spyOn(process, 'once')
        .mockImplementation((event: any, handler: any) => {
          handlers.set(event, handler);
          return process;
        });
      const removeSpy = jest
        .spyOn(process, 'removeListener')
        .mockImplementation((event: any, handler: any) => {
          if (handlers.get(event) === handler) {
            handlers.delete(event);
          }
          return process;
        });

      const servePromise = Sentinel.aserve({
        fabric: fabric as unknown as FameFabric,
        signals: ['SIGUSR2'],
      });

      await new Promise<void>((resolve) => process.nextTick(resolve));

      const registered = handlers.get('SIGUSR2');
      expect(registered).toBeDefined();
      registered?.();

      await servePromise;

      expect(fabric.enter).toHaveBeenCalledTimes(1);
      expect(fabric.exit).toHaveBeenCalledTimes(1);
      expect(removeSpy).toHaveBeenCalledWith('SIGUSR2', expect.any(Function));
      expect(handlers.size).toBe(0);

      onceSpy.mockRestore();
      removeSpy.mockRestore();
    });

    it('returns early when abort signal is already triggered', async () => {
      const fabric = createFabricStub();
      const controller = new AbortController();
      controller.abort();

      jest.spyOn(logging, 'basicConfig').mockImplementation(() => undefined);

      await Sentinel.aserve({
        fabric: fabric as unknown as FameFabric,
        signal: controller.signal,
        signals: [],
      });

      expect(fabric.enter).not.toHaveBeenCalled();
      expect(fabric.exit).not.toHaveBeenCalled();
    });
  });
});
