import type { SecurityManager } from '../security-manager.js';
import type { DefaultSecurityManagerConfig } from '../default-security-manager-factory.js';
import type { SecurityManagerComponentOverrides } from '../security-manager-factory.js';
import {
  NodeSecurityProfileFactory,
  PROFILE_NAME_GATED,
  PROFILE_NAME_GATED_CALLBACK,
  PROFILE_NAME_OPEN,
  PROFILE_NAME_OVERLAY,
  PROFILE_NAME_OVERLAY_CALLBACK,
  ENV_VAR_JWT_TRUSTED_ISSUER,
  ENV_VAR_JWKS_URL,
  ENV_VAR_JWT_AUDIENCE,
  ENV_VAR_JWT_ALGORITHM,
  ENV_VAR_JWT_REVERSE_AUTH_TRUSTED_ISSUER,
  ENV_VAR_JWT_REVERSE_AUTH_AUDIENCE,
  ENV_VAR_HMAC_SECRET,
  ENV_VAR_DEFAULT_ENCRYPTION_LEVEL,
} from '../node-security-profile-factory.js';
import { SECURITY_MANAGER_FACTORY_BASE_TYPE } from '../security-manager-factory.js';
import * as FactoryRegistry from '@naylence/factory';

const REQUIRED_ENV_VARS: Record<string, string> = {
  [ENV_VAR_JWT_TRUSTED_ISSUER]: 'https://issuer.example',
  [ENV_VAR_JWKS_URL]: 'https://issuer.example/jwks.json',
  [ENV_VAR_JWT_AUDIENCE]: 'runtime-clients',
  [ENV_VAR_JWT_ALGORITHM]: 'RS256',
  [ENV_VAR_DEFAULT_ENCRYPTION_LEVEL]: 'channel',
  [ENV_VAR_JWT_REVERSE_AUTH_TRUSTED_ISSUER]:
    'naylence.runtime.overlay.reverse-auth',
  [ENV_VAR_JWT_REVERSE_AUTH_AUDIENCE]: 'overlay-callback',
  [ENV_VAR_HMAC_SECRET]: 'super-secret',
};

describe('NodeSecurityProfileFactory', () => {
  const originalEnv = { ...process.env };
  const priorValues: Partial<Record<string, string | undefined>> = {};

  beforeEach(() => {
    for (const [key, value] of Object.entries(REQUIRED_ENV_VARS)) {
      if (!(key in priorValues)) {
        priorValues[key] = process.env[key];
      }
      process.env[key] = value;
    }
  });

  afterEach(() => {
    for (const key of Object.keys(REQUIRED_ENV_VARS)) {
      const previous = priorValues[key];
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  async function captureInvocation(
    profileInput?: string | null,
    overrides?: SecurityManagerComponentOverrides | null
  ): Promise<{
    config: DefaultSecurityManagerConfig;
    options: Record<string, unknown> | undefined;
    baseType: string | undefined;
  }> {
    let capturedConfig: DefaultSecurityManagerConfig | null = null;
    let capturedOptions: Record<string, unknown> | undefined;
    let capturedBaseType: string | undefined;

    const createSpy = jest
      .spyOn(FactoryRegistry, 'createResource')
      .mockImplementation(async (baseType, config, options) => {
        capturedBaseType = baseType as string;
        capturedConfig = config as DefaultSecurityManagerConfig;
        capturedOptions = options as Record<string, unknown> | undefined;
        return { kind: 'stub' } as unknown as SecurityManager;
      });

    const factory = new NodeSecurityProfileFactory();
    const providedConfig =
      profileInput === undefined
        ? undefined
        : profileInput === null
          ? { profile: null }
          : { profile: profileInput };

    await factory.create(providedConfig as any, overrides ?? undefined);

    createSpy.mockRestore();

    if (!capturedConfig) {
      throw new Error('Factory did not invoke createResource');
    }

    return {
      config: capturedConfig,
      options: capturedOptions,
      baseType: capturedBaseType,
    };
  }

  it('defaults to the overlay profile when no config is provided', async () => {
    const { config, options, baseType } = await captureInvocation();

    expect(baseType).toBe(SECURITY_MANAGER_FACTORY_BASE_TYPE);
    const env = options?.env as Record<string, string> | undefined;
    expect(env?.[ENV_VAR_JWT_TRUSTED_ISSUER]).toBe('https://issuer.example');
    expect(options?.validate).toBe(false);
    expect(config.type).toBe('DefaultSecurityManager');
    const policy = config.security_policy as Record<string, any> | undefined;
    const authorizer = config.authorizer as Record<string, any> | undefined;
    expect(policy?.signing?.signing_material).toBe('raw-key');
    expect(authorizer?.type).toBe('AuthorizationProfile');
    expect(authorizer?.profile).toBe('oauth2');
  });

  it('accepts profile names in a case-insensitive manner', async () => {
    const { config } = await captureInvocation('OvErLaY');
    const policy = config.security_policy as Record<string, any> | undefined;
    expect(policy?.signing?.signing_material).toBe('raw-key');
  });

  it('supports overlay-callback profile with reverse-auth token settings', async () => {
    const { config } = await captureInvocation(PROFILE_NAME_OVERLAY_CALLBACK);
    const authorizer = config.authorizer as Record<string, any> | undefined;
    expect(authorizer?.type).toBe('AuthorizationProfile');
    expect(authorizer?.profile).toBe('oauth2-callback');
  });

  it('supports gated profile with relaxed inbound signing', async () => {
    const { config } = await captureInvocation(PROFILE_NAME_GATED);
    const policy = config.security_policy as Record<string, any> | undefined;
    const authorizer = config.authorizer as Record<string, any> | undefined;
    expect(policy?.signing?.inbound?.signature_policy).toBe('disabled');
    expect(authorizer?.type).toBe('AuthorizationProfile');
    expect(authorizer?.profile).toBe('oauth2-gated');
  });

  it('supports gated-callback profile with HMAC verifier configuration', async () => {
    const { config } = await captureInvocation(PROFILE_NAME_GATED_CALLBACK);
    const authorizer = config.authorizer as Record<string, any> | undefined;
    expect(authorizer?.type).toBe('AuthorizationProfile');
    expect(authorizer?.profile).toBe('oauth2-callback');
  });

  it('supports open profile that disables authorizer and policy enforcement', async () => {
    const { config } = await captureInvocation(PROFILE_NAME_OPEN);
    const policy = config.security_policy as Record<string, any> | undefined;
    const authorizer = config.authorizer as Record<string, any> | undefined;
    expect(policy?.type).toBe('NoSecurityPolicy');
    expect(authorizer?.type).toBe('AuthorizationProfile');
    expect(authorizer?.profile).toBe('noop');
  });

  it('passes overrides as factory arguments to createResource', async () => {
    const overrides: SecurityManagerComponentOverrides = { authorizer: null };
    const { options } = await captureInvocation(
      PROFILE_NAME_OVERLAY,
      overrides
    );
    expect(options?.factoryArgs).toEqual([overrides]);
  });

  it('accepts snake_case profile property', async () => {
    const createSpy = jest
      .spyOn(FactoryRegistry, 'createResource')
      .mockImplementation(async (_baseType, config) => {
        return { kind: 'stub', config } as unknown as SecurityManager;
      });

    const factory = new NodeSecurityProfileFactory();
    await factory.create({ profile_name: PROFILE_NAME_OVERLAY } as any);

    const capturedConfig = createSpy.mock.calls[0]?.[1] as
      | DefaultSecurityManagerConfig
      | undefined;
    const policy = capturedConfig?.security_policy as
      | Record<string, unknown>
      | undefined;
    const signing = policy?.signing as Record<string, unknown> | undefined;
    expect(signing?.signing_material).toBe('raw-key');

    createSpy.mockRestore();
  });

  it('accepts camelCase profile property', async () => {
    const createSpy = jest
      .spyOn(FactoryRegistry, 'createResource')
      .mockImplementation(async (_baseType, config) => {
        return { kind: 'stub', config } as unknown as SecurityManager;
      });

    const factory = new NodeSecurityProfileFactory();
    await factory.create({ profileName: PROFILE_NAME_OPEN } as any);

    const capturedConfig = createSpy.mock.calls[0]?.[1] as
      | DefaultSecurityManagerConfig
      | undefined;
    const authorizer = capturedConfig?.authorizer as
      | Record<string, unknown>
      | undefined;
    expect(authorizer?.type).toBe('AuthorizationProfile');
    expect(authorizer?.profile).toBe('noop');

    createSpy.mockRestore();
  });

  it('throws when an unknown profile is requested', async () => {
    const factory = new NodeSecurityProfileFactory();
    await expect(factory.create({ profile: 'nonexistent' })).rejects.toThrow(
      'Unknown security profile'
    );
  });
});
