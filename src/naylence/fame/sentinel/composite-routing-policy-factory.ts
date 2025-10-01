import { createResource, registerFactory } from "naylence-factory";

import { getLogger } from "../util/logging.js";
import { CapabilityAwareRoutingPolicy } from "./capability-aware-routing-policy.js";
import { CompositeRoutingPolicy } from "./composite-routing-policy.js";
import { HybridPathRoutingPolicy } from "./hybrid-path-routing-policy.js";
import type { LoadBalancingStrategy } from "./load-balancing/load-balancing-strategy.js";
import {
  ROUTING_POLICY_FACTORY_BASE,
  RoutingPolicyFactory,
  type RoutingPolicy,
  type RoutingPolicyConfig,
} from "./routing-policy.js";

const logger = getLogger("composite-routing-policy-factory");

export interface CompositeRoutingPolicyConfig extends RoutingPolicyConfig {
  type: "CompositeRoutingPolicy";
  policies?: (RoutingPolicyConfig | Record<string, unknown> | null | undefined)[] | null;
}

interface NormalizedCompositeRoutingPolicyConfig {
  policies: (RoutingPolicyConfig | Record<string, unknown>)[];
}

export class CompositeRoutingPolicyFactory extends RoutingPolicyFactory {
  public readonly type = "CompositeRoutingPolicy";
  public readonly isDefault = true;
  public readonly priority = 100;

  public async create(
    config?: CompositeRoutingPolicyConfig | Record<string, unknown> | null,
    ...kwargs: unknown[]
  ): Promise<RoutingPolicy> {
    const normalized = this.normalizeConfig(config);
    const [loadBalancingStrategy] = kwargs as [LoadBalancingStrategy | undefined];

    const policies: RoutingPolicy[] = [];
    for (const policyConfig of normalized.policies) {
      try {
        const policy = await createResource<RoutingPolicy>(
          ROUTING_POLICY_FACTORY_BASE,
          policyConfig,
          {
            factoryArgs: [loadBalancingStrategy],
            validate: false,
          }
        );

        if (policy) {
          policies.push(policy);
        } else {
          logger.warning("composite_policy_null_child", { config: policyConfig });
        }
      } catch (error) {
        logger.warning("composite_policy_child_error", {
          error: error instanceof Error ? error.message : String(error),
          config: policyConfig,
        });
      }
    }

    if (policies.length === 0) {
      policies.push(...this.createFallbackPolicies(loadBalancingStrategy ?? null));
    }

    return new CompositeRoutingPolicy(policies);
  }

  private normalizeConfig(
    config?: CompositeRoutingPolicyConfig | Record<string, unknown> | null
  ): NormalizedCompositeRoutingPolicyConfig {
    if (!config) {
      return { policies: [] };
    }

    if ("type" in config) {
      const typeValue = (config as { type?: unknown }).type;
      if (typeValue !== undefined && typeValue !== "CompositeRoutingPolicy") {
        throw new Error(
          `CompositeRoutingPolicyFactory only supports CompositeRoutingPolicy config, got type ${String(
            typeValue
          )}`
        );
      }
    }

    const maybePolicies =
      "policies" in config ? (config as { policies?: unknown }).policies : undefined;
    if (maybePolicies == null) {
      return { policies: [] };
    }

    if (!Array.isArray(maybePolicies)) {
      throw new Error("policies must be an array when provided");
    }

    const normalizedPolicies = maybePolicies
      .map((entry) => this.normalizePolicyEntry(entry))
      .filter((entry): entry is RoutingPolicyConfig | Record<string, unknown> => entry !== null);

    return { policies: normalizedPolicies };
  }

  private normalizePolicyEntry(
    entry: RoutingPolicyConfig | Record<string, unknown> | null | undefined
  ): RoutingPolicyConfig | Record<string, unknown> | null {
    if (entry == null) {
      return null;
    }

    if (typeof entry !== "object") {
      throw new Error("Each policy entry must be an object when provided");
    }

    return entry;
  }

  private createFallbackPolicies(
    loadBalancingStrategy: LoadBalancingStrategy | null
  ): RoutingPolicy[] {
    const capabilityOptions = loadBalancingStrategy ? { loadBalancingStrategy } : undefined;
    const hybridOptions = loadBalancingStrategy ? { loadBalancingStrategy } : undefined;

    return [
      new CapabilityAwareRoutingPolicy(capabilityOptions),
      new HybridPathRoutingPolicy(hybridOptions),
    ];
  }
}

registerFactory<RoutingPolicy, CompositeRoutingPolicyConfig>(
  ROUTING_POLICY_FACTORY_BASE,
  "CompositeRoutingPolicy",
  CompositeRoutingPolicyFactory,
  { isDefault: true, priority: 100 }
);
