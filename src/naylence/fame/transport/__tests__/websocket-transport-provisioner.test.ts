import { ResourceFactoryRegistry } from '@naylence/factory';
import type { NodeHelloFrame } from '@naylence/core';

import {
  TransportProvisionerFactory,
  TRANSPORT_PROVISIONER_FACTORY_BASE_TYPE,
} from '../transport-provisioner.js';
import { WebSocketTransportProvisioner } from '../websocket-transport-provisioner.js';
import type { PlacementDecision } from '../../placement/node-placement-strategy.js';

function makeHelloFrame(
  overrides: Partial<NodeHelloFrame> = {}
): NodeHelloFrame {
  return {
    type: 'NodeHello',
    systemId: 'child-system',
    instanceId: 'child-instance',
    ...overrides,
  };
}

function makePlacementDecision(
  overrides: Partial<PlacementDecision> = {}
): PlacementDecision {
  return {
    accept: true,
    assignedPath: '/child',
    ...overrides,
  };
}

describe('WebSocketTransportProvisioner', () => {
  afterEach(() => {
    ResourceFactoryRegistry.clearCache(TRANSPORT_PROVISIONER_FACTORY_BASE_TYPE);
  });

  it('provisions a websocket connection grant when supported', async () => {
    const provisioner = new WebSocketTransportProvisioner({
      url: 'ws://localhost:8080/ws',
    });

    const hello = makeHelloFrame({
      supportedTransports: ['websocket', 'http'],
    });
    const decision = makePlacementDecision();

    const result = await provisioner.provision(decision, hello, {});

    expect(result.cleanupHandle).toBeNull();
    expect(result.connectionGrant).toMatchObject({
      type: 'WebSocketConnectionGrant',
      purpose: 'node.attach',
      url: 'ws://localhost:8080/ws',
    });
  });

  it('throws when websocket transport is not supported', async () => {
    const provisioner = new WebSocketTransportProvisioner({
      url: 'ws://example.com/ws',
    });
    const hello = makeHelloFrame({ supportedTransports: ['http'] });
    const decision = makePlacementDecision();

    await expect(provisioner.provision(decision, hello, {})).rejects.toThrow(
      'Unsupported transports: http'
    );
  });

  it('includes auth configuration and ttl metadata when attach token provided', async () => {
    const provisioner = new WebSocketTransportProvisioner({
      url: 'ws://example.com/ws',
      ttlSec: 90,
    });
    const hello = makeHelloFrame({ supportedTransports: ['websocket'] });
    const decision = makePlacementDecision();

    const result = await provisioner.provision(
      decision,
      hello,
      {},
      'secret-token'
    );

    const grant = result.connectionGrant as Record<string, unknown>;
    expect(grant).toMatchObject({
      auth: expect.objectContaining({ type: 'WebSocketSubprotocolAuth' }),
    });

    const tokenProvider = (grant.auth as Record<string, unknown>)
      .tokenProvider as Record<string, unknown>;
    expect(tokenProvider).toMatchObject({
      type: 'StaticTokenProvider',
      token: 'secret-token',
    });

    expect(result.metadata).toMatchObject({ ttlSec: 90 });
  });
});

describe('TransportProvisionerFactory', () => {
  afterEach(() => {
    ResourceFactoryRegistry.clearCache(TRANSPORT_PROVISIONER_FACTORY_BASE_TYPE);
  });

  it('creates websocket provisioner from configuration', async () => {
    const provisioner =
      await TransportProvisionerFactory.createTransportProvisioner({
        type: 'WebSocketTransportProvisioner',
        url: 'ws://fabric/ws',
      });

    expect(provisioner).toBeInstanceOf(WebSocketTransportProvisioner);
  });
});
