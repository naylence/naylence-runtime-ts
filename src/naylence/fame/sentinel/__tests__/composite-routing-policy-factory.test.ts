import { ROUTING_POLICY_FACTORY_BASE } from '../routing-policy.js';
import { CompositeRoutingPolicyFactory } from '../composite-routing-policy-factory.js';
import type { LoadBalancingStrategy } from '../load-balancing/load-balancing-strategy.js';

type LoggerInstance = {
  warning: jest.Mock<void, [string, Record<string, unknown>]>;
};

jest.mock('@naylence/factory', () => {
  const actual = jest.requireActual('@naylence/factory');
  return {
    ...actual,
    createResource: jest.fn(),
    registerFactory: jest.fn(),
  };
});

jest.mock('../../util/logging.js', () => {
  const logger: LoggerInstance = {
    warning: jest.fn<void, [string, Record<string, unknown>]>(),
  };

  return {
    getLogger: jest.fn(() => logger),
    __loggerMock: logger,
  };
});

jest.mock('../composite-routing-policy.js', () => ({
  CompositeRoutingPolicy: jest
    .fn()
    .mockImplementation((policies: unknown[]) => ({
      kind: 'CompositeRoutingPolicy',
      policies,
    })),
}));

jest.mock('../capability-aware-routing-policy.js', () => ({
  CapabilityAwareRoutingPolicy: jest
    .fn()
    .mockImplementation((options?: unknown) => ({
      kind: 'CapabilityAwareRoutingPolicy',
      options,
    })),
}));

jest.mock('../hybrid-path-routing-policy.js', () => ({
  HybridPathRoutingPolicy: jest
    .fn()
    .mockImplementation((options?: unknown) => ({
      kind: 'HybridPathRoutingPolicy',
      options,
    })),
}));

const { createResource: createResourceMock } = jest.requireMock(
  '@naylence/factory'
) as {
  createResource: jest.Mock;
};

const { CompositeRoutingPolicy: CompositeRoutingPolicyMock } = jest.requireMock(
  '../composite-routing-policy.js'
) as {
  CompositeRoutingPolicy: jest.Mock;
};

const { CapabilityAwareRoutingPolicy: CapabilityAwareRoutingPolicyMock } =
  jest.requireMock('../capability-aware-routing-policy.js') as {
    CapabilityAwareRoutingPolicy: jest.Mock;
  };

const { HybridPathRoutingPolicy: HybridPathRoutingPolicyMock } =
  jest.requireMock('../hybrid-path-routing-policy.js') as {
    HybridPathRoutingPolicy: jest.Mock;
  };

const { getLogger, __loggerMock: loggerInstance } = jest.requireMock(
  '../../util/logging.js'
) as {
  getLogger: jest.Mock<LoggerInstance, [string?]>;
  __loggerMock: LoggerInstance;
};

describe('CompositeRoutingPolicyFactory', () => {
  let factory: CompositeRoutingPolicyFactory;
  let logger: LoggerInstance;

  beforeEach(() => {
    createResourceMock.mockReset();
    CompositeRoutingPolicyMock.mockClear();
    CapabilityAwareRoutingPolicyMock.mockClear();
    HybridPathRoutingPolicyMock.mockClear();
    getLogger.mockClear();
    loggerInstance.warning.mockReset();
    logger = loggerInstance;
    getLogger.mockReturnValue(logger);
    factory = new CompositeRoutingPolicyFactory();
  });

  it('builds a composite policy from child configs', async () => {
    const strategy = { choose: jest.fn() } as unknown as LoadBalancingStrategy;
    const policyA = { kind: 'A' };
    const policyB = { kind: 'B' };
    createResourceMock
      .mockResolvedValueOnce(policyA)
      .mockResolvedValueOnce(policyB);

    const config = {
      type: 'CompositeRoutingPolicy' as const,
      policies: [{ type: 'PolicyA' }, { type: 'PolicyB' }],
    };

    const result = await factory.create(config, strategy);

    expect(createResourceMock).toHaveBeenNthCalledWith(
      1,
      ROUTING_POLICY_FACTORY_BASE,
      { type: 'PolicyA' },
      { factoryArgs: [strategy], validate: false }
    );
    expect(createResourceMock).toHaveBeenNthCalledWith(
      2,
      ROUTING_POLICY_FACTORY_BASE,
      { type: 'PolicyB' },
      { factoryArgs: [strategy], validate: false }
    );
    expect(CompositeRoutingPolicyMock).toHaveBeenCalledWith([policyA, policyB]);
    expect(result).toEqual({
      kind: 'CompositeRoutingPolicy',
      policies: [policyA, policyB],
    });
    expect(logger.warning).not.toHaveBeenCalled();
  });

  it('uses fallback policies when children are missing', async () => {
    const strategy = { choose: jest.fn() } as unknown as LoadBalancingStrategy;
    createResourceMock.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

    const config = {
      type: 'CompositeRoutingPolicy' as const,
      policies: [{ type: 'MissingA' }, { type: 'MissingB' }],
    };

    const result = await factory.create(config, strategy);

    expect(logger.warning).toHaveBeenNthCalledWith(
      1,
      'composite_policy_null_child',
      {
        config: { type: 'MissingA' },
      }
    );
    expect(logger.warning).toHaveBeenNthCalledWith(
      2,
      'composite_policy_null_child',
      {
        config: { type: 'MissingB' },
      }
    );
    expect(logger.warning).toHaveBeenCalledTimes(2);
    expect(CapabilityAwareRoutingPolicyMock).toHaveBeenCalledWith({
      loadBalancingStrategy: strategy,
    });
    expect(HybridPathRoutingPolicyMock).toHaveBeenCalledWith({
      loadBalancingStrategy: strategy,
    });
    expect(result).toEqual({
      kind: 'CompositeRoutingPolicy',
      policies: [
        {
          kind: 'CapabilityAwareRoutingPolicy',
          options: { loadBalancingStrategy: strategy },
        },
        {
          kind: 'HybridPathRoutingPolicy',
          options: { loadBalancingStrategy: strategy },
        },
      ],
    });
  });

  it('falls back when config is absent', async () => {
    const result = await factory.create();

    expect(CapabilityAwareRoutingPolicyMock).toHaveBeenCalledWith(undefined);
    expect(HybridPathRoutingPolicyMock).toHaveBeenCalledWith(undefined);
    expect(CompositeRoutingPolicyMock).toHaveBeenCalledWith([
      { kind: 'CapabilityAwareRoutingPolicy', options: undefined },
      { kind: 'HybridPathRoutingPolicy', options: undefined },
    ]);
    expect(result).toEqual({
      kind: 'CompositeRoutingPolicy',
      policies: [
        { kind: 'CapabilityAwareRoutingPolicy', options: undefined },
        { kind: 'HybridPathRoutingPolicy', options: undefined },
      ],
    });
  });

  it('continues after child creation throws', async () => {
    const strategy = { choose: jest.fn() } as unknown as LoadBalancingStrategy;
    const policy = { kind: 'valid' };
    createResourceMock
      .mockResolvedValueOnce(policy)
      .mockRejectedValueOnce(new Error('boom'));

    const config = {
      type: 'CompositeRoutingPolicy' as const,
      policies: [{ type: 'Ok' }, { type: 'Broken' }],
    };

    await factory.create(config, strategy);

    expect(logger.warning).toHaveBeenCalledWith(
      'composite_policy_child_error',
      {
        config: { type: 'Broken' },
        error: 'boom',
      }
    );
    expect(CompositeRoutingPolicyMock).toHaveBeenCalledWith([policy]);
  });

  it('skips null policy entries and only uses objects', async () => {
    const strategy = { choose: jest.fn() } as unknown as LoadBalancingStrategy;
    const policy = { kind: 'only' };
    createResourceMock.mockResolvedValueOnce(policy);

    const config = {
      type: 'CompositeRoutingPolicy' as const,
      policies: [null, undefined, { type: 'Only' }],
    };

    await factory.create(config, strategy);

    expect(createResourceMock).toHaveBeenCalledTimes(1);
    expect(createResourceMock).toHaveBeenCalledWith(
      ROUTING_POLICY_FACTORY_BASE,
      { type: 'Only' },
      { factoryArgs: [strategy], validate: false }
    );
  });

  it('normalizes snake_case type values and policy_configs alias', async () => {
    const strategy = { choose: jest.fn() } as unknown as LoadBalancingStrategy;
    const policy = { kind: 'cap' };
    createResourceMock.mockResolvedValueOnce(policy);

    const config = {
      type: 'composite_routing_policy',
      policy_configs: [{ type: 'capability_aware_routing_policy' }],
    } as unknown as Record<string, unknown>;

    const result = await factory.create(config, strategy);

    expect(createResourceMock).toHaveBeenCalledWith(
      ROUTING_POLICY_FACTORY_BASE,
      { type: 'CapabilityAwareRoutingPolicy' },
      { factoryArgs: [strategy], validate: false }
    );
    expect(result).toEqual({
      kind: 'CompositeRoutingPolicy',
      policies: [policy],
    });
  });

  it('validates config type and array structure', async () => {
    await expect(
      factory.create({ type: 'Other' } as unknown as { type: string })
    ).rejects.toThrow(
      'CompositeRoutingPolicyFactory only supports CompositeRoutingPolicy config, got type Other'
    );

    await expect(
      factory.create({
        type: 'CompositeRoutingPolicy',
        policies: 'bad',
      } as unknown as Record<string, unknown>)
    ).rejects.toThrow('policies must be an array when provided');
  });

  it('rejects non-object policy entries', async () => {
    await expect(
      factory.create({
        type: 'CompositeRoutingPolicy',
        policies: [42 as unknown as Record<string, unknown>],
      })
    ).rejects.toThrow('Each policy entry must be an object when provided');
  });

  it('treats null policies list as empty', async () => {
    await factory.create({ type: 'CompositeRoutingPolicy', policies: null });

    expect(createResourceMock).not.toHaveBeenCalled();
    expect(CapabilityAwareRoutingPolicyMock).toHaveBeenCalled();
    expect(HybridPathRoutingPolicyMock).toHaveBeenCalled();
  });
});
