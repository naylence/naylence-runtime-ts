import { createFameEnvelope, FameAddress } from 'naylence-core';

import { CapabilityAwareRoutingPolicy } from '../capability-aware-routing-policy.js';
import type { LoadBalancingStrategy } from '../load-balancing/load-balancing-strategy.js';
import {
  RouterState,
  Drop,
  DeliverLocal,
  ForwardChild,
  ForwardUp,
} from '../router.js';

describe('CapabilityAwareRoutingPolicy', () => {
  const baseStateOptions = () => ({
    nodeId: 'node-1',
    local: new Set<string>(),
    downstreamAddressRoutes: new Map(),
    peerAddressRoutes: new Map(),
    childSegments: new Set<string>(),
    peerSegments: new Set<string>(),
    hasParent: false,
    physicalSegments: ['node-1'],
    pools: new Map(),
    capabilities: {},
  });

  it('drops envelopes that already have an explicit destination', async () => {
    const policy = new CapabilityAwareRoutingPolicy();
    const envelope = createFameEnvelope({
      frame: { type: 'Data', payload: 'hello' },
      to: 'svc@/dest',
      capabilities: ['analytics'],
    });

    const state = new RouterState(baseStateOptions());

    const action = await policy.decide(envelope, state, null);
    expect(action).toBeInstanceOf(Drop);
  });

  it('delivers locally when resolver returns a local address', async () => {
    const localAddress = new FameAddress('svc@/local');
    const policy = new CapabilityAwareRoutingPolicy();

    const state = new RouterState({
      ...baseStateOptions(),
      local: new Set([localAddress.toString()]),
      resolveAddressByCapability: async () => localAddress,
    });

    const envelope = createFameEnvelope({
      frame: { type: 'Data', payload: 'hello' },
      capabilities: ['metrics'],
    });

    const action = await policy.decide(envelope, state, null);
    expect(action).toBeInstanceOf(DeliverLocal);

    const deliverLocal = jest.fn();
    await action.execute(envelope, { deliverLocal } as any, state, null);
    expect(deliverLocal).toHaveBeenCalledWith(
      localAddress,
      envelope,
      undefined
    );
  });

  it('drops non-data envelopes requesting capabilities', async () => {
    const policy = new CapabilityAwareRoutingPolicy();
    const state = new RouterState(baseStateOptions());

    const envelope = createFameEnvelope({
      frame: { type: 'DeliveryAck', ok: true },
      capabilities: ['metrics'],
    });

    const action = await policy.decide(envelope, state, null);
    expect(action).toBeInstanceOf(Drop);
  });

  it('drops when no capabilities are provided', async () => {
    const policy = new CapabilityAwareRoutingPolicy();
    const state = new RouterState(baseStateOptions());

    const envelope = createFameEnvelope({
      frame: { type: 'Data', payload: 'noop' },
    });

    const action = await policy.decide(envelope, state, null);
    expect(action).toBeInstanceOf(Drop);
  });

  it('forwards to child segment selected by load-balancing strategy when capabilities match', async () => {
    const chosenSegment = 'child-42';

    const stubStrategy: LoadBalancingStrategy = {
      choose: jest.fn(() => chosenSegment),
    };

    const policy = new CapabilityAwareRoutingPolicy({
      loadBalancingStrategy: stubStrategy,
    });

    const state = new RouterState({
      ...baseStateOptions(),
      childSegments: new Set(['child-42', 'child-7']),
      capabilities: {
        analytics: {
          'svc@/child-42': 'child-42',
          'svc@/child-7': 'child-7',
        },
        ingest: {
          'svc@/child-42': 'child-42',
        },
      },
    });

    const envelope = createFameEnvelope({
      frame: { type: 'Data', payload: { job: 'process' } },
      capabilities: ['analytics', 'ingest'],
    });

    const action = await policy.decide(envelope, state, null);
    expect(action).toBeInstanceOf(ForwardChild);
    expect(stubStrategy.choose).toHaveBeenCalledWith(
      ['analytics', 'ingest'],
      ['child-42'],
      envelope
    );

    const forwardToRoute = jest.fn();
    await action.execute(envelope, { forwardToRoute } as any, state, null);
    expect(forwardToRoute).toHaveBeenCalledWith(
      chosenSegment,
      envelope,
      undefined
    );
  });

  it('forwards upstream when capabilities cannot be satisfied locally or by children but a parent exists', async () => {
    const policy = new CapabilityAwareRoutingPolicy();

    const state = new RouterState({
      ...baseStateOptions(),
      hasParent: true,
      capabilities: {
        analytics: {
          'svc@/child-7': 'child-7',
        },
      },
      childSegments: new Set(['child-7']),
    });

    const envelope = createFameEnvelope({
      frame: { type: 'Data', payload: 1 },
      capabilities: ['analytics', 'compute'],
    });

    const action = await policy.decide(envelope, state, null);
    expect(action).toBeInstanceOf(ForwardUp);
  });

  it('falls back to provider segments when resolver returns non-local address', async () => {
    const chosenSegment = 'child-11';
    const stubStrategy: LoadBalancingStrategy = {
      choose: jest.fn(() => chosenSegment),
    };

    const policy = new CapabilityAwareRoutingPolicy({
      loadBalancingStrategy: stubStrategy,
    });

    const state = new RouterState({
      ...baseStateOptions(),
      resolveAddressByCapability: async () => new FameAddress('svc@/remote'),
      childSegments: new Set(['child-11']),
      capabilities: {
        analytics: {
          'svc@/child-11': 'child-11',
        },
      },
    });

    const envelope = createFameEnvelope({
      frame: { type: 'Data', payload: { report: true } },
      capabilities: ['analytics'],
    });

    const action = await policy.decide(envelope, state, null);
    expect(action).toBeInstanceOf(ForwardChild);
    expect(stubStrategy.choose).toHaveBeenCalledWith(
      ['analytics'],
      ['child-11'],
      envelope
    );
  });

  it('forwards upstream when load balancer declines to choose but parent exists', async () => {
    const stubStrategy: LoadBalancingStrategy = {
      choose: jest.fn(() => null),
    };

    const policy = new CapabilityAwareRoutingPolicy({
      loadBalancingStrategy: stubStrategy,
    });

    const state = new RouterState({
      ...baseStateOptions(),
      hasParent: true,
      childSegments: new Set(['child-5']),
      capabilities: {
        metrics: {
          'svc@/child-5': 'child-5',
        },
      },
    });

    const envelope = createFameEnvelope({
      frame: { type: 'Data', payload: 7 },
      capabilities: ['metrics'],
    });

    const action = await policy.decide(envelope, state, null);
    expect(action).toBeInstanceOf(ForwardUp);
    expect(stubStrategy.choose).toHaveBeenCalledWith(
      ['metrics'],
      ['child-5'],
      envelope
    );
  });

  it('drops when load balancer declines to choose and no parent exists', async () => {
    const stubStrategy: LoadBalancingStrategy = {
      choose: jest.fn(() => null),
    };

    const policy = new CapabilityAwareRoutingPolicy({
      loadBalancingStrategy: stubStrategy,
    });

    const state = new RouterState({
      ...baseStateOptions(),
      childSegments: new Set(['child-9']),
      capabilities: {
        io: {
          'svc@/child-9': 'child-9',
        },
      },
    });

    const envelope = createFameEnvelope({
      frame: { type: 'Data', payload: 9 },
      capabilities: ['io'],
    });

    const action = await policy.decide(envelope, state, null);
    expect(action).toBeInstanceOf(Drop);
  });

  it('drops when no route is available and no parent exists', async () => {
    const policy = new CapabilityAwareRoutingPolicy();

    const state = new RouterState({
      ...baseStateOptions(),
      capabilities: {},
    });

    const envelope = createFameEnvelope({
      frame: { type: 'Data', payload: { value: 1 } },
      capabilities: ['missing'],
    });

    const action = await policy.decide(envelope, state, null);
    expect(action).toBeInstanceOf(Drop);
  });

  it('drops when resolver throws an error resolving capabilities', async () => {
    const policy = new CapabilityAwareRoutingPolicy();

    const state = new RouterState({
      ...baseStateOptions(),
      resolveAddressByCapability: async () => {
        throw new Error('resolver failed');
      },
    });

    const envelope = createFameEnvelope({
      frame: { type: 'Data', payload: { job: 'process' } },
      capabilities: ['analytics'],
    });

    const action = await policy.decide(envelope, state, null);
    expect(action).toBeInstanceOf(Drop);
  });
});
