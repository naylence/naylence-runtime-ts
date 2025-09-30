import { createResource, registerFactory } from "naylence-factory";

import type { LoadBalancingStrategy } from "./load-balancing/load-balancing-strategy.js";
import {
  LOAD_BALANCING_STRATEGY_FACTORY_BASE,
  LoadBalancingStrategyFactory,
  type LoadBalancingStrategyConfig,
} from "./load-balancing/load-balancing-strategy-factory.js";
import { CapabilityAwareRoutingPolicy } from "./capability-aware-routing-policy.js";
import {
  ROUTING_POLICY_FACTORY_BASE,
  RoutingPolicyFactory,
  type RoutingPolicyConfig,
} from "./routing-policy.js";
import type { RoutingPolicy } from "./routing-policy.js";

export interface CapabilityAwareRoutingPolicyConfig extends RoutingPolicyConfig {
  type: "CapabilityAwareRoutingPolicy";
  loadBalancingStrategy?: LoadBalancingStrategyConfig | Record<string, unknown> | null;
}

export class CapabilityAwareRoutingPolicyFactory extends RoutingPolicyFactory {
  public readonly type = "CapabilityAwareRoutingPolicy";
  public readonly isDefault = true;
  public readonly priority = 50;

  public async create(
    config?: CapabilityAwareRoutingPolicyConfig | Record<string, unknown> | null,
    ...kwargs: unknown[]
  ): Promise<RoutingPolicy> {
    const normalized = this.normalizeConfig(config);
    const [providedStrategy] = kwargs as [LoadBalancingStrategy | undefined];

    let loadBalancingStrategy = providedStrategy ?? null;

    if (!loadBalancingStrategy) {
      loadBalancingStrategy = await this.tryCreateStrategy(normalized.loadBalancingStrategy);
    }

    if (!loadBalancingStrategy) {
      loadBalancingStrategy = await LoadBalancingStrategyFactory.createLoadBalancingStrategy(
        normalized.loadBalancingStrategy ?? null
      );
    }

    return new CapabilityAwareRoutingPolicy({ loadBalancingStrategy });
  }

  private normalizeConfig(
    config?: CapabilityAwareRoutingPolicyConfig | Record<string, unknown> | null
  ): CapabilityAwareRoutingPolicyConfig {
    if (!config) {
      return {
        type: "CapabilityAwareRoutingPolicy",
        loadBalancingStrategy: null,
      };
    }

    if ("type" in config && config.type !== "CapabilityAwareRoutingPolicy") {
      throw new Error(
        `CapabilityAwareRoutingPolicyFactory only supports CapabilityAwareRoutingPolicy config, got type ${String(
          (config as { type?: unknown }).type
        )}`
      );
    }

    const loadBalancingStrategy = this.extractStrategyConfig(config);

    return {
      type: "CapabilityAwareRoutingPolicy",
      loadBalancingStrategy,
    };
  }

  private extractStrategyConfig(
    config: CapabilityAwareRoutingPolicyConfig | Record<string, unknown>
  ): LoadBalancingStrategyConfig | Record<string, unknown> | null {
    if ("loadBalancingStrategy" in config) {
      const value = (config as CapabilityAwareRoutingPolicyConfig).loadBalancingStrategy;
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
    config: CapabilityAwareRoutingPolicyConfig["loadBalancingStrategy"]
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

registerFactory<RoutingPolicy, CapabilityAwareRoutingPolicyConfig>(
  ROUTING_POLICY_FACTORY_BASE,
  "CapabilityAwareRoutingPolicy",
  CapabilityAwareRoutingPolicyFactory,
  { isDefault: true, priority: 50 }
);
