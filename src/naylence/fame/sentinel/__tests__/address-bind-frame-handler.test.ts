import {
  DeliveryOriginType,
  FameResponseType,
  formatAddress,
  type AddressBindFrame,
  type AddressUnbindFrame,
  type FameDeliveryContext,
  type FameEnvelope,
} from 'naylence-core';

import { AddressBindFrameHandler, type PoolKey, type RouteManagerLike } from '../address-bind-frame-handler.js';
import type { RoutingNodeLike } from '../../node/routing-node-like.js';

interface TestContext {
  handler: AddressBindFrameHandler;
  routeManager: RouteManagerLike;
  forwardToRoute: jest.Mock;
  forwardToPeers: jest.Mock;
  forwardUpstream: jest.Mock;
  envelopeFactory: { createEnvelope: jest.Mock };
}

function createRouteManager(overrides: Partial<RouteManagerLike> = {}): RouteManagerLike {
  const base: RouteManagerLike = {
    downstreamRoutes: new Map([["segment-1", {}]]),
    _peer_routes: undefined,
    _downstream_addresses_routes: new Map(),
    _peer_addresses_routes: undefined,
    _downstream_route_store: new Map<string, { assignedPath?: string | null; assigned_path?: string | null }>([
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

function createTestContext(options: {
  routeManager?: RouteManagerLike;
  upstreamConnector?: () => unknown;
} = {}): TestContext {
  const routeManager = options.routeManager ?? createRouteManager();
  const forwardToRoute = jest.fn();
  const forwardToPeers = jest.fn();
  const forwardUpstream = jest.fn();

  const envelopeFactory = {
    createEnvelope: jest.fn((opts: { frame: FameEnvelope['frame']; corrId?: string }) => ({
      id: `ack-${Math.random().toString(16).slice(2)}`,
      frame: opts.frame,
      ...(opts.corrId ? { corrId: opts.corrId } : {}),
    }) as FameEnvelope),
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
  };
}

function createDeliveryContext(originType: DeliveryOriginType): FameDeliveryContext {
  return {
    originType,
    fromSystemId: 'segment-1',
    meta: {},
    security: undefined,
  } as FameDeliveryContext;
}

function createBindEnvelope(address: ReturnType<typeof formatAddress>, overrides: Partial<AddressBindFrame> = {}): FameEnvelope {
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

function createUnbindEnvelope(address: ReturnType<typeof formatAddress>): FameEnvelope {
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

function getPoolEntry(handler: AddressBindFrameHandler, match: PoolKey): { key: PoolKey; segments: Set<string> } | null {
  for (const [key, segments] of handler.pools.entries()) {
    if (key.name === match.name && key.pattern === match.pattern) {
      return { key, segments };
    }
  }
  return null;
}

describe('AddressBindFrameHandler', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('acceptAddressBind', () => {
    it('registers downstream routes and forwards acknowledgements', async () => {
      const address = formatAddress('svc', '/local/path');
      const addressKey = address.toString();
      const routeManager = createRouteManager();
      const { handler, forwardToRoute, forwardToPeers, forwardUpstream, envelopeFactory } = createTestContext({
        routeManager,
      });

      const envelope = createBindEnvelope(address, { encryptionKeyId: 'enc-1' });
      const context = createDeliveryContext(DeliveryOriginType.DOWNSTREAM);

      await handler.acceptAddressBind(envelope, context);

      const storedRoute = (routeManager._downstream_addresses_routes as Map<string, any>).get(addressKey);
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
      expect(forwardToPeers).toHaveBeenCalledWith(envelope, undefined, ['segment-1'], context);
    });

    it('tracks pool bindings for wildcard host addresses', async () => {
  const address = formatAddress('svc', '*.pool.host');
      const routeManager = createRouteManager();
      const { handler, routeManager: ctxRouteManager } = createTestContext({ routeManager });

      const envelope = createBindEnvelope(address);
      const context = createDeliveryContext(DeliveryOriginType.DOWNSTREAM);

      await handler.acceptAddressBind(envelope, context);

  const poolEntry = getPoolEntry(handler, { name: 'svc', pattern: '*.pool.host' });
      expect(poolEntry).not.toBeNull();
      expect(poolEntry?.segments.has('segment-1')).toBe(true);

      const downstreamRoutes = ctxRouteManager._downstream_addresses_routes as Map<string, unknown>;
      expect(downstreamRoutes.size).toBe(0);
    });
  });

  describe('acceptAddressUnbind', () => {
    it('removes pool bindings and forwards upstream', async () => {
      const address = formatAddress('svc', '*.pool.host');
      const routeManager = createRouteManager();
      const testContext = createTestContext({ routeManager });
      const { handler, forwardToRoute, forwardUpstream } = testContext;

      handler.pools.set({ name: 'svc', pattern: '*.pool.host' }, new Set(['segment-1']));

      const envelope = createUnbindEnvelope(address);
      const context = createDeliveryContext(DeliveryOriginType.DOWNSTREAM);

      await handler.acceptAddressUnbind(envelope, context);

      const poolEntry = getPoolEntry(handler, { name: 'svc', pattern: '*.pool.host' });
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
      const downstreamRoutes = new Map([[addressKey, { segment: 'segment-1', physicalPath: '/physical/node' }]]);
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
  });
});
