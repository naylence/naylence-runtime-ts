import type { FameDeliveryContext, FameEnvelope } from '@naylence/core';

import { Drop } from './router.js';
import type { RouterState, RoutingAction } from './router.js';
import type { RoutingPolicy } from './routing-policy.js';

/**
 * Composite routing policy that evaluates child policies in order.
 * Returns the first non-drop action produced by the configured policies.
 */
export class CompositeRoutingPolicy implements RoutingPolicy {
  private readonly policies: readonly RoutingPolicy[];

  constructor(policies: Iterable<RoutingPolicy>) {
    this.policies = Array.from(policies);
  }

  public async decide(
    envelope: FameEnvelope,
    state: RouterState,
    context: FameDeliveryContext | null = null
  ): Promise<RoutingAction> {
    for (const policy of this.policies) {
      const action = await policy.decide(envelope, state, context);
      if (!(action instanceof Drop)) {
        return action;
      }
    }

    return new Drop();
  }
}
