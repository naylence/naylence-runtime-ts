import type { FameAddress } from '@naylence/core';
import { FameDeliveryContext, FameEnvelope } from '@naylence/core';

import { getLogger, summarizeEnvelope } from '../util/logging.js';
import { HRWLoadBalancingStrategy } from './load-balancing/hrw-load-balancing-strategy.js';
import type { LoadBalancingStrategy } from './load-balancing/load-balancing-strategy.js';
import {
  DeliverLocal,
  Drop,
  ForwardChild,
  ForwardUp,
  type ResolveAddressByCapability,
  type RouterState,
  type RoutingAction,
} from './router.js';
import type { RoutingPolicy } from './routing-policy.js';

const logger = getLogger(
  'naylence.fame.sentinel.capability_aware_routing_policy'
);

export interface CapabilityAwareRoutingPolicyOptions {
  loadBalancingStrategy?: LoadBalancingStrategy;
  resolveAddressByCapability?: ResolveAddressByCapability;
}

type CapabilityAwareRoutingPolicyOptionsInput =
  | CapabilityAwareRoutingPolicyOptions
  | Record<string, unknown>
  | null
  | undefined;

function normalizeOptions(
  options?: CapabilityAwareRoutingPolicyOptionsInput
): CapabilityAwareRoutingPolicyOptions {
  if (!options || typeof options !== 'object') {
    return {};
  }

  const candidate = options as Record<string, unknown>;
  const resolved: CapabilityAwareRoutingPolicyOptions = {
    ...(options as CapabilityAwareRoutingPolicyOptions),
  };

  if ('load_balancing_strategy' in candidate) {
    const strategy = candidate.load_balancing_strategy;
    if (strategy && typeof strategy === 'object') {
      resolved.loadBalancingStrategy = strategy as LoadBalancingStrategy;
    }
  }

  if ('resolve_address_by_capability' in candidate) {
    const resolver = candidate.resolve_address_by_capability;
    if (typeof resolver === 'function') {
      resolved.resolveAddressByCapability =
        resolver as ResolveAddressByCapability;
    }
  }

  return resolved;
}

export class CapabilityAwareRoutingPolicy implements RoutingPolicy {
  private readonly loadBalancingStrategy: LoadBalancingStrategy;
  private readonly resolveAddressOverride: ResolveAddressByCapability | null;

  constructor(options: CapabilityAwareRoutingPolicyOptionsInput = {}) {
    const normalized = normalizeOptions(options);
    this.loadBalancingStrategy =
      normalized.loadBalancingStrategy ?? new HRWLoadBalancingStrategy();
    this.resolveAddressOverride = normalized.resolveAddressByCapability ?? null;
  }

  public async decide(
    envelope: FameEnvelope,
    state: RouterState,
    _context?: FameDeliveryContext | null
  ): Promise<RoutingAction> {
    if (envelope.to) {
      return new Drop();
    }

    if (!this.isDataEnvelope(envelope)) {
      return new Drop();
    }

    const capabilities = envelope.capabilities ?? [];
    if (capabilities.length === 0) {
      return new Drop();
    }

    const resolved = await this.tryResolveLocalAddress(capabilities, state);
    if (resolved) {
      return new DeliverLocal(resolved);
    }

    const providerSegments = this.getProviderSegments(capabilities, state);
    if (providerSegments.length > 0) {
      const chosenSegment = this.loadBalancingStrategy.choose(
        capabilities,
        providerSegments,
        envelope
      );
      if (chosenSegment) {
        return new ForwardChild(chosenSegment);
      }

      logger.warning('capability_policy_lb_failed', {
        segments: providerSegments,
        capabilities,
        ...summarizeEnvelope(envelope),
      });
    }

    if (state.hasParent) {
      return new ForwardUp();
    }

    return new Drop();
  }

  private isDataEnvelope(envelope: FameEnvelope): boolean {
    return envelope.frame?.type === 'Data';
  }

  private async tryResolveLocalAddress(
    capabilities: string[],
    state: RouterState
  ): Promise<FameAddress | null> {
    const resolver =
      state.resolveAddressByCapability ?? this.resolveAddressOverride;
    if (!resolver) {
      return null;
    }

    try {
      const address = await resolver(capabilities);
      if (!address) {
        return null;
      }

      if (this.hasLocalAddress(state, address)) {
        return address;
      }
    } catch (error) {
      logger.warning('capability_policy_resolve_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return null;
  }

  private hasLocalAddress(state: RouterState, candidate: FameAddress): boolean {
    return state.local.has(candidate.toString());
  }

  private getProviderSegments(
    capabilities: string[],
    state: RouterState
  ): string[] {
    let intersectingSegments: Set<string> | null = null;

    for (const capability of capabilities) {
      const routes = state.capabilities[capability];
      if (!routes) {
        intersectingSegments = new Set();
        break;
      }

      const segmentsForCap = new Set(Object.values(routes));
      if (intersectingSegments) {
        const nextSegments = new Set<string>();
        for (const segment of intersectingSegments) {
          if (segmentsForCap.has(segment)) {
            nextSegments.add(segment);
          }
        }
        intersectingSegments = nextSegments;
      } else {
        intersectingSegments = segmentsForCap;
      }

      if (intersectingSegments.size === 0) {
        break;
      }
    }

    return intersectingSegments ? [...intersectingSegments] : [];
  }
}
