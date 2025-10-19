import type { FameEnvelope } from 'naylence-core';

import { getLogger } from '../../util/logging.js';
import type { LoadBalancingStrategy } from './load-balancing-strategy.js';

const logger = getLogger(
  'naylence.fame.sentinel.load_balancing.composite_load_balancing_strategy'
);

export class CompositeLoadBalancingStrategy implements LoadBalancingStrategy {
  private readonly strategies: readonly LoadBalancingStrategy[];

  constructor(strategies: readonly LoadBalancingStrategy[]) {
    if (!strategies.length) {
      throw new Error(
        'CompositeLoadBalancingStrategy requires at least one strategy'
      );
    }

    this.strategies = [...strategies];
  }

  public choose(
    poolKey: unknown,
    segments: readonly string[],
    envelope: FameEnvelope
  ): string | null {
    if (!segments.length) {
      return null;
    }

    for (let index = 0; index < this.strategies.length; index += 1) {
      const strategy = this.strategies[index];
      try {
        const result = strategy.choose(poolKey, segments, envelope);
        if (result !== null) {
          logger.debug('composite_strategy_success', {
            envelopeId: envelope.id,
            poolKey,
            strategyIndex: index,
            strategyType: strategy.constructor?.name ?? 'unknown',
            result,
          });
          return result;
        }
      } catch (error) {
        logger.warning('composite_strategy_error', {
          envelopeId: envelope.id,
          poolKey,
          strategyIndex: index,
          strategyType: strategy.constructor?.name ?? 'unknown',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.debug('composite_strategy_all_failed', {
      envelopeId: envelope.id,
      poolKey,
      strategyCount: this.strategies.length,
    });
    return null;
  }
}
