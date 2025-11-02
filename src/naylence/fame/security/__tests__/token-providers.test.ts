import { ResourceFactoryRegistry } from '@naylence/factory';
import { createAuthorizationContext } from '@naylence/core';

import type { CredentialProvider } from '../credential/credential-provider.js';
import { NoneTokenProvider } from '../auth/none-token-provider.js';
import { OAuth2ClientCredentialsTokenProvider } from '../auth/oauth2-client-credentials-token-provider.js';
import { OAuth2ClientCredentialsTokenProviderFactory } from '../auth/oauth2-client-credentials-token-provider-factory.js';
import { SharedSecretTokenProvider } from '../auth/shared-secret-token-provider.js';
import { SharedSecretTokenProviderFactory } from '../auth/shared-secret-token-provider-factory.js';
import { SharedSecretTokenVerifier } from '../auth/shared-secret-token-verifier.js';
import { SharedSecretTokenVerifierFactory } from '../auth/shared-secret-token-verifier-factory.js';
import { StaticTokenProvider } from '../auth/static-token-provider.js';
import type { StaticTokenProviderOptions } from '../auth/static-token-provider.js';
import { StaticTokenProviderFactory } from '../auth/static-token-provider-factory.js';
import type { Token } from '../auth/token.js';
import { TokenProviderFactory } from '../auth/token-provider-factory.js';
import type { TokenVerifier } from '../auth/token-verifier.js';
import { TokenVerifierFactory } from '../auth/token-verifier-factory.js';
import '../auth/none-token-provider-factory.js';

class StubCredentialProvider implements CredentialProvider {
  constructor(private readonly value: string | null) {}

  async get(): Promise<string | null> {
    return this.value;
  }
}

describe('StaticTokenProvider', () => {
  it('returns configured token and optional expiration', async () => {
    const provider = new StaticTokenProvider({
      token: 'static-token',
      expiresAt: 123,
    });
    const token = await provider.getToken();

    expect(token).toEqual({ value: 'static-token', expiresAt: 123 });
  });

  it('creates provider via factory', async () => {
    const factory = new StaticTokenProviderFactory();
    const provider = await factory.create({
      type: 'StaticTokenProvider',
      token: 'factory-token',
    });

    const token = await provider.getToken();
    expect(token.value).toBe('factory-token');
  });

  it('normalizes Date expiresAt values', async () => {
    const date = new Date('2025-01-01T00:00:00Z');
    const provider = new StaticTokenProvider({
      token: 'date-token',
      expiresAt: date,
    });

    const token = await provider.getToken();
    expect(token.expiresAt).toBe(date.getTime());
  });

  it('parses ISO string expiresAt values', async () => {
    const iso = '2026-02-03T04:05:06Z';
    const provider = new StaticTokenProvider({
      token: 'iso-token',
      expiresAt: iso,
    });

    const token = await provider.getToken();
    expect(token.expiresAt).toBe(Date.parse(iso));
  });

  it('omits expiresAt when null or undefined', async () => {
    const providerWithNull = new StaticTokenProvider({
      token: 'null-token',
      expiresAt: null,
    });
    const providerWithUndefined = new StaticTokenProvider({
      token: 'undef-token',
    });

    expect((await providerWithNull.getToken()).expiresAt).toBeUndefined();
    expect((await providerWithUndefined.getToken()).expiresAt).toBeUndefined();
  });

  it('returns a defensive copy of the token', async () => {
    const provider = new StaticTokenProvider({
      token: 'copy-token',
      expiresAt: 1000,
    });

    const first = await provider.getToken();
    first.value = 'mutated';

    const second = await provider.getToken();
    expect(second.value).toBe('copy-token');
  });

  it('throws when token is missing or not a string', () => {
    expect(
      () =>
        new StaticTokenProvider(
          undefined as unknown as StaticTokenProviderOptions
        )
    ).toThrow('StaticTokenProvider requires a string token value');

    expect(
      () => new StaticTokenProvider({ token: 123 as unknown as string })
    ).toThrow('StaticTokenProvider requires a string token value');
  });

  it('throws when expiresAt number is not finite', () => {
    expect(
      () =>
        new StaticTokenProvider({
          token: 'finite',
          expiresAt: Number.POSITIVE_INFINITY,
        })
    ).toThrow('expiresAt must be a finite number when provided');
  });

  it('throws when expiresAt date is invalid', () => {
    const invalidDate = new Date('not-a-real-date');
    expect(
      () =>
        new StaticTokenProvider({
          token: 'invalid-date',
          expiresAt: invalidDate,
        })
    ).toThrow('expiresAt Date must be valid');
  });

  it('throws when expiresAt string cannot be parsed', () => {
    expect(
      () =>
        new StaticTokenProvider({
          token: 'invalid-string',
          expiresAt: 'not-a-date',
        })
    ).toThrow('expiresAt string must be ISO-8601 or epoch milliseconds');
  });

  it('throws when expiresAt is of unsupported type', () => {
    expect(
      () =>
        new StaticTokenProvider({
          token: 'bad-type',
          expiresAt: true as unknown as number,
        })
    ).toThrow('expiresAt must be a number, string, Date, or null/undefined');
  });

  it('accepts direct string constructor input', async () => {
    const provider = new StaticTokenProvider('direct-token');
    const token = await provider.getToken();
    expect(token.value).toBe('direct-token');
  });

  it('accepts snake_case constructor options', async () => {
    const provider = new StaticTokenProvider({
      token_value: 'alias-token',
      expires_at: '2026-01-01T00:00:00Z',
    } as Record<string, unknown>);

    const token = await provider.getToken();
    expect(token.value).toBe('alias-token');
    expect(token.expiresAt).toBe(Date.parse('2026-01-01T00:00:00Z'));
  });

  it('creates provider via factory using snake_case fields', async () => {
    const factory = new StaticTokenProviderFactory();
    const provider = await factory.create({
      type: 'StaticTokenProvider',
      token_value: 'factory-alias-token',
      expires_at: '2027-05-06T07:08:09Z',
    } as Record<string, unknown>);

    const token = await provider.getToken();
    expect(token.value).toBe('factory-alias-token');
    expect(token.expiresAt).toBe(Date.parse('2027-05-06T07:08:09Z'));
  });
});

describe('NoneTokenProvider', () => {
  it('returns empty token far in the future', async () => {
    const provider = new NoneTokenProvider();
    const token = await provider.getToken();

    expect(token.value).toBe('');
    expect(typeof token.expiresAt).toBe('number');
    expect((token.expiresAt ?? 0) - Date.now()).toBeGreaterThan(
      10 * 365 * 24 * 60 * 60 * 1000
    );
  });

  it('registers as default factory', async () => {
    const provider = await TokenProviderFactory.createTokenProvider();
    const token = await provider.getToken();
    expect(token.value).toBe('');
  });
});

describe('SharedSecretTokenProvider', () => {
  it('retrieves secret from credential provider', async () => {
    const credentialProvider = new StubCredentialProvider('shared-secret');
    const provider = new SharedSecretTokenProvider(credentialProvider);

    const token = await provider.getToken();
    expect(token.value).toBe('shared-secret');
  });

  it('creates provider via factory with string secret source', async () => {
    const factory = new SharedSecretTokenProviderFactory();
    const provider = await factory.create({
      type: 'SharedSecretTokenProvider',
      secret: 'static-secret',
    });

    const token = await provider.getToken();
    expect(token.value).toBe('static-secret');
  });

  it('accepts snake_case constructor options', async () => {
    const provider = new SharedSecretTokenProvider({
      credential_provider: new StubCredentialProvider('snake-secret'),
    } as Record<string, unknown>);

    const token = await provider.getToken();
    expect(token.value).toBe('snake-secret');
  });

  it('creates provider via factory using snake_case secret alias', async () => {
    const factory = new SharedSecretTokenProviderFactory();
    const provider = await factory.create({
      type: 'SharedSecretTokenProvider',
      secret_provider: {
        type: 'StaticCredentialProvider',
        credential_value: 'alias-secret',
      },
    } as Record<string, unknown>);

    const token = await provider.getToken();
    expect(token.value).toBe('alias-secret');
  });
});

describe('OAuth2ClientCredentialsTokenProvider', () => {
  const tokenUrl = 'https://auth.example.com/token';
  const stubCredential = (value: string) => new StubCredentialProvider(value);

  const buildResponse = (payload: Record<string, unknown>): Response =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  it('caches tokens until expiration and refreshes after', async () => {
    const responses = [
      buildResponse({ access_token: 'token-1', expires_in: 60 }),
      buildResponse({ access_token: 'token-2', expires_in: 60 }),
    ];
    let callCount = 0;

    const fetchImpl = jest.fn(
      async () =>
        responses[callCount++] ??
        buildResponse({ access_token: 'fallback-token', expires_in: 60 })
    );

    const provider = new OAuth2ClientCredentialsTokenProvider({
      tokenUrl,
      clientIdProvider: stubCredential('client-id'),
      clientSecretProvider: stubCredential('client-secret'),
      scopes: ['scope-a'],
      fetchImpl,
    });

    const first = await provider.getToken();
    const second = await provider.getToken();

    expect(first.value).toBe('token-1');
    expect(second.value).toBe('token-1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Force expiration and ensure refresh uses new token
    (provider as unknown as { cachedToken?: Token }).cachedToken = {
      value: first.value,
      expiresAt: Date.now() - 1000,
    };

    const third = await provider.getToken();
    expect(third.value).toBe('token-2');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('creates provider via factory and performs fetch', async () => {
    const originalFetch = global.fetch;
    const stubFetch = jest.fn(async () =>
      buildResponse({ access_token: 'factory-token', expires_in: 120 })
    );
    (global as typeof globalThis & { fetch: typeof fetch }).fetch =
      stubFetch as typeof fetch;

    try {
      const factory = new OAuth2ClientCredentialsTokenProviderFactory();
      const provider = await factory.create({
        type: 'OAuth2ClientCredentialsTokenProvider',
        tokenUrl,
        clientId: 'client-id',
        clientSecret: 'client-secret',
        scopes: ['scope-a'],
      });

      const token = await provider.getToken();
      expect(token.value).toBe('factory-token');
      expect(stubFetch).toHaveBeenCalledTimes(1);
    } finally {
      (global as typeof globalThis & { fetch: typeof fetch }).fetch =
        originalFetch;
    }
  });
});

describe('SharedSecretTokenVerifier', () => {
  it('returns authorization context for valid token', async () => {
    const verifier = new SharedSecretTokenVerifier({
      credentialProvider: new StubCredentialProvider('secret'),
      principal: 'principal-123',
    });

    const context = await verifier.verify('secret', {
      expectedAudience: 'audience',
    });
    expect(context.authenticated).toBe(true);
    expect(context.authorized).toBe(true);
    expect(context.claims?.aud).toBe('audience');
    expect(context.principal).toBe('principal-123');
  });

  it('accepts snake_case options and normalizes principal overrides', async () => {
    const verifier = new SharedSecretTokenVerifier({
      credential_provider: new StubCredentialProvider('snake-secret'),
      principal: ' custom-principal ',
    } as Record<string, unknown>);

    const context = await verifier.verify('snake-secret', {
      expectedAudience: 'aud-snake',
    });

    expect(context.principal).toBe('custom-principal');
    expect(context.claims?.aud).toBe('aud-snake');
  });

  it('throws for invalid token', async () => {
    const verifier = new SharedSecretTokenVerifier({
      credentialProvider: new StubCredentialProvider('secret'),
    });

    await expect(verifier.verify('wrong')).rejects.toThrow(
      'Invalid shared secret token'
    );
  });

  it('creates verifier via factory', async () => {
    const factory = new SharedSecretTokenVerifierFactory();
    const verifier = await factory.create({
      type: 'SharedSecretTokenVerifier',
      secret: 'factory-secret',
    });

    const context = await verifier.verify('factory-secret');
    expect(context.authenticated).toBe(true);
  });
});

describe('TokenProviderFactory integration', () => {
  afterEach(() => {
    ResourceFactoryRegistry.clearCache('TokenProviderFactory');
    ResourceFactoryRegistry.clearCache('CredentialProviderFactory');
  });

  it('resolves provider from configuration with string secret', async () => {
    const provider = await TokenProviderFactory.createTokenProvider({
      type: 'SharedSecretTokenProvider',
      secret: 'integrated-secret',
    });

    const token = await provider.getToken();
    expect(token.value).toBe('integrated-secret');
  });

  it('falls back to default provider when no config supplied', async () => {
    const provider = await TokenProviderFactory.createTokenProvider();
    const token = await provider.getToken();
    expect(token.value).toBe('');
  });
});

describe('TokenVerifierFactory integration', () => {
  afterEach(() => {
    ResourceFactoryRegistry.clearCache('TokenVerifierFactory');
    ResourceFactoryRegistry.clearCache('CredentialProviderFactory');
  });

  it('creates shared secret verifier via configuration', async () => {
    const verifier = await TokenVerifierFactory.createTokenVerifier({
      type: 'SharedSecretTokenVerifier',
      secret: 'verifier-secret',
      principal: 'principal',
    });

    const context = await verifier.verify('verifier-secret');
    expect(context.principal).toBe('principal');
  });

  it('throws when provider returns mismatched token', async () => {
    const verifier = new SharedSecretTokenVerifier({
      credentialProvider: new StubCredentialProvider('expected-secret'),
    });

    await expect(verifier.verify('mismatch')).rejects.toThrow(
      'Invalid shared secret token'
    );
  });

  it('returns context with auth method metadata', async () => {
    const verifier: TokenVerifier = new SharedSecretTokenVerifier({
      credentialProvider: new StubCredentialProvider('expected-secret'),
    });

    const context = await verifier.verify('expected-secret');
    expect(context.authMethod).toBe('shared_secret');
    expect(createAuthorizationContext(context).authenticated).toBe(true);
  });
});
