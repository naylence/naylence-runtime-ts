import { registerFactory } from 'naylence-factory';
import type { AuthInjectionStrategy } from './auth-injection-strategy.js';
import {
  AUTH_INJECTION_STRATEGY_FACTORY_BASE_TYPE,
  AuthInjectionStrategyFactory,
  type AuthInjectionStrategyConfig,
} from './auth-injection-strategy-factory.js';
import { BearerTokenHeaderAuthInjectionStrategy } from './bearer-token-header-auth-injection-strategy.js';
import type { TokenProviderConfig } from './token-provider-factory.js';

export interface BearerTokenHeaderAuthInjectionStrategyConfig extends AuthInjectionStrategyConfig {
  type: 'BearerTokenHeaderAuth';
  tokenProvider: TokenProviderConfig | Record<string, unknown>;
  token_provider?: TokenProviderConfig | Record<string, unknown>;
  headerName?: string;
  header_name?: string;
  param?: string;
}

interface NormalizedBearerConfig {
  type: 'BearerTokenHeaderAuth';
  tokenProvider: TokenProviderConfig | Record<string, unknown>;
  headerName: string;
}

export class BearerTokenHeaderAuthInjectionStrategyFactory extends AuthInjectionStrategyFactory<BearerTokenHeaderAuthInjectionStrategyConfig> {
  public readonly type = 'BearerTokenHeaderAuth';

  public async create(
    config?: BearerTokenHeaderAuthInjectionStrategyConfig | Record<string, unknown> | null
  ): Promise<AuthInjectionStrategy> {
    const normalized = normalizeConfig(config);
    return new BearerTokenHeaderAuthInjectionStrategy(normalized);
  }
}

function normalizeConfig(
  config?: BearerTokenHeaderAuthInjectionStrategyConfig | Record<string, unknown> | null
): NormalizedBearerConfig {
  if (!config) {
    throw new Error('BearerTokenHeaderAuthInjectionStrategy requires configuration');
  }

  const candidate = config as BearerTokenHeaderAuthInjectionStrategyConfig & Record<string, unknown>;
  const type = typeof candidate.type === 'string' ? candidate.type : undefined;
  if (type !== 'BearerTokenHeaderAuth') {
    throw new Error(
      `BearerTokenHeaderAuthInjectionStrategyFactory expects type "BearerTokenHeaderAuth", got "${type ?? 'undefined'}"`
    );
  }

  const tokenProvider = candidate.tokenProvider ?? candidate.token_provider;
  if (!tokenProvider) {
    throw new Error('BearerTokenHeaderAuthInjectionStrategy requires a tokenProvider configuration');
  }

  const headerCandidate =
    candidate.headerName ?? candidate.header_name ?? candidate.param;
  const headerName = typeof headerCandidate === 'string' && headerCandidate.trim().length > 0
    ? headerCandidate.trim()
    : 'Authorization';

  return {
    type: 'BearerTokenHeaderAuth',
    tokenProvider,
    headerName,
  };
}

registerFactory<AuthInjectionStrategy, BearerTokenHeaderAuthInjectionStrategyConfig>(
  AUTH_INJECTION_STRATEGY_FACTORY_BASE_TYPE,
  'BearerTokenHeaderAuth',
  BearerTokenHeaderAuthInjectionStrategyFactory
);
