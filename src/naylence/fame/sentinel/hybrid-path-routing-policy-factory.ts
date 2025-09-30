import { createResource, registerFactory } from "naylence-factory";

import { HybridPathRoutingPolicy } from "./hybrid-path-routing-policy.js";
import type { LoadBalancingStrategy } from "./load-balancing/load-balancing-strategy.js";
import {
  LOAD_BALANCING_STRATEGY_FACTORY_BASE,
  LoadBalancingStrategyFactory,
  type LoadBalancingStrategyConfig,
} from "./load-balancing/load-balancing-strategy-factory.js";
import {
  ROUTING_POLICY_FACTORY_BASE,
  RoutingPolicyFactory,
  type RoutingPolicy,
  type RoutingPolicyConfig,
} from "./routing-policy.js";

export interface HybridPathRoutingPolicyConfig extends RoutingPolicyConfig {
  type: "HybridPathRoutingPolicy";
  loadBalancingStrategy?: LoadBalancingStrategyConfig | Record<string, unknown> | null;
}

interface NormalizedHybridRoutingConfig {
  type: "HybridPathRoutingPolicy";
  loadBalancingStrategy: LoadBalancingStrategyConfig | Record<string, unknown> | null;
}

export class HybridPathRoutingPolicyFactory extends RoutingPolicyFactory {
  public readonly type = "HybridPathRoutingPolicy";

  public async create(
    config?: HybridPathRoutingPolicyConfig | Record<string, unknown> | null,
    ...kwargs: unknown[]
  ): Promise<RoutingPolicy> {
    const normalized = this.normalizeConfig(config);
    const [providedStrategy] = kwargs as [LoadBalancingStrategy | undefined];

    let strategy: LoadBalancingStrategy | null = providedStrategy ?? null;

    if (!strategy) {
      strategy = await this.tryCreateStrategy(normalized.loadBalancingStrategy);
    }

    if (!strategy) {
      strategy = await LoadBalancingStrategyFactory.createLoadBalancingStrategy(
        normalized.loadBalancingStrategy ?? null
      );
    }

    return new HybridPathRoutingPolicy({ loadBalancingStrategy: strategy });
  }

  private normalizeConfig(
    config?: HybridPathRoutingPolicyConfig | Record<string, unknown> | null
  ): NormalizedHybridRoutingConfig {
    if (!config) {
      return {
        type: "HybridPathRoutingPolicy",
        loadBalancingStrategy: null,
      };
    }

    if ("type" in config && config.type !== "HybridPathRoutingPolicy") {
      throw new Error(
        `HybridPathRoutingPolicyFactory only supports HybridPathRoutingPolicy config, got type ${String(
          (config as { type?: unknown }).type
        )}`
      );
    }

    return {
      type: "HybridPathRoutingPolicy",
      loadBalancingStrategy: this.extractStrategyConfig(config),
    };
  }

  private extractStrategyConfig(
    config: HybridPathRoutingPolicyConfig | Record<string, unknown>
  ): LoadBalancingStrategyConfig | Record<string, unknown> | null {
    if ("loadBalancingStrategy" in config) {
      const value = (config as HybridPathRoutingPolicyConfig).loadBalancingStrategy;
      if (value === undefined || value === null || typeof value === "object") {
        return (value as LoadBalancingStrategyConfig | Record<string, unknown> | null) ?? null;
      }

      throw new Error("loadBalancingStrategy must be an object or null when provided");
    }

    const raw = (config as Record<string, unknown>).loadBalancingStrategy;
    if (raw === undefined || raw === null || typeof raw === "object") {
      return (raw as LoadBalancingStrategyConfig | Record<string, unknown> | null) ?? null;
    }

    throw new Error("loadBalancingStrategy must be an object or null when provided");
  }

  private async tryCreateStrategy(
    config: LoadBalancingStrategyConfig | Record<string, unknown> | null
  ): Promise<LoadBalancingStrategy | null> {
    if (!config) {
      return null;
    }

    return await createResource<LoadBalancingStrategy>(
      LOAD_BALANCING_STRATEGY_FACTORY_BASE,
      config
    );
  }
}

registerFactory<RoutingPolicy, HybridPathRoutingPolicyConfig>(
  ROUTING_POLICY_FACTORY_BASE,
  "HybridPathRoutingPolicy",
  HybridPathRoutingPolicyFactory
);
