import type { FameEnvelope } from '@naylence/core';

import type { LoadBalancingStrategy } from './load-balancing-strategy.js';

type RandomSource = () => number;

export class RandomLoadBalancingStrategy implements LoadBalancingStrategy {
  private readonly random: RandomSource;

  constructor(options: { rng?: RandomSource } = {}) {
    this.random = options.rng ?? Math.random;
  }

  public choose(
    _poolKey: unknown,
    segments: readonly string[],
    _envelope: FameEnvelope
  ): string | null {
    if (!segments.length) {
      return null;
    }

    const value = this.random();
    const clamped = Number.isFinite(value)
      ? Math.min(Math.max(value, 0), 0.9999999999999999)
      : 0;
    const idx = Math.floor(clamped * segments.length);
    return segments[idx];
  }
}
