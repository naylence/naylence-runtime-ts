import {
  createFameEnvelope,
  DeliveryOriginType,
  DEFAULT_INVOKE_TIMEOUT_MILLIS,
  DEFAULT_POLLING_TIMEOUT_MS,
  FameDeliveryContext,
  FameEnvelope,
  FameResponseType,
} from 'naylence-core';
import { EnvelopeListenerManager } from '../envelope-listener-manager.js';
import type { Binding } from 'naylence-core';
import type { BindingManager } from '../binding-manager.js';
import type { NodeLike } from '../node-like.js';
import {
  TrackedEnvelope,
  EnvelopeStatus,
  MailboxType,
} from '../../delivery/tracked-envelope.js';
import { RetryPolicy } from '../../delivery/retry-policy.js';

type MockDeliveryTracker = {
  listInbound: jest.Mock<Promise<TrackedEnvelope[]>, any>;
  onEnvelopeDelivered: jest.Mock<
    Promise<TrackedEnvelope | null>,
    [string, FameEnvelope, FameDeliveryContext | undefined]
  >;
  onEnvelopeHandled: jest.Mock<Promise<void>, [TrackedEnvelope]>;
  onEnvelopeHandleFailed: jest.Mock<
    Promise<void>,
    [string, TrackedEnvelope, FameDeliveryContext | undefined, Error, boolean]
  >;
  cleanup: jest.Mock<Promise<void>, []>;
};

type ManagerSetup = {
  manager: EnvelopeListenerManager;
  bindingManager: jest.Mocked<BindingManager>;
  deliveryTracker: MockDeliveryTracker;
  channelPollingMock: jest.Mock;
  rpcServerHandlerSpy: jest.SpyInstance;
  rpcClientManagerSpies: {
    invoke: jest.SpyInstance;
    invokeStream: jest.SpyInstance;
    cleanup: jest.SpyInstance;
  };
};

function createAddress(serviceName: string): Binding['address'] {
  return {
    toString: () => `${serviceName}@node`,
  } as unknown as Binding['address'];
}

function createTrackedEnvelope(
  serviceName: string,
  status: EnvelopeStatus,
  attempt = 0
): TrackedEnvelope {
  const envelope = createFameEnvelope({
    id: `env-${serviceName}-${attempt}`,
    frame: {
      type: 'Data',
      payload: { serviceName },
    },
  });

  return new TrackedEnvelope({
    timeoutAtMs: 0,
    overallTimeoutAtMs: 0,
    expectedResponseType: FameResponseType.NONE,
    createdAtMs: Date.now(),
    attempt,
    status,
    originalEnvelope: envelope,
    serviceName,
  });
}

function setupManager(
  options: { useRealChannelPolling?: boolean } = {}
): ManagerSetup {
  const bindingManager = {
    bind: jest.fn(async (serviceName: string) => ({
      address: createAddress(serviceName),
      channel: {},
    })),
    clear: jest.fn(async () => {}),
  } as unknown as jest.Mocked<BindingManager>;

  const deliveryTracker: MockDeliveryTracker = {
    listInbound: jest
      .fn<Promise<TrackedEnvelope[]>, []>()
      .mockResolvedValue([]),
    onEnvelopeDelivered: jest
      .fn<
        Promise<TrackedEnvelope | null>,
        [string, FameEnvelope, FameDeliveryContext | undefined]
      >()
      .mockResolvedValue(null),
    onEnvelopeHandled: jest
      .fn<Promise<void>, [TrackedEnvelope]>()
      .mockResolvedValue(),
    onEnvelopeHandleFailed: jest
      .fn<
        Promise<void>,
        [
          string,
          TrackedEnvelope,
          FameDeliveryContext | undefined,
          Error,
          boolean,
        ]
      >()
      .mockResolvedValue(),
    cleanup: jest.fn<Promise<void>, []>().mockResolvedValue(),
  };

  const nodeLike = {
    id: 'node-1',
    sid: 'sid-1',
    physicalPath: '/node-1',
    acceptedLogicals: new Set<string>(),
    envelopeFactory: { createEnvelope: createFameEnvelope },
    deliveryPolicy: null,
    defaultBindingPath: '/node-1',
    hasParent: false,
    securityManager: null,
    admissionClient: null,
    publicUrl: null,
    storageProvider: { getKeyValueStore: jest.fn(), close: jest.fn() },
    eventListeners: [],
    upstreamConnector: null,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
    bind: jest.fn(),
    unbind: jest.fn(),
    send: jest.fn(async () => null),
    listen: jest.fn(),
    listenRpc: jest.fn(),
    invoke: jest.fn(),
    invokeByCapability: jest.fn(),
    invokeStream: jest.fn(),
    invokeByCapabilityStream: jest.fn(),
    deliver: jest.fn(),
    deliverLocal: jest.fn(),
    forwardUpstream: jest.fn(),
    hasLocal: jest.fn(),
    gatherSupportedCallbackGrants: jest.fn(() => []),
    dispatchEvent: jest.fn(),
    dispatchEnvelopeEvent: jest.fn(),
  } as unknown as NodeLike;

  const manager = new EnvelopeListenerManager({
    bindingManager,
    nodeLike,
    envelopeFactory: { createEnvelope: createFameEnvelope },
    deliveryTracker: deliveryTracker as unknown as any,
  });

  const channelPollingMock = jest.fn(async () => {});
  if (!options.useRealChannelPolling) {
    (manager as any).channelPollingManager = {
      startPollingLoop: channelPollingMock,
    };
  }

  const rpcServerHandlerInstance = (manager as any).rpcServerHandler;
  const rpcServerHandlerSpy = jest
    .spyOn(rpcServerHandlerInstance, 'handleRpcRequest')
    .mockResolvedValue(null);

  const rpcClientManagerInstance = (manager as any).rpcClientManager;
  const rpcClientManagerSpies = {
    invoke: jest
      .spyOn(rpcClientManagerInstance, 'invoke')
      .mockResolvedValue('rpc-result'),
    invokeStream: jest
      .spyOn(rpcClientManagerInstance, 'invokeStream')
      .mockResolvedValue((async function* () {})()),
    cleanup: jest
      .spyOn(rpcClientManagerInstance, 'cleanup')
      .mockResolvedValue(undefined),
  };

  return {
    manager,
    bindingManager,
    deliveryTracker,
    channelPollingMock,
    rpcServerHandlerSpy,
    rpcClientManagerSpies,
  };
}

describe('EnvelopeListenerManager', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('processes cached envelopes during recovery', async () => {
    const { manager, deliveryTracker } = setupManager();

    const tracked = createTrackedEnvelope(
      'svc',
      EnvelopeStatus.FAILED_TO_HANDLE,
      1
    );
    deliveryTracker.listInbound.mockImplementationOnce(async (predicate) => {
      expect(predicate(tracked)).toBe(true);
      return [tracked];
    });

    await manager.start();

    const handler = jest.fn().mockResolvedValue(null);
    await manager.listen('svc', handler);

    await (manager as any).recoverServiceIfNeeded('svc');

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(tracked.originalEnvelope, undefined);
    expect(deliveryTracker.onEnvelopeHandled).toHaveBeenCalledWith(tracked);
  });

  it('skips recovery when no cached envelopes are present', async () => {
    const { manager, deliveryTracker } = setupManager();

    const handler = jest.fn().mockResolvedValue(null);
    await manager.listen('svc', handler);

    const pendingEnvelopes: Map<string, TrackedEnvelope[]> = (manager as any)
      .pendingRecoveryEnvelopes;
    const pendingServices: Set<string> = (manager as any)
      .pendingRecoveryServices;
    pendingEnvelopes.set('svc', []);
    pendingServices.add('svc');

    await (manager as any).recoverServiceIfNeeded('svc');

    expect(handler).not.toHaveBeenCalled();
    expect(deliveryTracker.onEnvelopeHandled).not.toHaveBeenCalled();
  });

  it('retries handler according to retry policy and succeeds after retry', async () => {
    const { manager, deliveryTracker } = setupManager();

    const envelope = createTrackedEnvelope(
      'svc',
      EnvelopeStatus.RECEIVED
    ).originalEnvelope;
    const tracked = createTrackedEnvelope('svc', EnvelopeStatus.RECEIVED);
    const retryPolicy = new RetryPolicy({
      maxRetries: 2,
      baseDelayMs: 0,
      jitterMs: 0,
    });
    const handler = jest
      .fn()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockResolvedValueOnce('ok');

    const result = await (manager as any).executeHandlerWithRetries(
      handler,
      envelope,
      undefined,
      retryPolicy,
      tracked,
      'svc'
    );

    expect(result).toBe('ok');
    expect(handler).toHaveBeenCalledTimes(2);
    expect(deliveryTracker.onEnvelopeHandleFailed).toHaveBeenCalledWith(
      'svc',
      tracked,
      undefined,
      expect.any(Error),
      false
    );
    expect(deliveryTracker.onEnvelopeHandled).toHaveBeenCalledWith(tracked);
  });

  it('marks envelope as failed when retries exhausted', async () => {
    const { manager, deliveryTracker } = setupManager();

    const envelope = createTrackedEnvelope(
      'svc',
      EnvelopeStatus.RECEIVED
    ).originalEnvelope;
    const tracked = createTrackedEnvelope('svc', EnvelopeStatus.RECEIVED);
    const retryPolicy = new RetryPolicy({
      maxRetries: 1,
      baseDelayMs: 0,
      jitterMs: 0,
    });
    const handler = jest.fn().mockRejectedValue(new Error('boom'));

    await expect(
      (manager as any).executeHandlerWithRetries(
        handler,
        envelope,
        undefined,
        retryPolicy,
        tracked,
        'svc'
      )
    ).rejects.toThrow('boom');

    expect(handler).toHaveBeenCalledTimes(2);
    const failureCalls = deliveryTracker.onEnvelopeHandleFailed.mock.calls;
    expect(failureCalls[failureCalls.length - 1][4]).toBe(true);
  });

  it('throws immediately when attempts already exceed max retries', async () => {
    const { manager, deliveryTracker } = setupManager();
    const envelope = createTrackedEnvelope(
      'svc',
      EnvelopeStatus.RECEIVED
    ).originalEnvelope;
    const tracked = createTrackedEnvelope('svc', EnvelopeStatus.RECEIVED, 2);
    tracked.attempt = 2;
    const retryPolicy = new RetryPolicy({
      maxRetries: 1,
      baseDelayMs: 0,
      jitterMs: 0,
    });
    const handler = jest.fn();

    await expect(
      (manager as any).executeHandlerWithRetries(
        handler,
        envelope,
        undefined,
        retryPolicy,
        tracked,
        'svc'
      )
    ).rejects.toThrow('Handler retries exhausted: 2/2');

    expect(handler).not.toHaveBeenCalled();
    expect(deliveryTracker.onEnvelopeHandleFailed).toHaveBeenCalledWith(
      'svc',
      tracked,
      undefined,
      expect.any(Error),
      true
    );
  });

  it('does not accumulate retries for outbound stream replies', async () => {
    const { manager, deliveryTracker, channelPollingMock } = setupManager();

    (manager as any).nodeLike.deliveryPolicy = {
      receiverRetryPolicy: new RetryPolicy({
        maxRetries: 6,
        baseDelayMs: 0,
        jitterMs: 0,
      }),
    };

    const outboundTracked = createTrackedEnvelope(
      'svc',
      EnvelopeStatus.PENDING,
      6
    );
    outboundTracked.mailboxType = MailboxType.OUTBOX;
    outboundTracked.expectedResponseType = FameResponseType.STREAM;
    outboundTracked.originalEnvelope.corrId = 'corr-outbound';

    deliveryTracker.onEnvelopeDelivered.mockResolvedValue(outboundTracked);

    const handler = jest.fn().mockResolvedValue(null);

    await manager.listen('svc', handler);

    const trackingHandler = channelPollingMock.mock.calls[0][2];

    const firstReply = createFameEnvelope({
      id: 'reply-1',
      corrId: 'corr-outbound',
      frame: {
        type: 'Data',
        payload: { value: 1 },
      },
    });

    await expect(trackingHandler(firstReply, undefined)).resolves.toBeNull();

    const secondReply = createFameEnvelope({
      id: 'reply-2',
      corrId: 'corr-outbound',
      frame: {
        type: 'Data',
        payload: { value: 2 },
      },
    });

    await expect(trackingHandler(secondReply, undefined)).resolves.toBeNull();

    expect(handler).toHaveBeenCalledTimes(2);
    expect(deliveryTracker.onEnvelopeHandled).not.toHaveBeenCalled();
    expect(deliveryTracker.onEnvelopeHandleFailed).not.toHaveBeenCalled();
    expect(outboundTracked.attempt).toBe(6);
  });

  it('runs handler only for envelopes that need processing', async () => {
    const { manager, deliveryTracker, channelPollingMock } = setupManager();

    const envelope = createTrackedEnvelope(
      'svc',
      EnvelopeStatus.RECEIVED
    ).originalEnvelope;
    const context: FameDeliveryContext = {
      expectedResponseType: FameResponseType.NONE,
      originType: DeliveryOriginType.LOCAL,
    };

    deliveryTracker.onEnvelopeDelivered
      .mockResolvedValueOnce(
        createTrackedEnvelope('svc', EnvelopeStatus.HANDLED)
      )
      .mockResolvedValueOnce(
        createTrackedEnvelope('svc', EnvelopeStatus.FAILED_TO_HANDLE)
      );

    channelPollingMock.mockImplementation(async (_svc, _channel, handler) => {
      await handler(envelope, context);
      await handler(envelope, context);
    });

    const handler = jest.fn().mockResolvedValue(null);

    await manager.listen('svc', handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(deliveryTracker.onEnvelopeHandled).toHaveBeenCalledTimes(1);
  });

  it('continues recovery when handler keeps failing', async () => {
    const { manager, deliveryTracker } = setupManager();
    const tracked = createTrackedEnvelope('svc', EnvelopeStatus.RECEIVED);
    const failingHandler = jest
      .fn()
      .mockRejectedValue(new Error('recover fail'));

    await (manager as any).recoverServiceEnvelopes(
      'svc',
      [tracked],
      failingHandler
    );

    expect(failingHandler).toHaveBeenCalled();
    expect(deliveryTracker.onEnvelopeHandleFailed).toHaveBeenCalled();
  });

  it('returns early from recovery when no handler is registered', async () => {
    const { manager, deliveryTracker } = setupManager();
    const pendingEnvelopes: Map<string, TrackedEnvelope[]> = (manager as any)
      .pendingRecoveryEnvelopes;
    pendingEnvelopes.set('svc', [
      createTrackedEnvelope('svc', EnvelopeStatus.RECEIVED),
    ]);

    await (manager as any).recoverServiceIfNeeded('svc');

    expect(deliveryTracker.onEnvelopeHandled).not.toHaveBeenCalled();
  });

  it('executes handler without retry policy once', async () => {
    const { manager, deliveryTracker } = setupManager();
    const envelope = createTrackedEnvelope(
      'svc',
      EnvelopeStatus.RECEIVED
    ).originalEnvelope;
    const handler = jest.fn().mockResolvedValue('ok');

    const result = await (manager as any).executeHandlerWithRetries(
      handler,
      envelope,
      undefined,
      undefined,
      undefined,
      'svc'
    );

    expect(result).toBe('ok');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(deliveryTracker.onEnvelopeHandled).not.toHaveBeenCalled();
  });

  it('listens without handler and does not register service handler', async () => {
    const { manager, bindingManager, channelPollingMock } = setupManager();

    const address = await manager.listen('svc');

    expect(address.toString()).toContain('svc');
    expect(bindingManager.bind).toHaveBeenCalledWith('svc', undefined);
    expect(channelPollingMock).toHaveBeenCalledTimes(1);
    const handlers: Map<string, any> = (manager as any).serviceHandlers;
    expect(handlers.has('svc')).toBe(false);
  });

  it('falls back to default polling timeout when null provided', async () => {
    const { manager, channelPollingMock } = setupManager();

    await manager.listen('svc', jest.fn().mockResolvedValue(null), {
      pollTimeoutMs: null,
    });

    expect(channelPollingMock).toHaveBeenCalledWith(
      'svc',
      expect.any(Object),
      expect.any(Function),
      expect.objectContaining({ stopped: false }),
      DEFAULT_POLLING_TIMEOUT_MS
    );
  });

  it('skips inbound recovery when delivery tracker lacks listInbound method', async () => {
    const { manager } = setupManager();
    (manager as any).deliveryTracker.listInbound = undefined;

    await manager.recoverUnhandledInboundEnvelopes();

    const pendingServices: Set<string> = (manager as any)
      .pendingRecoveryServices;
    expect(pendingServices.size).toBe(0);
  });

  it('does not enqueue recovery when no failed inbound envelopes are found', async () => {
    const { manager, deliveryTracker } = setupManager();
    deliveryTracker.listInbound.mockResolvedValueOnce([]);

    await manager.recoverUnhandledInboundEnvelopes();

    const pendingServices: Set<string> = (manager as any)
      .pendingRecoveryServices;
    expect(pendingServices.size).toBe(0);
  });

  it('stores unknown service recovery envelopes under unknown key', async () => {
    const { manager, deliveryTracker } = setupManager();
    const tracked = createTrackedEnvelope('svc', EnvelopeStatus.RECEIVED);
    (tracked as any).serviceName = undefined;
    deliveryTracker.listInbound.mockImplementationOnce(async (predicate) => {
      expect(predicate(tracked)).toBe(true);
      return [tracked];
    });

    await manager.recoverUnhandledInboundEnvelopes();

    const pendingEnvelopes: Map<string, TrackedEnvelope[]> = (manager as any)
      .pendingRecoveryEnvelopes;
    expect(pendingEnvelopes.get('unknown')).toEqual([tracked]);
  });

  it('replaces existing listener when listen is called twice', async () => {
    const { manager, channelPollingMock } = setupManager();
    const firstHandler = jest.fn().mockResolvedValue(null);
    const secondHandler = jest.fn().mockResolvedValue(null);

    await manager.listen('svc', firstHandler);
    const listenersMap: Map<string, any> = (manager as any).listeners;
    const existing = listenersMap.get('svc');
    existing.listener.stop = jest.fn(
      existing.listener.stop.bind(existing.listener)
    );
    existing.listener.task.promise = Promise.resolve();

    await manager.listen('svc', secondHandler);

    expect(existing.listener.stop).toHaveBeenCalled();
    expect(channelPollingMock).toHaveBeenCalledTimes(2);
    expect(listenersMap.get('svc').handler).toBe(secondHandler);
  });

  it('logs resume information when retrying a previously attempted envelope', async () => {
    const { manager, deliveryTracker, channelPollingMock } = setupManager();
    const envelope = createTrackedEnvelope(
      'svc',
      EnvelopeStatus.RECEIVED
    ).originalEnvelope;

    deliveryTracker.onEnvelopeDelivered.mockResolvedValue(
      createTrackedEnvelope('svc', EnvelopeStatus.FAILED_TO_HANDLE, 2)
    );

    channelPollingMock.mockImplementation(async (_svc, _channel, handler) => {
      await handler(envelope, undefined);
    });

    const handler = jest.fn().mockResolvedValue(null);
    await manager.listen('svc', handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(deliveryTracker.onEnvelopeHandled).toHaveBeenCalled();
  });

  it('returns registered handler via getHandler', async () => {
    const { manager } = setupManager();
    const handler = jest.fn().mockResolvedValue(null);

    await manager.listen('svc', handler);

    const stored = manager.getHandler('svc');
    expect(stored).toBe(handler);
  });

  it('initializes RPC client manager helpers', async () => {
    const { manager } = setupManager();
    const rpcClientInternal: any = (manager as any).rpcClientManager;

    expect(rpcClientInternal.getPhysicalPath()).toBe('/node-1');
    expect(rpcClientInternal.getId()).toBe('node-1');

    const deliverFn = rpcClientInternal.deliverWrapper();
    expect(typeof deliverFn).toBe('function');

    const address = await rpcClientInternal.listenCallback('svc-helper', null);
    expect(address.toString()).toContain('svc-helper');

    await manager.stop();
  });

  it('wires deliver helpers for internal components', async () => {
    const { manager } = setupManager({ useRealChannelPolling: true });
    const envelope = createFameEnvelope({
      id: 'deliver-1',
      frame: { type: 'Data', payload: { ok: true } },
    });

    const deliverFn = (manager as any).deliver as (
      env: FameEnvelope,
      ctx?: FameDeliveryContext
    ) => Promise<void>;
    await deliverFn(envelope, undefined);
    const nodeLikeInternal: any = (manager as any).nodeLike;
    expect(nodeLikeInternal.send).toHaveBeenCalledWith(envelope, undefined);

    const streamingDeliver = (
      manager as any
    ).streamingResponseHandler.deliverWrapper();
    expect(typeof streamingDeliver).toBe('function');
    await streamingDeliver(envelope, undefined);
    expect(nodeLikeInternal.send).toHaveBeenCalledTimes(2);

    const channelDeliver = (
      manager as any
    ).channelPollingManager.deliverWrapper();
    expect(typeof channelDeliver).toBe('function');
    await channelDeliver(envelope, undefined);
    expect(nodeLikeInternal.send).toHaveBeenCalledTimes(3);
  });

  it('delivers to registered address and rejects unknown addresses', async () => {
    const { manager } = setupManager();
    const handler = jest.fn().mockResolvedValue(null);
    const address = await manager.listen('svc', handler);

    const responseEnvelope = createFameEnvelope({
      id: 'response-1',
      frame: {
        type: 'Data',
        payload: { ok: true },
      },
    });

    await manager.deliverToAddress(address, responseEnvelope);
    expect(handler).toHaveBeenCalledWith(responseEnvelope, undefined);

    await expect(
      manager.deliverToAddress(
        { toString: () => 'other@node' } as any,
        responseEnvelope
      )
    ).rejects.toThrow('No listener registered for address: other@node');
  });

  it('rejects delivery when listener has no handler', async () => {
    const { manager } = setupManager();
    const address = await manager.listen('svc');
    const envelope = createFameEnvelope({
      id: 'missing-handler',
      frame: { type: 'Data', payload: {} },
    });

    await expect(manager.deliverToAddress(address, envelope)).rejects.toThrow(
      `No listener registered for address: ${address.toString()}`
    );
  });

  it('delegates RPC listening and invocation helpers', async () => {
    const {
      manager,
      rpcServerHandlerSpy,
      rpcClientManagerSpies,
      channelPollingMock,
    } = setupManager();

    channelPollingMock.mockImplementation(async (_svc, _channel, handler) => {
      await handler(
        createFameEnvelope({ id: 'rpc', frame: { type: 'Data', payload: {} } }),
        undefined
      );
    });

    rpcServerHandlerSpy.mockResolvedValue({
      envelope: createFameEnvelope({
        id: 'resp',
        frame: { type: 'Data', payload: {} },
      }),
      context: undefined,
    });

    const rpcHandler = jest.fn().mockResolvedValue('rpc-ok');
    const address = await manager.listenRpc('svc-rpc', rpcHandler, {
      pollTimeoutMs: 1000,
    });

    expect(address.toString()).toContain('svc-rpc');
    expect(rpcServerHandlerSpy).toHaveBeenCalled();

    await manager.invoke({
      targetAddr: address,
      method: 'do',
      params: {},
      timeoutMs: 2000,
    });
    expect(rpcClientManagerSpies.invoke).toHaveBeenCalledWith({
      targetAddr: address,
      method: 'do',
      params: {},
      timeoutMs: 2000,
    });

    await manager.invoke({
      capabilities: ['cap'],
      method: 'cap',
      params: {},
      timeoutMs: 1500,
    });
    expect(rpcClientManagerSpies.invoke).toHaveBeenCalledWith({
      capabilities: ['cap'],
      method: 'cap',
      params: {},
      timeoutMs: 1500,
    });

    await manager.invokeStream({
      targetAddr: address,
      method: 'stream',
      params: {},
      timeoutMs: 500,
    });
    expect(rpcClientManagerSpies.invokeStream).toHaveBeenCalledWith({
      targetAddr: address,
      method: 'stream',
      params: {},
      timeoutMs: 500,
    });

    await manager.invokeStream({
      capabilities: ['cap'],
      method: 'stream',
      params: {},
      timeoutMs: 400,
    });
    expect(rpcClientManagerSpies.invokeStream).toHaveBeenCalledWith({
      capabilities: ['cap'],
      method: 'stream',
      params: {},
      timeoutMs: 400,
    });
  });

  it('returns null RPC handler response when server returns null', async () => {
    const { manager, rpcServerHandlerSpy, channelPollingMock } = setupManager();
    rpcServerHandlerSpy.mockResolvedValueOnce(null);
    channelPollingMock.mockImplementation(async (_svc, _channel, handler) => {
      await handler(
        createFameEnvelope({
          id: 'rpc-null',
          frame: { type: 'Data', payload: {} },
        }),
        undefined
      );
    });

    const rpcHandler = jest.fn().mockResolvedValue('ok');
    await manager.listenRpc('svc-rpc-null', rpcHandler);

    expect(rpcServerHandlerSpy).toHaveBeenCalled();
  });

  it('invokes RPC client with default timeout when none provided', async () => {
    const { manager, rpcClientManagerSpies } = setupManager();
    const handler = jest.fn().mockResolvedValue(null);
    const address = await manager.listen('svc-default', handler);

    await manager.invoke({ targetAddr: address, method: 'do', params: {} });

    expect(rpcClientManagerSpies.invoke).toHaveBeenLastCalledWith({
      targetAddr: address,
      method: 'do',
      params: {},
      timeoutMs: DEFAULT_INVOKE_TIMEOUT_MILLIS,
    });
  });

  it('invokes RPC stream client with default timeout when none provided', async () => {
    const { manager, rpcClientManagerSpies } = setupManager();
    const handler = jest.fn().mockResolvedValue(null);
    const address = await manager.listen('svc-stream', handler);

    await manager.invokeStream({
      targetAddr: address,
      method: 'stream',
      params: {},
    });

    expect(rpcClientManagerSpies.invokeStream).toHaveBeenLastCalledWith({
      targetAddr: address,
      method: 'stream',
      params: {},
      timeoutMs: DEFAULT_INVOKE_TIMEOUT_MILLIS,
    });
  });

  it('cleans up listeners and RPC client on stop', async () => {
    const { manager, rpcClientManagerSpies } = setupManager();
    const handler = jest.fn().mockResolvedValue(null);

    await manager.listen('svc', handler);
    await manager.stop();

    expect(rpcClientManagerSpies.cleanup).toHaveBeenCalled();
  });

  it('logs unexpected listener errors during stop', async () => {
    const { manager, channelPollingMock } = setupManager();
    channelPollingMock.mockImplementation(async () => {
      throw new Error('listener failure');
    });
    const handler = jest.fn().mockResolvedValue(null);

    await manager.listen('svc', handler);

    await expect(manager.stop()).resolves.toBeUndefined();
  });

  it('suppresses logging for task cancellation errors during stop', async () => {
    const { manager } = setupManager();
    const cancellationError = new Error('cancelled');
    cancellationError.name = 'TaskCancelledError';
    const handler = jest.fn().mockResolvedValue(null);

    await manager.listen('svc', handler);

    const listeners: Map<string, any> = (manager as any).listeners;
    const entry = listeners.get('svc');
    const rejection = Promise.reject(cancellationError);
    rejection.catch(() => {});
    entry.listener.task.promise = rejection;

    await expect(manager.stop()).resolves.toBeUndefined();
  });
});
