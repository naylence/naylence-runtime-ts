import {
  createFameEnvelope,
  DeliveryOriginType,
  FameAddress,
  FameResponseType,
  type FameDeliveryContext,
  type FameEnvelope,
} from 'naylence-core';

import { HybridPathRoutingPolicy } from '../hybrid-path-routing-policy.js';
import type { LoadBalancingStrategy } from '../load-balancing/load-balancing-strategy.js';
import { RouterState, Drop, DeliverLocal, ForwardChild, ForwardPeer, ForwardUp } from '../router.js';

describe('HybridPathRoutingPolicy', () => {
  const baseStateOptions = () => ({
    nodeId: 'node-1',
    local: new Set<FameAddress | string>(),
    downstreamAddressRoutes: new Map<string, string>(),
    peerAddressRoutes: new Map<string, string>(),
    childSegments: new Set<string>(),
    peerSegments: new Set<string>(),
    hasParent: false,
    physicalSegments: ['node-1'],
    pools: new Map<readonly [string, string], Set<string>>(),
    capabilities: {},
  });

  const createPolicy = (strategy?: LoadBalancingStrategy) =>
    new HybridPathRoutingPolicy(strategy ? { loadBalancingStrategy: strategy } : {});

  const toDataEnvelope = (to?: string): FameEnvelope =>
    createFameEnvelope({
      frame: { type: 'Data', payload: { id: 1 } },
      ...(to ? { to } : {}),
    });

  const toContext = (
    overrides: Partial<FameDeliveryContext> = {}
  ): FameDeliveryContext => ({
    expectedResponseType: FameResponseType.NONE,
    originType: DeliveryOriginType.LOCAL,
    ...overrides,
  });

  it('drops control frames that should not be routed', async () => {
    const policy = createPolicy();
    const state = new RouterState(baseStateOptions());
    const envelope = createFameEnvelope({
      frame: {
        type: 'NodeHello',
        systemId: 'node-2',
        instanceId: 'instance-1',
      },
    });

    const action = await policy.decide(envelope, state, null);
    expect(action).toBeInstanceOf(Drop);
  });

  it('forwards control frames upstream when a parent exists and origin is not upstream', async () => {
    const policy = createPolicy();
    const state = new RouterState({ ...baseStateOptions(), hasParent: true });
    const envelope = createFameEnvelope({
      frame: {
        type: 'NodeHeartbeat',
        systemId: 'node-2',
      },
    });

    const action = await policy.decide(
      envelope,
      state,
      toContext({ originType: DeliveryOriginType.DOWNSTREAM })
    );
    expect(action).toBeInstanceOf(ForwardUp);
  });

  it('drops control frames from upstream even when a parent exists', async () => {
    const policy = createPolicy();
    const state = new RouterState({ ...baseStateOptions(), hasParent: true });
    const envelope = createFameEnvelope({
      frame: {
        type: 'NodeHeartbeat',
        systemId: 'node-2',
      },
    });

    const action = await policy.decide(
      envelope,
      state,
      toContext({ originType: DeliveryOriginType.UPSTREAM })
    );
    expect(action).toBeInstanceOf(Drop);
  });

  it('drops key requests without an address', async () => {
    const policy = createPolicy();
    const state = new RouterState(baseStateOptions());
  const envelope = createFameEnvelope({ frame: { type: 'KeyRequest' } });

    const action = await policy.decide(envelope, state, null);
    expect(action).toBeInstanceOf(Drop);
  });

  it('drops routable frames missing destination addresses', async () => {
    const policy = createPolicy();
    const state = new RouterState(baseStateOptions());
    const envelope = createFameEnvelope({ frame: { type: 'Data', payload: { id: 2 } } });

    const action = await policy.decide(envelope, state, null);
    expect(action).toBeInstanceOf(Drop);
  });

  it('delivers locally when the destination is bound locally', async () => {
    const target = 'svc@/local';
    const policy = createPolicy();
    const state = new RouterState({
      ...baseStateOptions(),
      local: new Set<FameAddress | string>([target]),
    });

    const envelope = toDataEnvelope(target);
    const action = await policy.decide(envelope, state, null);
    expect(action).toBeInstanceOf(DeliverLocal);

    const deliverLocal = jest.fn();
    await action.execute(envelope, { deliverLocal } as any, state, null);
    expect(deliverLocal).toHaveBeenCalledWith(new FameAddress(target), envelope, undefined);
  });

  it('forwards to downstream routes unless the origin already matches the segment', async () => {
    const policy = createPolicy();
    const segment = 'child-1';
    const target = 'svc@/resource';
    const state = new RouterState({
      ...baseStateOptions(),
      downstreamAddressRoutes: new Map([[target, segment]]),
    });

    const envelope = toDataEnvelope(target);
    const action = await policy.decide(
      envelope,
      state,
      toContext({ originType: DeliveryOriginType.LOCAL, fromSystemId: 'node-1' })
    );
    expect(action).toBeInstanceOf(ForwardChild);

    const forwardToRoute = jest.fn();
    await action.execute(envelope, { forwardToRoute } as any, state, null);
    expect(forwardToRoute).toHaveBeenCalledWith(segment, envelope, undefined);

    const dropAction = await policy.decide(
      envelope,
      state,
      toContext({ originType: DeliveryOriginType.DOWNSTREAM, fromSystemId: segment })
    );
    expect(dropAction).toBeInstanceOf(Drop);
  });

  it('forwards to peer routes when present', async () => {
    const policy = createPolicy();
    const state = new RouterState({
      ...baseStateOptions(),
      peerAddressRoutes: new Map([['svc@/peer', 'peer-7']]),
    });
    const envelope = toDataEnvelope('svc@/peer');

    const action = await policy.decide(envelope, state, null);
    expect(action).toBeInstanceOf(ForwardPeer);
  });

  it('selects host-based pool members via load balancing', async () => {
    const chosenSegment = 'child-5';
    const strategy: LoadBalancingStrategy = {
      choose: jest.fn(() => chosenSegment),
    };
    const policy = createPolicy(strategy);

    const pools = new Map<readonly [string, string], Set<string>>([
      [['svc', '*.example.com'], new Set(['child-5', 'child-8'])],
    ]);

    const state = new RouterState({
      ...baseStateOptions(),
      pools,
    });

    const envelope = toDataEnvelope('svc@orders.example.com/path');
    const action = await policy.decide(envelope, state, null);
    expect(action).toBeInstanceOf(ForwardChild);
    expect(strategy.choose).toHaveBeenCalledWith(['svc', '*.example.com'], ['child-5', 'child-8'], envelope);

    const dropAction = await policy.decide(
      envelope,
      state,
      toContext({ originType: DeliveryOriginType.DOWNSTREAM, fromSystemId: chosenSegment })
    );
    expect(dropAction).toBeInstanceOf(Drop);
  });

  it('selects logical path pool members using load balancing', async () => {
    const chosenSegment = 'child-2';
    const strategy: LoadBalancingStrategy = {
      choose: jest.fn(() => chosenSegment),
    };
    const policy = createPolicy(strategy);

    const pools = new Map<readonly [string, string], Set<string>>([
      [['svc', 'regional/orders'], new Set(['child-2', 'child-9'])],
    ]);

    const state = new RouterState({
      ...baseStateOptions(),
      physicalSegments: ['node-1'],
      pools,
    });

    const envelope = toDataEnvelope('svc@/node-1/regional/orders');

    const action = await policy.decide(envelope, state, null);
    expect(action).toBeInstanceOf(ForwardChild);
    expect(strategy.choose).toHaveBeenCalledWith(
      ['svc', '/regional/orders'],
      ['child-2', 'child-9'],
      envelope
    );
  });

  it('drops logical pool routing when the origin matches the chosen member', async () => {
    const chosenSegment = 'child-4';
    const strategy: LoadBalancingStrategy = {
      choose: jest.fn(() => chosenSegment),
    };
    const policy = createPolicy(strategy);

    const pools = new Map<readonly [string, string], Set<string>>([
      [['svc', 'regional/orders'], new Set(['child-4', 'child-8'])],
    ]);

    const state = new RouterState({
      ...baseStateOptions(),
      physicalSegments: ['node-1'],
      pools,
    });

    const envelope = toDataEnvelope('svc@/node-1/regional/orders');
    const action = await policy.decide(
      envelope,
      state,
      toContext({
        originType: DeliveryOriginType.DOWNSTREAM,
        fromSystemId: chosenSegment,
      })
    );

    expect(action).toBeInstanceOf(Drop);
  });

  it('routes to peer segments based on path prefixes', async () => {
    const policy = createPolicy();
    const state = new RouterState({
      ...baseStateOptions(),
      peerSegments: new Set(['peer-1']),
    });

    const envelope = toDataEnvelope('svc@/peer-1/resource');
    const action = await policy.decide(envelope, state, null);
    expect(action).toBeInstanceOf(ForwardPeer);
  });

  it('routes to child segments when physical path prefix matches', async () => {
    const policy = createPolicy();
    const state = new RouterState({
      ...baseStateOptions(),
      childSegments: new Set(['child-3']),
    });

    const envelope = toDataEnvelope('svc@/node-1/child-3/data');
    const action = await policy.decide(envelope, state, null);
    expect(action).toBeInstanceOf(ForwardChild);
  });

  it('routes to child segments when there is no physical prefix', async () => {
    const policy = createPolicy();
    const state = new RouterState({
      ...baseStateOptions(),
      physicalSegments: [],
      childSegments: new Set(['child-9']),
    });

    const envelope = toDataEnvelope('svc@/child-9/data');
    const action = await policy.decide(envelope, state, null);
    expect(action).toBeInstanceOf(ForwardChild);
  });

  it('delivers locally when physical path matches without remainder', async () => {
    const policy = createPolicy();
    const state = new RouterState({
      ...baseStateOptions(),
      physicalSegments: ['node-1'],
    });

    const envelope = toDataEnvelope('svc@/node-1');
    const action = await policy.decide(envelope, state, null);
    expect(action).toBeInstanceOf(DeliverLocal);
  });

  it('forwards upstream when no route is available but a parent exists', async () => {
    const policy = createPolicy();
    const state = new RouterState({
      ...baseStateOptions(),
      hasParent: true,
      physicalSegments: [],
    });

    const envelope = toDataEnvelope('svc@/unroutable/path');
    const action = await policy.decide(envelope, state, null);
    expect(action).toBeInstanceOf(ForwardUp);
  });

  it('drops fallback routing when parent exists but origin is upstream', async () => {
    const policy = createPolicy();
    const state = new RouterState({
      ...baseStateOptions(),
      hasParent: true,
      physicalSegments: [],
    });

    const envelope = toDataEnvelope('svc@/unroutable/path');
    const action = await policy.decide(
      envelope,
      state,
      toContext({ originType: DeliveryOriginType.UPSTREAM })
    );
    expect(action).toBeInstanceOf(Drop);
  });

  it('drops when no route exists and there is no parent', async () => {
    const policy = createPolicy();
    const state = new RouterState({
      ...baseStateOptions(),
      physicalSegments: [],
    });

    const envelope = toDataEnvelope('svc@/nowhere');
    const action = await policy.decide(envelope, state, null);
    expect(action).toBeInstanceOf(Drop);
  });

  it('ignores unmatched pool entries when resolving host routes', async () => {
    const strategy: LoadBalancingStrategy = {
      choose: jest.fn(),
    };
    const policy = createPolicy(strategy);

    const pools = new Map<readonly [string, string], Set<string>>([
      [['other', '*.example.com'], new Set(['child-1'])],
      [['svc', '*.example.org'], new Set(['child-2'])],
    ]);

    const state = new RouterState({
      ...baseStateOptions(),
      pools,
    });

    const envelope = toDataEnvelope('svc@orders.example.com/path');
    const action = await policy.decide(envelope, state, null);
    expect(action).toBeInstanceOf(Drop);
    expect(strategy.choose).not.toHaveBeenCalled();
  });

  it('drops host-only destinations without matching pools or parent', async () => {
    const policy = createPolicy();
    const state = new RouterState({
      ...baseStateOptions(),
      physicalSegments: [],
      hasParent: false,
    });

    const envelope = toDataEnvelope('svc@example.com');
    const action = await policy.decide(envelope, state, null);
    expect(action).toBeInstanceOf(Drop);
  });

  it('skips logical pools that do not match the normalized path', async () => {
    const policy = createPolicy();
    const pools = new Map<readonly [string, string], Set<string>>([
      [['svc', 'regional/orders'], new Set(['child-6'])],
    ]);

    const state = new RouterState({
      ...baseStateOptions(),
      physicalSegments: ['node-1'],
      pools,
    });

    const envelope = toDataEnvelope('svc@/node-1/other');
    const action = await policy.decide(envelope, state, null);
    expect(action).toBeInstanceOf(Drop);
  });
});
