import { registerFactory } from "naylence-factory";

import type { LoadBalancingStrategy } from "./load-balancing-strategy.js";
import {
  LOAD_BALANCING_STRATEGY_FACTORY_BASE,
  LoadBalancingStrategyFactory,
  type LoadBalancingStrategyConfig,
} from "./load-balancing-strategy-factory.js";
import { RoundRobinLoadBalancingStrategy } from "./round-robin-load-balancing-strategy.js";

export interface RoundRobinLoadBalancingStrategyConfig extends LoadBalancingStrategyConfig {
  type: "RoundRobinLoadBalancingStrategy";
}

export class RoundRobinLoadBalancingStrategyFactory extends LoadBalancingStrategyFactory {
  public readonly type = "RoundRobinLoadBalancingStrategy";

  public async create(
    _config?: RoundRobinLoadBalancingStrategyConfig | Record<string, unknown> | null,
    ..._factoryArgs: unknown[]
  ): Promise<LoadBalancingStrategy> {
    return new RoundRobinLoadBalancingStrategy();
  }
}

registerFactory<LoadBalancingStrategy, RoundRobinLoadBalancingStrategyConfig>(
  LOAD_BALANCING_STRATEGY_FACTORY_BASE,
  "RoundRobinLoadBalancingStrategy",
  RoundRobinLoadBalancingStrategyFactory
);
