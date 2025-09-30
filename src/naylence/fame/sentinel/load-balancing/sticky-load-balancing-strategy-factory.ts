import { registerFactory } from "naylence-factory";

import type { LoadBalancingStrategy } from "./load-balancing-strategy.js";
import {
  LOAD_BALANCING_STRATEGY_FACTORY_BASE,
  LoadBalancingStrategyFactory,
  type LoadBalancingStrategyConfig,
} from "./load-balancing-strategy-factory.js";
import { StickyLoadBalancingStrategy } from "./sticky-load-balancing-strategy.js";
import type { LoadBalancerStickinessManager } from "../../stickiness/load-balancer-stickiness-manager.js";

export interface StickyLoadBalancingStrategyConfig extends LoadBalancingStrategyConfig {
  type: "StickyLoadBalancingStrategy";
}

interface StickyStrategyDependencies {
  stickinessManager?: LoadBalancerStickinessManager | null;
}

export class StickyLoadBalancingStrategyFactory extends LoadBalancingStrategyFactory {
  public readonly type = "StickyLoadBalancingStrategy";

  public async create(
    config?: StickyLoadBalancingStrategyConfig | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<LoadBalancingStrategy> {
    this.normalizeConfig(config);

    const dependencies = this.extractDependencies(factoryArgs);
    if (!dependencies.stickinessManager) {
      throw new Error("StickyLoadBalancingStrategy requires a stickinessManager dependency");
    }

    return new StickyLoadBalancingStrategy(dependencies.stickinessManager);
  }

  private normalizeConfig(
    config?: StickyLoadBalancingStrategyConfig | Record<string, unknown> | null
  ): StickyLoadBalancingStrategyConfig {
    if (!config) {
      throw new Error("StickyLoadBalancingStrategy requires configuration");
    }

    if ((config as { type?: unknown }).type && (config as { type?: unknown }).type !== this.type) {
      throw new Error("StickyLoadBalancingStrategyFactory only supports sticky configurations");
    }

    return { type: this.type };
  }

  private extractDependencies(args: unknown[]): StickyStrategyDependencies {
    for (const arg of args) {
      if (
        arg &&
        typeof arg === "object" &&
        "stickinessManager" in (arg as Record<string, unknown>)
      ) {
        return arg as StickyStrategyDependencies;
      }
    }

    return {};
  }
}

registerFactory<LoadBalancingStrategy, StickyLoadBalancingStrategyConfig>(
  LOAD_BALANCING_STRATEGY_FACTORY_BASE,
  "StickyLoadBalancingStrategy",
  StickyLoadBalancingStrategyFactory
);
