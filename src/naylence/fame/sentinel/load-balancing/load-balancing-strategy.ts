import type { FameEnvelope } from "naylence-core";

/**
 * Strategy interface for choosing a downstream segment from a pool.
 *
 * Returning `null` signals that the strategy could not make a decision and a fallback
 * strategy should be attempted.
 */
export interface LoadBalancingStrategy {
  choose(poolKey: unknown, segments: readonly string[], envelope: FameEnvelope): string | null;
}
