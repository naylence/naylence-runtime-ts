import type { RoutingPolicy } from '../routing-policy.js';
import {
  PROFILE_NAME_DEVELOPMENT,
  PROFILE_NAME_PRODUCTION,
  RoutingProfileFactory,
} from '../routing-profile-factory.js';
import { ROUTING_POLICY_FACTORY_BASE } from '../routing-policy.js';

jest.mock('naylence-factory', () => {
  const actual = jest.requireActual('naylence-factory');
  return {
    ...actual,
    createResource: jest.fn(),
    registerFactory: jest.fn(),
  };
});

const { createResource: createResourceMock, registerFactory: registerFactoryMock } =
  jest.requireMock('naylence-factory') as {
    createResource: jest.MockedFunction<
      typeof import('naylence-factory')['createResource']
    >;
    registerFactory: jest.Mock;
  };

describe('RoutingProfileFactory', () => {
  let factory: RoutingProfileFactory;

  beforeEach(() => {
    createResourceMock.mockReset();
    registerFactoryMock.mockClear();
    factory = new RoutingProfileFactory();
  });

  it('defaults to development profile when config is missing', async () => {
    const policy = {} as RoutingPolicy;
    createResourceMock.mockResolvedValueOnce(policy);

    const result = await factory.create();

    expect(result).toBe(policy);
    expect(createResourceMock).toHaveBeenCalledWith(
      ROUTING_POLICY_FACTORY_BASE,
      expect.objectContaining({ type: 'CompositeRoutingPolicy' }),
      { factoryArgs: [], validate: false }
    );
  });

  it('defaults to development profile when profile is omitted', async () => {
    const policy = {} as RoutingPolicy;
    createResourceMock.mockResolvedValueOnce(policy);

    await factory.create({ type: 'RoutingProfile' });

    const [, routingConfig] = createResourceMock.mock.calls[0];
    expect(routingConfig).toEqual(
      expect.objectContaining({
        type: 'CompositeRoutingPolicy',
      })
    );
  });

  it('defaults to development profile when profile is null', async () => {
    const policy = {} as RoutingPolicy;
    createResourceMock.mockResolvedValueOnce(policy);

    await factory.create({ type: 'RoutingProfile', profile: null });

    const [, routingConfig] = createResourceMock.mock.calls[0];
    expect(routingConfig).toEqual(
      expect.objectContaining({
        type: 'CompositeRoutingPolicy',
      })
    );
  });

  it('rejects when config type is not RoutingProfile', async () => {
    await expect(
      factory.create({ type: 'OtherProfile', profile: PROFILE_NAME_DEVELOPMENT })
    ).rejects.toThrow('RoutingProfileFactory only supports RoutingProfile config');

    expect(createResourceMock).not.toHaveBeenCalled();
  });

  it('rejects when profile is not a string', async () => {
    await expect(
      factory.create({ type: 'RoutingProfile', profile: 42 as unknown as string })
    ).rejects.toThrow('profile must be a non-empty string');

    expect(createResourceMock).not.toHaveBeenCalled();
  });

  it('rejects when profile is an empty string', async () => {
    await expect(
      factory.create({ type: 'RoutingProfile', profile: '   ' })
    ).rejects.toThrow('profile must be a non-empty string');

    expect(createResourceMock).not.toHaveBeenCalled();
  });

  it('rejects when profile is unknown', async () => {
    await expect(
      factory.create({ type: 'RoutingProfile', profile: 'unknown-profile' })
    ).rejects.toThrow('Unknown routing profile');

    expect(createResourceMock).not.toHaveBeenCalled();
  });

  it('creates the requested profile and forwards factory args', async () => {
    const policy = { name: 'production-policy' } as unknown as RoutingPolicy;
    createResourceMock.mockResolvedValueOnce(policy);

    const extraArg = Symbol('arg');
    const result = await factory.create(
      { type: 'RoutingProfile', profile: PROFILE_NAME_PRODUCTION },
      extraArg
    );

    expect(result).toBe(policy);
    expect(createResourceMock).toHaveBeenCalledWith(
      ROUTING_POLICY_FACTORY_BASE,
      expect.objectContaining({ type: 'CompositeRoutingPolicy' }),
      { factoryArgs: [extraArg], validate: false }
    );
  });

  it('throws when underlying policy creation fails', async () => {
    createResourceMock.mockResolvedValueOnce(null);

    await expect(factory.create()).rejects.toThrow(/Failed to create routing policy/);
  });
});
