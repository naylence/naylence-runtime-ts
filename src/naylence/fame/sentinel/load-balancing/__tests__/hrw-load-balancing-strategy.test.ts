import type { FameEnvelope } from '@naylence/core';

import { HRWLoadBalancingStrategy } from '../hrw-load-balancing-strategy.js';

describe('HRWLoadBalancingStrategy', () => {
  it('returns null when no segments are available', () => {
    const strategy = new HRWLoadBalancingStrategy();
    const envelope = { id: 'env' } as FameEnvelope;

    const chosen = strategy.choose(null, [], envelope);

    expect(chosen).toBeNull();
  });

  it('selects the segment with the highest weight using sticky attribute', () => {
    const calls: string[] = [];
    const strategy = new HRWLoadBalancingStrategy({
      hashFunc: (value) => {
        calls.push(value);
        return value.startsWith('beta') ? 5n : 1n;
      },
      stickyAttribute: 'stick',
    });

    const envelope = {
      id: 'ignored',
      stick: 'sticky-value',
    } as unknown as FameEnvelope;

    const chosen = strategy.choose(null, ['alpha', 'beta'], envelope);

    expect(chosen).toBe('beta');
    expect(calls).toEqual(['alpha:sticky-value', 'beta:sticky-value']);
  });

  it('falls back to the envelope id when sticky attribute is missing or empty', () => {
    const calls: string[] = [];
    const strategy = new HRWLoadBalancingStrategy({
      hashFunc: (value) => {
        calls.push(value);
        return value.startsWith('seg-b') ? 11n : 3n;
      },
      stickyAttribute: 'stick',
    });

    const envelope = {
      id: 'env-id',
      stick: '',
    } as unknown as FameEnvelope;

    const chosen = strategy.choose(null, ['seg-a', 'seg-b'], envelope);

    expect(chosen).toBe('seg-b');
    expect(calls).toEqual(['seg-a:env-id', 'seg-b:env-id']);
  });

  it('uses an empty salt when envelope lacks identifiers', () => {
    const calls: string[] = [];
    const strategy = new HRWLoadBalancingStrategy({
      hashFunc: (value) => {
        calls.push(value);
        return calls.length === 1 ? 0n : 1n;
      },
    });

    const envelope = {} as unknown as FameEnvelope;

    const chosen = strategy.choose(null, ['first', 'second'], envelope);

    expect(chosen).toBe('second');
    expect(calls).toEqual(['first:', 'second:']);
  });
});
