import {
  DeliveryOriginType,
  FameAddress,
  FameResponseType,
  type Binding,
  type FameDeliveryContext,
  type FameEnvelope,
  type KeyAnnounceFrame,
  type KeyRequestFrame,
  type ReadWriteChannel,
} from 'naylence-core';

import { KeyFrameHandler } from '../key-frame-handler.js';
import type { RoutingNodeLike } from '../../node/routing-node-like.js';
import type { BindingManager } from '../../node/binding-manager.js';
import type { KeyManager } from '../../security/keys/key-manager.js';
import type { KeyRecord } from '../../security/keys/key-store.js';
import type { KeyCorrelationMap } from '../key-correlation-map.js';
import { Binding as CoreBinding } from 'naylence-core';

jest.mock('../../util/logging.js', () => {
  const logger = {
    debug: jest.fn(),
    warning: jest.fn(),
    trace: jest.fn(),
  };
  return {
    getLogger: () => logger,
    __loggerMock: logger,
  };
});

type LoggerMock = {
  debug: jest.Mock;
  warning: jest.Mock;
  trace: jest.Mock;
};

const { __loggerMock: loggerMock } = jest.requireMock(
  '../../util/logging.js'
) as {
  __loggerMock: LoggerMock;
};

function createRoutingNode(
  overrides: Partial<RoutingNodeLike & { forwardToRoute?: any }> = {}
) {
  const envelopeFactory = {
    createEnvelope: jest.fn(
      (options: any) =>
        ({
          id: options.id ?? 'env-' + Math.random().toString(16).slice(2),
          version: '1.0',
          ts: new Date(),
          frame: options.frame,
          corrId: options.corrId,
          traceId: options.traceId,
          flowId: options.flowId,
          replyTo: options.replyTo,
        }) as FameEnvelope
    ),
  };

  return {
    physicalPath: '/local/node',
    envelopeFactory,
    forwardToRoute: jest.fn(async () => undefined),
    ...overrides,
  } as unknown as RoutingNodeLike & {
    envelopeFactory: { createEnvelope: jest.Mock };
  };
}

function createBindingManager(overrides: Partial<BindingManager> = {}) {
  const getBinding = jest.fn<Binding | undefined, [FameAddress | string]>(
    () => undefined
  );
  return {
    getBinding,
    ...overrides,
  } as unknown as BindingManager & { getBinding: typeof getBinding };
}

function createKeyManager(overrides: Partial<KeyManager> = {}) {
  return {
    getKeysForPath: jest.fn(async () => [] as Iterable<KeyRecord>),
    handleKeyRequest: jest.fn(async () => undefined),
    ...overrides,
  } as unknown as KeyManager & {
    getKeysForPath: jest.Mock<Promise<Iterable<KeyRecord>>, [string]>;
    handleKeyRequest: jest.Mock<Promise<void>, [any]>;
  };
}

function createCorrelationMap(overrides: Partial<KeyCorrelationMap> = {}) {
  return {
    runCleanup: jest.fn(async () => undefined),
    pop: jest.fn(() => null),
    add: jest.fn(),
    ...overrides,
  } as unknown as KeyCorrelationMap & {
    runCleanup: jest.Mock<Promise<void>, [any]>;
    pop: jest.Mock<string | null, [string]>;
    add: jest.Mock<void, [string, string]>;
  };
}

function createContext(
  overrides: Partial<FameDeliveryContext> = {}
): FameDeliveryContext {
  const base: FameDeliveryContext = {
    originType: DeliveryOriginType.DOWNSTREAM,
    fromSystemId: 'child-segment',
    expectedResponseType: FameResponseType.NONE,
  };

  return {
    ...base,
    ...overrides,
  } as FameDeliveryContext;
}

function createEnvelope(
  frame: FameEnvelope['frame'],
  overrides: Partial<FameEnvelope> = {}
): FameEnvelope {
  return {
    id: overrides.id ?? 'env-1',
    version: overrides.version ?? '1.0',
    ts: overrides.ts ?? new Date(),
    frame,
    ...overrides,
  } as FameEnvelope;
}

function makeKeyAnnounceFrame(
  overrides: Partial<KeyAnnounceFrame> = {}
): KeyAnnounceFrame {
  const base: KeyAnnounceFrame = {
    type: 'KeyAnnounce',
    physicalPath: '/origin/path',
    keys: overrides.keys ?? [{ kid: 'kid-default' }],
    created: overrides.created ?? new Date().toISOString(),
  };

  const frame = {
    ...base,
    ...overrides,
  };

  return frame as KeyAnnounceFrame;
}

function createBinding(address = 'svc@/local'): Binding {
  const channel: ReadWriteChannel = {
    receive: async () => null,
    acknowledge: async () => undefined,
    send: async () => undefined,
  };
  return new CoreBinding(channel, new FameAddress(address));
}

describe('KeyFrameHandler', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('starts cleanup task only once', async () => {
    const correlationMap = createCorrelationMap();
    const routingNode = createRoutingNode();
    const handler = new KeyFrameHandler({
      routingNode,
      routeManager: null,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: jest.fn(),
      keyManager: createKeyManager(),
      correlationMap,
    });

    const spawn = jest.fn((task: () => Promise<void>) => task());

    await handler.start(spawn);
    await handler.start(spawn);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(correlationMap.runCleanup).toHaveBeenCalledTimes(1);
  });

  it('treats sync spawn result as completed cleanup', async () => {
    const correlationMap = createCorrelationMap();
    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode(),
      routeManager: null,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: jest.fn(),
      keyManager: createKeyManager(),
      correlationMap,
    });

    const spawn = jest.fn(() => 'done');

    await handler.start(spawn);
    await handler.stop();

    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('returns early from stop when cleanup not started', async () => {
    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode(),
      routeManager: null,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: jest.fn(),
      keyManager: createKeyManager(),
      correlationMap: createCorrelationMap(),
    });

    await handler.stop();

    expect(loggerMock.warning).not.toHaveBeenCalled();
  });

  it('stops cleanup task and swallows abort errors', async () => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';

    const correlationMap = createCorrelationMap({
      runCleanup: jest.fn(async ({ signal }: { signal: AbortSignal }) => {
        await new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(abortError));
        });
      }),
    });

    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode(),
      routeManager: null,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: jest.fn(),
      keyManager: createKeyManager(),
      correlationMap,
    });

    const spawn = jest.fn((task: () => Promise<void>) => task());

    await handler.start(spawn);
    await handler.stop();

    expect(correlationMap.runCleanup).toHaveBeenCalled();
    expect(loggerMock.warning).not.toHaveBeenCalled();
  });

  it('logs warning when cleanup fails for non-abort reason', async () => {
    const correlationMap = createCorrelationMap({
      runCleanup: jest.fn(async () => {
        throw 'boom';
      }),
    });

    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode(),
      routeManager: null,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: jest.fn(),
      keyManager: createKeyManager(),
      correlationMap,
    });

    const spawn = jest.fn((task: () => Promise<void>) => task());

    await handler.start(spawn);
    await handler.stop();

    expect(loggerMock.warning).toHaveBeenCalledWith(
      'key_corr_cleanup_stop_error',
      expect.any(Object)
    );
  });

  it('routes key announce frames back to original requester when correlation matches', async () => {
    const forwardToRoute = jest.fn(async () => undefined);
    const routingNode = createRoutingNode({ forwardToRoute });
    const correlationMap = createCorrelationMap({
      pop: jest.fn(() => 'route-123'),
    });
    const acceptParent = jest.fn();

    const handler = new KeyFrameHandler({
      routingNode,
      routeManager: null,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: acceptParent,
      keyManager: createKeyManager(),
      correlationMap,
    });

    const frame = makeKeyAnnounceFrame({ address: 'svc@/path' });
    const envelope = createEnvelope(frame, {
      corrId: 'corr-1',
      replyTo: 'reply',
      traceId: 'trace',
      flowId: 'flow-1',
    });
    const context = createContext({
      originType: DeliveryOriginType.DOWNSTREAM,
    });

    await handler.acceptKeyAnnounce(envelope, context);

    expect(forwardToRoute).toHaveBeenCalledWith(
      'route-123',
      expect.objectContaining({ frame }),
      context
    );
    expect(acceptParent).not.toHaveBeenCalled();
  });

  it('throws when key announce is missing delivery context', async () => {
    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode(),
      routeManager: null,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: jest.fn(),
      keyManager: createKeyManager(),
      correlationMap: createCorrelationMap(),
    });

    const envelope = createEnvelope(makeKeyAnnounceFrame(), {
      id: 'env-missing',
    });

    await expect(handler.acceptKeyAnnounce(envelope)).rejects.toThrow(
      /delivery context/
    );
  });

  it('rejects key announce from unknown origin', async () => {
    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode(),
      routeManager: {
        downstreamRoutes: new Map<string, unknown>(),
        _peer_routes: new Map<string, unknown>(),
      } as any,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: jest.fn(),
      keyManager: createKeyManager(),
      correlationMap: createCorrelationMap({ pop: jest.fn(() => null) }),
    });

    const frame = makeKeyAnnounceFrame();
    const envelope = createEnvelope(frame, { corrId: 'corr-2' });
    const context = createContext({
      originType: DeliveryOriginType.PEER,
      fromSystemId: 'peer-1',
    });

    await expect(handler.acceptKeyAnnounce(envelope, context)).rejects.toThrow(
      /Cannot accept key announce from unknown/i
    );
  });

  it('warns and skips when frame is not a key announce', async () => {
    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode(),
      routeManager: null,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: jest.fn(),
      keyManager: createKeyManager(),
      correlationMap: createCorrelationMap(),
    });

    const envelope = createEnvelope({ type: 'Data' } as FameEnvelope['frame'], {
      id: 'env-warn',
    });
    const context = createContext();

    await handler.acceptKeyAnnounce(envelope, context);

    expect(loggerMock.warning).toHaveBeenCalledWith(
      'unexpected_frame_type_for_key_announce',
      expect.objectContaining({ envp_id: 'env-warn', frame_type: 'Data' })
    );
  });

  it('throws when routing node cannot forward correlated announce', async () => {
    const routingNode = createRoutingNode({ forwardToRoute: undefined });
    const handler = new KeyFrameHandler({
      routingNode,
      routeManager: null,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: jest.fn(),
      keyManager: createKeyManager(),
      correlationMap: createCorrelationMap({ pop: jest.fn(() => 'route-789') }),
    });

    const envelope = createEnvelope(makeKeyAnnounceFrame(), {
      corrId: 'corr-missing',
      id: 'env',
    });
    const context = createContext();

    await expect(handler.acceptKeyAnnounce(envelope, context)).rejects.toThrow(
      /does not support forwardToRoute/
    );
  });

  it('delegates key announce handling to parent when origin is known', async () => {
    const acceptParent = jest.fn(async () => undefined);
    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode(),
      routeManager: {
        _peer_routes: new Map<string, unknown>([['peer-1', {}]]),
      } as any,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: acceptParent,
      keyManager: createKeyManager(),
      correlationMap: createCorrelationMap(),
    });

    const frame = makeKeyAnnounceFrame();
    const envelope = createEnvelope(frame);
    const context = createContext({
      originType: DeliveryOriginType.PEER,
      fromSystemId: 'peer-1',
    });

    await handler.acceptKeyAnnounce(envelope, context);

    expect(acceptParent).toHaveBeenCalledWith(envelope, context);
  });

  it('delegates downstream key announce when route container is a record', async () => {
    const acceptParent = jest.fn(async () => undefined);
    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode(),
      routeManager: {
        downstreamRoutes: { 'child-segment': {} },
      } as any,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: acceptParent,
      keyManager: createKeyManager(),
      correlationMap: createCorrelationMap(),
    });

    const envelope = createEnvelope(makeKeyAnnounceFrame(), {
      id: 'env-downstream',
    });
    const context = createContext({
      originType: DeliveryOriginType.DOWNSTREAM,
      fromSystemId: 'child-segment',
    });

    await handler.acceptKeyAnnounce(envelope, context);

    expect(acceptParent).toHaveBeenCalledWith(envelope, context);
  });

  it('throws when downstream origin lacks configured routes', async () => {
    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode(),
      routeManager: null,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: jest.fn(),
      keyManager: createKeyManager(),
      correlationMap: createCorrelationMap(),
    });

    const envelope = createEnvelope(makeKeyAnnounceFrame(), {
      id: 'env-no-route',
    });
    const context = createContext({
      originType: DeliveryOriginType.DOWNSTREAM,
      fromSystemId: 'child-segment',
    });

    await expect(handler.acceptKeyAnnounce(envelope, context)).rejects.toThrow(
      /unknown downstream system/i
    );
  });

  it('throws when downstream origin lacks system id', async () => {
    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode(),
      routeManager: {
        downstreamRoutes: new Map<string, unknown>([['child-segment', {}]]),
      } as any,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: jest.fn(),
      keyManager: createKeyManager(),
      correlationMap: createCorrelationMap(),
    });

    const envelope = createEnvelope(makeKeyAnnounceFrame(), {
      id: 'env-no-id',
    });
    const context = createContext({ fromSystemId: undefined });

    await expect(handler.acceptKeyAnnounce(envelope, context)).rejects.toThrow(
      /unknown downstream system/i
    );
  });

  it('delegates key announce from upstream origin', async () => {
    const acceptParent = jest.fn(async () => undefined);
    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode(),
      routeManager: null,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: acceptParent,
      keyManager: createKeyManager(),
      correlationMap: createCorrelationMap(),
    });

    const envelope = createEnvelope(makeKeyAnnounceFrame(), {
      id: 'env-upstream',
    });
    const context = createContext({
      originType: DeliveryOriginType.UPSTREAM,
      fromSystemId: 'root-node',
    });

    await handler.acceptKeyAnnounce(envelope, context);

    expect(acceptParent).toHaveBeenCalledWith(envelope, context);
  });

  it('throws when key request lacks context', async () => {
    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode(),
      routeManager: null,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: jest.fn(),
      keyManager: createKeyManager(),
      correlationMap: createCorrelationMap(),
    });

    const envelope = createEnvelope({ type: 'KeyRequest' } as KeyRequestFrame);

    await expect(handler.acceptKeyRequest(envelope)).rejects.toThrow(
      /originType/
    );
  });

  it('throws when key manager is missing for key request', async () => {
    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode(),
      routeManager: null,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: jest.fn(),
    });

    const context = createContext();
    const envelope = createEnvelope({ type: 'KeyRequest' } as KeyRequestFrame);

    await expect(handler.acceptKeyRequest(envelope, context)).rejects.toThrow(
      /KeyManager must be set/
    );
  });

  it('throws when key manager is explicitly null for key request', async () => {
    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode(),
      routeManager: null,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: jest.fn(),
      keyManager: null,
    });

    const context = createContext();
    const envelope = createEnvelope({ type: 'KeyRequest' } as KeyRequestFrame);

    await expect(handler.acceptKeyRequest(envelope, context)).rejects.toThrow(
      /KeyManager must be set/
    );
  });

  it('throws when key request frame type is unexpected', async () => {
    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode(),
      routeManager: null,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: jest.fn(),
      keyManager: createKeyManager(),
      correlationMap: createCorrelationMap(),
    });

    const context = createContext();
    const envelope = createEnvelope({ type: 'NotAKeyRequest' } as any);

    await expect(handler.acceptKeyRequest(envelope, context)).rejects.toThrow(
      /only handles KeyRequest frames/
    );
  });

  it('throws when key request lacks origin system id', async () => {
    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode(),
      routeManager: null,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: jest.fn(),
      keyManager: createKeyManager(),
      correlationMap: createCorrelationMap(),
    });

    const frame: KeyRequestFrame = {
      type: 'KeyRequest',
      kid: 'kid-3',
    } as KeyRequestFrame;
    const envelope = createEnvelope(frame);
    const context = createContext({ fromSystemId: undefined });

    await expect(handler.acceptKeyRequest(envelope, context)).rejects.toThrow(
      /Missing origin system id/
    );
  });

  it('throws when key request lacks kid and address', async () => {
    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode(),
      routeManager: null,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: jest.fn(),
      keyManager: createKeyManager(),
      correlationMap: createCorrelationMap(),
    });

    const frame: KeyRequestFrame = { type: 'KeyRequest' } as KeyRequestFrame;
    const envelope = createEnvelope(frame);
    const context = createContext();

    await expect(handler.acceptKeyRequest(envelope, context)).rejects.toThrow(
      /must include either kid or address/
    );
  });

  it('stores correlation and delegates when route segment exists for address', async () => {
    const correlationMap = createCorrelationMap();
    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode(),
      routeManager: {
        _downstream_addresses_routes: {
          'svc@/remote': { segment: 'route-42' },
        },
      } as any,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: jest.fn(),
      keyManager: createKeyManager({ handleKeyRequest: jest.fn() }),
      correlationMap,
    });

    const frame: KeyRequestFrame = {
      type: 'KeyRequest',
      address: 'svc@/remote',
    } as KeyRequestFrame;
    const envelope = createEnvelope(frame, { corrId: 'corr-route' });
    const context = createContext();

    const result = await handler.acceptKeyRequest(envelope, context);

    expect(result).toBe(false);
    expect(correlationMap.add).toHaveBeenCalledWith(
      'corr-route',
      'child-segment'
    );
  });

  it('returns false when peer route mapping exists via record', async () => {
    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode(),
      routeManager: {
        _peer_addresses_routes: { 'svc@/peer-route': 'peer-segment' },
      } as any,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: jest.fn(),
      keyManager: createKeyManager(),
      correlationMap: createCorrelationMap(),
    });

    const frame: KeyRequestFrame = {
      type: 'KeyRequest',
      address: 'svc@/peer-route',
    } as KeyRequestFrame;
    const envelope = createEnvelope(frame);
    const context = createContext({
      originType: DeliveryOriginType.PEER,
      fromSystemId: 'peer-segment',
    });

    const handled = await handler.acceptKeyRequest(envelope, context);

    expect(handled).toBe(false);
  });

  it('returns false when peer route mapping exists via map', async () => {
    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode(),
      routeManager: {
        _peer_addresses_routes: new Map<string, string>([
          ['svc@/peer-map', 'peer-segment'],
        ]),
      } as any,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: jest.fn(),
      keyManager: createKeyManager(),
      correlationMap: createCorrelationMap(),
    });

    const frame: KeyRequestFrame = {
      type: 'KeyRequest',
      address: 'svc@/peer-map',
    } as KeyRequestFrame;
    const envelope = createEnvelope(frame);
    const context = createContext({
      originType: DeliveryOriginType.PEER,
      fromSystemId: 'peer-segment',
    });

    const handled = await handler.acceptKeyRequest(envelope, context);

    expect(handled).toBe(false);
  });

  it('handles key request locally using binding when encryption keys exist', async () => {
    const keyManager = createKeyManager({
      getKeysForPath: jest.fn(
        async () => [{ kid: 'kid-local', use: 'enc' }] as KeyRecord[]
      ),
    });

    const bindingManager = createBindingManager({
      getBinding: jest.fn(() => createBinding('svc@/local')),
    });

    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode({ physicalPath: '/local/node' }),
      routeManager: null,
      bindingManager,
      acceptKeyAnnounceParent: jest.fn(),
      keyManager,
      correlationMap: createCorrelationMap(),
    });

    const frame: KeyRequestFrame = {
      type: 'KeyRequest',
      address: 'svc@/local',
    } as KeyRequestFrame;
    const envelope = createEnvelope(frame, {
      corrId: 'corr-local',
      sid: 'sid-123',
    });
    const context = createContext();

    const handled = await handler.acceptKeyRequest(envelope, context);

    expect(handled).toBe(true);
    expect(context.stickinessRequired).toBe(true);
    expect(context.stickySid).toBe('sid-123');
    expect(keyManager.handleKeyRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        kid: 'kid-local',
        fromSegment: 'child-segment',
      })
    );
  });

  it('logs when local binding key lookup fails', async () => {
    const keyManager = createKeyManager({
      getKeysForPath: jest.fn(async (path: string) => {
        if (path === '/local/node') {
          throw 'lookup failed';
        }
        return [] as KeyRecord[];
      }),
    });

    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode({ physicalPath: '/local/node' }),
      routeManager: null,
      bindingManager: createBindingManager({
        getBinding: jest.fn(() => createBinding('svc@/local-bind')),
      }),
      acceptKeyAnnounceParent: jest.fn(),
      keyManager,
      correlationMap: createCorrelationMap(),
    });

    const frame: KeyRequestFrame = {
      type: 'KeyRequest',
      address: 'svc@/local-bind',
    } as KeyRequestFrame;
    const envelope = createEnvelope(frame);
    const context = createContext();

    const handled = await handler.acceptKeyRequest(envelope, context);

    expect(handled).toBe(false);
    expect(loggerMock.trace).toHaveBeenCalledWith(
      'key_lookup_for_local_binding_failed',
      expect.objectContaining({ path: '/local/node' })
    );
  });

  it('ignores local binding keys without string kid and falls back', async () => {
    const keyManager = createKeyManager({
      getKeysForPath: jest.fn(async (path: string) => {
        if (path === '/local/node') {
          return [
            { kid: 12345 as unknown as string, use: 'enc' },
          ] as unknown as KeyRecord[];
        }
        if (path === '/local-fallback') {
          return [
            { kid: 'kid-fallback', use: 'enc' },
          ] as unknown as KeyRecord[];
        }
        return [] as KeyRecord[];
      }),
    });

    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode({ physicalPath: '/local/node' }),
      routeManager: null,
      bindingManager: createBindingManager({
        getBinding: jest.fn(() => createBinding('svc@/local-fallback')),
      }),
      acceptKeyAnnounceParent: jest.fn(),
      keyManager,
      correlationMap: createCorrelationMap(),
    });

    const frame: KeyRequestFrame = {
      type: 'KeyRequest',
      address: 'svc@/local-fallback',
    } as KeyRequestFrame;
    const envelope = createEnvelope(frame, {
      corrId: 'corr-fallback',
      sid: 'sid-fallback',
    });
    const context = createContext();

    const handled = await handler.acceptKeyRequest(envelope, context);

    expect(handled).toBe(true);
    expect(keyManager.handleKeyRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        kid: 'kid-fallback',
        physicalPath: '/local-fallback',
      })
    );
  });

  it('handles key request using route metadata encryption key id', async () => {
    const keyManager = createKeyManager();

    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode(),
      routeManager: {
        _downstream_addresses_routes: new Map<string, any>([
          [
            'svc@/meta',
            { encryptionKeyId: 'kid-meta', physicalPath: '/meta/path' },
          ],
        ]),
      } as any,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: jest.fn(),
      keyManager,
      correlationMap: createCorrelationMap(),
    });

    const frame: KeyRequestFrame = {
      type: 'KeyRequest',
      address: 'svc@/meta',
    } as KeyRequestFrame;
    const envelope = createEnvelope(frame, { corrId: 'corr-meta' });
    const context = createContext();

    const handled = await handler.acceptKeyRequest(envelope, context);

    expect(handled).toBe(true);
    expect(keyManager.handleKeyRequest).toHaveBeenCalledWith(
      expect.objectContaining({ kid: 'kid-meta', physicalPath: '/meta/path' })
    );
    expect(context.stickinessRequired).toBe(true);
  });

  it('logs when route metadata encryption key handling fails', async () => {
    const keyManager = createKeyManager({
      handleKeyRequest: jest.fn(async () => {
        throw 'send failed';
      }),
      getKeysForPath: jest.fn(async () => [] as KeyRecord[]),
    });

    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode(),
      routeManager: {
        _downstream_addresses_routes: new Map<string, any>([
          [
            'svc@/meta-fail',
            { encryptionKeyId: 'kid-fail', physicalPath: '/meta/fail' },
          ],
        ]),
      } as any,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: jest.fn(),
      keyManager,
      correlationMap: createCorrelationMap(),
    });

    const frame: KeyRequestFrame = {
      type: 'KeyRequest',
      address: 'svc@/meta-fail',
    } as KeyRequestFrame;
    const envelope = createEnvelope(frame);
    const context = createContext();

    const handled = await handler.acceptKeyRequest(envelope, context);

    expect(handled).toBe(false);
    expect(loggerMock.trace).toHaveBeenCalledWith(
      'key_lookup_by_encryption_key_id_failed',
      expect.objectContaining({ key_id: 'kid-fail' })
    );
  });

  it('logs when route physical path lookup fails', async () => {
    const keyManager = createKeyManager({
      getKeysForPath: jest.fn(async (path: string) => {
        if (path === '/route/path') {
          throw 'route lookup failed';
        }
        return [] as KeyRecord[];
      }),
    });

    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode(),
      routeManager: {
        _downstream_addresses_routes: new Map<string, any>([
          ['svc@/route', { physicalPath: '/route/path' }],
        ]),
      } as any,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: jest.fn(),
      keyManager,
      correlationMap: createCorrelationMap(),
    });

    const frame: KeyRequestFrame = {
      type: 'KeyRequest',
      address: 'svc@/route',
    } as KeyRequestFrame;
    const envelope = createEnvelope(frame);
    const context = createContext();

    const handled = await handler.acceptKeyRequest(envelope, context);

    expect(handled).toBe(false);
    expect(loggerMock.trace).toHaveBeenCalledWith(
      'key_lookup_by_physical_path_failed',
      expect.objectContaining({ path: '/route/path' })
    );
    expect(keyManager.handleKeyRequest).not.toHaveBeenCalled();
  });

  it('handles key request using route physical path metadata', async () => {
    const keyManager = createKeyManager({
      getKeysForPath: jest.fn(async (path: string) => {
        if (path === '/route/success') {
          return [{ kid: 'kid-route', use: 'enc' }] as KeyRecord[];
        }
        return [] as KeyRecord[];
      }),
    });

    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode(),
      routeManager: {
        _downstream_addresses_routes: new Map<string, any>([
          ['svc@/route-success', { physicalPath: '/route/success' }],
        ]),
      } as any,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: jest.fn(),
      keyManager,
      correlationMap: createCorrelationMap(),
    });

    const frame: KeyRequestFrame = {
      type: 'KeyRequest',
      address: 'svc@/route-success',
    } as KeyRequestFrame;
    const envelope = createEnvelope(frame);
    const context = createContext();

    const handled = await handler.acceptKeyRequest(envelope, context);

    expect(handled).toBe(true);
    expect(context.stickinessRequired).toBe(true);
    expect(context.stickySid).toBe('child-segment');
    expect(keyManager.handleKeyRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        kid: 'kid-route',
        physicalPath: '/route/success',
      })
    );
  });

  it('falls back when route metadata physical path lacks string kid', async () => {
    const handleKeyRequest = jest.fn(async () => undefined);
    const keyManager = createKeyManager({
      getKeysForPath: jest.fn(async (path: string) => {
        if (path === '/route/no-string') {
          return [
            { kid: 999 as unknown as string, use: 'enc' },
          ] as unknown as KeyRecord[];
        }
        if (path === '/route-no-string') {
          return [{ kid: 'kid-fallback', use: 'enc' }] as KeyRecord[];
        }
        return [] as KeyRecord[];
      }),
      handleKeyRequest,
    });

    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode(),
      routeManager: {
        _downstream_addresses_routes: new Map<string, any>([
          ['svc@/route-no-string', { physicalPath: '/route/no-string' }],
        ]),
      } as any,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: jest.fn(),
      keyManager,
      correlationMap: createCorrelationMap(),
    });

    const frame: KeyRequestFrame = {
      type: 'KeyRequest',
      address: 'svc@/route-no-string',
    } as KeyRequestFrame;
    const envelope = createEnvelope(frame, { sid: 'sid-original' });
    const context = createContext();

    const handled = await handler.acceptKeyRequest(envelope, context);

    expect(handled).toBe(true);
    expect(context.stickinessRequired).toBe(true);
    expect(context.stickySid).toBe('sid-original');
    expect(handleKeyRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        kid: 'kid-fallback',
        physicalPath: '/route-no-string',
      })
    );
  });

  it('handles key request using explicit physical path metadata', async () => {
    const keyManager = createKeyManager({
      getKeysForPath: jest.fn(async (path: string) => {
        if (path === '/explicit') {
          return [{ kid: 'kid-explicit', use: 'enc' }] as KeyRecord[];
        }
        return [] as KeyRecord[];
      }),
    });

    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode(),
      routeManager: null,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: jest.fn(),
      keyManager,
      correlationMap: createCorrelationMap(),
    });

    const frame: KeyRequestFrame = {
      type: 'KeyRequest',
      address: 'svc@/explicit',
    } as KeyRequestFrame;
    const envelope = createEnvelope(frame, {
      corrId: 'corr-explicit',
      sid: 'sid-explicit',
    });
    const context = createContext();

    const handled = await handler.acceptKeyRequest(envelope, context);

    expect(handled).toBe(true);
    expect(keyManager.handleKeyRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        kid: 'kid-explicit',
        physicalPath: '/explicit',
      })
    );
  });

  it('logs when request physical path lookup fails', async () => {
    const keyManager = createKeyManager({
      getKeysForPath: jest.fn(async (path: string) => {
        if (path === '/request') {
          throw 'request lookup failed';
        }
        return [] as KeyRecord[];
      }),
    });

    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode(),
      routeManager: null,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: jest.fn(),
      keyManager,
      correlationMap: createCorrelationMap(),
    });

    const frame: KeyRequestFrame = {
      type: 'KeyRequest',
      address: 'svc@/request',
    } as KeyRequestFrame;
    const envelope = createEnvelope(frame);
    const context = createContext();

    const handled = await handler.acceptKeyRequest(envelope, context);

    expect(handled).toBe(false);
    expect(loggerMock.trace).toHaveBeenCalledWith(
      'key_lookup_by_extracted_path_failed',
      expect.objectContaining({ path: '/request' })
    );
    expect(keyManager.handleKeyRequest).not.toHaveBeenCalled();
  });

  it('handles key request by kid and sets stickiness', async () => {
    const keyManager = createKeyManager({
      getKeysForPath: jest.fn(
        async () => [{ kid: 'kid-remote', use: 'enc' }] as KeyRecord[]
      ),
    });

    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode(),
      routeManager: null,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: jest.fn(),
      keyManager,
      correlationMap: createCorrelationMap(),
    });

    const frame: KeyRequestFrame = {
      type: 'KeyRequest',
      kid: 'kid-remote',
      physicalPath: '/remote/path',
    } as KeyRequestFrame;
    const envelope = createEnvelope(frame, {
      corrId: 'corr-kid',
      sid: 'sid-client',
    });
    const context = createContext();

    const handled = await handler.acceptKeyRequest(envelope, context);

    expect(handled).toBe(true);
    expect(context.stickinessRequired).toBe(true);
    expect(context.stickySid).toBe('sid-client');
    expect(keyManager.handleKeyRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        kid: 'kid-remote',
        physicalPath: '/remote/path',
      })
    );
  });

  it('handles kid request without physical path', async () => {
    const handleKeyRequest = jest.fn(async () => undefined);
    const keyManager = createKeyManager({
      handleKeyRequest,
    });

    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode(),
      routeManager: null,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: jest.fn(),
      keyManager,
      correlationMap: createCorrelationMap(),
    });

    const frame: KeyRequestFrame = {
      type: 'KeyRequest',
      kid: 'kid-only',
    } as KeyRequestFrame;
    const envelope = createEnvelope(frame, { corrId: 'corr-kid-only' });
    const context = createContext();

    const handled = await handler.acceptKeyRequest(envelope, context);

    expect(handled).toBe(true);
    expect(handleKeyRequest).toHaveBeenCalledWith(
      expect.objectContaining({ kid: 'kid-only' })
    );
    expect(handleKeyRequest).not.toHaveBeenCalledWith(
      expect.objectContaining({ physicalPath: expect.anything() })
    );
  });

  it('does not set stickiness when no keys exist for kid physical path', async () => {
    const keyManager = createKeyManager({
      getKeysForPath: jest.fn(async () => [] as KeyRecord[]),
    });

    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode(),
      routeManager: null,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: jest.fn(),
      keyManager,
      correlationMap: createCorrelationMap(),
    });

    const frame: KeyRequestFrame = {
      type: 'KeyRequest',
      kid: 'kid-no-keys',
      physicalPath: '/no/keys',
    } as KeyRequestFrame;
    const envelope = createEnvelope(frame);
    const context = createContext();

    const handled = await handler.acceptKeyRequest(envelope, context);

    expect(handled).toBe(true);
    expect(context.stickinessRequired).toBeUndefined();
    expect(keyManager.handleKeyRequest).toHaveBeenCalledWith(
      expect.objectContaining({ kid: 'kid-no-keys', physicalPath: '/no/keys' })
    );
  });

  it('logs when kid request physical path lookup fails', async () => {
    const keyManager = createKeyManager({
      getKeysForPath: jest.fn(async (path: string) => {
        if (path === '/id/path') {
          throw 'id lookup failed';
        }
        return [] as KeyRecord[];
      }),
    });

    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode(),
      routeManager: null,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: jest.fn(),
      keyManager,
      correlationMap: createCorrelationMap(),
    });

    const frame: KeyRequestFrame = {
      type: 'KeyRequest',
      kid: 'kid-id',
      physicalPath: '/id/path',
    } as KeyRequestFrame;
    const envelope = createEnvelope(frame, { sid: 'sid-id' });
    const context = createContext();

    await handler.acceptKeyRequest(envelope, context);

    expect(loggerMock.trace).toHaveBeenCalledWith(
      'key_lookup_for_physical_path_failed',
      expect.objectContaining({ physical_path: '/id/path' })
    );
    expect(keyManager.handleKeyRequest).toHaveBeenCalledWith(
      expect.objectContaining({ kid: 'kid-id', physicalPath: '/id/path' })
    );
  });

  it('falls back to extracted address path when request lacks routing info', async () => {
    const keyManager = createKeyManager({
      getKeysForPath: jest.fn(async (path: string) =>
        path === '/extracted'
          ? ([{ kid: 'kid-extracted', use: 'enc' }] as KeyRecord[])
          : ([] as KeyRecord[])
      ),
    });

    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode(),
      routeManager: null,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: jest.fn(),
      keyManager,
      correlationMap: createCorrelationMap(),
    });

    const frame: KeyRequestFrame = {
      type: 'KeyRequest',
      address: 'svc@/extracted',
    } as KeyRequestFrame;
    const envelope = createEnvelope(frame, { corrId: 'corr-extracted' });
    const context = createContext();

    const handled = await handler.acceptKeyRequest(envelope, context);

    expect(handled).toBe(true);
    expect(keyManager.handleKeyRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        kid: 'kid-extracted',
        physicalPath: '/extracted',
      })
    );
  });

  it('logs when extracted address path lookup fails', async () => {
    const keyManager = createKeyManager({
      getKeysForPath: jest.fn(async (path: string) => {
        if (path === '/extracted') {
          throw 'extracted lookup failed';
        }
        return [] as KeyRecord[];
      }),
    });

    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode(),
      routeManager: null,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: jest.fn(),
      keyManager,
      correlationMap: createCorrelationMap(),
    });

    const frame: KeyRequestFrame = {
      type: 'KeyRequest',
      address: 'svc@/extracted',
    } as KeyRequestFrame;
    const envelope = createEnvelope(frame);
    const context = createContext();

    const handled = await handler.acceptKeyRequest(envelope, context);

    expect(handled).toBe(false);
    expect(loggerMock.trace).toHaveBeenCalledWith(
      'key_lookup_by_extracted_path_failed',
      expect.objectContaining({ path: '/extracted' })
    );
  });

  it('returns false when no key information is available for address-based request', async () => {
    const keyManager = createKeyManager({
      getKeysForPath: jest.fn(async () => [] as KeyRecord[]),
    });

    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode(),
      routeManager: null,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: jest.fn(),
      keyManager,
      correlationMap: createCorrelationMap(),
    });

    const frame: KeyRequestFrame = {
      type: 'KeyRequest',
      address: 'svc@/missing',
    } as KeyRequestFrame;
    const envelope = createEnvelope(frame, { corrId: 'corr-missing' });
    const context = createContext();

    const handled = await handler.acceptKeyRequest(envelope, context);

    expect(handled).toBe(false);
    expect(keyManager.handleKeyRequest).not.toHaveBeenCalled();
    expect(context.stickinessRequired).toBeUndefined();
    expect(context.stickySid).toBeUndefined();
  });

  it('returns false when address lacks separator', async () => {
    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode(),
      routeManager: null,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: jest.fn(),
      keyManager: createKeyManager({
        getKeysForPath: jest.fn(async () => [] as KeyRecord[]),
      }),
      correlationMap: createCorrelationMap(),
    });

    const frame: KeyRequestFrame = {
      type: 'KeyRequest',
      address: 'invalid',
    } as KeyRequestFrame;
    const envelope = createEnvelope(frame, { corrId: 'corr-invalid' });
    const context = createContext();

    const handled = await handler.acceptKeyRequest(envelope, context);

    expect(handled).toBe(false);
    expect(loggerMock.trace).toHaveBeenCalledWith(
      'delegating_key_request_to_routing_pipeline',
      expect.objectContaining({ address: 'invalid' })
    );
  });

  it('returns false when address path does not start with slash', async () => {
    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode(),
      routeManager: null,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: jest.fn(),
      keyManager: createKeyManager({
        getKeysForPath: jest.fn(async () => [] as KeyRecord[]),
      }),
      correlationMap: createCorrelationMap(),
    });

    const frame: KeyRequestFrame = {
      type: 'KeyRequest',
      address: 'svc@no-slash',
    } as KeyRequestFrame;
    const envelope = createEnvelope(frame);
    const context = createContext();

    const handled = await handler.acceptKeyRequest(envelope, context);

    expect(handled).toBe(false);
    expect(loggerMock.trace).toHaveBeenCalledWith(
      'delegating_key_request_to_routing_pipeline',
      expect.objectContaining({ address: 'svc@no-slash' })
    );
  });

  it('returns false when peer routes container is invalid', async () => {
    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode(),
      routeManager: {
        _peer_routes: 'not-a-map' as any,
      } as any,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: jest.fn(),
      keyManager: createKeyManager({
        getKeysForPath: jest.fn(async () => [] as KeyRecord[]),
      }),
      correlationMap: createCorrelationMap(),
    });

    const frame: KeyRequestFrame = {
      type: 'KeyRequest',
      address: 'svc@/peer-invalid',
    } as KeyRequestFrame;
    const envelope = createEnvelope(frame);
    const context = createContext({
      originType: DeliveryOriginType.PEER,
      fromSystemId: 'peer-invalid',
    });

    const handled = await handler.acceptKeyRequest(envelope, context);

    expect(handled).toBe(false);
  });

  it('ignores peer route entries with falsy segment', async () => {
    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode(),
      routeManager: {
        _peer_addresses_routes: new Map<string, string>([['svc@/falsy', '']]),
      } as any,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: jest.fn(),
      keyManager: createKeyManager({
        getKeysForPath: jest.fn(async () => [] as KeyRecord[]),
      }),
      correlationMap: createCorrelationMap(),
    });

    const frame: KeyRequestFrame = {
      type: 'KeyRequest',
      address: 'svc@/falsy',
    } as KeyRequestFrame;
    const envelope = createEnvelope(frame);
    const context = createContext({
      originType: DeliveryOriginType.PEER,
      fromSystemId: 'peer-empty',
    });

    const handled = await handler.acceptKeyRequest(envelope, context);

    expect(handled).toBe(false);
    expect(loggerMock.trace).toHaveBeenCalledWith(
      'delegating_key_request_to_routing_pipeline',
      expect.objectContaining({ address: 'svc@/falsy' })
    );
  });

  it('ignores downstream routes with null entries', async () => {
    const handler = new KeyFrameHandler({
      routingNode: createRoutingNode(),
      routeManager: {
        _downstream_addresses_routes: {
          'svc@/null-route': null,
          'svc@/other': { segment: 'other-segment' },
        } as any,
      } as any,
      bindingManager: createBindingManager(),
      acceptKeyAnnounceParent: jest.fn(),
      keyManager: createKeyManager({
        getKeysForPath: jest.fn(async () => [] as KeyRecord[]),
      }),
      correlationMap: createCorrelationMap(),
    });

    const frame: KeyRequestFrame = {
      type: 'KeyRequest',
      address: 'svc@/null-route',
    } as KeyRequestFrame;
    const envelope = createEnvelope(frame);
    const context = createContext();

    const handled = await handler.acceptKeyRequest(envelope, context);

    expect(handled).toBe(false);
  });
});
