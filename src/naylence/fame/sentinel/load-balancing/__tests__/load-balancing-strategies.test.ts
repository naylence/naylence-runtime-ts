import type { FameEnvelope } from '@naylence/core';

import { CompositeLoadBalancingStrategy } from '../composite-load-balancing-strategy.js';
import { CompositeLoadBalancingStrategyFactory } from '../composite-load-balancing-strategy-factory.js';
import { RandomLoadBalancingStrategy } from '../random-load-balancing-strategy.js';
import { RandomLoadBalancingStrategyFactory } from '../random-load-balancing-strategy-factory.js';
import { RoundRobinLoadBalancingStrategy } from '../round-robin-load-balancing-strategy.js';
import { RoundRobinLoadBalancingStrategyFactory } from '../round-robin-load-balancing-strategy-factory.js';
import { StickyLoadBalancingStrategy } from '../sticky-load-balancing-strategy.js';
import { StickyLoadBalancingStrategyFactory } from '../sticky-load-balancing-strategy-factory.js';
import {
  LoadBalancingProfileFactory,
  PROFILE_NAME_DEVELOPMENT,
  PROFILE_NAME_HRW,
  PROFILE_NAME_RANDOM,
  PROFILE_NAME_ROUND_ROBIN,
  PROFILE_NAME_STICKY_HRW,
} from '../load-balancing-profile-factory.js';
import { LoadBalancingStrategyFactory } from '../load-balancing-strategy-factory.js';
import type { LoadBalancerStickinessManager } from '../../../stickiness/load-balancer-stickiness-manager.js';
import type { LoadBalancingStrategy } from '../load-balancing-strategy.js';
import '../hrw-load-balancing-strategy-factory.js';

const createEnvelope = (
  overrides: Partial<FameEnvelope> = {}
): FameEnvelope => {
  return {
    id: 'env-1',
    frame: { type: 'Data', payload: null } as FameEnvelope['frame'],
    version: '1.0',
    flowFlags: 0,
    seqId: 0,
    ts: new Date(),
    traceId: 'trace-1',
    ...overrides,
  } as FameEnvelope;
};

describe('RandomLoadBalancingStrategy', () => {
  it('returns null when there are no segments', () => {
    const strategy = new RandomLoadBalancingStrategy({ rng: () => 0.5 });
    expect(strategy.choose('pool', [], createEnvelope())).toBeNull();
  });

  it('selects a segment using injected RNG', () => {
    const strategy = new RandomLoadBalancingStrategy({ rng: () => 0.9 });
    expect(strategy.choose('pool', ['a', 'b', 'c'], createEnvelope())).toBe(
      'c'
    );
  });

  it('clamps RNG results to valid range', () => {
    const strategy = new RandomLoadBalancingStrategy({ rng: () => 1.5 });
    expect(strategy.choose('pool', ['first', 'second'], createEnvelope())).toBe(
      'second'
    );
  });
});

describe('RoundRobinLoadBalancingStrategy', () => {
  it('cycles through segments per pool key', () => {
    const strategy = new RoundRobinLoadBalancingStrategy();
    const segments = ['s1', 's2', 's3'];
    const envelope = createEnvelope();

    expect(strategy.choose('pool', segments, envelope)).toBe('s1');
    expect(strategy.choose('pool', segments, envelope)).toBe('s2');
    expect(strategy.choose('pool', segments, envelope)).toBe('s3');
    expect(strategy.choose('pool', segments, envelope)).toBe('s1');
  });

  it('maintains separate counters per pool key', () => {
    const strategy = new RoundRobinLoadBalancingStrategy();
    const segments = ['s1', 's2'];
    const envelope = createEnvelope();

    expect(strategy.choose('pool-a', segments, envelope)).toBe('s1');
    expect(strategy.choose('pool-b', segments, envelope)).toBe('s1');
    expect(strategy.choose('pool-a', segments, envelope)).toBe('s2');
    expect(strategy.choose('pool-b', segments, envelope)).toBe('s2');
  });
});

describe('StickyLoadBalancingStrategy', () => {
  const segments = ['alpha', 'beta'];
  const envelope = createEnvelope({
    id: 'sticky-env',
    aft: { session: 'abc' } as unknown as FameEnvelope['aft'],
  });

  it('routes using stickiness manager result when present in segments', () => {
    const stickinessManager: LoadBalancerStickinessManager & {
      getMetrics: () => Record<string, unknown>;
      getAssociations: () => Record<string, unknown>;
    } = {
      negotiate: () => null,
      getStickyReplicaSegment: () => 'beta',
      getMetrics: jest.fn(() => ({ hits: 1 })),
      getAssociations: jest.fn(() => ({ beta: ['abc'] })),
    };

    const strategy = new StickyLoadBalancingStrategy(stickinessManager);
    expect(strategy.choose('pool', segments, envelope)).toBe('beta');
    expect(strategy.getLastChosenReplica()).toBe('beta');
    expect(strategy.getMetrics()).toEqual({ hits: 1 });
    expect(strategy.getAssociations()).toEqual({ beta: ['abc'] });
  });

  it('returns null when stickiness manager has no match', () => {
    const stickinessManager: LoadBalancerStickinessManager = {
      negotiate: () => null,
      getStickyReplicaSegment: () => 'gamma',
    };

    const strategy = new StickyLoadBalancingStrategy(stickinessManager);
    expect(strategy.choose('pool', segments, envelope)).toBeNull();
  });
});

describe('CompositeLoadBalancingStrategy', () => {
  const envelope = createEnvelope();
  const segments = ['one', 'two'];

  const createMockStrategy = (
    impl: (
      poolKey: unknown,
      candidates: readonly string[],
      env: FameEnvelope
    ) => string | null
  ): LoadBalancingStrategy & { choose: jest.Mock } => ({
    choose: jest.fn(
      (poolKey: unknown, candidates: readonly string[], env: FameEnvelope) =>
        impl(poolKey, candidates, env)
    ),
  });

  it('tries strategies sequentially until one succeeds', () => {
    const strategyA = createMockStrategy(() => null);
    const strategyB = createMockStrategy(() => 'two');

    const composite = new CompositeLoadBalancingStrategy([
      strategyA,
      strategyB,
    ]);

    expect(composite.choose('pool', segments, envelope)).toBe('two');
    expect(strategyA.choose).toHaveBeenCalledTimes(1);
    expect(strategyB.choose).toHaveBeenCalledTimes(1);
  });

  it('continues when a nested strategy throws', () => {
    const strategyA = createMockStrategy(() => {
      throw new Error('boom');
    });
    const strategyB = createMockStrategy(() => 'one');

    const composite = new CompositeLoadBalancingStrategy([
      strategyA,
      strategyB,
    ]);

    expect(composite.choose('pool', segments, envelope)).toBe('one');
  });

  it('returns null when all strategies fail', () => {
    const strategyA = createMockStrategy(() => null);
    const strategyB = createMockStrategy(() => null);

    const composite = new CompositeLoadBalancingStrategy([
      strategyA,
      strategyB,
    ]);

    expect(composite.choose('pool', segments, envelope)).toBeNull();
  });
});

describe('Load balancing strategy factories', () => {
  const stickinessManager: LoadBalancerStickinessManager = {
    negotiate: () => null,
    getStickyReplicaSegment: () => null,
  };

  it('RandomLoadBalancingStrategyFactory creates a random strategy', async () => {
    const factory = new RandomLoadBalancingStrategyFactory();
    const strategy = await factory.create({
      type: 'RandomLoadBalancingStrategy',
    });
    expect(strategy).toBeInstanceOf(RandomLoadBalancingStrategy);
  });

  it('RoundRobinLoadBalancingStrategyFactory creates a round-robin strategy', async () => {
    const factory = new RoundRobinLoadBalancingStrategyFactory();
    const strategy = await factory.create({
      type: 'RoundRobinLoadBalancingStrategy',
    });
    expect(strategy).toBeInstanceOf(RoundRobinLoadBalancingStrategy);
  });

  it('StickyLoadBalancingStrategyFactory requires stickiness manager', async () => {
    const factory = new StickyLoadBalancingStrategyFactory();
    await expect(
      factory.create({ type: 'StickyLoadBalancingStrategy' })
    ).rejects.toThrow(/stickinessManager/);

    const strategy = await factory.create(
      { type: 'StickyLoadBalancingStrategy' },
      { stickinessManager }
    );
    expect(strategy).toBeInstanceOf(StickyLoadBalancingStrategy);
  });

  it('CompositeLoadBalancingStrategyFactory composes nested strategies', async () => {
    const factory = new CompositeLoadBalancingStrategyFactory();
    const strategy = await factory.create(
      {
        type: 'CompositeLoadBalancingStrategy',
        strategies: [
          { type: 'RoundRobinLoadBalancingStrategy' },
          { type: 'RandomLoadBalancingStrategy' },
        ],
      },
      { stickinessManager }
    );

    expect(strategy).toBeInstanceOf(CompositeLoadBalancingStrategy);
  });

  it('LoadBalancingProfileFactory creates strategies for built-in profiles', async () => {
    const factory = new LoadBalancingProfileFactory();

    const randomStrategy = await factory.create({
      type: 'LoadBalancingProfile',
      profile: PROFILE_NAME_RANDOM,
    });
    expect(randomStrategy).toBeInstanceOf(RandomLoadBalancingStrategy);

    const rrStrategy = await factory.create({
      type: 'LoadBalancingProfile',
      profile: PROFILE_NAME_ROUND_ROBIN,
    });
    expect(rrStrategy).toBeInstanceOf(RoundRobinLoadBalancingStrategy);

    const hrwStrategy = await factory.create({
      type: 'LoadBalancingProfile',
      profile: PROFILE_NAME_HRW,
    });
    expect(hrwStrategy.constructor.name).toBe('HRWLoadBalancingStrategy');

    const stickyHrwStrategy = await factory.create({
      type: 'LoadBalancingProfile',
      profile: PROFILE_NAME_STICKY_HRW,
    });
    expect(stickyHrwStrategy.constructor.name).toBe('HRWLoadBalancingStrategy');

    const devStrategy = await factory.create({
      type: 'LoadBalancingProfile',
      profile: PROFILE_NAME_DEVELOPMENT,
    });
    expect(devStrategy).toBeInstanceOf(RoundRobinLoadBalancingStrategy);
  });

  it('LoadBalancingStrategyFactory.createLoadBalancingStrategy defaults to HRW strategy', async () => {
    const strategy =
      await LoadBalancingStrategyFactory.createLoadBalancingStrategy();
    expect(strategy.constructor.name).toBe('HRWLoadBalancingStrategy');
  });
});
