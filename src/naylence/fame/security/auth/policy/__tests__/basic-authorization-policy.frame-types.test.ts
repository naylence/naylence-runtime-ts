/**
 * Tests for frame type gating in BasicAuthorizationPolicy.
 */

import type { FameEnvelope } from '@naylence/core';

import type { NodeLike } from '../../../../node/node-like.js';
import { BasicAuthorizationPolicy } from '../basic-authorization-policy.js';

function makeEnvelope(overrides: Partial<FameEnvelope> = {}): FameEnvelope {
  const frame = overrides.frame ?? ({ type: 'Data', payload: {} } as any);
  return {
    id: overrides.id ?? `env-${Math.random().toString(36).slice(2)}`,
    frame: frame as FameEnvelope['frame'],
    meta: overrides.meta ?? {},
    to: overrides.to,
    ...overrides,
  } as FameEnvelope;
}

const mockNode = {} as NodeLike;

describe('BasicAuthorizationPolicy frame_type gating', () => {
  it('matches only configured frame types', async () => {
    const policy = new BasicAuthorizationPolicy({
      policyDefinition: {
        version: '1',
        default_effect: 'deny',
        rules: [
          {
            id: 'allow-data',
            effect: 'allow',
            frame_type: ['Data'],
          },
        ],
      },
    });

    const dataEnvelope = makeEnvelope({ frame: { type: 'Data' } as any });
    const ackEnvelope = makeEnvelope({
      frame: { type: 'DeliveryAck' } as any,
    });

    const allowResult = await policy.evaluateRequest(mockNode, dataEnvelope);
    const denyResult = await policy.evaluateRequest(mockNode, ackEnvelope);

    expect(allowResult.effect).toBe('allow');
    expect(denyResult.effect).toBe('deny');
  });

  it('matches any frame type when frame_type is omitted', async () => {
    const policy = new BasicAuthorizationPolicy({
      policyDefinition: {
        version: '1',
        default_effect: 'deny',
        rules: [
          {
            id: 'allow-any',
            effect: 'allow',
          },
        ],
      },
    });

    const envelope = makeEnvelope({ frame: { type: 'Data' } as any });
    const result = await policy.evaluateRequest(mockNode, envelope);

    expect(result.effect).toBe('allow');
  });

  it('rejects empty frame_type', () => {
    expect(() => {
      new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [
            {
              id: 'invalid',
              effect: 'allow',
              frame_type: [],
            },
          ],
        },
      });
    }).toThrow('frame_type');
  });

  it('matches frame types case-insensitively with trimming', async () => {
    const policy = new BasicAuthorizationPolicy({
      policyDefinition: {
        version: '1',
        default_effect: 'deny',
        rules: [
          {
            id: 'allow-data-and-attach',
            effect: 'allow',
            frame_type: [' data ', 'nodeattach'],
          },
        ],
      },
    });

    const dataEnvelope = makeEnvelope({ frame: { type: 'Data' } as any });
    const attachEnvelope = makeEnvelope({
      frame: { type: 'NodeAttach' } as any,
    });

    const dataResult = await policy.evaluateRequest(mockNode, dataEnvelope);
    const attachResult = await policy.evaluateRequest(mockNode, attachEnvelope);

    expect(dataResult.effect).toBe('allow');
    expect(attachResult.effect).toBe('allow');
  });
});
