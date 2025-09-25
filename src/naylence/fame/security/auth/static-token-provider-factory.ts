import { registerFactory } from 'naylence-factory';

import type { TokenProvider } from './token-provider.js';
import {
  TOKEN_PROVIDER_FACTORY_BASE_TYPE,
  TokenProviderFactory,
  type TokenProviderConfig,
} from './token-provider-factory.js';
import { StaticTokenProvider, type StaticTokenProviderOptions } from './static-token-provider.js';

export interface StaticTokenProviderConfig extends TokenProviderConfig {
  type: 'StaticTokenProvider';
  token: string;
  expiresAt?: number | string | Date | null;
}

function normalizeConfig(
  config?: StaticTokenProviderConfig | Record<string, unknown> | null
): StaticTokenProviderOptions {
  if (!config) {
    throw new Error('StaticTokenProvider requires configuration');
  }

  const record = config as Record<string, unknown>;
  const rawToken = record.token ?? record.tokenValue ?? record.token_value;

  if (typeof rawToken !== 'string' || rawToken.length === 0) {
    throw new Error('StaticTokenProvider configuration must include a non-empty "token" string');
  }

  const options: StaticTokenProviderOptions = {
    token: rawToken,
  };

  const rawExpires = record.expiresAt ?? record.expires_at ?? record.expiration;

  if (rawExpires !== undefined) {
    if (
      !(typeof rawExpires === 'string' ||
        typeof rawExpires === 'number' ||
        rawExpires instanceof Date ||
        rawExpires === null)
    ) {
      throw new TypeError('StaticTokenProvider expiresAt must be string, number, Date, null or undefined');
    }

    const expiresAtValue: StaticTokenProviderOptions['expiresAt'] =
      rawExpires === null ? null : (rawExpires as string | number | Date);

    options.expiresAt = expiresAtValue;
  }

  return options;
}

export class StaticTokenProviderFactory extends TokenProviderFactory<StaticTokenProviderConfig> {
  public readonly type = 'StaticTokenProvider';

  public async create(
    config?: StaticTokenProviderConfig | Record<string, unknown> | null
  ): Promise<TokenProvider> {
    const options = normalizeConfig(config);
    return new StaticTokenProvider(options);
  }
}

registerFactory<TokenProvider, StaticTokenProviderConfig>(
  TOKEN_PROVIDER_FACTORY_BASE_TYPE,
  'StaticTokenProvider',
  StaticTokenProviderFactory
);
