import type { AuthInjectionStrategy } from './auth-injection-strategy.js';
import {
  AUTH_INJECTION_STRATEGY_FACTORY_BASE_TYPE,
  AuthInjectionStrategyFactory,
  type AuthInjectionStrategyConfig,
} from './auth-injection-strategy-factory.js';
import { QueryParamAuthInjectionStrategy } from './query-param-auth-injection-strategy.js';
import type { TokenProviderConfig } from './token-provider-factory.js';

export interface QueryParamAuthInjectionStrategyConfig
  extends AuthInjectionStrategyConfig {
  type: 'QueryParamAuth';
  tokenProvider: TokenProviderConfig | Record<string, unknown>;
  token_provider?: TokenProviderConfig | Record<string, unknown>;
  paramName?: string;
  param_name?: string;
  param?: string;
}

interface NormalizedQueryParamConfig {
  type: 'QueryParamAuth';
  tokenProvider: TokenProviderConfig | Record<string, unknown>;
  paramName: string;
}

export const FACTORY_META = {
  base: AUTH_INJECTION_STRATEGY_FACTORY_BASE_TYPE,
  key: 'QueryParamAuth',
} as const;

export class QueryParamAuthInjectionStrategyFactory extends AuthInjectionStrategyFactory<QueryParamAuthInjectionStrategyConfig> {
  public readonly type = 'QueryParamAuth';

  public async create(
    config?:
      | QueryParamAuthInjectionStrategyConfig
      | Record<string, unknown>
      | null
  ): Promise<AuthInjectionStrategy> {
    const normalized = normalizeConfig(config);
    return new QueryParamAuthInjectionStrategy(normalized);
  }
}

function normalizeConfig(
  config?:
    | QueryParamAuthInjectionStrategyConfig
    | Record<string, unknown>
    | null
): NormalizedQueryParamConfig {
  if (!config) {
    throw new Error('QueryParamAuthInjectionStrategy requires configuration');
  }

  const candidate = config as QueryParamAuthInjectionStrategyConfig &
    Record<string, unknown>;
  const type = typeof candidate.type === 'string' ? candidate.type : undefined;
  if (type !== 'QueryParamAuth') {
    throw new Error(
      `QueryParamAuthInjectionStrategyFactory expects type "QueryParamAuth", got "${type ?? 'undefined'}"`
    );
  }

  const tokenProvider = candidate.tokenProvider ?? candidate.token_provider;
  if (!tokenProvider) {
    throw new Error(
      'QueryParamAuthInjectionStrategy requires a tokenProvider configuration'
    );
  }

  const paramCandidate =
    candidate.paramName ?? candidate.param_name ?? candidate.param;
  const paramName =
    typeof paramCandidate === 'string' && paramCandidate.trim().length > 0
      ? paramCandidate.trim()
      : 'token';

  return {
    type: 'QueryParamAuth',
    tokenProvider,
    paramName,
  };
}

export default QueryParamAuthInjectionStrategyFactory;
