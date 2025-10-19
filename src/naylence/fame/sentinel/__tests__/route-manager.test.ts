import {
  DeliveryOriginType,
  FameResponseType,
  type FameConnector,
  type FameEnvelope,
} from 'naylence-core';

import { RouteManager } from '../route-manager.js';
import type { RouteEntry } from '../store/route-store.js';
import type { RouteStore } from '../store/route-store.js';
import type { AddressRouteInfo } from '../key-frame-handler.js';
import { FameTransportClose } from '../../errors/errors.js';

jest.mock('../../util/logging.js', () => {
  const logger = {
    debug: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
  };

  return {
    getLogger: jest.fn(() => logger),
    __loggerMock: logger,
  };
});

jest.mock('../../util/task-utils.js', () => {
  const delay = jest.fn(
    (ms: number, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error('Aborted'));
          return;
        }

        const timeout = setTimeout(() => {
          signal?.removeEventListener('abort', abortHandler);
          resolve();
        }, ms);

        const abortHandler = () => {
          clearTimeout(timeout);
          signal?.removeEventListener('abort', abortHandler);
          reject(new Error('Aborted'));
        };

        signal?.addEventListener('abort', abortHandler);
      })
  );

  return {
    delay,
  };
});

jest.mock('../../connector/connector-factory.js', () => ({
  ConnectorFactory: {
    createConnector: jest.fn(),
  },
  createResource: jest.fn(),
}));

const createConnectorModule = () =>
  jest.requireMock('../../connector/connector-factory.js') as {
    ConnectorFactory: { createConnector?: jest.Mock }; // eslint-disable-line @typescript-eslint/no-explicit-any
    createResource: jest.Mock;
  };

const { __loggerMock: loggerMock } = jest.requireMock(
  '../../util/logging.js'
) as {
  getLogger: jest.Mock;
  __loggerMock: { debug: jest.Mock; warning: jest.Mock; error: jest.Mock };
};

const delayMock = (
  jest.requireMock('../../util/task-utils.js') as { delay: jest.Mock }
).delay as jest.Mock;

function createRouteStore(
  initial: Record<string, RouteEntry> = {}
): RouteStore {
  let data = { ...initial };
  return {
    set: jest.fn(async (key, value) => {
      data[key] = value;
    }),
    update: jest.fn(async (key, value) => {
      data[key] = value;
    }),
    get: jest.fn(async (key) => data[key]),
    delete: jest.fn(async (key) => {
      delete data[key];
    }),
    list: jest.fn(async () => ({ ...data })),
  } as RouteStore;
}

function createConnectorStub(): FameConnector {
  return {
    id: 'connector',
    start: jest.fn(async () => undefined),
    stop: jest.fn(async () => undefined),
    send: jest.fn(),
    replaceHandler: jest.fn(),
    close: jest.fn(),
    isClosed: () => false,
  } as unknown as FameConnector;
}

function flushAllTimers(): Promise<void> {
  return Promise.resolve().then(() => undefined);
}

describe('RouteManager', () => {
  beforeEach(() => {
    jest.useRealTimers();
    delayMock.mockClear();
    loggerMock.debug.mockClear();
    loggerMock.warning.mockClear();
    loggerMock.error.mockClear();

    const { ConnectorFactory, createResource } = createConnectorModule();
    ConnectorFactory.createConnector?.mockReset();
    createResource.mockReset();
  });

  afterEach(async () => {
    jest.useRealTimers();
  });

  it('aborts pending cleanup when re-registering a downstream route', async () => {
    const store = createRouteStore();
    const manager = new RouteManager({
      deliver: jest.fn(),
      routeStore: store,
      cleanupDelayMs: 50,
    });

    const controller = new AbortController();
    const abortSpy = jest.spyOn(controller, 'abort');
    (
      manager as unknown as {
        pendingCleanupControllers: Map<string, AbortController>;
      }
    ).pendingCleanupControllers.set('segment', controller);

    const connector = createConnectorStub();
    await manager.registerDownstreamRoute('segment', connector);

    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(
      (
        manager as unknown as {
          pendingCleanupControllers: Map<string, AbortController>;
        }
      ).pendingCleanupControllers.has('segment')
    ).toBe(false);
    expect(manager.downstreamRoutes.get('segment')).toBe(connector);

    await manager.shutdownTasks({ cancelHanging: true });
  });

  it('removes downstream route without stopping connector when requested', async () => {
    const store = createRouteStore();
    const manager = new RouteManager({ deliver: jest.fn(), routeStore: store });
    const connector = createConnectorStub();
    await manager.registerDownstreamRoute('child', connector);

    const downstreamRoutes = manager._downstream_addresses_routes as Map<
      string,
      AddressRouteInfo
    >;
    downstreamRoutes.set('svc@/child', {
      segment: 'child',
    } as AddressRouteInfo);
    manager._downstream_addresses_legacy.set('svc@/child', {
      segment: 'child',
    } as AddressRouteInfo);
    manager._peer_addresses_routes.set('svc@/child', 'child');
    manager._pools.set('pool', new Set(['child']));

    await (
      manager as unknown as {
        removeDownstreamRoute: (
          segment: string,
          options?: { stop?: boolean; retainAddresses?: boolean }
        ) => Promise<void>;
      }
    ).removeDownstreamRoute('child', {
      stop: false,
      retainAddresses: false,
    });

    await manager.shutdownTasks({ cancelHanging: true });

    expect(connector.stop as jest.Mock).not.toHaveBeenCalled();
    expect(store.delete).toHaveBeenCalledWith('child');
    expect(manager._downstream_addresses_routes.size).toBe(0);
    expect(manager._peer_addresses_routes.size).toBe(0);
    expect(manager._downstream_addresses_legacy.size).toBe(0);
    expect(manager._pools.get('pool')?.size).toBe(0);
  });

  it('retains downstream address references when removing route with default retention', async () => {
    const store = createRouteStore();
    const manager = new RouteManager({ deliver: jest.fn(), routeStore: store });
    const connector = createConnectorStub();
    await manager.registerDownstreamRoute('child', connector);

    manager._downstream_addresses_routes.set('svc@/child', {
      segment: 'child',
    } as AddressRouteInfo);
    manager._downstream_addresses_legacy.set('svc@/child', {
      segment: 'child',
    } as AddressRouteInfo);
    manager._peer_addresses_routes.set('svc@/child', 'child');
    manager._pools.set('pool', new Set(['child']));

    await (
      manager as unknown as {
        removeDownstreamRoute: (
          segment: string,
          options?: { stop?: boolean; retainAddresses?: boolean }
        ) => Promise<void>;
      }
    ).removeDownstreamRoute('child', { stop: false });

    expect(manager._downstream_addresses_routes.get('svc@/child')).toEqual({
      segment: 'child',
    });
    expect(manager._downstream_addresses_legacy.get('svc@/child')).toEqual({
      segment: 'child',
    });
    expect(manager._peer_addresses_routes.get('svc@/child')).toBe('child');
    expect(manager._pools.get('pool')?.has('child')).toBe(true);

    await manager.shutdownTasks({ cancelHanging: true });
  });

  it('purges address references when retention is disabled globally', async () => {
    const store = createRouteStore();
    const manager = new RouteManager({
      deliver: jest.fn(),
      routeStore: store,
      retainAddressBindingsOnDisconnect: false,
    });
    const connector = createConnectorStub();
    await manager.registerDownstreamRoute('child', connector);

    manager._downstream_addresses_routes.set('svc@/child', {
      segment: 'child',
    } as AddressRouteInfo);
    manager._downstream_addresses_legacy.set('svc@/child', {
      segment: 'child',
    } as AddressRouteInfo);
    manager._peer_addresses_routes.set('svc@/child', 'child');
    manager._pools.set('pool', new Set(['child']));

    await manager.unregisterDownstreamRoute('child', { stop: false });

    expect(manager._downstream_addresses_routes.size).toBe(0);
    expect(manager._downstream_addresses_legacy.size).toBe(0);
    expect(manager._peer_addresses_routes.size).toBe(0);
    expect(manager._pools.get('pool')?.size).toBe(0);

    await manager.shutdownTasks({ cancelHanging: true });
  });

  it('stops connector immediately when delay is non-positive', async () => {
    const store = createRouteStore();
    const manager = new RouteManager({ deliver: jest.fn(), routeStore: store });
    const connector = createConnectorStub();
    await manager.registerDownstreamRoute('child', connector);

    await (
      manager as unknown as {
        removeDownstreamRoute: (
          segment: string,
          options?: { stop?: boolean; delayMs?: number }
        ) => Promise<void>;
      }
    ).removeDownstreamRoute('child', { delayMs: 0 });

    await manager.shutdownTasks({ cancelHanging: true });

    expect(connector.stop).toHaveBeenCalledTimes(1);
  });

  it('cancels scheduled cleanup when route is re-registered', async () => {
    jest.useFakeTimers();
    const store = createRouteStore();
    const manager = new RouteManager({
      deliver: jest.fn(),
      routeStore: store,
      cleanupDelayMs: 100,
    });
    const first = createConnectorStub();
    const second = createConnectorStub();

    await manager.registerDownstreamRoute('child', first);
    await (
      manager as unknown as {
        removeDownstreamRoute: (segment: string) => Promise<void>;
      }
    ).removeDownstreamRoute('child');

    await manager.registerDownstreamRoute('child', second);

    await jest.advanceTimersByTimeAsync(200);
    await flushAllTimers();

    await manager.shutdownTasks({ cancelHanging: true });

    expect(first.stop).not.toHaveBeenCalled();
    expect(manager.downstreamRoutes.get('child')).toBe(second);
  });

  it('restores routes by retrying transient failures and propagating authorization', async () => {
    const now = new Date();
    const future = new Date(now.getTime() + 5000);

    const entries: Record<string, RouteEntry> = {
      'missing-config': { systemId: 'one' },
      'expired-route': {
        connectorConfig: { type: 'ws' } as any,
        attachExpiresAt: new Date(now.getTime() - 1000).toISOString(),
      },
      'recoverable-route': {
        connectorConfig: { type: 'ws' } as any,
        metadata: {
          authenticated: true,
          authorized: true,
          sub: 'node-123',
          aud: 'cluster',
          acceptedCapabilities: ['svc.cap'],
          acceptedLogicals: ['log'],
          scopes: ['scope'],
          instance_id: 'instance',
          assigned_path: '/child',
        },
        attachExpiresAt: future.toISOString(),
      },
    };

    const store = createRouteStore(entries);
    const deliver = jest.fn(async () => undefined);
    const manager = new RouteManager({
      deliver,
      routeStore: store,
      getId: () => 'rm',
    });

    const { ConnectorFactory } = createConnectorModule();

    type DeliveryHandler = (
      env: FameEnvelope,
      ctx: unknown
    ) => Promise<unknown>;
    let capturedHandler: DeliveryHandler | null = null;
    const connector = {
      start: jest.fn(async (handler: DeliveryHandler) => {
        capturedHandler = handler;
      }),
      stop: jest.fn(async () => undefined),
    } as unknown as FameConnector;

    ConnectorFactory.createConnector
      ?.mockRejectedValueOnce(new FameTransportClose('temporary close'))
      .mockResolvedValue(connector);

    jest.useFakeTimers();
    try {
      const restorePromise = manager.restoreRoutes();

      await jest.advanceTimersByTimeAsync(2000);
      await jest.advanceTimersByTimeAsync(4000);
      await restorePromise;
      await flushAllTimers();
    } finally {
      jest.useRealTimers();
    }

    expect(ConnectorFactory.createConnector).toHaveBeenCalledTimes(2);
    expect(loggerMock.warning).toHaveBeenCalledWith(
      'route_restore_missing_config',
      {
        segment: 'missing-config',
      }
    );
    expect(loggerMock.debug).toHaveBeenCalledWith('skipping_expired_route', {
      segment: 'expired-route',
    });
    expect(manager.downstreamRoutes.has('recoverable-route')).toBe(true);

    expect(capturedHandler).toBeInstanceOf(Function);
    const envelope = { frame: { type: 'Data' } } as FameEnvelope;
    const handler = capturedHandler!;
    await handler(envelope, {
      fromConnector: connector,
      fromSystemId: 'recoverable-route',
      originType: DeliveryOriginType.DOWNSTREAM,
      expectedResponseType: FameResponseType.NONE,
    });

    expect(deliver).toHaveBeenCalledWith(
      envelope,
      expect.objectContaining({
        fromSystemId: 'recoverable-route',
        security: expect.objectContaining({
          authorization: expect.objectContaining({ sub: 'node-123' }),
        }),
      })
    );

    await manager.stop();
    await manager.shutdownTasks({ cancelHanging: true });
  });

  it('auto-expires routes discovered in the route store', async () => {
    const connector = createConnectorStub();
    const store = createRouteStore({
      'peer-1': {
        connectorConfig: { type: 'ws' } as any,
        attachExpiresAt: new Date(Date.now() - 1000).toISOString(),
      },
    });

    const manager = new RouteManager({ deliver: jest.fn(), routeStore: store });
    manager._peer_routes.set('peer-1', connector);

    await (
      manager as unknown as {
        scanStoreForExpirations: (
          store: RouteStore,
          now: Date,
          kind: 'peer'
        ) => Promise<void>;
      }
    ).scanStoreForExpirations(store, new Date(), 'peer');

    expect(store.delete).toHaveBeenCalledWith('peer-1');
    expect(manager._peer_routes.has('peer-1')).toBe(false);
    expect(connector.stop).toHaveBeenCalledTimes(1);

    await manager.shutdownTasks({ cancelHanging: true });
  });

  it('parses authorization metadata and handles corrupt entries', () => {
    const manager = new RouteManager({
      deliver: jest.fn(),
      routeStore: createRouteStore(),
    });

    const metadata = {
      authenticated: true,
      authorized: true,
      sub: 'subject',
      aud: 'audience',
      acceptedCapabilities: ['cap'],
      acceptedLogicals: ['log'],
      scopes: ['scope'],
      instanceId: 'instance',
      assignedPath: '/path',
      attachExpiresAt: new Date().toISOString(),
    };

    const parsed = (
      manager as unknown as {
        parseAuthorization: (
          metadata: Record<string, unknown> | null
        ) => unknown;
      }
    ).parseAuthorization(metadata) as Record<string, unknown>;

    expect(parsed?.sub).toBe('subject');
    expect(parsed?.scopes).toEqual(['scope']);

    const empty = (
      manager as unknown as {
        parseAuthorization: (
          metadata: Record<string, unknown> | null
        ) => unknown;
      }
    ).parseAuthorization(null);

    expect(empty).toBeNull();

    const invalid = (
      manager as unknown as {
        parseAuthorization: (
          metadata: Record<string, unknown> | null
        ) => unknown;
      }
    ).parseAuthorization({ authenticated: 'yes' } as unknown as Record<
      string,
      unknown
    >);

    expect(invalid).toBeNull();
    expect(loggerMock.error).toHaveBeenCalledWith(
      'corrupt_route_metadata',
      expect.any(Object)
    );

    return manager.shutdownTasks({ cancelHanging: true });
  });

  it('creates connectors via fallback resource when factory is unavailable', async () => {
    const manager = new RouteManager({
      deliver: jest.fn(),
      routeStore: createRouteStore(),
    });
    const moduleMocks = createConnectorModule();
    const connector = createConnectorStub();

    const originalFactory = moduleMocks.ConnectorFactory.createConnector;
    Reflect.deleteProperty(moduleMocks.ConnectorFactory, 'createConnector');
    moduleMocks.createResource.mockResolvedValue(connector);

    const created = await (
      manager as unknown as {
        createConnector: (
          config: Record<string, unknown>
        ) => Promise<FameConnector>;
      }
    ).createConnector({ type: 'ws' });

    expect(created).toBe(connector);
    expect(moduleMocks.createResource).toHaveBeenCalledWith({ type: 'ws' });

    if (originalFactory) {
      moduleMocks.ConnectorFactory.createConnector = originalFactory;
    }
    await manager.shutdownTasks({ cancelHanging: true });
  });

  it('defaults cleanup delay when configured with non-finite values', async () => {
    const store = createRouteStore();
    const manager = new RouteManager({
      deliver: jest.fn(),
      routeStore: store,
      cleanupDelayMs: Number.POSITIVE_INFINITY,
    });

    const actualDelay = (manager as unknown as { cleanupDelayMs: number })
      .cleanupDelayMs;
    expect(actualDelay).toBe(200);

    const zeroManager = new RouteManager({
      deliver: jest.fn(),
      routeStore: createRouteStore(),
      cleanupDelayMs: -25,
    });

    const sanitizedDelay = (
      zeroManager as unknown as { cleanupDelayMs: number }
    ).cleanupDelayMs;
    expect(sanitizedDelay).toBe(0);

    await manager.shutdownTasks({ cancelHanging: true });
    await zeroManager.shutdownTasks({ cancelHanging: true });
  });

  it('classifies transient errors based on type and message', () => {
    const manager = new RouteManager({
      deliver: jest.fn(),
      routeStore: createRouteStore(),
    });

    const asTransient = (
      manager as unknown as {
        isTransientError: (error: unknown) => boolean;
      }
    ).isTransientError.bind(manager);

    expect(asTransient(new FameTransportClose('closed'))).toBe(true);
    expect(asTransient(new Error('Timeout reached'))).toBe(true);
    expect(asTransient(new Error('temporary outage'))).toBe(true);
    expect(asTransient(new Error('fatal error'))).toBe(false);
    expect(asTransient('boom')).toBe(false);

    return manager.shutdownTasks({ cancelHanging: true });
  });

  it('stops pending routes and ignores connector stop errors', async () => {
    const store = createRouteStore();
    const manager = new RouteManager({ deliver: jest.fn(), routeStore: store });

    const downstreamConnector = createConnectorStub();
    const peerConnector = createConnectorStub();
    const failingConnector = createConnectorStub();
    (failingConnector.stop as jest.Mock).mockImplementation(async () => {
      throw new Error('fail');
    });

    manager.downstreamRoutes.set('down', downstreamConnector);
    manager._peer_routes.set('peer', peerConnector);
    manager.trackFlowRoute('flow-1', failingConnector);

    const cancelAttach = jest.fn();
    (
      manager as unknown as {
        _pending_routes: Map<
          string,
          {
            connector: FameConnector;
            attached: { set(): void };
            buffer: FameEnvelope[];
            cancelAttachTimeout?: () => void;
          }
        >;
      }
    )._pending_routes.set('pending', {
      connector: failingConnector,
      attached: { set: jest.fn() },
      buffer: [],
      cancelAttachTimeout: cancelAttach,
    });

    await manager.stop();

    expect(cancelAttach).toHaveBeenCalledTimes(1);
    expect(failingConnector.stop).toHaveBeenCalledTimes(1);
    expect(loggerMock.debug).toHaveBeenCalledWith(
      'connector_stop_ignored',
      expect.objectContaining({ error: 'fail' })
    );
    expect(manager.getFlowRoute('flow-1')).toBeUndefined();
  });

  it('schedules delayed cleanup when removing peer route', async () => {
    jest.useFakeTimers();
    const store = createRouteStore();
    const manager = new RouteManager({
      deliver: jest.fn(),
      routeStore: store,
      cleanupDelayMs: 25,
    });
    const connector = createConnectorStub();

    try {
      await manager.registerPeerRoute('peer', connector);

      await (
        manager as unknown as {
          removePeerRoute: (segment: string) => Promise<void>;
        }
      ).removePeerRoute('peer');

      expect(manager._peer_routes.has('peer')).toBe(false);
      expect(store.delete).toHaveBeenCalledWith('peer');
      expect(connector.stop as jest.Mock).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(30);
      await flushAllTimers();

      expect(connector.stop).toHaveBeenCalledTimes(1);
      expect(
        (
          manager as unknown as {
            pendingCleanupControllers: Map<string, AbortController>;
          }
        ).pendingCleanupControllers.size
      ).toBe(0);
    } finally {
      jest.useRealTimers();
      await manager.shutdownTasks({ cancelHanging: true });
    }
  });

  it('logs cleanup delay failures when delay rejects', async () => {
    const store = createRouteStore();
    const manager = new RouteManager({
      deliver: jest.fn(),
      routeStore: store,
      cleanupDelayMs: 25,
    });
    const connector = createConnectorStub();

    delayMock.mockImplementationOnce(async () => {
      throw new Error('delay failed');
    });

    await (
      manager as unknown as {
        cleanupConnector: (
          segment: string,
          connector: FameConnector,
          delayMs: number
        ) => Promise<void>;
      }
    ).cleanupConnector('segment', connector, 25);

    await manager.shutdownTasks({ cancelHanging: true });

    expect(loggerMock.debug).toHaveBeenCalledWith(
      'connector_cleanup_delay_failed',
      expect.objectContaining({ segment: 'segment', error: 'delay failed' })
    );
    expect(connector.stop).not.toHaveBeenCalled();
  });

  it('expires routes later and warns when deletion fails', async () => {
    jest.useFakeTimers();
    const store = createRouteStore();
    const manager = new RouteManager({ deliver: jest.fn(), routeStore: store });
    const connector = createConnectorStub();

    try {
      manager.downstreamRoutes.set('segment', connector);
      (store.delete as jest.Mock).mockRejectedValueOnce(new Error('db down'));

      const expirePromise = (
        manager as unknown as {
          expireRouteLater: (segment: string, delayMs: number) => Promise<void>;
        }
      ).expireRouteLater('segment', 20);

      await jest.advanceTimersByTimeAsync(20);
      await flushAllTimers();
      await expirePromise;

      expect(connector.stop).toHaveBeenCalledTimes(1);
      expect(loggerMock.warning).toHaveBeenCalledWith(
        'route_expiration_delete_failed',
        expect.objectContaining({ segment: 'segment' })
      );
      expect(loggerMock.debug).toHaveBeenCalledWith('expired_route', {
        route: 'segment',
      });
    } finally {
      jest.useRealTimers();
      await manager.shutdownTasks({ cancelHanging: true });
    }
  });

  it('logs janitor loop errors and exits gracefully', async () => {
    jest.useFakeTimers();
    const store = createRouteStore();
    const manager = new RouteManager({ deliver: jest.fn(), routeStore: store });

    const scanSpy = jest
      .spyOn(
        manager as unknown as {
          scanStoreForExpirations: (...args: unknown[]) => Promise<void>;
        },
        'scanStoreForExpirations'
      )
      .mockRejectedValueOnce(new Error('scan failed'))
      .mockResolvedValue(undefined);

    try {
      await manager.start();
      await flushAllTimers();

      expect(loggerMock.error).toHaveBeenCalledWith(
        'janitor_loop_error',
        expect.objectContaining({ error: 'scan failed' })
      );
      expect(loggerMock.debug).toHaveBeenCalledWith('janitor_loop_exited');
    } finally {
      scanSpy.mockRestore();
      jest.useRealTimers();
      await manager.shutdownTasks({ cancelHanging: true });
    }
  });

  it('logs janitor loop non-error failures', async () => {
    jest.useFakeTimers();
    const manager = new RouteManager({
      deliver: jest.fn(),
      routeStore: createRouteStore(),
    });

    const scanSpy = jest
      .spyOn(
        manager as unknown as {
          scanStoreForExpirations: (...args: unknown[]) => Promise<void>;
        },
        'scanStoreForExpirations'
      )
      .mockRejectedValueOnce('scan broke')
      .mockResolvedValue(undefined);

    try {
      await manager.start();
      await flushAllTimers();

      expect(loggerMock.error).toHaveBeenCalledWith(
        'janitor_loop_error',
        expect.objectContaining({ error: 'scan broke' })
      );
      expect(loggerMock.debug).toHaveBeenCalledWith('janitor_loop_exited');
    } finally {
      scanSpy.mockRestore();
      jest.useRealTimers();
      await manager.shutdownTasks({ cancelHanging: true });
    }
  });

  it('warns when downstream route deletion fails', async () => {
    const store = createRouteStore();
    const manager = new RouteManager({
      deliver: jest.fn(),
      routeStore: store,
      cleanupDelayMs: 0,
    });
    const connector = createConnectorStub();
    await manager.registerDownstreamRoute('segment', connector);
    (store.delete as jest.Mock).mockRejectedValueOnce(
      new Error('delete failed')
    );

    await (
      manager as unknown as {
        removeDownstreamRoute: (segment: string) => Promise<void>;
      }
    ).removeDownstreamRoute('segment');

    await manager.shutdownTasks({ cancelHanging: true });

    expect(loggerMock.warning).toHaveBeenCalledWith(
      'route_delete_failed',
      expect.objectContaining({ segment: 'segment' })
    );
  });

  it('logs warning when auto-expire deletion fails', async () => {
    const connector = createConnectorStub();
    const store = createRouteStore({
      'peer-1': {
        connectorConfig: { type: 'ws' } as any,
        attachExpiresAt: new Date(Date.now() - 1000).toISOString(),
      },
    });

    const manager = new RouteManager({ deliver: jest.fn(), routeStore: store });
    manager._peer_routes.set('peer-1', connector);
    (store.delete as jest.Mock).mockRejectedValueOnce(
      new Error('cannot delete')
    );

    await (
      manager as unknown as {
        scanStoreForExpirations: (
          store: RouteStore,
          now: Date,
          kind: 'peer'
        ) => Promise<void>;
      }
    ).scanStoreForExpirations(store, new Date(), 'peer');

    expect(loggerMock.warning).toHaveBeenCalledWith(
      'route_auto_expire_delete_failed',
      expect.objectContaining({ segment: 'peer-1' })
    );

    await manager.shutdownTasks({ cancelHanging: true });
  });

  it('logs pending route stop failure when safe stop rejects', async () => {
    const manager = new RouteManager({
      deliver: jest.fn(),
      routeStore: createRouteStore(),
    });
    const connector = createConnectorStub();
    (
      manager as unknown as {
        _pending_routes: Map<
          string,
          {
            connector: FameConnector;
            attached: { set(): void };
            buffer: FameEnvelope[];
          }
        >;
      }
    )._pending_routes.set('pending', {
      connector,
      attached: { set: jest.fn() },
      buffer: [],
    });

    const safeStopSpy = jest
      .spyOn(
        manager as unknown as {
          safeStop: (conn: FameConnector) => Promise<void>;
        },
        'safeStop'
      )
      .mockRejectedValueOnce(new Error('boom'));

    await manager.stop();

    expect(loggerMock.debug).toHaveBeenCalledWith(
      'pending_route_stop_failed',
      expect.objectContaining({ error: 'boom' })
    );

    safeStopSpy.mockRestore();
  });

  it('tracks and clears flow routes', async () => {
    const manager = new RouteManager({
      deliver: jest.fn(),
      routeStore: createRouteStore(),
    });
    const connector = createConnectorStub();

    expect(manager.getFlowRoute('flow')).toBeUndefined();
    manager.trackFlowRoute('flow', connector);
    expect(manager.getFlowRoute('flow')).toBe(connector);
    manager.clearFlowRoute('flow');
    expect(manager.getFlowRoute('flow')).toBeUndefined();

    await manager.shutdownTasks({ cancelHanging: true });
  });

  it('unregisters routes via convenience helpers', async () => {
    const store = createRouteStore();
    const manager = new RouteManager({
      deliver: jest.fn(),
      routeStore: store,
      cleanupDelayMs: 0,
    });
    const downstream = createConnectorStub();
    const peer = createConnectorStub();

    await manager.registerDownstreamRoute('down', downstream);
    await manager.registerPeerRoute('peer', peer);

    await manager.unregisterDownstreamRoute('down');
    await manager.unregisterPeerRoute('peer');

    expect(manager.downstreamRoutes.has('down')).toBe(false);
    expect(manager._peer_routes.has('peer')).toBe(false);

    await manager.shutdownTasks({ cancelHanging: true });
  });

  it('logs fatal restore failures for non-transient errors', async () => {
    const entries: Record<string, RouteEntry> = {
      'fatal-route': {
        connectorConfig: { type: 'ws' } as any,
      },
    };
    const store = createRouteStore(entries);
    const manager = new RouteManager({
      deliver: jest.fn(),
      routeStore: store,
      getId: () => 'rm',
    });
    const { ConnectorFactory } = createConnectorModule();
    ConnectorFactory.createConnector?.mockRejectedValue(new Error('fatal'));

    await manager.restoreRoutes();

    expect(loggerMock.error).toHaveBeenCalledWith(
      'failed_to_restore_route',
      expect.objectContaining({ segment: 'fatal-route', error: 'fatal' })
    );

    await manager.shutdownTasks({ cancelHanging: true });
  });

  it('skips non-expired routes while scanning store', async () => {
    const store = createRouteStore({
      active: {
        connectorConfig: { type: 'ws' } as any,
        attachExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });

    const manager = new RouteManager({ deliver: jest.fn(), routeStore: store });

    await (
      manager as unknown as {
        scanStoreForExpirations: (
          store: RouteStore,
          now: Date,
          kind: 'downstream'
        ) => Promise<void>;
      }
    ).scanStoreForExpirations(store, new Date(), 'downstream');

    expect(store.delete).not.toHaveBeenCalled();

    await manager.shutdownTasks({ cancelHanging: true });
  });

  it('processes janitor loop iterations until aborted', async () => {
    jest.useFakeTimers();
    const manager = new RouteManager({
      deliver: jest.fn(),
      routeStore: createRouteStore(),
    });
    const scanSpy = jest
      .spyOn(
        manager as unknown as {
          scanStoreForExpirations: (...args: unknown[]) => Promise<void>;
        },
        'scanStoreForExpirations'
      )
      .mockResolvedValue(undefined);

    try {
      const loopPromise = (
        manager as unknown as { janitorLoop: () => Promise<void> }
      ).janitorLoop();
      await flushAllTimers();

      expect(scanSpy).toHaveBeenCalledWith(
        manager._downstream_route_store,
        expect.any(Date),
        'downstream'
      );
      expect(scanSpy).toHaveBeenCalledWith(
        manager._peer_route_store,
        expect.any(Date),
        'peer'
      );

      (
        manager as unknown as { stopController: AbortController }
      ).stopController.abort();
      await jest.advanceTimersByTimeAsync(0);
      await loopPromise;

      expect(loggerMock.debug).toHaveBeenCalledWith('janitor_loop_exited');
    } finally {
      scanSpy.mockRestore();
      jest.useRealTimers();
      await manager.shutdownTasks({ cancelHanging: true });
    }
  });

  it('handles cleanup when task signal states vary', async () => {
    const manager = new RouteManager({
      deliver: jest.fn(),
      routeStore: createRouteStore(),
      cleanupDelayMs: 10,
    });
    const connector = createConnectorStub();

    let captured: ((signal?: AbortSignal) => Promise<void>) | undefined;
    const spawnSpy = jest
      .spyOn(manager as unknown as { spawn: RouteManager['spawn'] }, 'spawn')
      .mockImplementation((task) => {
        captured = task as (signal?: AbortSignal) => Promise<void>;
        return { id: 'test-task' } as unknown as ReturnType<
          RouteManager['spawn']
        >;
      });

    await (
      manager as unknown as {
        cleanupConnector: (
          segment: string,
          connector: FameConnector,
          delayMs: number
        ) => Promise<void>;
      }
    ).cleanupConnector('segment', connector, 10);

    expect(captured).toBeDefined();

    delayMock.mockImplementationOnce(async () => undefined);
    await captured?.(undefined);

    delayMock.mockImplementationOnce(async (_ms, signal?: AbortSignal) => {
      expect(signal?.aborted).toBe(true);
      throw new Error('aborted');
    });
    const abortedSignal = {
      aborted: true,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    } as unknown as AbortSignal;

    await captured?.(abortedSignal);

    expect(loggerMock.debug).toHaveBeenCalledWith(
      'connector_cleanup_cancelled',
      {
        segment: 'segment',
      }
    );
    expect(
      (
        manager as unknown as {
          pendingCleanupControllers: Map<string, AbortController>;
        }
      ).pendingCleanupControllers.has('segment')
    ).toBe(false);

    spawnSpy.mockRestore();
    await manager.shutdownTasks({ cancelHanging: true });
  });

  it('parses authorization metadata edge cases for helper coverage', () => {
    const manager = new RouteManager({
      deliver: jest.fn(),
      routeStore: createRouteStore(),
    });

    const metadata = {
      authenticated: true,
      authorized: true,
      acceptedCapabilities: [123],
      acceptedLogicals: [],
      scopes: ['scope', 123],
      attachExpiresAt: {},
    } as unknown as Record<string, unknown>;

    const parsed = (
      manager as unknown as {
        parseAuthorization: (
          metadata: Record<string, unknown> | null
        ) => unknown;
      }
    ).parseAuthorization(metadata) as Record<string, unknown> | null;

    const parsedAny = parsed as unknown as {
      acceptedCapabilities?: unknown;
      acceptedLogicals?: unknown;
      scopes?: unknown;
      attachExpiresAt?: unknown;
    } | null;

    expect(parsedAny?.acceptedCapabilities).toBeUndefined();
    expect(parsedAny?.acceptedLogicals).toBeUndefined();
    expect(parsedAny?.scopes).toEqual(['scope']);
    expect(parsedAny?.attachExpiresAt).toBeUndefined();

    return manager.shutdownTasks({ cancelHanging: true });
  });

  it('restores routes without expiration and avoids zero-delay scheduling', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2024-01-01T00:00:00Z'));

    const store = createRouteStore({
      'no-expire': {
        connectorConfig: { type: 'ws' } as any,
      },
      'zero-delay': {
        connectorConfig: { type: 'ws' } as any,
        attachExpiresAt: new Date('2024-01-01T00:00:00Z').toISOString(),
      },
    });

    const deliver = jest.fn(async () => undefined);
    const manager = new RouteManager({
      deliver,
      routeStore: store,
      getId: () => 'rm',
    });
    const { ConnectorFactory } = createConnectorModule();

    ConnectorFactory.createConnector
      ?.mockResolvedValueOnce(createConnectorStub())
      .mockResolvedValueOnce(createConnectorStub());

    const spawnSpy = jest.spyOn(
      manager as unknown as { spawn: RouteManager['spawn'] },
      'spawn'
    );

    try {
      await manager.restoreRoutes();

      expect(manager.downstreamRoutes.has('no-expire')).toBe(true);
      expect(manager.downstreamRoutes.has('zero-delay')).toBe(true);

      const noExpireConnector = manager.downstreamRoutes.get(
        'no-expire'
      ) as FameConnector;
      const handler = (noExpireConnector.start as jest.Mock).mock.calls[0][0];

      const envelope = { frame: { type: 'Data' } } as FameEnvelope;
      await handler(envelope);

      expect(deliver).toHaveBeenCalledWith(
        envelope,
        expect.objectContaining({
          security: undefined,
          fromSystemId: 'no-expire',
        })
      );
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      spawnSpy.mockRestore();
      jest.useRealTimers();
      await manager.shutdownTasks({ cancelHanging: true });
    }
  });

  it('logs restore failures with non-error values', async () => {
    const store = createRouteStore({
      flaky: {
        connectorConfig: { type: 'ws' } as any,
      },
    });

    const manager = new RouteManager({
      deliver: jest.fn(),
      routeStore: store,
      getId: () => 'rm',
    });
    const { ConnectorFactory } = createConnectorModule();

    const transientSpy = jest
      .spyOn(
        manager as unknown as { isTransientError: (error: unknown) => boolean },
        'isTransientError'
      )
      .mockImplementation((error) => error === 'temporary-string');

    ConnectorFactory.createConnector?.mockImplementationOnce(async () => {
      throw 'temporary-string';
    });
    ConnectorFactory.createConnector?.mockImplementationOnce(async () => {
      throw 'fatal-string';
    });

    delayMock.mockResolvedValue(undefined);

    await manager.restoreRoutes();

    expect(loggerMock.warning).toHaveBeenCalledWith(
      'transient_restore_failure',
      expect.objectContaining({ error: 'temporary-string' })
    );
    expect(loggerMock.error).toHaveBeenCalledWith(
      'failed_to_restore_route',
      expect.objectContaining({ error: 'fatal-string' })
    );

    transientSpy.mockRestore();
    await manager.shutdownTasks({ cancelHanging: true });
  });

  it('purges references when expiring routes without connectors', async () => {
    const store = createRouteStore();
    const manager = new RouteManager({ deliver: jest.fn(), routeStore: store });

    const downstream = manager._downstream_addresses_routes as Map<
      string,
      AddressRouteInfo
    >;
    downstream.set('match', { segment: 'target' } as AddressRouteInfo);
    downstream.set('other', { segment: 'other' } as AddressRouteInfo);
    const legacy = manager._downstream_addresses_legacy as Map<
      string,
      AddressRouteInfo
    >;
    legacy.set('legacy-match', { segment: 'target' } as AddressRouteInfo);
    legacy.set('legacy-other', { segment: 'legacy-other' } as AddressRouteInfo);
    manager._peer_addresses_routes.set('peer-match', 'target');
    manager._peer_addresses_routes.set('peer-other', 'different');
    manager._pools.set('pool', new Set(['target', 'other']));

    (store.delete as jest.Mock).mockRejectedValueOnce('delete-failed');

    await (
      manager as unknown as {
        expireRouteLater: (segment: string, delayMs: number) => Promise<void>;
      }
    ).expireRouteLater('target', 0);

    expect(store.delete).toHaveBeenCalledWith('target');
    expect(loggerMock.warning).toHaveBeenCalledWith(
      'route_expiration_delete_failed',
      expect.objectContaining({ segment: 'target', error: 'delete-failed' })
    );
    expect(downstream.has('match')).toBe(false);
    expect(downstream.has('other')).toBe(true);
    expect(legacy.has('legacy-match')).toBe(false);
    expect(legacy.has('legacy-other')).toBe(true);
    expect(manager._peer_addresses_routes.has('peer-match')).toBe(false);
    expect(manager._peer_addresses_routes.has('peer-other')).toBe(true);
    expect(manager._pools.get('pool')?.has('other')).toBe(true);

    await manager.shutdownTasks({ cancelHanging: true });
  });

  it('handles cleanup delay rejections with non-error reasons', async () => {
    const manager = new RouteManager({
      deliver: jest.fn(),
      routeStore: createRouteStore(),
      cleanupDelayMs: 10,
    });
    const connector = createConnectorStub();

    let captured: ((signal?: AbortSignal) => Promise<void>) | undefined;
    const spawnSpy = jest
      .spyOn(manager as unknown as { spawn: RouteManager['spawn'] }, 'spawn')
      .mockImplementation((task, options) => {
        captured = task as (signal?: AbortSignal) => Promise<void>;
        return { id: options?.name ?? 'task' } as unknown as ReturnType<
          RouteManager['spawn']
        >;
      });

    await (
      manager as unknown as {
        cleanupConnector: (
          segment: string,
          connector: FameConnector,
          delayMs: number
        ) => Promise<void>;
      }
    ).cleanupConnector('segment', connector, 10);

    delayMock.mockImplementationOnce(async () => {
      throw 'delay-string';
    });

    await captured?.(undefined);

    expect(loggerMock.debug).toHaveBeenCalledWith(
      'connector_cleanup_delay_failed',
      expect.objectContaining({ segment: 'segment', error: 'delay-string' })
    );
    expect(connector.stop).not.toHaveBeenCalled();

    spawnSpy.mockRestore();
    await manager.shutdownTasks({ cancelHanging: true });
  });

  it('ignores non-error stop failures during safeStop', async () => {
    const manager = new RouteManager({
      deliver: jest.fn(),
      routeStore: createRouteStore(),
    });
    const connector = createConnectorStub();
    (connector.stop as jest.Mock).mockImplementationOnce(async () => {
      throw 'stop-fail';
    });

    loggerMock.debug.mockClear();
    manager.trackFlowRoute('flow', connector);

    await (
      manager as unknown as { safeStop: (conn: FameConnector) => Promise<void> }
    ).safeStop(connector);

    expect(loggerMock.debug).not.toHaveBeenCalledWith(
      'connector_stop_ignored',
      expect.objectContaining({ error: expect.any(String) })
    );
    expect(manager.getFlowRoute('flow')).toBeUndefined();

    await manager.shutdownTasks({ cancelHanging: true });
  });

  it('handles missing connectors during expiration scanning', async () => {
    const store = createRouteStore({
      ghost: {
        connectorConfig: { type: 'ws' } as any,
        attachExpiresAt: new Date(Date.now() - 1).toISOString(),
      },
    });

    const manager = new RouteManager({ deliver: jest.fn(), routeStore: store });
    (store.delete as jest.Mock).mockRejectedValueOnce('remove-failed');

    await (
      manager as unknown as {
        scanStoreForExpirations: (
          store: RouteStore,
          now: Date,
          kind: 'downstream' | 'peer'
        ) => Promise<void>;
      }
    ).scanStoreForExpirations(store, new Date(), 'downstream');

    expect(store.delete).toHaveBeenCalledWith('ghost');
    expect(loggerMock.warning).toHaveBeenCalledWith(
      'route_auto_expire_delete_failed',
      expect.objectContaining({ segment: 'ghost', error: 'remove-failed' })
    );

    await manager.shutdownTasks({ cancelHanging: true });
  });

  it('parses legacy authorization metadata variants', () => {
    const manager = new RouteManager({
      deliver: jest.fn(),
      routeStore: createRouteStore(),
    });

    const legacyMetadata = {
      authenticated: true,
      authorized: true,
      sub: '',
      aud: undefined,
      accepted_capabilities: ['cap-1', 42],
      accepted_logicals: 'not-an-array',
      scopes: 'scope-string',
      instance_id: 'inst-1',
      assigned_path: '/legacy',
      attach_expires_at: new Date('invalid'),
    } as unknown as Record<string, unknown>;

    const parsed = (
      manager as unknown as {
        parseAuthorization: (
          metadata: Record<string, unknown> | null
        ) => unknown;
      }
    ).parseAuthorization(legacyMetadata) as Record<string, unknown> | null;

    expect(parsed?.sub).toBeUndefined();
    expect(parsed?.aud).toBeUndefined();
    expect(parsed?.assignedPath).toBe('/legacy');
    expect(parsed?.acceptedCapabilities).toEqual(['cap-1']);
    expect(parsed?.acceptedLogicals).toBeUndefined();
    expect(parsed?.scopes).toBeUndefined();
    expect(parsed?.attachExpiresAt).toBeUndefined();

    const numericExpiryMetadata = {
      ...legacyMetadata,
      accepted_capabilities: ['cap-a'],
      accepted_logicals: ['one'],
      scopes: ['s'],
      attach_expires_at: Date.now(),
    } as unknown as Record<string, unknown>;

    const parsedNumeric = (
      manager as unknown as {
        parseAuthorization: (
          metadata: Record<string, unknown> | null
        ) => unknown;
      }
    ).parseAuthorization(numericExpiryMetadata) as Record<
      string,
      unknown
    > | null;

    expect(parsedNumeric?.attachExpiresAt).toBeInstanceOf(Date);

    const dateObjectMetadata = {
      ...numericExpiryMetadata,
      attach_expires_at: new Date('2024-01-01T00:00:00Z'),
    } as unknown as Record<string, unknown>;

    const parsedDate = (
      manager as unknown as {
        parseAuthorization: (
          metadata: Record<string, unknown> | null
        ) => unknown;
      }
    ).parseAuthorization(dateObjectMetadata) as Record<string, unknown> | null;

    expect(parsedDate?.attachExpiresAt).toBeInstanceOf(Date);

    return manager.shutdownTasks({ cancelHanging: true });
  });

  it('logs pending route stop failures with non-error reasons', async () => {
    const manager = new RouteManager({
      deliver: jest.fn(),
      routeStore: createRouteStore(),
    });
    const connector = createConnectorStub();

    (
      manager as unknown as {
        _pending_routes: Map<
          string,
          {
            connector: FameConnector;
            attached: { set(): void };
            buffer: FameEnvelope[];
            cancelAttachTimeout?: () => void;
          }
        >;
      }
    )._pending_routes.set('pending', {
      connector,
      attached: { set: jest.fn() },
      buffer: [],
      cancelAttachTimeout: jest.fn(),
    });

    const safeStopSpy = jest
      .spyOn(
        manager as unknown as {
          safeStop: (conn: FameConnector) => Promise<void>;
        },
        'safeStop'
      )
      .mockRejectedValueOnce('string-error');

    await manager.stop();

    expect(loggerMock.debug).toHaveBeenCalledWith(
      'pending_route_stop_failed',
      expect.objectContaining({ error: 'string-error' })
    );

    safeStopSpy.mockRestore();
    await manager.shutdownTasks({ cancelHanging: true });
  });
});
