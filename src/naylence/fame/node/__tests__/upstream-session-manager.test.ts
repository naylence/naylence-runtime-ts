/**
 * Note: When running all tests together, Jest may report an open handle warning
 * due to fake timer accumulation across multiple test cases. Individual tests
 * and small subsets run cleanly. This is a known Jest limitation with extensive
 * fake timer usage and does not indicate actual resource leaks.
 */
import {
  createFameEnvelope,
  DeliveryAckFrame,
  DeliveryOriginType,
  FameEnvelope,
  FameFabric,
  FameResponseType,
  type FameDeliveryContext,
  type FameEnvelopeWith,
  type FameEnvelopeHandler,
  type NodeHeartbeatAckFrame,
  type NodeWelcomeFrame,
} from '@naylence/core';
import { UpstreamSessionManager } from '../upstream-session-manager.js';
import { ConnectorFactory } from '../../connector/connector-factory.js';
import {
  FameConnectError,
  FameMessageTooLarge,
  FameTransportClose,
} from '../../errors/errors.js';
import { NodeEnvelopeFactory } from '../node-envelope-factory.js';
import { AsyncEvent } from '../../util/async-event.js';
import { getLogger } from '../../util/logging.js';
import type { NodeLike } from '../node-like.js';
import type {
  NodeAttachClient,
  AttachInfo,
} from '../admission/node-attach-client.js';
import type { AdmissionClient } from '../admission/admission-client.js';
import type { FameConnector } from '@naylence/core';
import { TaskCancelledError, type SpawnedTask } from '../../util/task-types.js';
import type { CryptoProvider } from '../../security/crypto/providers/crypto-provider.js';

function createNodeStub(overrides: Partial<NodeLike> = {}): NodeLike {
  const dispatchEnvelopeEvent = jest
    .fn<
      Promise<FameEnvelope | null>,
      Parameters<NodeLike['dispatchEnvelopeEvent']>
    >()
    .mockResolvedValue(null);
  const dispatchEvent = jest
    .fn<Promise<void>, Parameters<NodeLike['dispatchEvent']>>()
    .mockResolvedValue();

  const node: Partial<NodeLike> = {
    id: 'node-1',
    provisionalId: 'node-1',
    sid: null,
    physicalPath: '/node-1',
    acceptedLogicals: new Set<string>(),
    envelopeFactory: new NodeEnvelopeFactory(() => 'sid-1'),
    deliveryPolicy: null,
    defaultBindingPath: '/node-1',
    hasParent: true,
    securityManager: null,
    admissionClient: null,
    eventListeners: [],
    upstreamConnector: null,
    publicUrl: null,
    storageProvider: {} as any,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
    bind: jest.fn(),
    unbind: jest.fn(),
    send: jest.fn(),
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
    gatherSupportedCallbackGrants: jest
      .fn()
      .mockReturnValue([{ type: 'callback' }]),
    dispatchEvent,
    dispatchEnvelopeEvent,
    cryptoProvider: null as unknown as CryptoProvider,
  };

  return Object.assign(node, overrides) as NodeLike;
}

function createWelcomeFrame(): FameEnvelopeWith<NodeWelcomeFrame> {
  return {
    id: 'welcome-1',
    frame: {
      type: 'NodeWelcome',
      systemId: 'system-1',
      instanceId: 'instance-1',
      assignedPath: '/assigned',
      acceptedLogicals: ['logic-1'],
      connectionGrants: [
        {
          type: 'ws',
          purpose: 'node.attach',
          url: 'wss://example.test',
        },
      ],
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    },
  } as FameEnvelopeWith<NodeWelcomeFrame>;
}

function createAttachInfo(): AttachInfo {
  return {
    systemId: 'system-1',
    targetSystemId: 'target-1',
    targetPhysicalPath: '/target',
    assignedPath: '/assigned',
    acceptedLogicals: ['logic-1'],
    attachExpiresAt: new Date(Date.now() + 60_000),
    routingEpoch: 'epoch-1',
  } satisfies AttachInfo;
}

describe('UpstreamSessionManager', () => {
  let node: NodeLike;
  let admissionClient: jest.Mocked<AdmissionClient>;
  let attachClient: jest.Mocked<NodeAttachClient>;
  let inboundHandler: FameEnvelopeHandler;
  let onWelcome: jest.MockedFunction<
    (frame: NodeWelcomeFrame) => Promise<void>
  >;
  let onAttach: jest.MockedFunction<
    (info: AttachInfo, connector: FameConnector) => Promise<void>
  >;
  let onEpochChange: jest.MockedFunction<(epoch: string) => Promise<void>>;
  let connector: jest.Mocked<FameConnector>;
  // let connectorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useRealTimers();

    admissionClient = {
      hello: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AdmissionClient>;

    attachClient = {
      attach: jest.fn(),
    } as unknown as jest.Mocked<NodeAttachClient>;

    inboundHandler = jest
      .fn()
      .mockResolvedValue(undefined) as unknown as FameEnvelopeHandler;
    onWelcome = jest.fn().mockResolvedValue(undefined);
    onAttach = jest.fn().mockResolvedValue(undefined);
    onEpochChange = jest.fn().mockResolvedValue(undefined);

    connector = {
      start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockResolvedValue(undefined),
      state: 'CONNECTED',
      authorizationContext: { principal: 'tester' },
    } as unknown as jest.Mocked<FameConnector>;

    jest
      .spyOn(ConnectorFactory, 'createConnector')
      .mockResolvedValue(connector);

    node = createNodeStub({ admissionClient });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('supports snake_case constructor options', () => {
    const manager = new UpstreamSessionManager({
      node,
      attach_client: attachClient,
      requested_logicals: ['alias-logic'],
      outbound_origin_type: DeliveryOriginType.LOCAL,
      inbound_origin_type: DeliveryOriginType.LOCAL,
      inbound_handler: inboundHandler,
      on_welcome: onWelcome,
      on_attach: onAttach,
      on_epoch_change: onEpochChange,
      admission_client: admissionClient,
    } as never);

    const internal = manager as unknown as {
      requestedLogicals: string[];
      outboundOriginType: DeliveryOriginType;
    };

    expect(internal.requestedLogicals).toEqual(['alias-logic']);
    expect(internal.outboundOriginType).toBe(DeliveryOriginType.LOCAL);
  });

  function createTaskStub(
    promise: Promise<void> = Promise.resolve(),
    overrides: Partial<SpawnedTask<void>> = {}
  ): SpawnedTask<void> {
    const abortController = new AbortController();
    const base: SpawnedTask<void> = {
      id: `task-${Math.random().toString(16).slice(2)}`,
      name: 'task',
      promise,
      abortController,
      startTime: Date.now(),
      cancel: jest.fn(() => abortController.abort()),
      isCancelled: jest.fn().mockReturnValue(false),
      isCompleted: jest.fn().mockReturnValue(false),
      isFailed: jest.fn().mockReturnValue(false),
    } as SpawnedTask<void>;

    return Object.assign(base, overrides);
  }

  function createManager(): UpstreamSessionManager {
    return new UpstreamSessionManager({
      node,
      attachClient,
      requestedLogicals: ['logic-1'],
      outboundOriginType: DeliveryOriginType.LOCAL,
      inboundOriginType: DeliveryOriginType.UPSTREAM,
      inboundHandler,
      onWelcome,
      onAttach,
      onEpochChange,
      admissionClient,
    });
  }

  //   test('connectCycle performs attach handshake and sets ready state', async () => {
  //     const welcome = createWelcomeFrame();
  //     admissionClient.hello.mockResolvedValue(welcome);

  //     const attachInfo = createAttachInfo();
  //     attachClient.attach.mockResolvedValue(attachInfo);
  //     const prepareForAttach = jest.fn();
  //     setCryptoProvider({
  //       prepareForAttach,
  //       nodeJwk: () => ({ kid: 'node', use: 'sig' }),
  //       getJwks: () => ({ keys: [{ kid: 'node', use: 'sig' }, { kid: 'enc', use: 'enc' }] }),
  //     });

  //     const manager = createManager();

  //     const spawnNames: string[] = [];
  //     jest
  //       .spyOn(manager as unknown as { spawn: UpstreamSessionManager['spawn'] }, 'spawn')
  //       .mockImplementation((_, options) => {
  //         spawnNames.push(options?.name ?? 'unknown');
  //         return createTaskStub();
  //       });

  //     jest
  //       .spyOn(manager as unknown as { waitForFailureOrStop: UpstreamSessionManager['waitForFailureOrStop'] }, 'waitForFailureOrStop')
  //       .mockResolvedValue(undefined);

  //     const message = node.envelopeFactory.createEnvelope({
  //       frame: { type: 'Data', payload: { value: 1 } } as any,
  //     });
  //     await manager.send(message);

  //     await (manager as any).connectCycle();

  //     expect(connectorSpy).toHaveBeenCalledWith(welcome.frame.connectionGrants![0], {
  //       systemId: welcome.frame.systemId,
  //     });
  //     expect(onWelcome).toHaveBeenCalledWith(welcome.frame);
  //     expect(onAttach).toHaveBeenCalledWith(attachInfo, connector);
  //     expect(manager.isReady()).toBe(true);
  //     expect(manager.systemId).toBe(attachInfo.targetSystemId);
  //     expect(prepareForAttach).toHaveBeenCalledWith(
  //       welcome.frame.systemId,
  //       welcome.frame.assignedPath,
  //       welcome.frame.acceptedLogicals ?? []
  //     );
  //     expect(spawnNames).toEqual(
  //       expect.arrayContaining([
  //         expect.stringContaining('heartbeat'),
  //         expect.stringContaining('message-pump'),
  //         expect.stringContaining('expiry-guard'),
  //       ])
  //     );
  //     expect((manager as any).hadSuccessfulAttach).toBe(true);
  //   });

  //   test('connectCycle throws when node attach grant is missing', async () => {
  //     const welcome = createWelcomeFrame();
  //     welcome.frame.connectionGrants = [{ type: 'ws', purpose: 'other' }];
  //     admissionClient.hello.mockResolvedValue(welcome);
  //     const manager = createManager();

  //     await expect((manager as any).connectCycle()).rejects.toThrow('Welcome frame missing node attach grant');
  //     expect(connectorSpy).not.toHaveBeenCalled();
  //   });

  //   test('connectCycle throws when welcome lacks connection grants', async () => {
  //     const welcome = createWelcomeFrame();
  //     welcome.frame.connectionGrants = undefined;
  //     admissionClient.hello.mockResolvedValue(welcome);
  //     const manager = createManager();

  //     await expect((manager as any).connectCycle()).rejects.toThrow('Welcome frame missing connection grants');
  //   });

  test('connectCycle throws when admission client is unavailable', async () => {
    const manager = createManager();
    (manager as any).admissionClient = null;

    await expect((manager as any).connectCycle()).rejects.toThrow(
      'Admission client is required to attach upstream'
    );
  });

  test('start throws when ready event never sets', async () => {
    const manager = createManager();
    jest
      .spyOn(
        manager as unknown as { spawn: UpstreamSessionManager['spawn'] },
        'spawn'
      )
      .mockImplementation(() => createTaskStub());

    await expect(manager.start()).rejects.toThrow(
      'Upstream session manager failed to attach'
    );
  });

  test('start is a no-op when already running', async () => {
    const manager = createManager();
    (manager as any).fsmTask = createTaskStub();

    const spawnSpy = jest.spyOn(
      manager as unknown as { spawn: UpstreamSessionManager['spawn'] },
      'spawn'
    );
    await manager.start();
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  test('start resolves immediately when waitUntilReady is false', async () => {
    const manager = createManager();
    const spawnSpy = jest
      .spyOn(
        manager as unknown as { spawn: UpstreamSessionManager['spawn'] },
        'spawn'
      )
      .mockImplementation(() => createTaskStub());

    await expect(
      manager.start({ waitUntilReady: false })
    ).resolves.toBeUndefined();
    expect(spawnSpy).toHaveBeenCalled();
  });

  test('stop cancels running task and stops connector', async () => {
    const manager = createManager();
    const cancelSpy = jest.fn();
    (manager as any).fsmTask = createTaskStub(Promise.resolve(), {
      cancel: cancelSpy,
    });
    (manager as any).connector = connector;

    await manager.stop();
    expect(cancelSpy).toHaveBeenCalled();
    expect(connector.stop).toHaveBeenCalled();
    expect((manager as any).fsmTask).toBeNull();
  });

  test('awaitReady respects timeout', async () => {
    const manager = createManager();
    jest.useFakeTimers();
    const promise = manager.awaitReady(10);
    jest.advanceTimersByTime(10);
    await expect(promise).rejects.toThrow(
      'Timed out waiting for upstream ready'
    );
    jest.runOnlyPendingTimers();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('awaitReady resolves immediately when already ready', async () => {
    const manager = createManager();
    (manager as any).readyEvent.set();
    await expect(manager.awaitReady()).resolves.toBeUndefined();
  });

  test('awaitReady waits until ready when no timeout is provided', async () => {
    const manager = createManager();
    const readyPromise = manager.awaitReady();
    (manager as any).readyEvent.set();
    await expect(readyPromise).resolves.toBeUndefined();
  });

  test('systemId reflects the latest attached target', () => {
    const manager = createManager();
    expect(manager.systemId).toBeNull();
    (manager as any).targetSystemId = 'target-42';
    expect(manager.systemId).toBe('target-42');
  });

  test('start waits for the ready event when waitUntilReady is true', async () => {
    const manager = createManager();
    const readyEvent = (manager as any).readyEvent as AsyncEvent;
    let resolveTask: () => void = () => undefined;
    const taskPromise = new Promise<void>((resolve) => {
      resolveTask = resolve;
    });
    const task = createTaskStub(taskPromise);
    (task.cancel as jest.Mock).mockImplementation(() => {
      resolveTask();
    });

    const spawnSpy = jest
      .spyOn(
        manager as unknown as { spawn: UpstreamSessionManager['spawn'] },
        'spawn'
      )
      .mockImplementation(
        (..._args: unknown[]) => task as unknown as SpawnedTask<unknown>
      );

    const startPromise = manager.start();
    readyEvent.set();
    resolveTask();
    await expect(startPromise).resolves.toBeUndefined();

    await manager.stop();
    expect(spawnSpy).toHaveBeenCalled();
  });

  test('stop cancels fsm task and ignores unexpected errors', async () => {
    const manager = createManager();
    const error = new Error('boom');
    const task = createTaskStub(Promise.reject(error));
    (manager as any).fsmTask = task;

    await expect(manager.stop()).resolves.toBeUndefined();
    expect(task.cancel).toHaveBeenCalled();
  });

  test('stop swallows connector stop failures', async () => {
    const manager = createManager();
    (manager as any).connector = {
      stop: jest.fn().mockRejectedValue(new Error('stop failed')),
    } as unknown as FameConnector;

    await expect(manager.stop()).resolves.toBeUndefined();
    expect((manager as any).connector).toBeNull();
  });

  test('send throws when queue is full', async () => {
    const manager = createManager();
    const queue = (manager as any).messageQueue as FameEnvelope[];
    for (let i = 0; i < UpstreamSessionManager.TX_QUEUE_MAX; i += 1) {
      queue.push({
        id: `env-${i}`,
        frame: { type: 'Data', payload: null },
      } as unknown as FameEnvelope);
    }

    await expect(
      manager.send({
        id: 'overflow',
        frame: { type: 'Data', payload: null },
      } as FameEnvelope)
    ).rejects.toThrow('Upstream message queue is full');
  });

  test('fsmLoop rethrows connection error when attach never succeeds', async () => {
    const manager = createManager();
    const error = new FameConnectError('fail');
    jest.spyOn(manager as any, 'connectCycle').mockRejectedValue(error);

    await expect((manager as any).fsmLoop()).rejects.toBe(error);
  });

  test('fsmLoop exits when connect cycle completes successfully', async () => {
    const manager = createManager();
    jest.spyOn(manager as any, 'connectCycle').mockImplementation(async () => {
      (manager as any).stopEvent.set();
    });

    await expect((manager as any).fsmLoop()).resolves.toBeUndefined();
  });

  test('fsmLoop applies backoff and retries after prior success', async () => {
    const manager = createManager();
    (manager as any).hadSuccessfulAttach = true;
    const connectMock = jest
      .spyOn(manager as any, 'connectCycle')
      .mockImplementation(async () => {
        (manager as any).stopEvent.set();
        throw new Error('transient');
      });

    const backoffSpy = jest.spyOn(manager as any, 'applyBackoff');
    await (manager as any).fsmLoop();
    expect(connectMock).toHaveBeenCalled();
    expect(backoffSpy).toHaveBeenCalled();
  });

  test('fsmLoop retries transport close errors before stopping', async () => {
    const manager = createManager();
    jest
      .spyOn(manager as any, 'connectCycle')
      .mockRejectedValue(new FameTransportClose('closed'));
    const backoffSpy = jest
      .spyOn(manager as any, 'applyBackoff')
      .mockImplementation(async () => {
        (manager as any).stopEvent.set();
        return UpstreamSessionManager.BACKOFF_INITIAL;
      });

    await expect((manager as any).fsmLoop()).resolves.toBeUndefined();
    expect(backoffSpy).toHaveBeenCalledWith(
      UpstreamSessionManager.BACKOFF_INITIAL
    );
  });

  test('fsmLoop rethrows task cancellation errors from connect cycle', async () => {
    const manager = createManager();
    jest
      .spyOn(manager as any, 'connectCycle')
      .mockRejectedValue(new TaskCancelledError('cancel'));

    await expect((manager as any).fsmLoop()).rejects.toBeInstanceOf(
      TaskCancelledError
    );
  });

  test('fsmLoop rethrows unexpected errors before first attach', async () => {
    const manager = createManager();
    const error = new Error('unexpected');
    jest.spyOn(manager as any, 'connectCycle').mockRejectedValue(error);

    await expect((manager as any).fsmLoop()).rejects.toBe(error);
  });

  test('applyBackoff doubles delay and caps at maximum', async () => {
    const manager = createManager();
    const sleepSpy = jest
      .spyOn(manager as any, 'sleepWithStop')
      .mockResolvedValue(undefined);
    const nextDelay = await (manager as any).applyBackoff(
      UpstreamSessionManager.BACKOFF_CAP
    );
    expect(sleepSpy).toHaveBeenCalled();
    expect(nextDelay).toBe(UpstreamSessionManager.BACKOFF_CAP);
  });

  test('heartbeatLoop throws when heartbeat acknowledgement is missed', async () => {
    const manager = createManager();
    const stopEvt = new AsyncEvent();
    jest.useFakeTimers();
    try {
      const loopPromise = (manager as any).heartbeatLoop(connector, stopEvt);
      jest.advanceTimersByTime(
        UpstreamSessionManager.HEARTBEAT_INTERVAL * 1000
      );
      await Promise.resolve();
      const graceMs =
        UpstreamSessionManager.HEARTBEAT_INTERVAL *
        1000 *
        UpstreamSessionManager.HEARTBEAT_GRACE;
      (manager as any).lastHeartbeatAckTime = Date.now() - graceMs - 1;
      jest.advanceTimersByTime(
        UpstreamSessionManager.HEARTBEAT_INTERVAL * 1000
      );
      await expect(loopPromise).rejects.toThrow(
        'missed heartbeat acknowledgement'
      );
    } finally {
      jest.runOnlyPendingTimers();
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  test('heartbeatLoop rethrows when wait is cancelled', async () => {
    const manager = createManager();
    const stopEvt = new AsyncEvent();
    jest
      .spyOn(manager as any, 'waitEvent')
      .mockRejectedValue(new TaskCancelledError('cancelled'));

    await expect(
      (manager as any).heartbeatLoop(connector, stopEvt)
    ).rejects.toBeInstanceOf(TaskCancelledError);
  });

  test('heartbeatLoop stops when stop event triggers during wait', async () => {
    const manager = createManager();
    const stopEvt = new AsyncEvent();
    jest
      .spyOn(manager as any, 'waitEvent')
      .mockImplementation(async (...args: unknown[]) => {
        const event = args[0] as AsyncEvent;
        if (event === stopEvt) {
          stopEvt.set();
        }
      });

    await expect(
      (manager as any).heartbeatLoop(connector, stopEvt)
    ).resolves.toBeUndefined();
  });

  test('heartbeatLoop swallows completion failures when send throws', async () => {
    const manager = createManager();
    const stopEvt = new AsyncEvent();
    connector.send.mockRejectedValue(new Error('send failed'));

    (node as any).dispatchEnvelopeEvent = jest.fn(async (event: string) => {
      if (event === 'onForwardUpstreamComplete') {
        throw new Error('complete failed');
      }
    });

    jest.useFakeTimers();
    const loopPromise = (manager as any).heartbeatLoop(connector, stopEvt);
    jest.advanceTimersByTime(UpstreamSessionManager.HEARTBEAT_INTERVAL * 1000);
    await expect(loopPromise).rejects.toThrow('send failed');
    jest.runOnlyPendingTimers();
    jest.clearAllTimers();
    jest.useRealTimers();

    const completionCalls = (node.dispatchEnvelopeEvent as jest.Mock).mock
      .calls;
    expect(
      completionCalls.some((call) => call[0] === 'onForwardUpstreamComplete')
    ).toBe(true);
  });

  test('sleepWithStop returns immediately for non-positive delay', async () => {
    const manager = createManager();
    await expect((manager as any).sleepWithStop(0)).resolves.toBeUndefined();
  });

  test('sleepWithStop aborts early when stop event triggers', async () => {
    const manager = createManager();
    jest.useFakeTimers();
    setTimeout(() => (manager as any).stopEvent.set(), 10);
    const promise = (manager as any).sleepWithStop(1);
    jest.advanceTimersByTime(10);
    await expect(promise).resolves.toBeUndefined();
    jest.runOnlyPendingTimers();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('getNodeAttachGrant returns matching grant and null otherwise', () => {
    const manager = createManager();
    const grant = { purpose: 'node.attach' };
    expect((manager as any).getNodeAttachGrant([grant])).toBe(grant);
    expect(
      (manager as any).getNodeAttachGrant([{ purpose: 'other' }])
    ).toBeNull();
    expect((manager as any).getNodeAttachGrant(undefined)).toBeNull();
  });

  test('connectCycle handles epoch change without callback', async () => {
    const welcome = createWelcomeFrame();
    admissionClient.hello.mockResolvedValue(welcome);
    const attachInfo = { ...createAttachInfo(), routingEpoch: 'epoch-99' };
    attachClient.attach.mockResolvedValue(attachInfo);

    const manager = new UpstreamSessionManager({
      node,
      attachClient,
      requestedLogicals: ['logic-1'],
      outboundOriginType: DeliveryOriginType.LOCAL,
      inboundOriginType: DeliveryOriginType.UPSTREAM,
      inboundHandler,
      onWelcome,
      onAttach,
      admissionClient,
    });

    jest
      .spyOn(
        manager as unknown as { spawn: UpstreamSessionManager['spawn'] },
        'spawn'
      )
      .mockImplementation(() => createTaskStub());
    jest
      .spyOn(
        manager as unknown as {
          waitForFailureOrStop: UpstreamSessionManager['waitForFailureOrStop'];
        },
        'waitForFailureOrStop'
      )
      .mockResolvedValue(undefined);

    await (manager as any).connectCycle();
    expect(manager.isReady()).toBe(true);
  });

  test('connectCycle throws when welcome lacks connection grants', async () => {
    const manager = createManager();
    const welcome = createWelcomeFrame();
    welcome.frame.connectionGrants = [];
    admissionClient.hello.mockResolvedValue(welcome);

    await expect((manager as any).connectCycle()).rejects.toThrow(
      'Welcome frame missing connection grants'
    );
  });

  test('connectCycle throws when node attach grant is missing', async () => {
    const manager = createManager();
    const welcome = createWelcomeFrame();
    welcome.frame.connectionGrants = [
      { purpose: 'other' } as Record<string, any>,
    ];
    admissionClient.hello.mockResolvedValue(welcome);

    await expect((manager as any).connectCycle()).rejects.toThrow(
      'Welcome frame missing node attach grant'
    );
  });

  test('connectCycle prepares crypto provider when assigned path is present', async () => {
    const manager = createManager();
    const welcome = createWelcomeFrame();
    admissionClient.hello.mockResolvedValue(welcome);
    attachClient.attach.mockResolvedValue(createAttachInfo());
    const prepare = jest.fn();
    Object.assign(node, {
      cryptoProvider: {
        prepareForAttach: prepare,
      } as unknown as CryptoProvider,
    });

    jest
      .spyOn(
        manager as unknown as { spawn: UpstreamSessionManager['spawn'] },
        'spawn'
      )
      .mockReturnValue(createTaskStub());
    jest
      .spyOn(
        manager as unknown as {
          waitForFailureOrStop: UpstreamSessionManager['waitForFailureOrStop'];
        },
        'waitForFailureOrStop'
      )
      .mockResolvedValue(undefined);

    await (manager as any).connectCycle();
    expect(prepare).toHaveBeenCalledWith(
      welcome.frame.systemId,
      welcome.frame.assignedPath,
      welcome.frame.acceptedLogicals
    );
  });

  test('connectCycle flushes buffered frames when queue is populated', async () => {
    const manager = createManager();
    const welcome = createWelcomeFrame();
    admissionClient.hello.mockResolvedValue(welcome);
    attachClient.attach.mockResolvedValue(createAttachInfo());
    (manager as any).messageQueue.push(
      createFameEnvelope({
        frame: { type: 'Data', payload: { value: 1 } } as any,
      })
    );

    jest
      .spyOn(
        manager as unknown as { spawn: UpstreamSessionManager['spawn'] },
        'spawn'
      )
      .mockReturnValue(createTaskStub());
    jest
      .spyOn(
        manager as unknown as {
          waitForFailureOrStop: UpstreamSessionManager['waitForFailureOrStop'];
        },
        'waitForFailureOrStop'
      )
      .mockResolvedValue(undefined);

    await (manager as any).connectCycle();
    expect((manager as any).queueEvent.isSet()).toBe(true);
  });

  test('connectCycle logs reconnection when already attached', async () => {
    const manager = createManager();
    (manager as any).hadSuccessfulAttach = true;
    const welcome = createWelcomeFrame();
    admissionClient.hello.mockResolvedValue(welcome);
    const attachInfo = createAttachInfo();
    attachClient.attach.mockResolvedValue(attachInfo);

    jest
      .spyOn(
        manager as unknown as { spawn: UpstreamSessionManager['spawn'] },
        'spawn'
      )
      .mockReturnValue(createTaskStub());
    jest
      .spyOn(
        manager as unknown as {
          waitForFailureOrStop: UpstreamSessionManager['waitForFailureOrStop'];
        },
        'waitForFailureOrStop'
      )
      .mockResolvedValue(undefined);

    await (manager as any).connectCycle();
    expect(manager.systemId).toBe(attachInfo.targetSystemId);
  });

  test('connectCycle triggers epoch change callback when provided', async () => {
    const welcome = createWelcomeFrame();
    admissionClient.hello.mockResolvedValue(welcome);
    const attachInfo = { ...createAttachInfo(), routingEpoch: 'epoch-55' };
    attachClient.attach.mockResolvedValue(attachInfo);

    const manager = new UpstreamSessionManager({
      node,
      attachClient,
      requestedLogicals: ['logic-1'],
      outboundOriginType: DeliveryOriginType.LOCAL,
      inboundOriginType: DeliveryOriginType.UPSTREAM,
      inboundHandler,
      onWelcome,
      onAttach,
      onEpochChange,
      admissionClient,
    });

    const spawnSpy = jest
      .spyOn(
        manager as unknown as { spawn: UpstreamSessionManager['spawn'] },
        'spawn'
      )
      .mockReturnValue(createTaskStub());
    jest
      .spyOn(
        manager as unknown as {
          waitForFailureOrStop: UpstreamSessionManager['waitForFailureOrStop'];
        },
        'waitForFailureOrStop'
      )
      .mockResolvedValue(undefined);

    await (manager as any).connectCycle();
    expect(spawnSpy).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ name: 'epoch-change-epoch-55' })
    );
  });

  test('connectCycle propagates failures from subtasks', async () => {
    const manager = createManager();
    const welcome = createWelcomeFrame();
    admissionClient.hello.mockResolvedValue(welcome);
    attachClient.attach.mockResolvedValue(createAttachInfo());
    const error = new Error('task failed');

    jest
      .spyOn(
        manager as unknown as { spawn: UpstreamSessionManager['spawn'] },
        'spawn'
      )
      .mockReturnValue(createTaskStub());
    jest
      .spyOn(
        manager as unknown as {
          waitForFailureOrStop: UpstreamSessionManager['waitForFailureOrStop'];
        },
        'waitForFailureOrStop'
      )
      .mockRejectedValue(error);
    connector.stop.mockRejectedValue(new Error('stop fail'));

    await expect((manager as any).connectCycle()).rejects.toBe(error);
    expect(connector.stop).toHaveBeenCalled();
  });

  test('getKeys handles shareable keys cases and crypto provider fallback', () => {
    const sharedKeys = [{ kid: 'k1' }];
    const manager = createManager();
    const securityManager = {
      supportsOverlaySecurity: true,
      getShareableKeys: jest
        .fn()
        .mockReturnValueOnce(sharedKeys)
        .mockReturnValueOnce([])
        .mockReturnValueOnce({ kid: 'single' })
        .mockReturnValue(null),
    };
    (manager as any).node.securityManager = securityManager;

    expect((manager as any).getKeys()).toEqual(sharedKeys);
    expect((manager as any).getKeys()).toBeNull();
    expect((manager as any).getKeys()).toEqual([{ kid: 'single' }]);

    Object.assign((manager as any).node, {
      cryptoProvider: {
        nodeJwk: () => ({ kid: 'node', use: 'sig' }),
        getJwks: () => ({
          keys: [
            { kid: 'node', use: 'sig' },
            { kid: 'enc', use: 'enc' },
          ],
        }),
      },
    } as unknown as { cryptoProvider: CryptoProvider });

    expect((manager as any).getKeys()).toEqual([
      { kid: 'node', use: 'sig' },
      { kid: 'enc', use: 'enc' },
    ]);
  });

  test('getKeys returns null when security manager is absent', () => {
    const manager = createManager();
    expect((manager as any).getKeys()).toBeNull();
  });

  test('waitForFailureOrStop cancels tasks when stop event fires', async () => {
    const manager = createManager();
    const stopEvt = new AsyncEvent();
    const tasks: SpawnedTask<void>[] = [
      createTaskStub(new Promise<void>(() => undefined)),
    ];

    const waitPromise = (manager as any).waitForFailureOrStop(tasks, stopEvt);
    stopEvt.set();
    await waitPromise;
    expect(tasks[0].cancel).toHaveBeenCalled();
  });

  test('waitForFailureOrStop propagates task errors', async () => {
    const manager = createManager();
    const stopEvt = new AsyncEvent();
    const error = new Error('boom');
    const tasks: SpawnedTask<void>[] = [createTaskStub(Promise.reject(error))];

    await expect(
      (manager as any).waitForFailureOrStop(tasks, stopEvt)
    ).rejects.toBe(error);
  });

  test('waitForFailureOrStop ignores task cancellation errors', async () => {
    const manager = createManager();
    const stopEvt = new AsyncEvent();
    const tasks: SpawnedTask<void>[] = [
      createTaskStub(Promise.reject(new TaskCancelledError('cancelled'))),
    ];

    await expect(
      (manager as any).waitForFailureOrStop(tasks, stopEvt)
    ).resolves.toBeUndefined();
  });

  test('messagePumpLoop sends queued messages and stops gracefully', async () => {
    const manager = createManager();
    const stopEvt = new AsyncEvent();
    const envelope = createFameEnvelope({
      frame: { type: 'Data', payload: { hello: 'world' } } as any,
    });
    await manager.send(envelope);

    connector.send.mockImplementation(async () => {
      stopEvt.set();
    });

    await (manager as any).messagePumpLoop(connector, stopEvt);
    expect(connector.send).toHaveBeenCalledWith(envelope);
  });

  test('messagePumpLoop handles message too large errors', async () => {
    const manager = createManager();
    const stopEvt = new AsyncEvent();
    const envelope = createFameEnvelope({
      frame: { type: 'Data', payload: { hello: 'world' } } as any,
      corrId: 'c1',
      replyTo: 'reply@test.example',
    });
    await manager.send(envelope);

    const handleSpy = jest
      .spyOn(manager as any, 'handleMessageTooLarge')
      .mockResolvedValue(undefined);

    connector.send.mockImplementation(async () => {
      stopEvt.set();
      throw new FameMessageTooLarge('big');
    });

    await (manager as any).messagePumpLoop(connector, stopEvt);
    expect(handleSpy).toHaveBeenCalledWith(envelope, 'big');
  });

  test('messagePumpLoop requeues messages when transport closes', async () => {
    const manager = createManager();
    const stopEvt = new AsyncEvent();
    const envelope = createFameEnvelope({
      frame: { type: 'Data', payload: {} } as any,
    });
    await manager.send(envelope);

    connector.send.mockImplementation(async () => {
      throw new FameTransportClose('closed');
    });

    await expect(
      (manager as any).messagePumpLoop(connector, stopEvt)
    ).rejects.toThrow('closed');
    expect((manager as any).messageQueue[0]).toBe(envelope);
  });

  test('messagePumpLoop stops when takeMessage is cancelled', async () => {
    const manager = createManager();
    const stopEvt = new AsyncEvent();

    jest
      .spyOn(manager as any, 'takeMessage')
      .mockRejectedValue(new TaskCancelledError('cancelled'));

    await expect(
      (manager as any).messagePumpLoop(connector, stopEvt)
    ).resolves.toBeUndefined();
  });

  test('messagePumpLoop ignores empty dequeue iterations', async () => {
    const manager = createManager();
    const stopEvt = new AsyncEvent();

    const takeSpy = jest.spyOn(manager as any, 'takeMessage');
    takeSpy.mockResolvedValueOnce(null);
    takeSpy.mockImplementationOnce(async () => {
      stopEvt.set();
      return null;
    });

    await expect(
      (manager as any).messagePumpLoop(connector, stopEvt)
    ).resolves.toBeUndefined();
    expect(takeSpy).toHaveBeenCalledTimes(2);
  });

  test('messagePumpLoop rethrows unexpected send errors', async () => {
    const manager = createManager();
    const stopEvt = new AsyncEvent();
    const envelope = createFameEnvelope({
      frame: { type: 'Data', payload: {} } as any,
    });
    await manager.send(envelope);

    const error = new Error('boom');
    connector.send.mockRejectedValue(error);

    await expect(
      (manager as any).messagePumpLoop(connector, stopEvt)
    ).rejects.toBe(error);
  });

  test('takeMessage returns null when stop event is already set', async () => {
    const manager = createManager();
    const stopEvt = new AsyncEvent();
    stopEvt.set();
    await expect((manager as any).takeMessage(stopEvt)).resolves.toBeNull();
  });

  test('takeMessage returns null when abort signal is already triggered', async () => {
    const manager = createManager();
    const stopEvt = new AsyncEvent();
    const controller = new AbortController();
    controller.abort();

    await expect(
      (manager as any).takeMessage(stopEvt, controller.signal)
    ).resolves.toBeNull();
  });

  test('takeMessage returns null after waiting when stop event fires', async () => {
    const manager = createManager();
    const stopEvt = new AsyncEvent();

    jest
      .spyOn(manager as any, 'waitEvent')
      .mockImplementation(async (...args: unknown[]) => {
        const event = args[0] as AsyncEvent;
        if (event === stopEvt) {
          stopEvt.set();
        }
      });

    await expect((manager as any).takeMessage(stopEvt)).resolves.toBeNull();
  });

  test('handleMessageTooLarge sends nack when reply information is present', async () => {
    const manager = createManager();
    const fabricSend = jest.fn().mockResolvedValue(undefined);
    jest
      .spyOn(FameFabric, 'current')
      .mockReturnValue({ send: fabricSend } as unknown as FameFabric);

    const envelope = createFameEnvelope({
      frame: { type: 'Data', payload: { hello: 'world' } } as any,
      corrId: 'corr-1',
      replyTo: 'reply@test.example',
      id: 'env-1',
    });

    await (manager as any).handleMessageTooLarge(envelope, 'big');

    expect(fabricSend).toHaveBeenCalledWith(
      expect.objectContaining({
        frame: expect.objectContaining<DeliveryAckFrame>({
          type: 'DeliveryAck',
          ok: false,
          code: 'MESSAGE_TOO_LARGE',
        }),
      })
    );
  });

  test('handleMessageTooLarge ignores envelopes without correlation', async () => {
    const manager = createManager();
    const fabricSend = jest.fn();
    jest
      .spyOn(FameFabric, 'current')
      .mockReturnValue({ send: fabricSend } as unknown as FameFabric);

    await (manager as any).handleMessageTooLarge(
      { frame: { type: 'Data', payload: {} } } as FameEnvelope,
      'big'
    );
    expect(fabricSend).not.toHaveBeenCalled();
  });

  test('handleMessageTooLarge swallows errors when nack send fails', async () => {
    const manager = createManager();
    const fabricSend = jest.fn().mockRejectedValue(new Error('send failed'));
    jest
      .spyOn(FameFabric, 'current')
      .mockReturnValue({ send: fabricSend } as unknown as FameFabric);
    const envelope = createFameEnvelope({
      frame: { type: 'Data', payload: {} } as any,
      corrId: 'corr-2',
      replyTo: 'reply@test.example',
    });

    await expect(
      (manager as any).handleMessageTooLarge(envelope, 'fail')
    ).resolves.toBeUndefined();
    expect(fabricSend).toHaveBeenCalled();
  });

  test('expiryGuard waits when no expiry data present', async () => {
    const manager = createManager();
    const stopEvt = new AsyncEvent();
    const waitSpy = jest
      .spyOn(manager as any, 'waitEvent')
      .mockResolvedValue(undefined);
    const welcome = createWelcomeFrame();
    welcome.frame.expiresAt = undefined;
    const info = { ...createAttachInfo(), attachExpiresAt: undefined };

    await (manager as any).expiryGuard(connector, welcome, info, stopEvt);
    expect(waitSpy).toHaveBeenCalledWith(stopEvt, undefined);
  });

  test('expiryGuard stops connector before expiry', async () => {
    const manager = createManager();
    const stopEvt = new AsyncEvent();
    const welcome = createWelcomeFrame();
    welcome.frame.expiresAt = new Date(Date.now() + 90_000).toISOString();
    const info = createAttachInfo();

    jest.useFakeTimers();
    const promise = (manager as any).expiryGuard(
      connector,
      welcome,
      info,
      stopEvt
    );
    jest.runOnlyPendingTimers();
    jest.clearAllTimers();
    await promise;
    expect(connector.stop).toHaveBeenCalled();
    jest.useRealTimers();
  });

  test('expiryGuard does not stop connector when stop event triggers early', async () => {
    const manager = createManager();
    const stopEvt = new AsyncEvent();
    stopEvt.set();

    const welcome = createWelcomeFrame();
    const soon =
      Date.now() + (UpstreamSessionManager.JWT_REFRESH_SAFETY - 1) * 1000;
    welcome.frame.expiresAt = new Date(soon).toISOString();
    const info = { ...createAttachInfo(), attachExpiresAt: new Date(soon) };

    jest.useFakeTimers();
    await (manager as any).expiryGuard(connector, welcome, info, stopEvt);
    jest.runOnlyPendingTimers();
    jest.clearAllTimers();
    expect(connector.stop).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  test('makeHeartbeatEnabledHandler handles heartbeat acknowledgements and downstream forwarding', async () => {
    const manager = createManager();
    const downstream = jest.fn().mockResolvedValue(undefined);
    const handler = (manager as any).makeHeartbeatEnabledHandler(downstream);

    const ackEnvelope = createFameEnvelope({
      frame: {
        type: 'NodeHeartbeatAck',
        routingEpoch: 'epoch-2',
      } as NodeHeartbeatAckFrame,
      id: 'ack-1',
      corrId: 'corr',
    });

    await handler(ackEnvelope);
    expect(onEpochChange).toHaveBeenCalledWith('epoch-2');

    const normalEnvelope = createFameEnvelope({
      frame: { type: 'Data', payload: { ping: true } } as any,
    });
    await handler(normalEnvelope);
    expect(downstream).toHaveBeenCalledWith(normalEnvelope, expect.any(Object));
  });

  test('makeHeartbeatEnabledHandler ignores NodeAttachAck frames', async () => {
    const manager = createManager();
    const downstream = jest.fn().mockResolvedValue(undefined);
    const handler = (manager as any).makeHeartbeatEnabledHandler(downstream);

    const attachAck = createFameEnvelope({
      frame: { type: 'NodeAttachAck' } as any,
    });

    await handler(attachAck);
    expect(downstream).not.toHaveBeenCalled();
  });

  test('waitEvent forwards AbortSignal when provided', async () => {
    const manager = createManager();
    const event = {
      wait: jest.fn().mockResolvedValue(undefined),
    } as unknown as AsyncEvent;
    const controller = new AbortController();

    await (manager as any).waitEvent(event, controller.signal);
    expect(event.wait).toHaveBeenCalledWith({ signal: controller.signal });

    await (manager as any).waitEvent(event);
    expect(event.wait).toHaveBeenLastCalledWith();
  });

  test('makeHeartbeatEnabledHandler populates context defaults when provided', async () => {
    const manager = createManager();
    const downstream = jest.fn().mockResolvedValue(undefined);
    const handler = (manager as any).makeHeartbeatEnabledHandler(downstream);

    (manager as any).connector = connector;
    (manager as any).targetSystemId = 'target-1';

    const context = {} as FameDeliveryContext;
    context.originType = DeliveryOriginType.LOCAL;
    const envelope = createFameEnvelope({
      frame: { type: 'Data', payload: { value: 42 } } as any,
    });

    await handler(envelope, context);

    expect(context.originType).toBe(DeliveryOriginType.UPSTREAM);
    expect(context.fromConnector).toBe(connector);
    expect(context.fromSystemId).toBe('target-1');
    expect(context.security?.authorization).toEqual(
      connector.authorizationContext
    );
    expect(context.expectedResponseType).toBe(FameResponseType.NONE);
    expect(downstream).toHaveBeenCalledWith(envelope, context);
  });

  test('makeHeartbeatEnabledHandler warns when epoch changes without callback', async () => {
    const manager = createManager();
    const downstream = jest.fn().mockResolvedValue(undefined);
    const handler = (manager as any).makeHeartbeatEnabledHandler(downstream);
    const logger = getLogger('naylence.fame.node.upstream_session_manager');
    const warningSpy = jest.spyOn(logger, 'warning');

    (manager as any).connector = connector;
    (manager as any).lastSeenEpoch = 'epoch-1';
    (manager as any).onEpochChange = undefined;

    const ackEnvelope = createFameEnvelope({
      frame: {
        type: 'NodeHeartbeatAck',
        routingEpoch: 'epoch-2',
      } as NodeHeartbeatAckFrame,
      corrId: 'corr-3',
    });

    await handler(ackEnvelope);

    expect(warningSpy).toHaveBeenCalledWith('parent_epoch_changed', {
      epoch: 'epoch-2',
    });
    expect(downstream).not.toHaveBeenCalled();
  });
});
