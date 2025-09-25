import { registerFactory } from 'naylence-factory';
import type { AuthInjectionStrategy } from './auth-injection-strategy.js';
import {
  AUTH_INJECTION_STRATEGY_FACTORY_BASE_TYPE,
  AuthInjectionStrategyFactory,
  type AuthInjectionStrategyConfig,
} from './auth-injection-strategy-factory.js';
import { NoAuthInjectionStrategy } from './no-auth-injection-strategy.js';

export interface NoAuthInjectionStrategyConfig extends AuthInjectionStrategyConfig {
  type: 'NoAuth';
}

export class NoAuthInjectionStrategyFactory extends AuthInjectionStrategyFactory<NoAuthInjectionStrategyConfig> {
  public readonly type = 'NoAuth';

  public async create(
    config?: NoAuthInjectionStrategyConfig | Record<string, unknown> | null
  ): Promise<AuthInjectionStrategy> {
    const preparedConfig = normalizeConfig(config);
    return new NoAuthInjectionStrategy(preparedConfig);
  }
}

function normalizeConfig(
  config?: NoAuthInjectionStrategyConfig | Record<string, unknown> | null
): NoAuthInjectionStrategyConfig {
  const defaultConfig: NoAuthInjectionStrategyConfig = { type: 'NoAuth' };

  if (!config) {
    return defaultConfig;
  }

  const candidate = config as Record<string, unknown>;
  const type = typeof candidate.type === 'string' ? candidate.type : 'NoAuth';

  if (type !== 'NoAuth') {
    throw new Error(`NoAuthInjectionStrategyFactory expects type "NoAuth", got "${type}"`);
  }

  return defaultConfig;
}

registerFactory<AuthInjectionStrategy, NoAuthInjectionStrategyConfig>(
  AUTH_INJECTION_STRATEGY_FACTORY_BASE_TYPE,
  'NoAuth',
  NoAuthInjectionStrategyFactory
);
