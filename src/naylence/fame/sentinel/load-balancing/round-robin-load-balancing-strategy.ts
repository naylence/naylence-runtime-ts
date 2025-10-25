import type { FameEnvelope } from '@naylence/core';

import type { LoadBalancingStrategy } from './load-balancing-strategy.js';

export class RoundRobinLoadBalancingStrategy implements LoadBalancingStrategy {
  private readonly counters = new Map<unknown, number>();

  public choose(
    poolKey: unknown,
    segments: readonly string[],
    _envelope: FameEnvelope
  ): string | null {
    if (!segments.length) {
      return null;
    }

    const current = this.counters.get(poolKey) ?? 0;
    const nextIndex = current % segments.length;
    this.counters.set(poolKey, current + 1);
    return segments[nextIndex];
  }
}
