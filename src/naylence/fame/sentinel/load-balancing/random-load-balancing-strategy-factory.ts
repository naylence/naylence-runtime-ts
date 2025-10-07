import type { LoadBalancingStrategy } from './load-balancing-strategy.js';
import {
  LOAD_BALANCING_STRATEGY_FACTORY_BASE,
  LoadBalancingStrategyFactory,
  type LoadBalancingStrategyConfig,
} from './load-balancing-strategy-factory.js';
import { RandomLoadBalancingStrategy } from './random-load-balancing-strategy.js';

export interface RandomLoadBalancingStrategyConfig
  extends LoadBalancingStrategyConfig {
  type: 'RandomLoadBalancingStrategy';
}

export const FACTORY_META = {
  base: LOAD_BALANCING_STRATEGY_FACTORY_BASE,
  key: 'RandomLoadBalancingStrategy',
} as const;

export class RandomLoadBalancingStrategyFactory extends LoadBalancingStrategyFactory {
  public readonly type = 'RandomLoadBalancingStrategy';

  public async create(
    _config?:
      | RandomLoadBalancingStrategyConfig
      | Record<string, unknown>
      | null,
    ..._factoryArgs: unknown[]
  ): Promise<LoadBalancingStrategy> {
    return new RandomLoadBalancingStrategy();
  }
}

export default RandomLoadBalancingStrategyFactory;
