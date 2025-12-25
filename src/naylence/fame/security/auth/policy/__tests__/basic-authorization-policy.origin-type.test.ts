/**
 * Tests for origin_type gating in BasicAuthorizationPolicy.
 */

import { DeliveryOriginType, type FameEnvelope, type FameDeliveryContext } from '@naylence/core';

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

function makeContext(overrides: Partial<FameDeliveryContext> = {}): FameDeliveryContext {
  return {
    ...overrides,
  } as FameDeliveryContext;
}

const mockNode = {} as NodeLike;

describe('BasicAuthorizationPolicy origin_type gating', () => {
  describe('single origin_type matching', () => {
    it('matches when context.originType equals rule origin_type (downstream)', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [
            {
              id: 'allow-downstream',
              effect: 'allow',
              origin_type: 'downstream',
            },
          ],
        },
      });

      const envelope = makeEnvelope();
      const context = makeContext({ originType: DeliveryOriginType.DOWNSTREAM });

      const result = await policy.evaluateRequest(mockNode, envelope, context);

      expect(result.effect).toBe('allow');
      expect(result.matchedRule).toBe('allow-downstream');
    });

    it('matches when context.originType equals rule origin_type (upstream)', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [
            {
              id: 'allow-upstream',
              effect: 'allow',
              origin_type: 'upstream',
            },
          ],
        },
      });

      const envelope = makeEnvelope();
      const context = makeContext({ originType: DeliveryOriginType.UPSTREAM });

      const result = await policy.evaluateRequest(mockNode, envelope, context);

      expect(result.effect).toBe('allow');
      expect(result.matchedRule).toBe('allow-upstream');
    });

    it('matches when context.originType equals rule origin_type (peer)', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [
            {
              id: 'allow-peer',
              effect: 'allow',
              origin_type: 'peer',
            },
          ],
        },
      });

      const envelope = makeEnvelope();
      const context = makeContext({ originType: DeliveryOriginType.PEER });

      const result = await policy.evaluateRequest(mockNode, envelope, context);

      expect(result.effect).toBe('allow');
      expect(result.matchedRule).toBe('allow-peer');
    });

    it('matches when context.originType equals rule origin_type (local)', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [
            {
              id: 'allow-local',
              effect: 'allow',
              origin_type: 'local',
            },
          ],
        },
      });

      const envelope = makeEnvelope();
      const context = makeContext({ originType: DeliveryOriginType.LOCAL });

      const result = await policy.evaluateRequest(mockNode, envelope, context);

      expect(result.effect).toBe('allow');
      expect(result.matchedRule).toBe('allow-local');
    });

    it('does not match when context.originType differs from rule origin_type', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [
            {
              id: 'allow-downstream-only',
              effect: 'allow',
              origin_type: 'downstream',
            },
          ],
        },
      });

      const envelope = makeEnvelope();
      const context = makeContext({ originType: DeliveryOriginType.UPSTREAM });

      const result = await policy.evaluateRequest(mockNode, envelope, context);

      expect(result.effect).toBe('deny');
      expect(result.evaluationTrace).toContainEqual(
        expect.objectContaining({
          ruleId: 'allow-downstream-only',
          result: false,
          expression: expect.stringContaining('origin_type'),
        })
      );
    });
  });

  describe('array origin_type matching (any-of)', () => {
    it('matches when context.originType is in the array (upstream)', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [
            {
              id: 'allow-upstream-or-peer',
              effect: 'allow',
              origin_type: ['upstream', 'peer'],
            },
          ],
        },
      });

      const envelope = makeEnvelope();
      const upstreamContext = makeContext({ originType: DeliveryOriginType.UPSTREAM });

      const result = await policy.evaluateRequest(mockNode, envelope, upstreamContext);

      expect(result.effect).toBe('allow');
      expect(result.matchedRule).toBe('allow-upstream-or-peer');
    });

    it('matches when context.originType is in the array (peer)', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [
            {
              id: 'allow-upstream-or-peer',
              effect: 'allow',
              origin_type: ['upstream', 'peer'],
            },
          ],
        },
      });

      const envelope = makeEnvelope();
      const peerContext = makeContext({ originType: DeliveryOriginType.PEER });

      const result = await policy.evaluateRequest(mockNode, envelope, peerContext);

      expect(result.effect).toBe('allow');
      expect(result.matchedRule).toBe('allow-upstream-or-peer');
    });

    it('does not match when context.originType is not in the array', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [
            {
              id: 'allow-upstream-or-peer',
              effect: 'allow',
              origin_type: ['upstream', 'peer'],
            },
          ],
        },
      });

      const envelope = makeEnvelope();
      const localContext = makeContext({ originType: DeliveryOriginType.LOCAL });

      const result = await policy.evaluateRequest(mockNode, envelope, localContext);

      expect(result.effect).toBe('deny');
    });
  });

  describe('missing context.originType', () => {
    it('does not match when rule requires origin_type but context has none', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [
            {
              id: 'require-downstream',
              effect: 'allow',
              origin_type: 'downstream',
            },
          ],
        },
      });

      const envelope = makeEnvelope();
      // No context provided
      const result = await policy.evaluateRequest(mockNode, envelope);

      expect(result.effect).toBe('deny');
      expect(result.evaluationTrace).toContainEqual(
        expect.objectContaining({
          ruleId: 'require-downstream',
          result: false,
          expression: expect.stringContaining('missing'),
        })
      );
    });

    it('does not match when rule requires origin_type but context.originType is undefined', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [
            {
              id: 'require-downstream',
              effect: 'allow',
              origin_type: 'downstream',
            },
          ],
        },
      });

      const envelope = makeEnvelope();
      const context = makeContext({ originType: undefined });

      const result = await policy.evaluateRequest(mockNode, envelope, context);

      expect(result.effect).toBe('deny');
    });
  });

  describe('omitted origin_type (matches any)', () => {
    it('matches any origin when rule does not specify origin_type', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [
            {
              id: 'allow-all-origins',
              effect: 'allow',
              // no origin_type specified
            },
          ],
        },
      });

      const envelope = makeEnvelope();

      // Test all origin types
      for (const originType of [
        DeliveryOriginType.DOWNSTREAM,
        DeliveryOriginType.UPSTREAM,
        DeliveryOriginType.PEER,
        DeliveryOriginType.LOCAL,
      ]) {
        const context = makeContext({ originType });
        const result = await policy.evaluateRequest(mockNode, envelope, context);
        expect(result.effect).toBe('allow');
      }

      // Also matches when no context
      const noContextResult = await policy.evaluateRequest(mockNode, envelope);
      expect(noContextResult.effect).toBe('allow');
    });
  });

  describe('case insensitivity and whitespace handling', () => {
    it('accepts whitespace and different cases in origin_type (single)', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [
            {
              id: 'allow-downstream-trimmed',
              effect: 'allow',
              origin_type: ' DownStream ',
            },
          ],
        },
      });

      const envelope = makeEnvelope();
      const context = makeContext({ originType: DeliveryOriginType.DOWNSTREAM });

      const result = await policy.evaluateRequest(mockNode, envelope, context);

      expect(result.effect).toBe('allow');
      expect(result.matchedRule).toBe('allow-downstream-trimmed');
    });

    it('accepts snake_case origin_type values', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [
            {
              id: 'allow-downstream-snake',
              effect: 'allow',
              origin_type: 'down_stream',
            },
          ],
        },
      });

      const envelope = makeEnvelope();
      const context = makeContext({ originType: DeliveryOriginType.DOWNSTREAM });

      const result = await policy.evaluateRequest(mockNode, envelope, context);

      expect(result.effect).toBe('allow');
      expect(result.matchedRule).toBe('allow-downstream-snake');
    });

    it('accepts whitespace and different cases in origin_type (array)', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [
            {
              id: 'allow-mixed-case',
              effect: 'allow',
              origin_type: [' UPSTREAM ', '  Peer  '],
            },
          ],
        },
      });

      const envelope = makeEnvelope();
      const upstreamContext = makeContext({ originType: DeliveryOriginType.UPSTREAM });
      const peerContext = makeContext({ originType: DeliveryOriginType.PEER });

      const upstreamResult = await policy.evaluateRequest(mockNode, envelope, upstreamContext);
      const peerResult = await policy.evaluateRequest(mockNode, envelope, peerContext);

      expect(upstreamResult.effect).toBe('allow');
      expect(peerResult.effect).toBe('allow');
    });
  });

  describe('validation errors', () => {
    it('throws on invalid origin_type value (single)', () => {
      expect(() => {
        new BasicAuthorizationPolicy({
          policyDefinition: {
            version: '1',
            default_effect: 'deny',
            rules: [
              {
                id: 'invalid-origin',
                effect: 'allow',
                origin_type: 'invalid',
              },
            ],
          },
        });
      }).toThrow(/origin_type.*invalid.*Must be one of/);
    });

    it('throws on invalid origin_type value in array', () => {
      expect(() => {
        new BasicAuthorizationPolicy({
          policyDefinition: {
            version: '1',
            default_effect: 'deny',
            rules: [
              {
                id: 'invalid-origin-array',
                effect: 'allow',
                origin_type: ['downstream', 'not-valid'],
              },
            ],
          },
        });
      }).toThrow(/origin_type.*not-valid.*Must be one of/);
    });

    it('throws on empty origin_type array', () => {
      expect(() => {
        new BasicAuthorizationPolicy({
          policyDefinition: {
            version: '1',
            default_effect: 'deny',
            rules: [
              {
                id: 'empty-origin-array',
                effect: 'allow',
                origin_type: [],
              },
            ],
          },
        });
      }).toThrow(/origin_type.*array must not be empty/);
    });

    it('throws on empty string origin_type', () => {
      expect(() => {
        new BasicAuthorizationPolicy({
          policyDefinition: {
            version: '1',
            default_effect: 'deny',
            rules: [
              {
                id: 'empty-origin',
                effect: 'allow',
                origin_type: '',
              },
            ],
          },
        });
      }).toThrow(/origin_type.*must not be empty/);
    });

    it('throws on whitespace-only origin_type', () => {
      expect(() => {
        new BasicAuthorizationPolicy({
          policyDefinition: {
            version: '1',
            default_effect: 'deny',
            rules: [
              {
                id: 'whitespace-origin',
                effect: 'allow',
                origin_type: '   ',
              },
            ],
          },
        });
      }).toThrow(/origin_type.*must not be empty/);
    });
  });
});
