import * as core from 'naylence-core';
import {
  DeliveryOriginType,
  FameResponseType,
  formatAddress,
  type AddressBindFrame,
  type AddressUnbindFrame,
  type FameDeliveryContext,
  type FameEnvelope,
} from 'naylence-core';

import {
  AddressBindFrameHandler,
  type PoolKey,
  type RouteManagerLike,
} from '../address-bind-frame-handler.js';
import type { RoutingNodeLike } from '../../node/routing-node-like.js';

interface TestContext {
  handler: AddressBindFrameHandler;
  routeManager: RouteManagerLike;
  forwardToRoute: jest.Mock;
  forwardToPeers: jest.Mock;
  forwardUpstream: jest.Mock;
  envelopeFactory: { createEnvelope: jest.Mock };
  routingNode: RoutingNodeLike;
}

function createRouteManager(
  overrides: Partial<RouteManagerLike> = {}
): RouteManagerLike {
  const base: RouteManagerLike = {
    downstreamRoutes: new Map([['segment-1', {}]]),
    _peer_routes: undefined,
    _downstream_addresses_routes: new Map(),
    _peer_addresses_routes: undefined,
    _downstream_route_store: new Map<
      string,
      { assignedPath?: string | null; assigned_path?: string | null }
    >([
      [
        'segment-1',
        {
          assignedPath: '/physical/node',
        },
      ],
    ]),
    _downstream_addresses_legacy: new Map(),
  };

  return { ...base, ...overrides };
}

function createTestContext(
  options: {
    routeManager?: RouteManagerLike;
    upstreamConnector?: () => unknown;
  } = {}
): TestContext {
  const routeManager = options.routeManager ?? createRouteManager();
  const forwardToRoute = jest.fn();
  const forwardToPeers = jest.fn();
  const forwardUpstream = jest.fn();

  const envelopeFactory = {
    createEnvelope: jest.fn(
      (opts: { frame: FameEnvelope['frame']; corrId?: string }) =>
        ({
          id: `ack-${Math.random().toString(16).slice(2)}`,
          frame: opts.frame,
          ...(opts.corrId ? { corrId: opts.corrId } : {}),
        }) as FameEnvelope
    ),
  };

  const routingNode = {
    id: 'routing-node',
    envelopeFactory,
    forwardToRoute,
    forwardToPeers,
    forwardUpstream,
  } as unknown as RoutingNodeLike;

  const handler = new AddressBindFrameHandler({
    routingNode,
    routeManager,
    upstreamConnector: options.upstreamConnector ?? (() => true),
  });

  return {
    handler,
    routeManager,
    forwardToRoute,
    forwardToPeers,
    forwardUpstream,
    envelopeFactory,
    routingNode,
  };
}

function createDeliveryContext(
  originType: DeliveryOriginType,
  overrides: Partial<FameDeliveryContext> = {}
): FameDeliveryContext {
  return {
    originType,
    fromSystemId: 'segment-1',
    meta: {},
    security: undefined,
    ...overrides,
  } as FameDeliveryContext;
}

function createBindEnvelope(
  address: ReturnType<typeof formatAddress>,
  overrides: Partial<AddressBindFrame> = {}
): FameEnvelope {
  const frame: AddressBindFrame = {
    type: 'AddressBind',
    address,
    encryptionKeyId: undefined,
    ...overrides,
  };

  return {
    id: 'env-bind',
    corrId: 'corr-1',
    frame,
  } as FameEnvelope;
}

function createUnbindEnvelope(
  address: ReturnType<typeof formatAddress>
): FameEnvelope {
  const frame: AddressUnbindFrame = {
    type: 'AddressUnbind',
    address,
  };

  return {
    id: 'env-unbind',
    corrId: 'corr-2',
    frame,
  } as FameEnvelope;
}

function getPoolEntry(
  handler: AddressBindFrameHandler,
  match: PoolKey
): { key: PoolKey; segments: Set<string> } | null {
  for (const [key, segments] of handler.pools.entries()) {
    if (key.name === match.name && key.pattern === match.pattern) {
      return { key, segments };
    }
  }
  return null;
}

describe('AddressBindFrameHandler', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  describe('acceptAddressBind', () => {
    it('registers downstream routes and forwards acknowledgements', async () => {
      const address = formatAddress('svc', '/local/path');
      const addressKey = address.toString();
      const routeManager = createRouteManager();
      const {
        handler,
        forwardToRoute,
        forwardToPeers,
        forwardUpstream,
        envelopeFactory,
      } = createTestContext({
        routeManager,
      });

      const envelope = createBindEnvelope(address, {
        encryptionKeyId: 'enc-1',
      });
      const context = createDeliveryContext(DeliveryOriginType.DOWNSTREAM);

      await handler.acceptAddressBind(envelope, context);

      const storedRoute = (
        routeManager._downstream_addresses_routes as Map<string, any>
      ).get(addressKey);
      expect(storedRoute).toMatchObject({
        segment: 'segment-1',
        physicalPath: '/physical/node',
        encryptionKeyId: 'enc-1',
      });

      expect(envelopeFactory.createEnvelope).toHaveBeenCalledWith({
        frame: {
          type: 'AddressBindAck',
          address: addressKey,
          ok: true,
          refId: 'env-bind',
        },
        corrId: 'corr-1',
      });

      expect(forwardToRoute).toHaveBeenCalledTimes(1);
      const [, ackEnvelope, ackContext] = forwardToRoute.mock.calls[0];
      expect(ackEnvelope.frame.type).toBe('AddressBindAck');
      expect(ackContext).toMatchObject({
        originType: DeliveryOriginType.LOCAL,
        fromSystemId: 'routing-node',
        meta: { 'message-type': 'response' },
        expectedResponseType: FameResponseType.NONE,
      });

      expect(forwardUpstream).toHaveBeenCalledWith(envelope, context);
      expect(forwardToPeers).toHaveBeenCalledWith(
        envelope,
        undefined,
        ['segment-1'],
        context
      );
    });

    it('does not propagate reserved system addresses upstream', async () => {
      const address = formatAddress('__sys__', '/physical/node');
      const routeManager = createRouteManager();
      const { handler, forwardUpstream, forwardToPeers } = createTestContext({
        routeManager,
      });

      const envelope = createBindEnvelope(address);
      const context = createDeliveryContext(DeliveryOriginType.DOWNSTREAM);

      await handler.acceptAddressBind(envelope, context);

      expect(forwardUpstream).not.toHaveBeenCalled();
      expect(forwardToPeers).toHaveBeenCalledWith(
        envelope,
        undefined,
        ['segment-1'],
        context
      );
    });
    it('forwards upstream for host-based logical bindings', async () => {
      const address = formatAddress('svc', 'api.service');
      const routeManager = createRouteManager();
      const { handler, forwardUpstream, forwardToPeers } = createTestContext({
        routeManager,
      });

      const envelope = createBindEnvelope(address);
      const context = createDeliveryContext(DeliveryOriginType.DOWNSTREAM);

      await handler.acceptAddressBind(envelope, context);

      expect(forwardUpstream).toHaveBeenCalledWith(envelope, context);
      expect(forwardToPeers).toHaveBeenCalledWith(
        envelope,
        undefined,
        ['segment-1'],
        context
      );
    });

    it('tracks pool bindings for wildcard host addresses', async () => {
      const address = formatAddress('svc', '*.pool.host');
      const routeManager = createRouteManager();
      const { handler, routeManager: ctxRouteManager } = createTestContext({
        routeManager,
      });

      const envelope = createBindEnvelope(address);
      const context = createDeliveryContext(DeliveryOriginType.DOWNSTREAM);

      await handler.acceptAddressBind(envelope, context);

      const poolEntry = getPoolEntry(handler, {
        name: 'svc',
        pattern: '*.pool.host',
      });
      expect(poolEntry).not.toBeNull();
      expect(poolEntry?.segments.has('segment-1')).toBe(true);

      const downstreamRoutes =
        ctxRouteManager._downstream_addresses_routes as Map<string, unknown>;
      expect(downstreamRoutes.size).toBe(0);
    });

    it('throws when delivery context is missing', async () => {
      const { handler } = createTestContext();
      const envelope = createBindEnvelope(formatAddress('svc', '/local'));

      await expect(
        handler.acceptAddressBind(envelope, undefined)
      ).rejects.toThrow(/requires delivery context/i);
    });

    it('throws when frame is not AddressBind', async () => {
      const { handler } = createTestContext();
      const envelope = {
        id: 'env-invalid',
        frame: { type: 'AddressUnbind' },
      } as FameEnvelope;
      const context = createDeliveryContext(DeliveryOriginType.DOWNSTREAM);

      await expect(
        handler.acceptAddressBind(envelope, context)
      ).rejects.toThrow(/Expected AddressBindFrame/i);
    });

    it('returns early when source system id is missing', async () => {
      const routeManager = createRouteManager();
      const {
        handler,
        forwardToRoute,
        forwardToPeers,
        forwardUpstream,
        routeManager: ctxRouteManager,
      } = createTestContext({ routeManager });

      const envelope = createBindEnvelope(formatAddress('svc', '/local'));
      const context = createDeliveryContext(DeliveryOriginType.DOWNSTREAM, {
        fromSystemId: undefined,
      });

      await handler.acceptAddressBind(envelope, context);

      expect(forwardToRoute).not.toHaveBeenCalled();
      expect(forwardToPeers).not.toHaveBeenCalled();
      expect(forwardUpstream).not.toHaveBeenCalled();
      expect(
        (ctxRouteManager._downstream_addresses_routes as Map<string, unknown>)
          .size
      ).toBe(0);
    });

    it('throws when downstream route is unknown', async () => {
      const routeManager = createRouteManager({ downstreamRoutes: new Map() });
      const { handler } = createTestContext({ routeManager });
      const envelope = createBindEnvelope(formatAddress('svc', '/local'));
      const context = createDeliveryContext(DeliveryOriginType.DOWNSTREAM);

      await expect(
        handler.acceptAddressBind(envelope, context)
      ).rejects.toThrow(/unknown downstream system/i);
    });

    it('throws when peer route is unknown', async () => {
      const routeManager = createRouteManager({ _peer_routes: new Map() });
      const { handler } = createTestContext({ routeManager });
      const envelope = createBindEnvelope(formatAddress('svc', '/local'));
      const context = createDeliveryContext(DeliveryOriginType.PEER);

      await expect(
        handler.acceptAddressBind(envelope, context)
      ).rejects.toThrow(/unknown peer system/i);
    });

    it('registers peer routes for known segments', async () => {
      const peerAddressRoutes = new Map<string, string>();
      const routeManager = createRouteManager({
        _peer_routes: new Map([['peer-1', {}]]),
        _peer_addresses_routes: peerAddressRoutes,
      });
      const { handler, forwardToRoute, forwardToPeers, forwardUpstream } =
        createTestContext({
          routeManager,
        });

      const address = formatAddress('svc', '/peer/path');
      const envelope = createBindEnvelope(address);
      const context = createDeliveryContext(DeliveryOriginType.PEER, {
        fromSystemId: 'peer-1',
      });

      await handler.acceptAddressBind(envelope, context);

      expect(peerAddressRoutes.get(address.toString())).toBe('peer-1');
      expect(forwardToRoute).not.toHaveBeenCalled();
      expect(forwardUpstream).toHaveBeenCalledWith(envelope, context);
      expect(forwardToPeers).toHaveBeenCalledWith(
        envelope,
        undefined,
        ['peer-1'],
        context
      );
    });

    it('tracks pool bindings for wildcard path addresses', async () => {
      const parseAddressSpy = jest
        .spyOn(core, 'parseAddress')
        .mockReturnValue(['svc', '/pool/**'] as unknown as ReturnType<
          typeof core.parseAddress
        >);
      const parseComponentsSpy = jest
        .spyOn(core, 'parseAddressComponents')
        .mockReturnValue(['svc', null] as unknown as ReturnType<
          typeof core.parseAddressComponents
        >);

      const address = {
        toString: () => 'svc:///pool/**',
      } as unknown as ReturnType<typeof formatAddress>;
      const { handler } = createTestContext();

      const envelope = createBindEnvelope(address);
      const context = createDeliveryContext(DeliveryOriginType.DOWNSTREAM);

      await handler.acceptAddressBind(envelope, context);

      const poolEntry = getPoolEntry(handler, { name: 'svc', pattern: 'pool' });
      expect(poolEntry).not.toBeNull();
      expect(poolEntry?.segments.has('segment-1')).toBe(true);

      parseAddressSpy.mockRestore();
      parseComponentsSpy.mockRestore();
    });

    it('uses assigned_path field when available', async () => {
      const getRouteEntry = jest.fn(async (segment: string) => {
        if (segment === 'segment-1') {
          return {
            assigned_path: '/legacy/path',
          };
        }
        return null;
      });

      const routeManager = createRouteManager({
        _downstream_route_store: {
          get: getRouteEntry,
        },
      });
      const { handler, routeManager: ctxRouteManager } = createTestContext({
        routeManager,
      });

      const address = formatAddress('svc', '/legacy');
      const envelope = createBindEnvelope(address);
      const context = createDeliveryContext(DeliveryOriginType.DOWNSTREAM);

      await handler.acceptAddressBind(envelope, context);

      const storedRoute = (
        ctxRouteManager._downstream_addresses_routes as Map<
          string,
          { physicalPath?: string }
        >
      ).get(address.toString());
      expect(storedRoute?.physicalPath).toBe('/legacy/path');
      expect(getRouteEntry).toHaveBeenCalledWith('segment-1');
    });

    it('omits physicalPath when route entry lacks assignment', async () => {
      const routeManager = createRouteManager({
        _downstream_route_store: new Map([['segment-1', {}]]),
      });
      const { handler, routeManager: ctxRouteManager } = createTestContext({
        routeManager,
      });

      const address = formatAddress('svc', '/no-assignment');
      const envelope = createBindEnvelope(address);
      const context = createDeliveryContext(DeliveryOriginType.DOWNSTREAM);

      await handler.acceptAddressBind(envelope, context);

      const storedRoute = (
        ctxRouteManager._downstream_addresses_routes as Map<
          string,
          { physicalPath?: string }
        >
      ).get(address.toString());

      expect(storedRoute).toMatchObject({ segment: 'segment-1' });
      expect(storedRoute?.physicalPath).toBeUndefined();
    });

    it('registers downstream routes when using object-based containers', async () => {
      const downstreamRoutes: Record<string, unknown> = {
        'segment-1': {},
      };
      const routeStore: Record<string, { assignedPath?: string | null }> = {
        'segment-1': {
          assignedPath: '/object/path',
        },
      };
      const addressRoutes: Record<
        string,
        { segment?: string; physicalPath?: string } | undefined
      > = {};
      const legacyRoutes: Record<string, unknown> = {};

      const routeManager = createRouteManager({
        downstreamRoutes,
        _downstream_route_store: routeStore,
        _downstream_addresses_routes: addressRoutes,
        _downstream_addresses_legacy: legacyRoutes,
      });

      const testContext = createTestContext({ routeManager });
      const { handler } = testContext;

      const address = formatAddress('svc', '/object/path');
      const envelope = createBindEnvelope(address);
      const context = createDeliveryContext(DeliveryOriginType.DOWNSTREAM);

      await handler.acceptAddressBind(envelope, context);

      const storedRoute = addressRoutes[address.toString()];
      expect(storedRoute).toMatchObject({
        segment: 'segment-1',
        physicalPath: '/object/path',
      });
      expect(address.toString() in legacyRoutes).toBe(false);
    });

    it('registers peer routes when containers are plain objects', async () => {
      const peerRoutes: Record<string, unknown> = {
        'peer-1': {},
      };
      const peerAddressRoutes: Record<string, string | undefined> = {};

      const routeManager = createRouteManager({
        _peer_routes: peerRoutes,
        _peer_addresses_routes: peerAddressRoutes,
      });

      const testContext = createTestContext({ routeManager });
      const { handler, forwardToRoute, forwardToPeers, forwardUpstream } =
        testContext;

      const address = formatAddress('svc', '/peer/object');
      const envelope = createBindEnvelope(address);
      const context = createDeliveryContext(DeliveryOriginType.PEER, {
        fromSystemId: 'peer-1',
      });

      await handler.acceptAddressBind(envelope, context);

      expect(peerAddressRoutes[address.toString()]).toBe('peer-1');
      expect(forwardToRoute).not.toHaveBeenCalled();
      expect(forwardUpstream).toHaveBeenCalledWith(envelope, context);
      expect(forwardToPeers).toHaveBeenCalledWith(
        envelope,
        undefined,
        ['peer-1'],
        context
      );
    });

    it('does not forward upstream when connector returns falsy', async () => {
      const routeManager = createRouteManager();
      const upstreamConnector = jest.fn(() => undefined);
      const testContext = createTestContext({
        routeManager,
        upstreamConnector,
      });
      const { handler, forwardUpstream } = testContext;

      const address = formatAddress('svc', '/local');
      const envelope = createBindEnvelope(address);
      const context = createDeliveryContext(DeliveryOriginType.DOWNSTREAM);

      await handler.acceptAddressBind(envelope, context);

      expect(upstreamConnector).toHaveBeenCalled();
      expect(forwardUpstream).not.toHaveBeenCalled();
    });

    it('throws when origin type is unsupported', async () => {
      const { handler } = createTestContext();
      const address = formatAddress('svc', '/local');
      const envelope = createBindEnvelope(address);
      const context = createDeliveryContext(DeliveryOriginType.LOCAL);

      await expect(
        handler.acceptAddressBind(envelope, context)
      ).rejects.toThrow(/Unsupported origin type/i);
    });

    it('skips forwarding to peers when routing node lacks forwardToPeers', async () => {
      const testContext = createTestContext();
      const { handler, routingNode, forwardToPeers, forwardUpstream } =
        testContext;

      delete (routingNode as unknown as Record<string, unknown>).forwardToPeers;

      const address = formatAddress('svc', '/local/path');
      const envelope = createBindEnvelope(address);
      const context = createDeliveryContext(DeliveryOriginType.DOWNSTREAM);

      await handler.acceptAddressBind(envelope, context);

      expect(routingNode.forwardToPeers).toBeUndefined();
      expect(forwardUpstream).toHaveBeenCalledWith(envelope, context);
      expect(forwardToPeers).not.toHaveBeenCalled();
    });

    it('throws when routing node lacks forwardToRoute support', async () => {
      const testContext = createTestContext();
      const { handler, routingNode, forwardUpstream } = testContext;

      delete (routingNode as unknown as Record<string, unknown>).forwardToRoute;

      const envelope = createBindEnvelope(formatAddress('svc', '/local'));
      const context = createDeliveryContext(DeliveryOriginType.DOWNSTREAM);

      await expect(
        handler.acceptAddressBind(envelope, context)
      ).rejects.toThrow(/does not support forwardToRoute/i);

      expect(routingNode.forwardToRoute).toBeUndefined();
      expect(forwardUpstream).not.toHaveBeenCalled();
    });

    it('continues binding when parseAddressComponents throws', async () => {
      const parseComponentsSpy = jest
        .spyOn(core, 'parseAddressComponents')
        .mockImplementation(() => {
          throw new Error('parse error');
        });

      const routeManager = createRouteManager();
      const { handler } = createTestContext({ routeManager });

      const address = formatAddress('svc', '/recoverable/path');
      const envelope = createBindEnvelope(address);
      const context = createDeliveryContext(DeliveryOriginType.DOWNSTREAM);

      await handler.acceptAddressBind(envelope, context);

      const storedRoute = (
        routeManager._downstream_addresses_routes as Map<
          string,
          { segment: string }
        >
      ).get(address.toString());

      expect(storedRoute?.segment).toBe('segment-1');
      expect(parseComponentsSpy).toHaveBeenCalled();
    });
  });

  describe('acceptAddressUnbind', () => {
    it('removes pool bindings and forwards upstream', async () => {
      const address = formatAddress('svc', '*.pool.host');
      const routeManager = createRouteManager();
      const testContext = createTestContext({ routeManager });
      const { handler, forwardToRoute, forwardUpstream } = testContext;

      handler.pools.set(
        { name: 'svc', pattern: '*.pool.host' },
        new Set(['segment-1'])
      );

      const envelope = createUnbindEnvelope(address);
      const context = createDeliveryContext(DeliveryOriginType.DOWNSTREAM);

      await handler.acceptAddressUnbind(envelope, context);

      const poolEntry = getPoolEntry(handler, {
        name: 'svc',
        pattern: '*.pool.host',
      });
      expect(poolEntry).toBeNull();

      expect(forwardUpstream).toHaveBeenCalledWith(envelope, context);
      expect(forwardToRoute).toHaveBeenCalledTimes(1);
      const [, ackEnvelope, ackContext] = forwardToRoute.mock.calls[0];
      expect(ackEnvelope.frame.type).toBe('AddressUnbindAck');
      expect(ackContext?.expectedResponseType).toBe(FameResponseType.NONE);
    });

    it('clears downstream routes when matching segment unbinds', async () => {
      const address = formatAddress('svc', '/local/path');
      const addressKey = address.toString();
      const downstreamRoutes = new Map([
        [addressKey, { segment: 'segment-1', physicalPath: '/physical/node' }],
      ]);
      const legacyRoutes = new Map([[addressKey, { legacy: true }]]);

      const routeManager = createRouteManager({
        _downstream_addresses_routes: downstreamRoutes,
        _downstream_addresses_legacy: legacyRoutes,
      });

      const testContext = createTestContext({ routeManager });
      const { handler, forwardToRoute, forwardUpstream } = testContext;

      const envelope = createUnbindEnvelope(address);
      const context = createDeliveryContext(DeliveryOriginType.DOWNSTREAM);

      await handler.acceptAddressUnbind(envelope, context);

      expect(downstreamRoutes.has(addressKey)).toBe(false);
      expect(legacyRoutes.has(addressKey)).toBe(false);

      expect(forwardUpstream).toHaveBeenCalledWith(envelope, context);
      expect(forwardToRoute).toHaveBeenCalledTimes(1);
    });

    it('unbinds downstream route when legacy container is missing', async () => {
      const address = formatAddress('svc', '/no-legacy');
      const addressKey = address.toString();
      const downstreamRoutes = new Map([
        [addressKey, { segment: 'segment-1' }],
      ]);

      const routeManager = createRouteManager({
        _downstream_addresses_routes: downstreamRoutes,
        _downstream_addresses_legacy: undefined,
      });

      const testContext = createTestContext({ routeManager });
      const { handler, forwardUpstream } = testContext;

      const envelope = createUnbindEnvelope(address);
      const context = createDeliveryContext(DeliveryOriginType.DOWNSTREAM);

      await handler.acceptAddressUnbind(envelope, context);

      expect(downstreamRoutes.has(addressKey)).toBe(false);
      expect(forwardUpstream).toHaveBeenCalledWith(envelope, context);
    });

    it('does not propagate reserved system unbinds upstream', async () => {
      const address = formatAddress('__sys__', '/physical/node');
      const addressKey = address.toString();
      const downstreamRoutes = new Map([
        [addressKey, { segment: 'segment-1' }],
      ]);

      const routeManager = createRouteManager({
        _downstream_addresses_routes: downstreamRoutes,
      });

      const testContext = createTestContext({ routeManager });
      const { handler, forwardUpstream } = testContext;

      const envelope = createUnbindEnvelope(address);
      const context = createDeliveryContext(DeliveryOriginType.DOWNSTREAM);

      await handler.acceptAddressUnbind(envelope, context);

      expect(downstreamRoutes.has(addressKey)).toBe(false);
      expect(forwardUpstream).not.toHaveBeenCalled();
    });

    it('forwards upstream for host-based unbinds', async () => {
      const address = formatAddress('svc', 'api.service');
      const addressKey = address.toString();
      const downstreamRoutes = new Map([
        [addressKey, { segment: 'segment-1' }],
      ]);

      const routeManager = createRouteManager({
        _downstream_addresses_routes: downstreamRoutes,
      });

      const testContext = createTestContext({ routeManager });
      const { handler, forwardUpstream } = testContext;

      const envelope = createUnbindEnvelope(address);
      const context = createDeliveryContext(DeliveryOriginType.DOWNSTREAM);

      await handler.acceptAddressUnbind(envelope, context);

      expect(forwardUpstream).toHaveBeenCalledWith(envelope, context);
      expect(downstreamRoutes.has(addressKey)).toBe(false);
    });

    it('removes wildcard path pool entries and forwards upstream', async () => {
      const parseAddressSpy = jest
        .spyOn(core, 'parseAddress')
        .mockReturnValue(['svc', '/pool/**'] as unknown as ReturnType<
          typeof core.parseAddress
        >);
      const parseComponentsSpy = jest
        .spyOn(core, 'parseAddressComponents')
        .mockReturnValue(['svc', null] as unknown as ReturnType<
          typeof core.parseAddressComponents
        >);

      const routeManager = createRouteManager();
      const testContext = createTestContext({ routeManager });
      const { handler, forwardToRoute, forwardUpstream } = testContext;

      handler.pools.set(
        { name: 'svc', pattern: 'pool' },
        new Set(['segment-1'])
      );

      const address = {
        toString: () => 'svc:///pool/**',
      } as unknown as ReturnType<typeof formatAddress>;

      const envelope = createUnbindEnvelope(address);
      const context = createDeliveryContext(DeliveryOriginType.DOWNSTREAM);

      await handler.acceptAddressUnbind(envelope, context);

      expect(
        getPoolEntry(handler, { name: 'svc', pattern: 'pool' })
      ).toBeNull();
      expect(forwardUpstream).toHaveBeenCalledWith(envelope, context);
      expect(forwardToRoute).toHaveBeenCalledTimes(1);

      parseAddressSpy.mockRestore();
      parseComponentsSpy.mockRestore();
    });

    it('throws when frame is not AddressUnbind', async () => {
      const { handler } = createTestContext();
      const envelope = {
        id: 'env-invalid',
        frame: { type: 'AddressBind' },
      } as FameEnvelope;
      const context = createDeliveryContext(DeliveryOriginType.DOWNSTREAM);

      await expect(
        handler.acceptAddressUnbind(envelope, context)
      ).rejects.toThrow(/Expected AddressUnbindFrame/i);
    });

    it('returns early when source system id is missing', async () => {
      const testContext = createTestContext();
      const { handler, forwardToRoute, forwardUpstream } = testContext;

      const envelope = createUnbindEnvelope(formatAddress('svc', '/local'));
      const context = createDeliveryContext(DeliveryOriginType.DOWNSTREAM, {
        fromSystemId: undefined,
      });

      await handler.acceptAddressUnbind(envelope, context);

      expect(forwardToRoute).not.toHaveBeenCalled();
      expect(forwardUpstream).not.toHaveBeenCalled();
    });

    it('does nothing when pool entry is missing', async () => {
      const testContext = createTestContext();
      const { handler, forwardUpstream } = testContext;

      const envelope = createUnbindEnvelope(
        formatAddress('svc', '*.pool.host')
      );
      const context = createDeliveryContext(DeliveryOriginType.DOWNSTREAM);

      await handler.acceptAddressUnbind(envelope, context);

      expect(forwardUpstream).not.toHaveBeenCalled();
    });

    it('does not delete routes owned by other segments', async () => {
      const address = formatAddress('svc', '/local/path');
      const addressKey = address.toString();
      const downstreamRoutes = new Map([
        [addressKey, { segment: 'segment-2' }],
      ]);
      const routeManager = createRouteManager({
        _downstream_addresses_routes: downstreamRoutes,
      });
      const testContext = createTestContext({ routeManager });
      const { handler, forwardUpstream } = testContext;

      const envelope = createUnbindEnvelope(address);
      const context = createDeliveryContext(DeliveryOriginType.DOWNSTREAM);

      await handler.acceptAddressUnbind(envelope, context);

      expect(downstreamRoutes.has(addressKey)).toBe(true);
      expect(forwardUpstream).not.toHaveBeenCalled();
    });

    it('does not send acknowledgements for peer origin', async () => {
      const testContext = createTestContext();
      const { handler, forwardToRoute } = testContext;

      const envelope = createUnbindEnvelope(formatAddress('svc', '/peer/path'));
      const context = createDeliveryContext(DeliveryOriginType.PEER, {
        fromSystemId: 'peer-1',
      });

      await handler.acceptAddressUnbind(envelope, context);

      expect(forwardToRoute).not.toHaveBeenCalled();
    });

    it('removes pool binding without forwarding when connector is falsy', async () => {
      const routeManager = createRouteManager();
      const upstreamConnector = jest.fn(() => undefined);
      const testContext = createTestContext({
        routeManager,
        upstreamConnector,
      });
      const { handler, forwardUpstream } = testContext;

      const key: PoolKey = { name: 'svc', pattern: '*.pool.host' };
      handler.pools.set(key, new Set(['segment-1', 'segment-2']));

      const envelope = createUnbindEnvelope(
        formatAddress('svc', '*.pool.host')
      );
      const context = createDeliveryContext(DeliveryOriginType.DOWNSTREAM);

      await handler.acceptAddressUnbind(envelope, context);

      const poolEntry = getPoolEntry(handler, key);
      expect(poolEntry).not.toBeNull();
      expect(poolEntry?.segments.has('segment-1')).toBe(false);
      expect(poolEntry?.segments.has('segment-2')).toBe(true);
      expect(forwardUpstream).not.toHaveBeenCalled();
    });

    it('clears object-based downstream route containers', async () => {
      const address = formatAddress('svc', '/object/path');
      const addressKey = address.toString();
      const downstreamRoutes: Record<string, { segment: string }> = {
        [addressKey]: { segment: 'segment-1' },
      };
      const legacyRoutes: Record<string, unknown> = {
        [addressKey]: { legacy: true },
      };

      const routeManager = createRouteManager({
        _downstream_addresses_routes: downstreamRoutes,
        _downstream_addresses_legacy: legacyRoutes,
      });

      const testContext = createTestContext({ routeManager });
      const { handler, forwardUpstream } = testContext;

      const envelope = createUnbindEnvelope(address);
      const context = createDeliveryContext(DeliveryOriginType.DOWNSTREAM);

      await handler.acceptAddressUnbind(envelope, context);

      expect(addressKey in downstreamRoutes).toBe(false);
      expect(addressKey in legacyRoutes).toBe(false);
      expect(forwardUpstream).toHaveBeenCalledWith(envelope, context);
    });

    it('keeps pool entry when segment is not a member', async () => {
      const testContext = createTestContext();
      const { handler, forwardUpstream } = testContext;

      const key: PoolKey = { name: 'svc', pattern: '*.pool.host' };
      handler.pools.set(key, new Set(['segment-2']));

      const envelope = createUnbindEnvelope(
        formatAddress('svc', '*.pool.host')
      );
      const context = createDeliveryContext(DeliveryOriginType.DOWNSTREAM);

      await handler.acceptAddressUnbind(envelope, context);

      const poolEntry = getPoolEntry(handler, key);
      expect(poolEntry?.segments.has('segment-2')).toBe(true);
      expect(poolEntry?.segments.size).toBe(1);
      expect(forwardUpstream).not.toHaveBeenCalled();
    });

    it('throws when routing node lacks forwardToRoute support', async () => {
      const downstreamRoutes = new Map([
        [
          formatAddress('svc', '/local/path').toString(),
          { segment: 'segment-1', physicalPath: '/physical' },
        ],
      ]);

      const routeManager = createRouteManager({
        _downstream_addresses_routes: downstreamRoutes,
      });

      const testContext = createTestContext({ routeManager });
      const { handler, routingNode } = testContext;

      delete (routingNode as unknown as Record<string, unknown>).forwardToRoute;

      const envelope = createUnbindEnvelope(
        formatAddress('svc', '/local/path')
      );
      const context = createDeliveryContext(DeliveryOriginType.DOWNSTREAM);

      await expect(
        handler.acceptAddressUnbind(envelope, context)
      ).rejects.toThrow(/does not support forwardToRoute/i);

      expect(routingNode.forwardToRoute).toBeUndefined();
    });

    it('continues unbind when parseAddressComponents throws', async () => {
      const parseComponentsSpy = jest
        .spyOn(core, 'parseAddressComponents')
        .mockImplementation(() => {
          throw new Error('parse error');
        });

      const address = formatAddress('svc', '/local/path');
      const addressKey = address.toString();
      const downstreamRoutes = new Map([
        [addressKey, { segment: 'segment-1', physicalPath: '/physical/node' }],
      ]);

      const routeManager = createRouteManager({
        _downstream_addresses_routes: downstreamRoutes,
      });

      const testContext = createTestContext({ routeManager });
      const { handler, forwardUpstream } = testContext;

      const envelope = createUnbindEnvelope(address);
      const context = createDeliveryContext(DeliveryOriginType.DOWNSTREAM);

      await handler.acceptAddressUnbind(envelope, context);

      expect(downstreamRoutes.has(addressKey)).toBe(false);
      expect(forwardUpstream).toHaveBeenCalledWith(envelope, context);
      expect(parseComponentsSpy).toHaveBeenCalled();
    });
  });
});
