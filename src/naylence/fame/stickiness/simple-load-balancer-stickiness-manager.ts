import type { FameEnvelope, Stickiness } from 'naylence-core';

import { BaseNodeEventListener } from '../node/node-event-listener.js';
import { getLogger } from '../util/logging.js';

import type { LoadBalancerStickinessManager } from './load-balancer-stickiness-manager.js';
import type { SimpleLoadBalancerStickinessManagerConfig } from './simple-load-balancer-stickiness-manager-factory.js';

const logger = getLogger(
  'naylence.fame.stickiness.simple_load_balancer_stickiness_manager'
);

export class SimpleLoadBalancerStickinessManager
  extends BaseNodeEventListener
  implements LoadBalancerStickinessManager
{
  private readonly config: SimpleLoadBalancerStickinessManagerConfig | null;

  constructor(config?: SimpleLoadBalancerStickinessManagerConfig | null) {
    super();
    this.config = config ?? null;

    logger.debug('simple_load_balancer_stickiness_manager_initialized');
  }

  public negotiate(stickiness?: Stickiness | null): Stickiness | null {
    if (!stickiness) {
      if (this.config) {
        logger.debug('stickiness_negotiated_no_offer_attr_fallback');
        return { enabled: true, mode: 'attr', version: 1 };
      }

      return null;
    }

    const version = stickiness.version ?? 1;

    if (!this.config) {
      logger.debug('stickiness_negotiation_disabled_by_config');
      return { enabled: false, version };
    }

    const childModes = new Set<string>();
    if (
      Array.isArray(stickiness.supportedModes) &&
      stickiness.supportedModes.length > 0
    ) {
      for (const mode of stickiness.supportedModes) {
        childModes.add(mode);
      }
    } else if (stickiness.mode) {
      childModes.add(stickiness.mode);
    }

    if (childModes.has('attr')) {
      const policy: Stickiness = { enabled: true, mode: 'attr', version };
      logger.debug('stickiness_negotiated', { mode: policy.mode });
      return policy;
    }

    logger.debug('stickiness_negotiation_no_common_mode');
    return { enabled: false, version };
  }

  public getStickyReplicaSegment(
    envelope: FameEnvelope,
    segments?: readonly string[] | null
  ): string | null {
    if (!this.config) {
      logger.debug('stickiness_disabled', { envelopeId: envelope.id });
      return null;
    }

    if (envelope.sid && Array.isArray(segments) && segments.length > 0) {
      const index =
        SimpleLoadBalancerStickinessManager.computeDeterministicIndex(
          envelope.sid,
          segments.length
        );
      const chosen = segments[index];
      logger.debug('sid_based_deterministic_choice', {
        envelopeId: envelope.id,
        sid: envelope.sid,
        chosen,
        routingType: 'sid_deterministic',
      });
      return chosen;
    }

    logger.debug('no_stickiness_routing', {
      envelopeId: envelope.id,
      hasAft: Boolean(envelope.aft),
      hasSid: Boolean(envelope.sid),
    });
    return null;
  }

  private static computeDeterministicIndex(
    key: string,
    modulo: number
  ): number {
    let hash = 0;

    for (let i = 0; i < key.length; i += 1) {
      hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
    }

    return modulo === 0 ? 0 : hash % modulo;
  }
}
