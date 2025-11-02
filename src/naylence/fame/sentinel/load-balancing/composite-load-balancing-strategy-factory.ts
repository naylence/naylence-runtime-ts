import { createResource } from '@naylence/factory';
import type { LoadBalancingStrategy } from './load-balancing-strategy.js';
import {
  LOAD_BALANCING_STRATEGY_FACTORY_BASE,
  LoadBalancingStrategyFactory,
  type LoadBalancingStrategyConfig,
} from './load-balancing-strategy-factory.js';
import { CompositeLoadBalancingStrategy } from './composite-load-balancing-strategy.js';

export interface CompositeLoadBalancingStrategyConfig
  extends LoadBalancingStrategyConfig {
  type: 'CompositeLoadBalancingStrategy';
  strategies: LoadBalancingStrategyConfig[];
}

export const FACTORY_META = {
  base: LOAD_BALANCING_STRATEGY_FACTORY_BASE,
  key: 'CompositeLoadBalancingStrategy',
} as const;

export class CompositeLoadBalancingStrategyFactory extends LoadBalancingStrategyFactory {
  public readonly type = 'CompositeLoadBalancingStrategy';

  public async create(
    config?:
      | CompositeLoadBalancingStrategyConfig
      | Record<string, unknown>
      | null,
    ...factoryArgs: unknown[]
  ): Promise<LoadBalancingStrategy> {
    const finalConfig = this.normalizeConfig(config);
    const strategies = await Promise.all(
      finalConfig.strategies.map(async (strategyConfig) => {
        const strategy = await createResource<LoadBalancingStrategy>(
          LOAD_BALANCING_STRATEGY_FACTORY_BASE,
          strategyConfig,
          { factoryArgs }
        );

        if (!strategy) {
          throw new Error(
            'Failed to create composite load balancing strategy component'
          );
        }

        return strategy;
      })
    );

    return new CompositeLoadBalancingStrategy(strategies);
  }

  private normalizeConfig(
    config?:
      | CompositeLoadBalancingStrategyConfig
      | Record<string, unknown>
      | null
  ): CompositeLoadBalancingStrategyConfig {
    if (!config) {
      throw new Error(
        'CompositeLoadBalancingStrategy requires strategy configuration'
      );
    }

    if (
      (config as { type?: unknown }).type &&
      (config as { type?: unknown }).type !== this.type
    ) {
      throw new Error(
        'CompositeLoadBalancingStrategyFactory only supports composite configurations'
      );
    }

    const rawStrategies = this.extractStrategies(config);
    if (!Array.isArray(rawStrategies) || rawStrategies.length === 0) {
      throw new Error(
        'CompositeLoadBalancingStrategy requires at least one nested strategy'
      );
    }

    return {
      type: this.type,
      strategies: rawStrategies as LoadBalancingStrategyConfig[],
    };
  }

  private extractStrategies(
    config:
      | CompositeLoadBalancingStrategyConfig
      | Record<string, unknown>
  ): unknown {
    const typedCandidate = config as { strategies?: unknown };
    if (Array.isArray(typedCandidate.strategies)) {
      return typedCandidate.strategies;
    }

    const recordCandidate = config as Record<string, unknown>;
    for (const key of ['strategies', 'strategy_configs', 'strategyConfigs'] as const) {
      if (Object.prototype.hasOwnProperty.call(recordCandidate, key)) {
        return recordCandidate[key];
      }
    }

    return undefined;
  }
}

export default CompositeLoadBalancingStrategyFactory;
