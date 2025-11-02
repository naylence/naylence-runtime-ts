import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { FameEnvelope } from '@naylence/core';

import type { LoadBalancingStrategy } from './load-balancing-strategy.js';

type HashFunction = (value: string) => bigint;

interface HRWLoadBalancingStrategyOptions {
  hashFunc?: HashFunction;
  stickyAttribute?: string | null;
}

type HRWLoadBalancingStrategyOptionsInput =
  | HRWLoadBalancingStrategyOptions
  | Record<string, unknown>
  | null
  | undefined;

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
function normalizeOptions(
  options: HRWLoadBalancingStrategyOptionsInput = {}
): HRWLoadBalancingStrategyOptions {
  if (!options || typeof options !== 'object') {
    return {};
  }

  const candidate = options as Record<string, unknown>;
  const normalized: HRWLoadBalancingStrategyOptions = {
    ...(options as HRWLoadBalancingStrategyOptions),
  };

  const hashFuncCandidate = candidate['hash_func'];
  if (typeof hashFuncCandidate === 'function') {
    normalized.hashFunc = hashFuncCandidate as HashFunction;
  }

  const stickyAliasKeys = [
    'stickyAttribute',
    'sticky_attribute',
    'stickyAttr',
    'sticky_attr',
  ] as const;

  let stickyCandidate: unknown = undefined;
  let stickyFound = false;
  for (const key of stickyAliasKeys) {
    if (Object.prototype.hasOwnProperty.call(candidate, key)) {
      stickyCandidate = candidate[key];
      stickyFound = true;
      if (stickyCandidate !== undefined) {
        break;
      }
    }
  }

  if (stickyFound) {
    if (stickyCandidate === null || stickyCandidate === undefined) {
      normalized.stickyAttribute = null;
    } else if (typeof stickyCandidate === 'string') {
      normalized.stickyAttribute = stickyCandidate;
    } else {
      throw new Error('stickyAttribute must be a string when provided');
    }
  }

  return normalized;
}

export class HRWLoadBalancingStrategy implements LoadBalancingStrategy {
  private readonly hash: HashFunction;
  private readonly stickyAttribute: string | null;

  constructor(options: HRWLoadBalancingStrategyOptionsInput = {}) {
    const normalized = normalizeOptions(options);
    this.hash = normalized.hashFunc ?? defaultHash;
    this.stickyAttribute = normalized.stickyAttribute ?? null;
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
