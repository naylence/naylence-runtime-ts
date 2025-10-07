import type { LoadBalancingStrategy } from '../load-balancing/load-balancing-strategy.js';
import {
  LOAD_BALANCING_STRATEGY_FACTORY_BASE,
  LoadBalancingStrategyFactory,
} from '../load-balancing/load-balancing-strategy-factory.js';
import { HybridPathRoutingPolicyFactory } from '../hybrid-path-routing-policy-factory.js';

jest.mock('naylence-factory', () => {
  const actual = jest.requireActual('naylence-factory');
  return {
    ...actual,
    createResource: jest.fn(),
    registerFactory: jest.fn(),
  };
});

jest.mock('../hybrid-path-routing-policy.js', () => ({
  HybridPathRoutingPolicy: jest.fn().mockImplementation((options: unknown) => ({
    kind: 'HybridPathRoutingPolicy',
    options,
  })),
}));

const { createResource: createResourceMock } = jest.requireMock(
  'naylence-factory'
) as {
  createResource: jest.MockedFunction<
    (typeof import('naylence-factory'))['createResource']
  >;
};

const { HybridPathRoutingPolicy: HybridPathRoutingPolicyMock } =
  jest.requireMock('../hybrid-path-routing-policy.js') as {
    HybridPathRoutingPolicy: jest.Mock;
  };

const makeStrategy = (label: string): LoadBalancingStrategy => ({
  choose: jest.fn(() => label),
});

describe('HybridPathRoutingPolicyFactory', () => {
  let factory: HybridPathRoutingPolicyFactory;
  const createStrategySpy = jest.spyOn(
    LoadBalancingStrategyFactory,
    'createLoadBalancingStrategy'
  );

  beforeEach(() => {
    createResourceMock.mockReset();
    HybridPathRoutingPolicyMock.mockClear();
    createStrategySpy.mockReset();
    factory = new HybridPathRoutingPolicyFactory();
  });

  it('uses a provided strategy when supplied via factory args', async () => {
    const providedStrategy = makeStrategy('provided');

    const policy = await factory.create(null, providedStrategy);

    expect(createResourceMock).not.toHaveBeenCalled();
    expect(createStrategySpy).not.toHaveBeenCalled();
    expect(HybridPathRoutingPolicyMock).toHaveBeenCalledWith({
      loadBalancingStrategy: providedStrategy,
    });
    expect(policy).toEqual({
      kind: 'HybridPathRoutingPolicy',
      options: { loadBalancingStrategy: providedStrategy },
    });
  });

  it('creates a strategy via resource when config supplies one', async () => {
    const createdStrategy = makeStrategy('resource');
    createResourceMock.mockResolvedValueOnce(createdStrategy);

    const policy = await factory.create({
      type: 'HybridPathRoutingPolicy',
      loadBalancingStrategy: { type: 'custom' },
    });

    expect(createResourceMock).toHaveBeenCalledWith(
      LOAD_BALANCING_STRATEGY_FACTORY_BASE,
      {
        type: 'custom',
      }
    );
    expect(createStrategySpy).not.toHaveBeenCalled();
    expect(HybridPathRoutingPolicyMock).toHaveBeenCalledWith({
      loadBalancingStrategy: createdStrategy,
    });
    expect(policy).toEqual({
      kind: 'HybridPathRoutingPolicy',
      options: { loadBalancingStrategy: createdStrategy },
    });
  });

  it('falls back to LoadBalancingStrategyFactory when resource creation returns null', async () => {
    createResourceMock.mockResolvedValueOnce(null);
    const fallbackStrategy = makeStrategy('fallback');
    createStrategySpy.mockResolvedValueOnce(fallbackStrategy);

    const policy = await factory.create({
      type: 'HybridPathRoutingPolicy',
      loadBalancingStrategy: { type: 'custom' },
    });

    expect(createResourceMock).toHaveBeenCalledWith(
      LOAD_BALANCING_STRATEGY_FACTORY_BASE,
      {
        type: 'custom',
      }
    );
    expect(createStrategySpy).toHaveBeenCalledWith({ type: 'custom' });
    expect(HybridPathRoutingPolicyMock).toHaveBeenCalledWith({
      loadBalancingStrategy: fallbackStrategy,
    });
    expect(policy).toEqual({
      kind: 'HybridPathRoutingPolicy',
      options: { loadBalancingStrategy: fallbackStrategy },
    });
  });

  it('falls back to LoadBalancingStrategyFactory when config is missing', async () => {
    const defaultStrategy = makeStrategy('default');
    createStrategySpy.mockResolvedValueOnce(defaultStrategy);

    const policy = await factory.create();

    expect(createResourceMock).not.toHaveBeenCalled();
    expect(createStrategySpy).toHaveBeenCalledWith(null);
    expect(HybridPathRoutingPolicyMock).toHaveBeenCalledWith({
      loadBalancingStrategy: defaultStrategy,
    });
    expect(policy).toEqual({
      kind: 'HybridPathRoutingPolicy',
      options: { loadBalancingStrategy: defaultStrategy },
    });
  });

  it('rejects when config type is not HybridPathRoutingPolicy', async () => {
    await expect(
      factory.create({
        type: 'OtherPolicy',
        loadBalancingStrategy: null,
      } as any)
    ).rejects.toThrow(
      'HybridPathRoutingPolicyFactory only supports HybridPathRoutingPolicy config'
    );

    expect(createResourceMock).not.toHaveBeenCalled();
    expect(createStrategySpy).not.toHaveBeenCalled();
    expect(HybridPathRoutingPolicyMock).not.toHaveBeenCalled();
  });

  it('rejects when loadBalancingStrategy is not an object', async () => {
    await expect(
      factory.create({
        type: 'HybridPathRoutingPolicy',
        loadBalancingStrategy: 42 as unknown as Record<string, unknown>,
      })
    ).rejects.toThrow(
      'loadBalancingStrategy must be an object or null when provided'
    );

    expect(createResourceMock).not.toHaveBeenCalled();
    expect(createStrategySpy).not.toHaveBeenCalled();
    expect(HybridPathRoutingPolicyMock).not.toHaveBeenCalled();
  });

  it('rejects when loadBalancingStrategy record value is not object', async () => {
    await expect(
      factory.create({ loadBalancingStrategy: 42 } as Record<string, unknown>)
    ).rejects.toThrow(
      'loadBalancingStrategy must be an object or null when provided'
    );

    expect(createResourceMock).not.toHaveBeenCalled();
    expect(createStrategySpy).not.toHaveBeenCalled();
    expect(HybridPathRoutingPolicyMock).not.toHaveBeenCalled();
  });

  it('treats undefined loadBalancingStrategy as null', async () => {
    const defaultStrategy = makeStrategy('auto');
    createStrategySpy.mockResolvedValueOnce(defaultStrategy);

    const policy = await factory.create({
      type: 'HybridPathRoutingPolicy',
      loadBalancingStrategy: undefined,
    });

    expect(createResourceMock).not.toHaveBeenCalled();
    expect(createStrategySpy).toHaveBeenCalledWith(null);
    expect(HybridPathRoutingPolicyMock).toHaveBeenCalledWith({
      loadBalancingStrategy: defaultStrategy,
    });
    expect(policy).toEqual({
      kind: 'HybridPathRoutingPolicy',
      options: { loadBalancingStrategy: defaultStrategy },
    });
  });

  it('treats missing loadBalancingStrategy key on record configs as null', async () => {
    const defaultStrategy = makeStrategy('record-null');
    createStrategySpy.mockResolvedValueOnce(defaultStrategy);

    const config = Object.create(null) as Record<string, unknown>;
    config.other = 'value';

    const policy = await factory.create(config);

    expect(createResourceMock).not.toHaveBeenCalled();
    expect(createStrategySpy).toHaveBeenCalledWith(null);
    expect(HybridPathRoutingPolicyMock).toHaveBeenCalledWith({
      loadBalancingStrategy: defaultStrategy,
    });
    expect(policy).toEqual({
      kind: 'HybridPathRoutingPolicy',
      options: { loadBalancingStrategy: defaultStrategy },
    });
  });

  it('rejects when proxy hides loadBalancingStrategy presence but value is invalid', async () => {
    const base: Record<string, unknown> = {
      type: 'HybridPathRoutingPolicy',
      loadBalancingStrategy: 42,
    };
    const trickyConfig = new Proxy(base, {
      has(target, prop) {
        if (prop === 'loadBalancingStrategy') {
          return false;
        }
        return Reflect.has(target, prop);
      },
    });

    await expect(factory.create(trickyConfig)).rejects.toThrow(
      'loadBalancingStrategy must be an object or null when provided'
    );

    expect(createResourceMock).not.toHaveBeenCalled();
    expect(createStrategySpy).not.toHaveBeenCalled();
    expect(HybridPathRoutingPolicyMock).not.toHaveBeenCalled();
  });
});
