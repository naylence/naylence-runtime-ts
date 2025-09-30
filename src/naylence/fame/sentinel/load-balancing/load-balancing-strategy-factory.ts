import { createResource } from "naylence-factory";
import type { ResourceConfig, ResourceFactory as BaseResourceFactory } from "naylence-factory";

import type { LoadBalancingStrategy } from "./load-balancing-strategy.js";

export const LOAD_BALANCING_STRATEGY_FACTORY_BASE = "LoadBalancingStrategyFactory";

export interface LoadBalancingStrategyConfig extends ResourceConfig {
  type: string;
}

export abstract class LoadBalancingStrategyFactory
  implements BaseResourceFactory<LoadBalancingStrategy, LoadBalancingStrategyConfig>
{
  public abstract readonly type: string;
  public readonly isDefault?: boolean = false;
  public readonly priority?: number = 0;

  public abstract create(
    config?: LoadBalancingStrategyConfig | Record<string, unknown> | null,
    ...kwargs: unknown[]
  ): Promise<LoadBalancingStrategy>;

  public static async createLoadBalancingStrategy(
    config?: LoadBalancingStrategyConfig | Record<string, unknown> | null
  ): Promise<LoadBalancingStrategy> {
    const finalConfig = config ?? { type: "HRWLoadBalancingStrategy" };

    const strategy = await createResource<LoadBalancingStrategy>(
      LOAD_BALANCING_STRATEGY_FACTORY_BASE,
      finalConfig
    );

    if (!strategy) {
      throw new Error("Failed to create load balancing strategy");
    }

    return strategy;
  }
}
