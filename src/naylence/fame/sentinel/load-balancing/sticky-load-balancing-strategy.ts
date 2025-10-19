import type { FameEnvelope } from 'naylence-core';

import { getLogger } from '../../util/logging.js';
import type { LoadBalancerStickinessManager } from '../../stickiness/load-balancer-stickiness-manager.js';
import type { LoadBalancingStrategy } from './load-balancing-strategy.js';

const logger = getLogger(
  'naylence.fame.sentinel.load_balancing.sticky_load_balancing_strategy'
);

type MetricsGetter = () => Record<string, unknown>;

type AssociationsGetter = () => Record<string, unknown>;

export class StickyLoadBalancingStrategy implements LoadBalancingStrategy {
  private readonly stickinessManager: LoadBalancerStickinessManager;
  private lastChosenReplica: string | null = null;

  constructor(stickinessManager: LoadBalancerStickinessManager) {
    if (!stickinessManager) {
      throw new Error(
        'StickyLoadBalancingStrategy requires a stickiness manager'
      );
    }
    this.stickinessManager = stickinessManager;
  }

  public choose(
    poolKey: unknown,
    segments: readonly string[],
    envelope: FameEnvelope
  ): string | null {
    if (!segments.length) {
      return null;
    }

    const stickyReplica = this.stickinessManager.getStickyReplicaSegment(
      envelope,
      segments
    );

    if (stickyReplica && segments.includes(stickyReplica)) {
      logger.debug('routing_via_stickiness', {
        envelopeId: envelope.id,
        poolKey,
        replicaId: stickyReplica,
        aftPresent: Boolean((envelope as Record<string, unknown>).aft),
        sidPresent: Boolean((envelope as Record<string, unknown>).sid),
      });
      this.lastChosenReplica = stickyReplica;
      return stickyReplica;
    }

    logger.debug('no_stickiness_match_fallback', {
      envelopeId: envelope.id,
      poolKey,
      aftPresent: Boolean((envelope as Record<string, unknown>).aft),
      sidPresent: Boolean((envelope as Record<string, unknown>).sid),
    });
    return null;
  }

  public getMetrics(): Record<string, unknown> {
    const candidate = this.stickinessManager as unknown as {
      getMetrics?: MetricsGetter;
    };
    if (typeof candidate.getMetrics === 'function') {
      return candidate.getMetrics();
    }
    return {};
  }

  public getAssociations(): Record<string, unknown> {
    const candidate = this.stickinessManager as unknown as {
      getAssociations?: AssociationsGetter;
    };
    if (typeof candidate.getAssociations === 'function') {
      return candidate.getAssociations();
    }
    return {};
  }

  public getLastChosenReplica(): string | null {
    return this.lastChosenReplica;
  }
}
