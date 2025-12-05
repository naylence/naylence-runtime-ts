import { jest } from '@jest/globals';

import type { NodeHelloFrame } from '@naylence/core';

import type { PlacementDecision } from '../node-placement-strategy.js';
import { NodePlacementStrategyFactory } from '../node-placement-strategy-factory.js';
import { StaticNodePlacementStrategy } from '../static-node-placement-strategy.js';
import { StaticNodePlacementStrategyFactory } from '../static-node-placement-strategy-factory.js';

function createHelloFrame(
  overrides: Partial<NodeHelloFrame> = {}
): NodeHelloFrame {
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

  it('accepts snake_case constructor options', async () => {
    const strategy = new StaticNodePlacementStrategy({
      target_system_id: 'parent-node',
      target_physical_path: '/parent/path',
    });

    const decision = await strategy.place(
      createHelloFrame({ systemId: 'child-node' })
    );

    expectDecision(decision, {
      targetSystemId: 'parent-node',
      targetPhysicalPath: '/parent/path',
      assignedPath: '/parent/path/child-node',
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

  it('throws when using the removed WebSocket type alias', async () => {
    const factory = new StaticNodePlacementStrategyFactory();
    await expect(
      factory.create({
        type: 'WebSocketNodePlacementStrategy',
        targetSystemId: 'parent-node',
        targetPhysicalPath: '/parent',
      } as any)
    ).rejects.toThrow('WebSocketNodePlacementStrategy has been removed');
  });
});

describe('NodePlacementStrategyFactory defaults', () => {
  it('matches the Python failure semantics when no default factory is registered', async () => {
    await expect(
      NodePlacementStrategyFactory.createNodePlacementStrategy()
    ).rejects.toThrow('Failed to create default node placement strategy');
  });
});
