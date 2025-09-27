import { jest } from '@jest/globals';

import type { NodeHelloFrame } from 'naylence-core';

import { NodePlacementStrategyFactory, type PlacementDecision } from '../node-placement-strategy.js';
import { StaticNodePlacementStrategy } from '../static-node-placement-strategy.js';
import { StaticNodePlacementStrategyFactory } from '../static-node-placement-strategy-factory.js';
import { WebSocketPlacementStrategyFactory } from '../websocket-node-placement-strategy-factory.js';
import { pushNode } from '../../node/node-context-stack.js';
import type { NodeLike } from '../../node/node-like.js';

function createHelloFrame(overrides: Partial<NodeHelloFrame> = {}): NodeHelloFrame {
  return {
    type: 'NodeHello',
    systemId: overrides.systemId ?? 'child-node',
    instanceId: overrides.instanceId ?? 'instance-123',
    logicals: overrides.logicals,
    capabilities: overrides.capabilities,
    supportedTransports: overrides.supportedTransports,
    regionHint: overrides.regionHint,
    securitySettings: overrides.securitySettings,
  } satisfies NodeHelloFrame;
}

function expectDecision(
  decision: PlacementDecision,
  expected: Partial<PlacementDecision>
): void {
  expect(decision.accept).toBe(true);
  expect(decision.assignedPath).toBe(expected.assignedPath);
  expect(decision.targetSystemId).toBe(
    expected.targetSystemId ?? decision.targetSystemId
  );
  expect(decision.targetPhysicalPath).toBe(
    expected.targetPhysicalPath ?? decision.targetPhysicalPath
  );
  expect(decision.metadata).toEqual(expected.metadata ?? decision.metadata);
}

describe('StaticNodePlacementStrategy', () => {
  it('treats matching system id as root node', async () => {
    const strategy = new StaticNodePlacementStrategy({
      targetSystemId: 'root-node',
      targetPhysicalPath: '/root',
    });

    const decision = await strategy.place(
      createHelloFrame({ systemId: 'root-node' })
    );

    expectDecision(decision, {
      targetSystemId: null,
      targetPhysicalPath: null,
      assignedPath: '/root-node',
      metadata: {
        accepted_logicals: null,
        accepted_capabilities: null,
      },
    });
  });

  it('assigns child nodes under the configured path', async () => {
    const strategy = new StaticNodePlacementStrategy({
      targetSystemId: 'parent-node',
      targetPhysicalPath: '/parent/path',
    });

    const decision = await strategy.place(
      createHelloFrame({
        systemId: 'child-node',
        logicals: ['sensor'],
        capabilities: ['telemetry'],
      })
    );

    expectDecision(decision, {
      targetSystemId: 'parent-node',
      targetPhysicalPath: '/parent/path',
      assignedPath: '/parent/path/child-node',
      metadata: {
        accepted_logicals: ['sensor'],
        accepted_capabilities: ['telemetry'],
      },
    });
  });
});

describe('StaticNodePlacementStrategyFactory', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('creates a static strategy from camelCase config', async () => {
    const factory = new StaticNodePlacementStrategyFactory();
    const strategy = await factory.create({
      type: 'StaticNodePlacementStrategy',
      targetSystemId: 'parent-node',
      targetPhysicalPath: '/parent',
    });

    const decision = await strategy.place(
      createHelloFrame({ systemId: 'child' })
    );
    expect(decision.assignedPath).toBe('/parent/child');
    expect(decision.targetSystemId).toBe('parent-node');
  });

  it('normalizes snake_case fields', async () => {
    const factory = new StaticNodePlacementStrategyFactory();
    const strategy = await factory.create({
      type: 'StaticNodePlacementStrategy',
      target_system_id: 'parent-node',
      target_physical_path: '/parent',
    });

    const decision = await strategy.place(
      createHelloFrame({ systemId: 'child' })
    );
    expect(decision.assignedPath).toBe('/parent/child');
  });

  it('emits a deprecation warning when using the legacy WebSocket type alias', async () => {
    const emitSpy = jest
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => void 0);

    const factory = new StaticNodePlacementStrategyFactory();
    await factory.create({
      type: 'WebSocketNodePlacementStrategy',
      targetSystemId: 'parent-node',
      targetPhysicalPath: '/parent',
    });

    expect(emitSpy).toHaveBeenCalledWith(
      expect.stringContaining('deprecated'),
      expect.objectContaining({ type: 'DeprecationWarning' })
    );
  });
});

describe('NodePlacementStrategyFactory defaults', () => {
  it('matches the Python failure semantics when no default factory is registered', async () => {
    await expect(
      NodePlacementStrategyFactory.createNodePlacementStrategy()
    ).rejects.toThrow('Failed to create default node placement strategy');
  });
});

describe('WebSocketPlacementStrategyFactory', () => {
  const baseNode: NodeLike = {
    id: 'parent-id',
    sid: 'parent-sid',
    physicalPath: '/parent',
    acceptedLogicals: new Set(),
    envelopeFactory: {} as any,
    deliveryPolicy: null,
    defaultBindingPath: '/',
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
    bind: jest.fn(async () => ({}) as any),
    unbind: jest.fn(async () => void 0),
    send: jest.fn(async () => null),
    listen: jest.fn(async () => ({}) as any),
    listenRpc: jest.fn(async () => ({}) as any),
    invoke: jest.fn(async () => ({})),
    invokeByCapability: jest.fn(async () => ({})),
    invokeStreaming: jest.fn(async function* () {
      return;
    }),
    registerService: jest.fn(async () => ({})),
    unregisterService: jest.fn(async () => void 0),
    getRegisteredServices: jest.fn(() => []),
    registerParticipant: jest.fn(async () => ({})),
    unregisterParticipant: jest.fn(async () => void 0),
    getRegisteredParticipants: jest.fn(() => []),
    registerDeliveryPolicy: jest.fn(() => void 0),
    unregisterDeliveryPolicy: jest.fn(() => void 0),
    getDeliveryPolicy: jest.fn(() => null),
    getAcceptedLogicals: jest.fn(() => new Set()),
    hasCapability: jest.fn(() => false),
    getCapabilities: jest.fn(() => new Set()),
    getCapability: jest.fn(() => null),
    listCapabilities: jest.fn(() => []),
    getConnector: jest.fn(() => null),
    getConnectorNames: jest.fn(() => []),
    registerConnector: jest.fn(() => void 0),
    unregisterConnector: jest.fn(() => void 0),
    getAdmissionClient: jest.fn(() => null),
    getSecurityManager: jest.fn(() => null),
  } as unknown as NodeLike;

  beforeEach(() => {
    jest.spyOn(process, 'emitWarning').mockImplementation(() => void 0);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses the node context when no resolvers are provided', async () => {
    const pop = pushNode(baseNode);
    try {
      const factory = new WebSocketPlacementStrategyFactory();
      const strategy = await factory.create({
        type: 'WebSocketNodePlacementStrategy',
      });

      const decision = await strategy.place(
        createHelloFrame({ systemId: 'child' })
      );

      expect(decision.targetSystemId).toBe('parent-id');
      expect(decision.assignedPath).toBe('/parent/child');
      expect(process.emitWarning).toHaveBeenCalledWith(
        expect.stringContaining('deprecated'),
        expect.objectContaining({ type: 'DeprecationWarning' })
      );
    } finally {
      pop();
    }
  });

  it('prefers injected resolver functions over node context', async () => {
    const customFactory = new WebSocketPlacementStrategyFactory(
      () => 'injected-parent',
      () => '/custom/path'
    );

    const strategy = await customFactory.create({
      type: 'WebSocketNodePlacementStrategy',
    });
    const decision = await strategy.place(
      createHelloFrame({ systemId: 'child' })
    );

    expect(decision.targetSystemId).toBe('injected-parent');
    expect(decision.assignedPath).toBe('/custom/path/child');
  });
});
