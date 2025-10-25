import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { FameEnvelope } from '@naylence/core';

import type { LoadBalancingStrategy } from './load-balancing-strategy.js';

type HashFunction = (value: string) => bigint;

const defaultHash: HashFunction = (value: string) => {
  const digest = sha256(utf8ToBytes(value));
  return BigInt(`0x${bytesToHex(digest)}`);
};

/**
 * Highest Random Weight (HRW) load balancing strategy.
 *
 * This strategy deterministically selects the segment that maximizes the hash of
 * the segment identifier combined with a salt. The salt defaults to the envelope id,
 * or a sticky attribute if configured, reproducing the Python implementation semantics.
 */
export class HRWLoadBalancingStrategy implements LoadBalancingStrategy {
  private readonly hash: HashFunction;
  private readonly stickyAttribute: string | null;

  constructor(
    options: { hashFunc?: HashFunction; stickyAttribute?: string | null } = {}
  ) {
    this.hash = options.hashFunc ?? defaultHash;
    this.stickyAttribute = options.stickyAttribute ?? null;
  }

  public choose(
    _poolKey: unknown,
    segments: readonly string[],
    envelope: FameEnvelope
  ): string | null {
    if (!segments.length) {
      return null;
    }

    const salt = this.resolveSalt(envelope);

    let bestSegment: string | null = null;
    let bestWeight: bigint | null = null;

    for (const segment of segments) {
      const weight = this.hash(`${segment}:${salt}`);
      if (bestSegment === null || bestWeight === null || weight > bestWeight) {
        bestSegment = segment;
        bestWeight = weight;
      }
    }

    return bestSegment;
  }

  private resolveSalt(envelope: FameEnvelope): string {
    if (this.stickyAttribute) {
      const candidate = (envelope as Record<string, unknown>)[
        this.stickyAttribute
      ];
      if (typeof candidate === 'string' && candidate.length > 0) {
        return candidate;
      }
    }

    if (typeof envelope.id === 'string' && envelope.id.length > 0) {
      return envelope.id;
    }

    return '';
  }
}
