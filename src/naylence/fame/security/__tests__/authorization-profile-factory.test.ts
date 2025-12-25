import { jest } from '@jest/globals';

import type { Authorizer } from '../auth/authorizer.js';
import { AuthorizerFactory } from '../auth/authorizer-factory.js';
import {
  AuthorizationProfileFactory,
  PROFILE_NAME_NOOP,
  PROFILE_NAME_OAUTH2,
  PROFILE_NAME_POLICY_LOCALFILE,
} from '../auth/authorization-profile-factory.js';

describe('AuthorizationProfileFactory', () => {
  let factory: AuthorizationProfileFactory;
  let createAuthorizerSpy: jest.SpiedFunction<
    typeof AuthorizerFactory.createAuthorizer
  >;

  beforeEach(() => {
    factory = new AuthorizationProfileFactory();
    createAuthorizerSpy = jest
      .spyOn(AuthorizerFactory, 'createAuthorizer')
      .mockResolvedValue({} as Authorizer);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('defaults to oauth2 profile when config missing', async () => {
    await factory.create(undefined);

    expect(createAuthorizerSpy).toHaveBeenCalledTimes(1);
    const [profileConfig] = createAuthorizerSpy.mock.calls[0];
    expect(profileConfig).toMatchObject({ type: 'OAuth2Authorizer' });
  });

  it('accepts snake_case profile alias', async () => {
    await factory.create({
      type: 'AuthorizationProfile',
      profile_name: 'no_op',
    });

    expect(createAuthorizerSpy).toHaveBeenCalledTimes(1);
    const [profileConfig] = createAuthorizerSpy.mock.calls[0];
    expect(profileConfig).toMatchObject({ type: 'NoopAuthorizer' });
  });

  it('accepts camelCase profile alias and normalizes casing', async () => {
    await factory.create({
      type: 'AuthorizationProfile',
      profileName: 'OAUTH2',
    });

    expect(createAuthorizerSpy).toHaveBeenCalledTimes(1);
    const [profileConfig] = createAuthorizerSpy.mock.calls[0];
    expect(profileConfig).toMatchObject({ type: 'OAuth2Authorizer' });
  });

  it('passes through factory args when resolving authorizer', async () => {
    const tokenVerifier = { verify: async () => ({}) };
    await factory.create(
      {
        type: 'AuthorizationProfile',
        profile: PROFILE_NAME_NOOP,
      },
      tokenVerifier
    );

    expect(createAuthorizerSpy).toHaveBeenCalledTimes(1);
    const [, options] = createAuthorizerSpy.mock.calls[0];
    expect(options).toMatchObject({ factoryArgs: [tokenVerifier] });
  });

  it('maps compact aliases onto canonical profile names', async () => {
    await factory.create({
      type: 'AuthorizationProfile',
      profile: 'oidc',
    });

    expect(createAuthorizerSpy).toHaveBeenCalledTimes(1);
    const [profileConfig] = createAuthorizerSpy.mock.calls[0];
    expect(profileConfig).toMatchObject({ type: 'OAuth2Authorizer' });
  });

  it('throws for unknown profiles after normalization', async () => {
    createAuthorizerSpy.mockRestore();

    await expect(
      factory.create({
        type: 'AuthorizationProfile',
        profile: 'custom-profile',
      })
    ).rejects.toThrow('Unknown authorization profile: custom-profile');
  });

  it('resolves explicit oauth2 profile name', async () => {
    await factory.create({
      type: 'AuthorizationProfile',
      profile: PROFILE_NAME_OAUTH2,
    });

    expect(createAuthorizerSpy).toHaveBeenCalledTimes(1);
    const [profileConfig] = createAuthorizerSpy.mock.calls[0];
    expect(profileConfig).toMatchObject({ type: 'OAuth2Authorizer' });
  });

  it('resolves policy-localfile profile name to PolicyAuthorizer with policySource', async () => {
    await factory.create({
      type: 'AuthorizationProfile',
      profile: PROFILE_NAME_POLICY_LOCALFILE,
    });

    expect(createAuthorizerSpy).toHaveBeenCalledTimes(1);
    const [profileConfig] = createAuthorizerSpy.mock.calls[0];
    expect(profileConfig).toMatchObject({
      type: 'PolicyAuthorizer',
      policySource: expect.objectContaining({
        type: 'LocalFileAuthorizationPolicySource',
      }),
    });
  });

});
