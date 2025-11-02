import {
  ResourceFactoryRegistry,
  registerFactory,
  unregisterFactory,
} from '@naylence/factory';
import { NoAuthInjectionStrategyFactory } from '../auth/no-auth-injection-strategy-factory.js';
import { QueryParamAuthInjectionStrategyFactory } from '../auth/query-param-auth-injection-strategy-factory.js';
import { QueryParamAuthInjectionStrategy } from '../auth/query-param-auth-injection-strategy.js';
import { WebSocketSubprotocolAuthInjectionStrategyFactory } from '../auth/websocket-subprotocol-auth-injection-strategy-factory.js';
import { WebSocketSubprotocolAuthInjectionStrategy } from '../auth/websocket-subprotocol-auth-injection-strategy.js';
import { BearerTokenHeaderAuthInjectionStrategyFactory } from '../auth/bearer-token-header-auth-injection-strategy-factory.js';
import { BearerTokenHeaderAuthInjectionStrategy } from '../auth/bearer-token-header-auth-injection-strategy.js';
import {
  TOKEN_PROVIDER_FACTORY_BASE_TYPE,
  TokenProviderFactory,
} from '../auth/token-provider-factory.js';
import type { TokenProviderConfig } from '../auth/token-provider-factory.js';
import type { TokenProvider } from '../auth/token-provider.js';
import type { Token } from '../auth/token.js';
import { isTokenExpired, isTokenValid } from '../auth/token.js';
import { registerRuntimeFactories } from '../../util/register-runtime-factories.js';

describe('auth injection strategies', () => {
  beforeAll(() => {
    registerFactory<TokenProvider, StaticTokenProviderConfig>(
      TOKEN_PROVIDER_FACTORY_BASE_TYPE,
      'StaticTokenProvider',
      StaticTokenProviderFactory
    );
  });

  afterEach(() => {
    ResourceFactoryRegistry.clearCache(TOKEN_PROVIDER_FACTORY_BASE_TYPE);
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('provides no-auth strategy by default', async () => {
    const factory = new NoAuthInjectionStrategyFactory();
    const strategy = await factory.create(null);

    await expect(strategy.apply({})).resolves.toBeUndefined();
    await expect(strategy.cleanup()).resolves.toBeUndefined();

    await expect(
      factory.create({ type: 'Unexpected' } as unknown as TokenProviderConfig)
    ).rejects.toThrow('NoAuthInjectionStrategyFactory expects type "NoAuth"');
  });

  it('injects bearer token via setAuthHeader and refreshes before expiry', async () => {
    jest.useFakeTimers({ now: 1735689600000 });

    const strategy =
      await new BearerTokenHeaderAuthInjectionStrategyFactory().create({
        type: 'BearerTokenHeaderAuth',
        tokenProvider: {
          type: 'StaticTokenProvider',
          sequence: [
            { value: 'initial', expiresAt: Date.now() + 2 * 60_000 },
            { value: 'pre-refresh', expiresAt: Date.now() + 2 * 60_000 },
            { value: 'refreshed', expiresAt: Date.now() + 4 * 60_000 },
          ],
        },
      });

    const connector = { setAuthHeader: jest.fn() };
    await strategy.apply(connector);

    expect(connector.setAuthHeader).toHaveBeenCalledTimes(1);
    expect(connector.setAuthHeader).toHaveBeenLastCalledWith('Bearer initial');

    await jest.advanceTimersByTimeAsync(90_000);

    expect(connector.setAuthHeader).toHaveBeenCalledTimes(2);
    expect(connector.setAuthHeader).toHaveBeenLastCalledWith(
      'Bearer refreshed'
    );

    await strategy.cleanup();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('rejects bearer configuration without token provider', async () => {
    const factory = new BearerTokenHeaderAuthInjectionStrategyFactory();
    await expect(
      factory.create({
        type: 'BearerTokenHeaderAuth',
        headerName: 'Authorization',
      } as unknown as TokenProviderConfig)
    ).rejects.toThrow(
      'BearerTokenHeaderAuthInjectionStrategy requires a tokenProvider configuration'
    );
  });

  it('recovers from token provider errors after retry backoff', async () => {
    jest.useFakeTimers({ now: 1735689600000 });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const strategy =
      await new BearerTokenHeaderAuthInjectionStrategyFactory().create({
        type: 'BearerTokenHeaderAuth',
        header_name: 'X-Auth',
        tokenProvider: {
          type: 'StaticTokenProvider',
          sequence: [
            { value: 'initial', expiresAt: Date.now() + 60_000 },
            { throw: true },
            { value: 'pre-retry', expiresAt: Date.now() + 2 * 60_000 },
            { value: 'retry', expiresAt: Date.now() + 2 * 60_000 },
          ],
        },
      });

    const headers: Record<string, string> = {};
    await strategy.apply(headers);
    expect(headers['X-Auth']).toBe('Bearer initial');

    await jest.advanceTimersByTimeAsync(60_000);
    expect(errorSpy).toHaveBeenCalledWith(
      'auth_token_refresh_failed',
      expect.any(Error)
    );

    await jest.advanceTimersByTimeAsync(90_000);
    expect(headers['X-Auth']).toBe('Bearer retry');

    await strategy.cleanup();
  });

  it('warns when connector cannot accept auth headers', async () => {
    jest.useFakeTimers({ now: 1735689600000 });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const strategy =
      await new BearerTokenHeaderAuthInjectionStrategyFactory().create({
        type: 'BearerTokenHeaderAuth',
        tokenProvider: {
          type: 'StaticTokenProvider',
          sequence: [
            { value: 'token', expiresAt: Date.now() + 60_000 },
            { value: 'refresh', expiresAt: Date.now() + 60_000 },
          ],
        },
      });

    await strategy.apply('raw-connector');
    expect(warnSpy).toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(60_000);
    await strategy.cleanup();
  });

  it('applies headers on map objects without constructors', async () => {
    jest.useFakeTimers({ now: 1735689600000 });

    const strategy =
      await new BearerTokenHeaderAuthInjectionStrategyFactory().create({
        type: 'BearerTokenHeaderAuth',
        tokenProvider: {
          type: 'StaticTokenProvider',
          sequence: [
            { value: 'token', expiresAt: Date.now() + 120_000 },
            { value: 'next', expiresAt: Date.now() + 120_000 },
          ],
        },
      });

    const headerMap = Object.create(null) as Record<string, string>;
    await strategy.apply(headerMap);
    expect(headerMap.Authorization).toBe('Bearer token');
    await jest.advanceTimersByTimeAsync(90_000);
    expect(headerMap.Authorization).toBe('Bearer next');
    await strategy.cleanup();
  });

  it('supports snake_case options for direct bearer strategy construction', async () => {
    jest.useFakeTimers({ now: 1735689600000 });

    const strategy = new BearerTokenHeaderAuthInjectionStrategy({
      token_provider: {
        type: 'StaticTokenProvider',
        sequence: [{ value: 'direct', expiresAt: Date.now() + 60_000 }],
      },
      header_name: 'X-Direct',
    });

    const headers = Object.create(null) as Record<string, string>;
    await strategy.apply(headers);
    expect(headers['X-Direct']).toBe('Bearer direct');
    await strategy.cleanup();
  });

  it('restarts refresh loop when apply is called twice', async () => {
    jest.useFakeTimers({ now: 1735689600000 });

    const strategy =
      await new BearerTokenHeaderAuthInjectionStrategyFactory().create({
        type: 'BearerTokenHeaderAuth',
        tokenProvider: {
          type: 'StaticTokenProvider',
          sequence: [
            { value: 'first', expiresAt: Date.now() + 2 * 60_000 },
            { value: 'first-loop', expiresAt: Date.now() + 2 * 60_000 },
            { value: 'second', expiresAt: Date.now() + 2 * 60_000 },
            { value: 'second-loop', expiresAt: Date.now() + 2 * 60_000 },
          ],
        },
      });

    const firstConnector = { setAuthHeader: jest.fn() };
    await strategy.apply(firstConnector);

    const secondConnector = { setAuthHeader: jest.fn() };
    await strategy.apply(secondConnector);

    expect(firstConnector.setAuthHeader).toHaveBeenCalledWith('Bearer first');
    expect(secondConnector.setAuthHeader).toHaveBeenCalledWith('Bearer first');
    await strategy.cleanup();
  });

  it('schedules minimum refresh when token is already expired', async () => {
    jest.useFakeTimers({ now: 1735689600000 });

    const strategy =
      await new BearerTokenHeaderAuthInjectionStrategyFactory().create({
        type: 'BearerTokenHeaderAuth',
        tokenProvider: {
          type: 'StaticTokenProvider',
          sequence: [
            { value: 'initial', expiresAt: Date.now() + 10_000 },
            { value: 'expired', expiresAt: Date.now() - 1 },
            { value: 'after-expired', expiresAt: Date.now() + 10_000 },
          ],
        },
      });

    const connector = { setAuthHeader: jest.fn() };
    await strategy.apply(connector);

    await jest.advanceTimersByTimeAsync(60_000);
    expect(connector.setAuthHeader).toHaveBeenLastCalledWith(
      'Bearer after-expired'
    );
    await strategy.cleanup();
  });

  it('uses default refresh interval when token lacks expiration', async () => {
    jest.useFakeTimers({ now: 1735689600000 });

    const strategy =
      await new BearerTokenHeaderAuthInjectionStrategyFactory().create({
        type: 'BearerTokenHeaderAuth',
        tokenProvider: {
          type: 'StaticTokenProvider',
          sequence: [
            { value: 'initial', expiresAt: Date.now() + 10_000 },
            { value: 'no-expiry' },
            { value: 'refresh', expiresAt: Date.now() + 10_000 },
          ],
        },
      });

    const connector = { setAuthHeader: jest.fn() };
    await strategy.apply(connector);
    await strategy.cleanup();
    expect(connector.setAuthHeader).toHaveBeenCalledWith('Bearer initial');
  });

  it('handles null tokens from provider gracefully', async () => {
    jest.useFakeTimers({ now: 1735689600000 });

    const strategy =
      await new BearerTokenHeaderAuthInjectionStrategyFactory().create({
        type: 'BearerTokenHeaderAuth',
        tokenProvider: {
          type: 'StaticTokenProvider',
          sequence: [
            { value: 'initial', expiresAt: Date.now() + 60_000 },
            { nullToken: true },
            { value: 'after-null', expiresAt: Date.now() + 60_000 },
          ],
        },
      });

    const connector = { setAuthHeader: jest.fn() };
    await strategy.apply(connector);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(connector.setAuthHeader).toHaveBeenLastCalledWith(
      'Bearer after-null'
    );
    await strategy.cleanup();
  });

  it('modifies URLs with dynamic query parameters', async () => {
    const factory = new QueryParamAuthInjectionStrategyFactory();
    const strategy = (await factory.create({
      type: 'QueryParamAuth',
      param: 'auth',
      tokenProvider: {
        type: 'StaticTokenProvider',
        sequence: [{ value: 'q123' }],
      },
    })) as QueryParamAuthInjectionStrategy;

    const absolute = await strategy.modifyUrl(
      'https://example.com/path?existing=1'
    );
    expect(absolute).toBe('https://example.com/path?existing=1&auth=q123');

    const relative = await strategy.modifyUrl('/ws?foo=bar');
    expect(relative).toBe('/ws?foo=bar&auth=q123');
  });

  it('preserves URL hash fragment when injecting query token', async () => {
    const factory = new QueryParamAuthInjectionStrategyFactory();
    const strategy = (await factory.create({
      type: 'QueryParamAuth',
      paramName: 'token',
      tokenProvider: {
        type: 'StaticTokenProvider',
        sequence: [{ value: 'abc' }],
      },
    })) as QueryParamAuthInjectionStrategy;

    const modified = await strategy.modifyUrl(
      'https://example.com/path#section'
    );
    expect(modified).toBe('https://example.com/path?token=abc#section');
  });

  it('rejects query param strategy for invalid type', async () => {
    const factory = new QueryParamAuthInjectionStrategyFactory();
    await expect(
      factory.create({
        type: 'WrongType',
        tokenProvider: {
          type: 'StaticTokenProvider',
          sequence: [{ value: 'x' }],
        },
      } as unknown as TokenProviderConfig)
    ).rejects.toThrow(
      /QueryParamAuthInjectionStrategyFactory expects type "QueryParamAuth"/
    );
  });

  it('supports snake_case options when constructing query param strategy directly', async () => {
    const strategy = new QueryParamAuthInjectionStrategy({
      token_provider: {
        type: 'StaticTokenProvider',
        sequence: [{ value: 'direct' }],
      },
      param_name: 'auth_token',
    });

    const modified = await strategy.modifyUrl('/ws');
    expect(modified).toBe('/ws?auth_token=direct');
    await strategy.cleanup();
  });

  it('returns WebSocket subprotocol tokens when available', async () => {
    const factory = new WebSocketSubprotocolAuthInjectionStrategyFactory();
    const strategy = (await factory.create({
      type: 'WebSocketSubprotocolAuth',
      param: 'custom',
      tokenProvider: {
        type: 'StaticTokenProvider',
        sequence: [{ value: 'secret' }],
      },
    })) as WebSocketSubprotocolAuthInjectionStrategy;

    const protocols = await strategy.getSubprotocols();
    expect(protocols).toEqual(['custom', 'secret']);

    ResourceFactoryRegistry.clearCache(TOKEN_PROVIDER_FACTORY_BASE_TYPE);
    const emptyStrategy = (await factory.create({
      type: 'WebSocketSubprotocolAuth',
      tokenProvider: {
        type: 'StaticTokenProvider',
        sequence: [{ value: '' }],
      },
    })) as WebSocketSubprotocolAuthInjectionStrategy;

    const empty = await emptyStrategy.getSubprotocols();
    expect(empty).toEqual([]);
  });

  it('supports snake_case options when constructing WebSocket subprotocol strategy directly', async () => {
    const strategy = new WebSocketSubprotocolAuthInjectionStrategy({
      token_provider: {
        type: 'StaticTokenProvider',
        sequence: [{ value: 'custom-token' }],
      },
      subprotocol_prefix: 'custom',
    });

    const protocols = await strategy.getSubprotocols();
    expect(protocols).toEqual(['custom', 'custom-token']);
    await strategy.cleanup();
  });

  it('rejects websocket subprotocol configuration without provider', async () => {
    const factory = new WebSocketSubprotocolAuthInjectionStrategyFactory();
    await expect(
      factory.create({
        type: 'WebSocketSubprotocolAuth',
      } as unknown as TokenProviderConfig)
    ).rejects.toThrow(
      'WebSocketSubprotocolAuthInjectionStrategy requires a tokenProvider configuration'
    );
  });

  it('fails to create default token provider when none are registered', async () => {
    unregisterFactory(TOKEN_PROVIDER_FACTORY_BASE_TYPE);
    ResourceFactoryRegistry.clearCache(TOKEN_PROVIDER_FACTORY_BASE_TYPE);

    try {
      await expect(
        TokenProviderFactory.createTokenProvider(null)
      ).rejects.toThrow('Failed to create default token provider');
    } finally {
      await registerRuntimeFactories();
      registerFactory<TokenProvider, StaticTokenProviderConfig>(
        TOKEN_PROVIDER_FACTORY_BASE_TYPE,
        'StaticTokenProvider',
        StaticTokenProviderFactory
      );
    }
  });

  it('evaluates token helpers', () => {
    const now = Date.now();
    const expired: Token = { value: 'a', expiresAt: now - 1 };
    const valid: Token = { value: 'b', expiresAt: now + 10_000 };
    const timeless: Token = { value: 'c' };

    expect(isTokenExpired(expired)).toBe(true);
    expect(isTokenValid(expired)).toBe(false);
    expect(isTokenExpired(valid)).toBe(false);
    expect(isTokenValid(valid)).toBe(true);
    expect(isTokenExpired(timeless)).toBe(false);
  });
});

interface StaticTokenSequenceEntry {
  value?: string;
  expiresAt?: number;
  throw?: boolean;
  nullToken?: boolean;
}

interface StaticTokenProviderConfig extends TokenProviderConfig {
  type: 'StaticTokenProvider';
  sequence: StaticTokenSequenceEntry[];
}

class StaticTokenProvider implements TokenProvider {
  private index = 0;

  public constructor(private readonly responses: StaticTokenSequenceEntry[]) {}

  public async getToken(): Promise<Token> {
    const entry =
      this.responses[this.index] ?? this.responses[this.responses.length - 1];
    if (this.index < this.responses.length - 1) {
      this.index += 1;
    }

    if (entry?.throw) {
      throw new Error('token provider failure');
    }

    if (entry?.nullToken) {
      return null as unknown as Token;
    }

    const value = entry?.value ?? 'token';
    const token: Token = { value };
    if (typeof entry?.expiresAt === 'number') {
      token.expiresAt = entry.expiresAt;
    }

    return token;
  }
}

class StaticTokenProviderFactory extends TokenProviderFactory<StaticTokenProviderConfig> {
  public readonly type = 'StaticTokenProvider';
  public readonly isDefault = true;

  public async create(
    config?: StaticTokenProviderConfig | Record<string, unknown> | null
  ): Promise<TokenProvider> {
    if (!config) {
      throw new Error('StaticTokenProvider requires configuration');
    }

    const candidate = config as StaticTokenProviderConfig &
      Record<string, unknown>;
    if (candidate.type !== 'StaticTokenProvider') {
      throw new Error(
        'StaticTokenProvider config must declare type StaticTokenProvider'
      );
    }

    const sequenceValue = candidate.sequence;
    if (!Array.isArray(sequenceValue) || sequenceValue.length === 0) {
      throw new Error('StaticTokenProvider requires a non-empty sequence');
    }

    return new StaticTokenProvider([
      ...(sequenceValue as StaticTokenSequenceEntry[]),
    ]);
  }
}
