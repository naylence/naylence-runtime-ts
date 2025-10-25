import type { CreateResourceOptions, ResourceConfig } from '@naylence/factory';
import {
  AbstractResourceFactory,
  createDefaultResource,
  createResource,
} from '@naylence/factory';
import type { AuthInjectionStrategy } from './auth-injection-strategy.js';

export const AUTH_INJECTION_STRATEGY_FACTORY_BASE_TYPE =
  'AuthInjectionStrategyFactory';

export interface AuthInjectionStrategyConfig extends ResourceConfig {
  type: string;
  [key: string]: unknown;
}

export abstract class AuthInjectionStrategyFactory<
  C extends AuthInjectionStrategyConfig = AuthInjectionStrategyConfig,
> extends AbstractResourceFactory<AuthInjectionStrategy, C> {
  public abstract create(
    config?: C | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<AuthInjectionStrategy>;

  public static async createAuthInjectionStrategy<
    C extends AuthInjectionStrategyConfig = AuthInjectionStrategyConfig,
  >(
    config?: C | Record<string, unknown> | null,
    options: CreateResourceOptions = {}
  ): Promise<AuthInjectionStrategy> {
    if (config) {
      const strategy = await createResource<AuthInjectionStrategy>(
        AUTH_INJECTION_STRATEGY_FACTORY_BASE_TYPE,
        config,
        options
      );

      if (!strategy) {
        throw new Error(
          'Failed to create auth injection strategy from configuration'
        );
      }

      return strategy;
    }

    const strategy = await createDefaultResource<AuthInjectionStrategy>(
      AUTH_INJECTION_STRATEGY_FACTORY_BASE_TYPE,
      null,
      options
    );

    if (!strategy) {
      throw new Error('Failed to create default auth injection strategy');
    }

    return strategy;
  }
}
