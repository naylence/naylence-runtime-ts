import type { FameDeliveryContext, FameEnvelope } from "naylence-core";
import {
  createDefaultResource,
  createResource,
  type ResourceConfig,
  type ResourceFactory as BaseResourceFactory,
} from "naylence-factory";

import type { RouterState, RoutingAction } from "./router.js";
import type { LoadBalancingStrategy } from "./load-balancing/load-balancing-strategy.js";

export const ROUTING_POLICY_FACTORY_BASE = "RoutingPolicyFactory";

export interface RoutingPolicy {
  decide(
    envelope: FameEnvelope,
    state: RouterState,
    context?: FameDeliveryContext | null
  ): Promise<RoutingAction>;
}

export interface RoutingPolicyConfig extends ResourceConfig {
  type: string;
  [key: string]: unknown;
}

export abstract class RoutingPolicyFactory
  implements BaseResourceFactory<RoutingPolicy, RoutingPolicyConfig>
{
  public abstract readonly type: string;
  public readonly isDefault?: boolean = false;
  public readonly priority?: number = 0;

  public abstract create(
    config?: RoutingPolicyConfig | Record<string, unknown> | null,
    ...kwargs: unknown[]
  ): Promise<RoutingPolicy>;

  public static async createRoutingPolicy(
    loadBalancingStrategy: LoadBalancingStrategy,
    config?: RoutingPolicyConfig | Record<string, unknown> | null
  ): Promise<RoutingPolicy> {
    const typedConfig = config ?? null;

    if (typedConfig && typeof (typedConfig as Record<string, unknown>).type === "string") {
      const policy = await createResource<RoutingPolicy>(ROUTING_POLICY_FACTORY_BASE, typedConfig, {
        factoryArgs: [loadBalancingStrategy],
        validate: false,
      });

      if (policy) {
        return policy;
      }
    }

    const policy = await createDefaultResource<RoutingPolicy>(
      ROUTING_POLICY_FACTORY_BASE,
      config ?? null,
      {
        factoryArgs: [loadBalancingStrategy],
        validate: false,
      }
    );

    if (!policy) {
      throw new Error("Failed to create routing policy");
    }

    return policy;
  }
}
