/**
 * Tests for frame_type field in BasicAuthorizationPolicy.
 *
 * The frame_type field is reserved for the advanced-security package.
 * Basic policy accepts the field but warns users and skips any rules that use it.
 */

import type { FameEnvelope } from '@naylence/core';

import type { NodeLike } from '../../../../node/node-like.js';
import { BasicAuthorizationPolicy } from '../basic-authorization-policy.js';
import { getLogger } from '../../../../util/logging.js';

const policyLogger = getLogger('naylence.fame.security.auth.policy.basic_authorization_policy');

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

describe('BasicAuthorizationPolicy frame_type field (reserved for advanced-security)', () => {
  it('warns and skips rules with frame_type field', async () => {
    const warnSpy = jest.spyOn(policyLogger, 'warning');

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

    // Should have warned during construction
    expect(warnSpy).toHaveBeenCalledWith(
      'reserved_field_frame_type_will_be_skipped',
      expect.objectContaining({
        ruleId: 'allow-data',
        message: expect.stringContaining('reserved field "frame_type"'),
      })
    );

    warnSpy.mockRestore();

    const dataEnvelope = makeEnvelope({ frame: { type: 'Data' } as any });
    const ackEnvelope = makeEnvelope({
      frame: { type: 'DeliveryAck' } as any,
    });

    // Both should be denied because the rule with frame_type is skipped
    const dataResult = await policy.evaluateRequest(mockNode, dataEnvelope);
    const ackResult = await policy.evaluateRequest(mockNode, ackEnvelope);

    expect(dataResult.effect).toBe('deny');
    expect(dataResult.reason).toContain('No rule matched');
    expect(ackResult.effect).toBe('deny');
    expect(ackResult.reason).toContain('No rule matched');

    // Verify trace shows the rule was skipped
    expect(dataResult.evaluationTrace).toHaveLength(1);
    expect(dataResult.evaluationTrace?.[0].expression).toContain(
      'frame_type clause (skipped by basic policy)'
    );
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

  it('accepts empty frame_type array but skips the rule', async () => {
    const policy = new BasicAuthorizationPolicy({
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

    const envelope = makeEnvelope({ frame: { type: 'Data' } as any });
    const result = await policy.evaluateRequest(mockNode, envelope);

    // Rule is skipped, falls back to default effect
    expect(result.effect).toBe('deny');
    expect(result.evaluationTrace).toHaveLength(1);
    expect(result.evaluationTrace?.[0].expression).toContain(
      'frame_type clause (skipped by basic policy)'
    );
  });

  it('skips rules with frame_type regardless of case', async () => {
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

    // Both should be denied because the rule with frame_type is skipped
    const dataResult = await policy.evaluateRequest(mockNode, dataEnvelope);
    const attachResult = await policy.evaluateRequest(mockNode, attachEnvelope);

    expect(dataResult.effect).toBe('deny');
    expect(attachResult.effect).toBe('deny');
  });

  it('does not warn when warnOnUnknownFields is false', () => {
    const warnSpy = jest.spyOn(policyLogger, 'warning');

    new BasicAuthorizationPolicy({
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
      warnOnUnknownFields: false,
    });

    // Should not have warned when explicitly disabled
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('evaluates other rules when frame_type rule is skipped', async () => {
    const policy = new BasicAuthorizationPolicy({
      policyDefinition: {
        version: '1',
        default_effect: 'deny',
        rules: [
          {
            id: 'frame-type-rule',
            effect: 'deny',
            frame_type: ['Data'],
          },
          {
            id: 'fallback-rule',
            effect: 'allow',
          },
        ],
      },
    });

    const envelope = makeEnvelope({ frame: { type: 'Data' } as any });
    const result = await policy.evaluateRequest(mockNode, envelope);

    // First rule is skipped, second rule matches
    expect(result.effect).toBe('allow');
    expect(result.matchedRule).toBe('fallback-rule');
  });
});
