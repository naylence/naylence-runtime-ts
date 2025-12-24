/**
 * Tests for BasicAuthorizationPolicy.
 */

import {
  DeliveryOriginType,
  type FameDeliveryContext,
  type FameEnvelope,
} from '@naylence/core';

import type { NodeLike } from '../../../../node/node-like.js';
import type { AuthorizationPolicyDefinition } from '../authorization-policy-definition.js';
import { BasicAuthorizationPolicy } from '../basic-authorization-policy.js';

// Helper to create a minimal envelope
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

// Authorization context type for tests - must match the required structure
interface TestAuthContext {
  authenticated: boolean;
  authorized: boolean;
  claims: Record<string, unknown>;
  grantedScopes: string[];
  restrictions: Record<string, unknown>;
}

// Helper to create an authorization context with defaults
function makeAuthContext(overrides: {
  grantedScopes?: string[];
  claims?: Record<string, unknown>;
} = {}): TestAuthContext {
  return {
    authenticated: true,
    authorized: true,
    claims: overrides.claims ?? {},
    grantedScopes: overrides.grantedScopes ?? [],
    restrictions: {},
  };
}

// Helper to create an authorization context without grantedScopes
// This allows testing claims-based scope extraction fallback
// Uses type assertion since the runtime code handles missing grantedScopes
function makeClaimsOnlyAuthContext(
  claims: Record<string, unknown>
): TestAuthContext {
  // Intentionally omit grantedScopes to test claims extraction fallback
  // The policy's extractGrantedScopes function handles this case
  return {
    authenticated: true,
    authorized: true,
    claims,
    restrictions: {},
  } as TestAuthContext;
}

// Helper to create a delivery context
function makeContext(
  overrides: Partial<FameDeliveryContext> = {}
): FameDeliveryContext {
  return {
    originType: DeliveryOriginType.LOCAL,
    meta: {},
    security: {},
    ...overrides,
  } as FameDeliveryContext;
}

// Mock node for testing
const mockNode = {} as NodeLike;

describe('BasicAuthorizationPolicy', () => {
  describe('constructor validation', () => {
    it('should throw on invalid default_effect', () => {
      expect(() => {
        new BasicAuthorizationPolicy({
          policyDefinition: {
            version: '1',
            default_effect: 'maybe' as any,
            rules: [],
          },
        });
      }).toThrow('Invalid default_effect: "maybe". Must be "allow" or "deny"');
    });

    it('should throw on invalid rule effect', () => {
      expect(() => {
        new BasicAuthorizationPolicy({
          policyDefinition: {
            version: '1',
            default_effect: 'deny',
            rules: [{ effect: 'perhaps' as any }],
          },
        });
      }).toThrow('Invalid effect in rule "rule_0": "perhaps". Must be "allow" or "deny"');
    });

    it('should throw on invalid action', () => {
      expect(() => {
        new BasicAuthorizationPolicy({
          policyDefinition: {
            version: '1',
            default_effect: 'deny',
            rules: [{ id: 'bad-action', effect: 'allow', action: 'delete' as any }],
          },
        });
      }).toThrow('Invalid action in rule "bad-action"');
    });

    it('should throw on empty action array', () => {
      expect(() => {
        new BasicAuthorizationPolicy({
          policyDefinition: {
            version: '1',
            default_effect: 'deny',
            rules: [{ id: 'empty-action', effect: 'allow', action: [] as any }],
          },
        });
      }).toThrow('Invalid action in rule "empty-action": array must not be empty');
    });

    it('should throw on invalid action in array', () => {
      expect(() => {
        new BasicAuthorizationPolicy({
          policyDefinition: {
            version: '1',
            default_effect: 'deny',
            rules: [{ id: 'bad-array-action', effect: 'allow', action: ['ForwardUpstream', 'invalid'] as any }],
          },
        });
      }).toThrow('Invalid action in rule "bad-array-action": "invalid"');
    });

    it('should throw on empty frame_type string', () => {
      expect(() => {
        new BasicAuthorizationPolicy({
          policyDefinition: {
            version: '1',
            default_effect: 'deny',
            rules: [{ id: 'empty-frame', effect: 'allow', frame_type: '  ' as any }],
          },
        });
      }).toThrow('Invalid frame_type in rule "empty-frame": value must not be empty');
    });

    it('should throw on empty frame_type array', () => {
      expect(() => {
        new BasicAuthorizationPolicy({
          policyDefinition: {
            version: '1',
            default_effect: 'deny',
            rules: [{ id: 'empty-frame-arr', effect: 'allow', frame_type: [] as any }],
          },
        });
      }).toThrow('Invalid frame_type in rule "empty-frame-arr": array must not be empty');
    });

    it('should throw on empty string in frame_type array', () => {
      expect(() => {
        new BasicAuthorizationPolicy({
          policyDefinition: {
            version: '1',
            default_effect: 'deny',
            rules: [{ id: 'empty-in-arr', effect: 'allow', frame_type: ['Data', '  '] as any }],
          },
        });
      }).toThrow('Invalid frame_type in rule "empty-in-arr": values must not be empty');
    });

    it('should throw on empty address string', () => {
      expect(() => {
        new BasicAuthorizationPolicy({
          policyDefinition: {
            version: '1',
            default_effect: 'deny',
            rules: [{ id: 'empty-addr', effect: 'allow', address: '' }],
          },
        });
      }).toThrow('Invalid address in rule "empty-addr": value must not be empty');
    });

    it('should throw on empty address array', () => {
      expect(() => {
        new BasicAuthorizationPolicy({
          policyDefinition: {
            version: '1',
            default_effect: 'deny',
            rules: [{ id: 'empty-addr-arr', effect: 'allow', address: [] }],
          },
        });
      }).toThrow('Invalid address in rule "empty-addr-arr": array must not be empty');
    });

    it('should throw on whitespace-only address', () => {
      expect(() => {
        new BasicAuthorizationPolicy({
          policyDefinition: {
            version: '1',
            default_effect: 'deny',
            rules: [{ id: 'whitespace-addr', effect: 'allow', address: '   ' }],
          },
        });
      }).toThrow('Invalid address in rule "whitespace-addr": value must not be empty');
    });

    it('should throw on invalid scope requirement', () => {
      expect(() => {
        new BasicAuthorizationPolicy({
          policyDefinition: {
            version: '1',
            default_effect: 'deny',
            rules: [
              {
                id: 'bad-scope',
                effect: 'allow',
                scope: { invalid_operator: ['a'] } as any,
              },
            ],
          },
        });
      }).toThrow('Invalid scope requirement in rule "bad-scope"');
    });

    it('should accept valid policy with allow default', () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'allow',
          rules: [],
        },
      });
      expect(policy).toBeDefined();
    });

    it('should accept valid policy with deny default', () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [],
        },
      });
      expect(policy).toBeDefined();
    });

    it('should generate rule IDs when not provided', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [{ effect: 'allow' }],
        },
      });

      const envelope = makeEnvelope();
      const result = await policy.evaluateRequest(mockNode, envelope);
      expect(result.matchedRule).toBe('rule_0');
    });
  });

  describe('default effect', () => {
    it('should return allow when no rules match and default is allow', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'allow',
          rules: [{ id: 'never-match', effect: 'deny', action: 'Connect' }],
        },
      });

      const envelope = makeEnvelope({ frame: { type: 'Data' } as any });
      const context = makeContext({ originType: DeliveryOriginType.LOCAL });

      // Using ForwardUpstream action which won't match the Connect rule
      const result = await policy.evaluateRequest(mockNode, envelope, context, 'ForwardUpstream');

      expect(result.effect).toBe('allow');
      expect(result.reason).toContain('No rule matched');
      expect(result.matchedRule).toBeUndefined();
    });

    it('should return deny when no rules match and default is deny', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [{ id: 'never-match', effect: 'allow', action: 'Connect' }],
        },
      });

      const envelope = makeEnvelope({ frame: { type: 'Data' } as any });
      const context = makeContext({ originType: DeliveryOriginType.LOCAL });

      // Using ForwardUpstream action which won't match the Connect rule
      const result = await policy.evaluateRequest(mockNode, envelope, context, 'ForwardUpstream');

      expect(result.effect).toBe('deny');
      expect(result.reason).toContain('No rule matched');
    });
  });

  describe('action matching', () => {
    it('should match Connect action for NodeAttach frames', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [{ id: 'allow-connect', effect: 'allow', action: 'Connect' }],
        },
      });

      const envelope = makeEnvelope({ frame: { type: 'NodeAttach' } as any });
      // Explicitly pass Connect action
      const result = await policy.evaluateRequest(mockNode, envelope, undefined, 'Connect');

      expect(result.effect).toBe('allow');
      expect(result.matchedRule).toBe('allow-connect');
    });

    it('should match ForwardUpstream action', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [{ id: 'allow-forward-up', effect: 'allow', action: 'ForwardUpstream' }],
        },
      });

      const envelope = makeEnvelope({ frame: { type: 'Data' } as any });
      const context = makeContext({ originType: DeliveryOriginType.LOCAL });

      const result = await policy.evaluateRequest(mockNode, envelope, context, 'ForwardUpstream');

      expect(result.effect).toBe('allow');
      expect(result.matchedRule).toBe('allow-forward-up');
    });

    it('should match ForwardDownstream action', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [{ id: 'allow-forward-down', effect: 'allow', action: 'ForwardDownstream' }],
        },
      });

      const envelope = makeEnvelope({ frame: { type: 'Data' } as any });
      const context = makeContext({ originType: DeliveryOriginType.DOWNSTREAM });

      const result = await policy.evaluateRequest(mockNode, envelope, context, 'ForwardDownstream');

      expect(result.effect).toBe('allow');
      expect(result.matchedRule).toBe('allow-forward-down');
    });

    it('should match ForwardPeer action', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [{ id: 'allow-forward-peer', effect: 'allow', action: 'ForwardPeer' }],
        },
      });

      const envelope = makeEnvelope({ frame: { type: 'Data' } as any });
      const context = makeContext({ originType: DeliveryOriginType.PEER });

      const result = await policy.evaluateRequest(mockNode, envelope, context, 'ForwardPeer');

      expect(result.effect).toBe('allow');
      expect(result.matchedRule).toBe('allow-forward-peer');
    });

    it('should match DeliverLocal action', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [{ id: 'allow-deliver-local', effect: 'allow', action: 'DeliverLocal' }],
        },
      });

      const envelope = makeEnvelope({ frame: { type: 'Data' } as any });
      const context = makeContext({ originType: DeliveryOriginType.LOCAL });

      const result = await policy.evaluateRequest(mockNode, envelope, context, 'DeliverLocal');

      expect(result.effect).toBe('allow');
      expect(result.matchedRule).toBe('allow-deliver-local');
    });

    it('should default to wildcard when action is omitted', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [{ id: 'allow-upstream-only', effect: 'allow', action: 'ForwardUpstream' }],
        },
      });

      const envelope = makeEnvelope({ frame: { type: 'Data' } as any });
      // Omitting action should default to '*' which won't match ForwardUpstream specifically
      // Actually, '*' in the rule means "match any action", but the rule has ForwardUpstream
      // So with no action provided (defaults to '*'), it won't match ForwardUpstream rule
      const result = await policy.evaluateRequest(mockNode, envelope);

      expect(result.effect).toBe('deny'); // No match because '*' != 'ForwardUpstream'
    });

    it('should match wildcard action for any action type', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [{ id: 'allow-all', effect: 'allow', action: '*' }],
        },
      });

      // Test Connect
      let envelope = makeEnvelope({ frame: { type: 'NodeAttach' } as any });
      let result = await policy.evaluateRequest(mockNode, envelope, undefined, 'Connect');
      expect(result.matchedRule).toBe('allow-all');

      // Test ForwardUpstream
      envelope = makeEnvelope({ frame: { type: 'Data' } as any });
      result = await policy.evaluateRequest(
        mockNode,
        envelope,
        makeContext({ originType: DeliveryOriginType.LOCAL }),
        'ForwardUpstream'
      );
      expect(result.matchedRule).toBe('allow-all');

      // Test ForwardDownstream
      result = await policy.evaluateRequest(
        mockNode,
        envelope,
        makeContext({ originType: DeliveryOriginType.DOWNSTREAM }),
        'ForwardDownstream'
      );
      expect(result.matchedRule).toBe('allow-all');

      // Test DeliverLocal
      result = await policy.evaluateRequest(
        mockNode,
        envelope,
        makeContext({ originType: DeliveryOriginType.LOCAL }),
        'DeliverLocal'
      );
      expect(result.matchedRule).toBe('allow-all');
    });

    it('should not match when action does not match', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [{ id: 'connect-only', effect: 'allow', action: 'Connect' }],
        },
      });

      const envelope = makeEnvelope({ frame: { type: 'Data' } as any });
      const context = makeContext({ originType: DeliveryOriginType.LOCAL });

      // ForwardUpstream won't match Connect-only rule
      const result = await policy.evaluateRequest(mockNode, envelope, context, 'ForwardUpstream');

      expect(result.effect).toBe('deny');
      expect(result.evaluationTrace).toContainEqual(
        expect.objectContaining({
          ruleId: 'connect-only',
          result: false,
          expression: expect.stringContaining('action'),
        })
      );
    });

    it('should match when action is in array', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [
            {
              id: 'forward-actions',
              effect: 'allow',
              action: ['ForwardUpstream', 'ForwardDownstream'],
            },
          ],
        },
      });

      // Test ForwardUpstream
      const sendEnvelope = makeEnvelope({ frame: { type: 'Data' } as any });
      const sendContext = makeContext({ originType: DeliveryOriginType.LOCAL });
      const sendResult = await policy.evaluateRequest(
        mockNode,
        sendEnvelope,
        sendContext,
        'ForwardUpstream'
      );
      expect(sendResult.effect).toBe('allow');
      expect(sendResult.matchedRule).toBe('forward-actions');

      // Test ForwardDownstream
      const receiveContext = makeContext({ originType: DeliveryOriginType.DOWNSTREAM });
      const receiveResult = await policy.evaluateRequest(
        mockNode,
        sendEnvelope,
        receiveContext,
        'ForwardDownstream'
      );
      expect(receiveResult.effect).toBe('allow');
      expect(receiveResult.matchedRule).toBe('forward-actions');

      // Test Connect - should not match
      const connectEnvelope = makeEnvelope({ frame: { type: 'NodeAttach' } as any });
      const connectResult = await policy.evaluateRequest(
        mockNode,
        connectEnvelope,
        undefined,
        'Connect'
      );
      expect(connectResult.effect).toBe('deny');
    });

    it('should match when action array contains wildcard', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [{ id: 'all-via-array', effect: 'allow', action: ['*'] }],
        },
      });

      const connectEnvelope = makeEnvelope({ frame: { type: 'NodeAttach' } as any });
      const result = await policy.evaluateRequest(mockNode, connectEnvelope, undefined, 'Connect');
      expect(result.effect).toBe('allow');
    });
  });

  describe('frame_type matching', () => {
    it('should match single frame_type string', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [{ id: 'data-only', effect: 'allow', frame_type: 'Data' }],
        },
      });

      const dataEnvelope = makeEnvelope({ frame: { type: 'Data' } as any });
      const result = await policy.evaluateRequest(mockNode, dataEnvelope);
      expect(result.effect).toBe('allow');
      expect(result.matchedRule).toBe('data-only');
    });

    it('should not match when frame_type does not match', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [{ id: 'data-only', effect: 'allow', frame_type: 'Data' }],
        },
      });

      const attachEnvelope = makeEnvelope({ frame: { type: 'NodeAttach' } as any });
      const result = await policy.evaluateRequest(mockNode, attachEnvelope);
      expect(result.effect).toBe('deny');
    });

    it('should match frame_type case-insensitively', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [{ id: 'data-case', effect: 'allow', frame_type: 'DATA' }],
        },
      });

      const dataEnvelope = makeEnvelope({ frame: { type: 'data' } as any });
      const result = await policy.evaluateRequest(mockNode, dataEnvelope);
      expect(result.effect).toBe('allow');
    });

    it('should match frame_type with trimming', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [{ id: 'trimmed', effect: 'allow', frame_type: '  Data  ' }],
        },
      });

      const dataEnvelope = makeEnvelope({ frame: { type: 'Data' } as any });
      const result = await policy.evaluateRequest(mockNode, dataEnvelope);
      expect(result.effect).toBe('allow');
    });

    it('should match frame_type array (any-of)', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [{ id: 'multi-frame', effect: 'allow', frame_type: ['Data', 'NodeAttach'] }],
        },
      });

      // Test Data
      const dataEnvelope = makeEnvelope({ frame: { type: 'Data' } as any });
      const dataResult = await policy.evaluateRequest(mockNode, dataEnvelope);
      expect(dataResult.effect).toBe('allow');

      // Test NodeAttach
      const attachEnvelope = makeEnvelope({ frame: { type: 'NodeAttach' } as any });
      const attachResult = await policy.evaluateRequest(mockNode, attachEnvelope);
      expect(attachResult.effect).toBe('allow');

      // Test other - should not match
      const otherEnvelope = makeEnvelope({ frame: { type: 'Control' } as any });
      const otherResult = await policy.evaluateRequest(mockNode, otherEnvelope);
      expect(otherResult.effect).toBe('deny');
    });

    it('should handle frame_type array case-insensitively', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [{ id: 'case-array', effect: 'allow', frame_type: ['DATA', 'NODEATTACH'] }],
        },
      });

      const dataEnvelope = makeEnvelope({ frame: { type: 'data' } as any });
      const result = await policy.evaluateRequest(mockNode, dataEnvelope);
      expect(result.effect).toBe('allow');
    });

    it('should not match when frame is missing and frame_type is specified', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [{ id: 'needs-frame', effect: 'allow', frame_type: 'Data' }],
        },
      });

      const noFrameEnvelope = makeEnvelope({ frame: undefined as any });
      const result = await policy.evaluateRequest(mockNode, noFrameEnvelope);
      expect(result.effect).toBe('deny');
    });

    it('should match any frame when frame_type is not specified', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [{ id: 'any-frame', effect: 'allow' }],
        },
      });

      const dataEnvelope = makeEnvelope({ frame: { type: 'Data' } as any });
      const result = await policy.evaluateRequest(mockNode, dataEnvelope);
      expect(result.effect).toBe('allow');
    });
  });

  describe('address pattern matching', () => {
    it('should match exact address', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [
            { id: 'exact-match', effect: 'allow', address: 'api@services.v1' },
          ],
        },
      });

      const envelope = makeEnvelope({ to: 'api@services.v1' });
      const result = await policy.evaluateRequest(mockNode, envelope);

      expect(result.effect).toBe('allow');
      expect(result.matchedRule).toBe('exact-match');
    });

    it('should match glob pattern with single wildcard', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [
            { id: 'glob-single', effect: 'allow', address: 'api@*.v1' },
          ],
        },
      });

      const envelope = makeEnvelope({ to: 'api@services.v1' });
      const result = await policy.evaluateRequest(mockNode, envelope);

      expect(result.effect).toBe('allow');
      expect(result.matchedRule).toBe('glob-single');
    });

    it('should match glob pattern with double wildcard', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [
            { id: 'glob-double', effect: 'allow', address: '*@services.**' },
          ],
        },
      });

      const envelope = makeEnvelope({ to: 'api@services.v1.endpoint' });
      const result = await policy.evaluateRequest(mockNode, envelope);

      expect(result.effect).toBe('allow');
      expect(result.matchedRule).toBe('glob-double');
    });

    it('rejects ^ prefix patterns (regex not supported in OSS/basic policy)', () => {
      // In OSS/basic policy, patterns starting with ^ are rejected as errors.
      // Regex patterns are reserved for advanced/BSL policy.
      expect(() => {
        new BasicAuthorizationPolicy({
          policyDefinition: {
            version: '1',
            default_effect: 'deny',
            rules: [
              {
                id: 'regex-attempt',
                effect: 'allow',
                address: '^api@public\..*$',
              },
            ],
          },
        });
      }).toThrow(/Regex patterns are not supported.*address.*OSS\/basic policy/);
    });

    it('rejects ^ prefix in address array', () => {
      expect(() => {
        new BasicAuthorizationPolicy({
          policyDefinition: {
            version: '1',
            default_effect: 'deny',
            rules: [
              {
                id: 'regex-in-array',
                effect: 'allow',
                address: ['service.api.*', '^regex\\.pattern$'],
              },
            ],
          },
        });
      }).toThrow(/Regex patterns are not supported.*address/);
    });

    it('should match address from array (any-of)', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [
            {
              id: 'multi-addr',
              effect: 'allow',
              address: ['api@services.v1', 'web@services.*'],
            },
          ],
        },
      });

      // Matches first pattern exactly
      const env1 = makeEnvelope({ to: 'api@services.v1' });
      const result1 = await policy.evaluateRequest(mockNode, env1);
      expect(result1.effect).toBe('allow');
      expect(result1.matchedRule).toBe('multi-addr');

      // Matches second pattern (glob)
      const env2 = makeEnvelope({ to: 'web@services.home' });
      const result2 = await policy.evaluateRequest(mockNode, env2);
      expect(result2.effect).toBe('allow');
      expect(result2.matchedRule).toBe('multi-addr');

      // Does not match any pattern
      const env3 = makeEnvelope({ to: 'other@external.svc' });
      const result3 = await policy.evaluateRequest(mockNode, env3);
      expect(result3.effect).toBe('deny');
    });

    it('should not match when address pattern does not match', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [
            { id: 'specific', effect: 'allow', address: 'api@services.v1' },
          ],
        },
      });

      const envelope = makeEnvelope({ to: 'other@external.svc' });
      const result = await policy.evaluateRequest(mockNode, envelope);

      expect(result.effect).toBe('deny');
      expect(result.evaluationTrace).toContainEqual(
        expect.objectContaining({
          ruleId: 'specific',
          result: false,
          expression: expect.stringContaining('address'),
        })
      );
    });

    it('should not match when address is required but not provided', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [
            { id: 'needs-address', effect: 'allow', address: 'service.*' },
          ],
        },
      });

      const envelope = makeEnvelope({ to: undefined });
      const result = await policy.evaluateRequest(mockNode, envelope);

      expect(result.effect).toBe('deny');
      expect(result.evaluationTrace).toContainEqual(
        expect.objectContaining({
          ruleId: 'needs-address',
          result: false,
          expression: expect.stringContaining('none provided'),
        })
      );
    });

    it('should match when no address pattern is specified', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [{ id: 'any-address', effect: 'allow' }],
        },
      });

      const envelope = makeEnvelope({ to: 'any.address.here' });
      const result = await policy.evaluateRequest(mockNode, envelope);

      expect(result.effect).toBe('allow');
      expect(result.matchedRule).toBe('any-address');
    });

    it('should handle address as object with toString', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [
            { id: 'obj-address', effect: 'allow', address: 'service.api' },
          ],
        },
      });

      const addressObj = { toString: () => 'service.api' };
      const envelope = makeEnvelope({ to: addressObj as any });
      const result = await policy.evaluateRequest(mockNode, envelope);

      expect(result.effect).toBe('allow');
    });

    it('should treat Object.create(null) address as undefined', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [
            { id: 'needs-address', effect: 'allow', address: 'service.*' },
          ],
        },
      });

      // Object without prototype (no toString method)
      const addressObj = Object.create(null);
      addressObj.value = 'service.api';
      const envelope = makeEnvelope({ to: addressObj as any });
      const result = await policy.evaluateRequest(mockNode, envelope);

      expect(result.effect).toBe('deny');
      expect(result.evaluationTrace).toContainEqual(
        expect.objectContaining({
          ruleId: 'needs-address',
          result: false,
          expression: expect.stringContaining('none provided'),
        })
      );
    });
  });

  describe('scope matching', () => {
    it('should match simple scope string', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [{ id: 'needs-read', effect: 'allow', scope: 'read' }],
        },
      });

      const context = makeContext({
        security: {
          authorization: makeAuthContext({ grantedScopes: ['read', 'write'] }),
        },
      });

      const envelope = makeEnvelope();
      const result = await policy.evaluateRequest(mockNode, envelope, context);

      expect(result.effect).toBe('allow');
      expect(result.matchedRule).toBe('needs-read');
    });

    it('should match any_of scope requirement', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [
            {
              id: 'needs-any',
              effect: 'allow',
              scope: { any_of: ['admin', 'superuser'] },
            },
          ],
        },
      });

      const context = makeContext({
        security: {
          authorization: makeAuthContext({ grantedScopes: ['user', 'admin'] }),
        },
      });

      const envelope = makeEnvelope();
      const result = await policy.evaluateRequest(mockNode, envelope, context);

      expect(result.effect).toBe('allow');
    });

    it('should match all_of scope requirement', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [
            {
              id: 'needs-all',
              effect: 'allow',
              scope: { all_of: ['read', 'write'] },
            },
          ],
        },
      });

      const context = makeContext({
        security: {
          authorization: makeAuthContext({ grantedScopes: ['read', 'write', 'delete'] }),
        },
      });

      const envelope = makeEnvelope();
      const result = await policy.evaluateRequest(mockNode, envelope, context);

      expect(result.effect).toBe('allow');
    });

    it('should match none_of scope requirement', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [
            {
              id: 'no-restricted',
              effect: 'allow',
              scope: { none_of: ['restricted', 'blocked'] },
            },
          ],
        },
      });

      const context = makeContext({
        security: {
          authorization: makeAuthContext({ grantedScopes: ['read', 'write'] }),
        },
      });

      const envelope = makeEnvelope();
      const result = await policy.evaluateRequest(mockNode, envelope, context);

      expect(result.effect).toBe('allow');
    });

    it('should fail none_of when forbidden scope present', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'allow',
          rules: [
            {
              id: 'no-restricted',
              effect: 'deny',
              scope: { none_of: ['restricted'] },
            },
          ],
        },
      });

      const context = makeContext({
        security: {
          authorization: makeAuthContext({ grantedScopes: ['read', 'restricted'] }),
        },
      });

      const envelope = makeEnvelope();
      const result = await policy.evaluateRequest(mockNode, envelope, context);

      // none_of fails because 'restricted' is present, so rule doesn't match
      // Falls through to default_effect: allow
      expect(result.effect).toBe('allow');
      expect(result.matchedRule).toBeUndefined();
    });

    it('should not match when scope requirement not satisfied', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [{ id: 'needs-admin', effect: 'allow', scope: 'admin' }],
        },
      });

      const context = makeContext({
        security: {
          authorization: makeAuthContext({ grantedScopes: ['read', 'write'] }),
        },
      });

      const envelope = makeEnvelope();
      const result = await policy.evaluateRequest(mockNode, envelope, context);

      expect(result.effect).toBe('deny');
      expect(result.evaluationTrace).toContainEqual(
        expect.objectContaining({
          ruleId: 'needs-admin',
          result: false,
          expression: expect.stringContaining('scope'),
        })
      );
    });

    it('should extract scopes from claims.scope string', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [{ id: 'needs-read', effect: 'allow', scope: 'read' }],
        },
      });

      const context = makeContext({
        security: {
          authorization: makeClaimsOnlyAuthContext({ scope: 'read write delete' }),
        },
      });

      const envelope = makeEnvelope();
      const result = await policy.evaluateRequest(mockNode, envelope, context);

      expect(result.effect).toBe('allow');
    });

    it('should extract scopes from claims.scopes array', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [{ id: 'needs-write', effect: 'allow', scope: 'write' }],
        },
      });

      const context = makeContext({
        security: {
          authorization: makeClaimsOnlyAuthContext({ scopes: ['read', 'write'] }),
        },
      });

      const envelope = makeEnvelope();
      const result = await policy.evaluateRequest(mockNode, envelope, context);

      expect(result.effect).toBe('allow');
    });

    it('should extract scopes from claims.scp', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [{ id: 'needs-api', effect: 'allow', scope: 'api.read' }],
        },
      });

      const context = makeContext({
        security: {
          authorization: makeClaimsOnlyAuthContext({ scp: 'api.read api.write' }),
        },
      });

      const envelope = makeEnvelope();
      const result = await policy.evaluateRequest(mockNode, envelope, context);

      expect(result.effect).toBe('allow');
    });

    it('should filter non-string values from claims.scopes array', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [{ id: 'needs-write', effect: 'allow', scope: 'write' }],
        },
      });

      const context = makeContext({
        security: {
          authorization: makeClaimsOnlyAuthContext(
            { scopes: ['read', 123, 'write', null, { invalid: true }] }
          ),
        },
      });

      const envelope = makeEnvelope();
      const result = await policy.evaluateRequest(mockNode, envelope, context);

      expect(result.effect).toBe('allow');
    });

    it('should return empty scopes when claims has no scope fields', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [{ id: 'needs-scope', effect: 'allow', scope: 'any' }],
        },
      });

      const context = makeContext({
        security: {
          authorization: makeAuthContext({ claims: { sub: 'user123', name: 'Test' } }),
        },
      });

      const envelope = makeEnvelope();
      const result = await policy.evaluateRequest(mockNode, envelope, context);

      expect(result.effect).toBe('deny');
    });

    it('should handle empty scopes when no authorization context', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [{ id: 'needs-scope', effect: 'allow', scope: 'any' }],
        },
      });

      const envelope = makeEnvelope();
      const result = await policy.evaluateRequest(mockNode, envelope);

      expect(result.effect).toBe('deny');
    });

    it('should match glob pattern in scope', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [
            { id: 'api-any', effect: 'allow', scope: 'api.*' },
          ],
        },
      });

      const context = makeContext({
        security: {
          authorization: makeAuthContext({ grantedScopes: ['api.read'] }),
        },
      });

      const envelope = makeEnvelope();
      const result = await policy.evaluateRequest(mockNode, envelope, context);

      expect(result.effect).toBe('allow');
    });

    it('rejects ^ prefix patterns in scope (regex not supported)', () => {
      expect(() => {
        new BasicAuthorizationPolicy({
          policyDefinition: {
            version: '1',
            default_effect: 'deny',
            rules: [
              { id: 'regex-scope', effect: 'allow', scope: '^api\\..*$' },
            ],
          },
        });
      }).toThrow(/Regex patterns are not supported.*scope.*OSS\/basic policy/);
    });

    it('rejects ^ prefix patterns in nested scope requirements', () => {
      expect(() => {
        new BasicAuthorizationPolicy({
          policyDefinition: {
            version: '1',
            default_effect: 'deny',
            rules: [
              {
                id: 'nested-regex',
                effect: 'allow',
                scope: { any_of: ['read', '^admin\\..*$'] },
              },
            ],
          },
        });
      }).toThrow(/Regex patterns are not supported.*scope.*OSS\/basic policy/);
    });
  });

  describe('first-match-wins semantics', () => {
    it('should return first matching rule', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [
            { id: 'first', effect: 'allow', action: 'ForwardUpstream' },
            { id: 'second', effect: 'deny', action: 'ForwardUpstream' },
          ],
        },
      });

      const envelope = makeEnvelope();
      const context = makeContext({ originType: DeliveryOriginType.LOCAL });

      const result = await policy.evaluateRequest(mockNode, envelope, context, 'ForwardUpstream');

      expect(result.effect).toBe('allow');
      expect(result.matchedRule).toBe('first');
    });

    it('should skip non-matching rules', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [
            { id: 'connect-rule', effect: 'deny', action: 'Connect' },
            { id: 'downstream-rule', effect: 'deny', action: 'ForwardDownstream' },
            { id: 'upstream-rule', effect: 'allow', action: 'ForwardUpstream' },
          ],
        },
      });

      const envelope = makeEnvelope();
      const context = makeContext({ originType: DeliveryOriginType.LOCAL });

      const result = await policy.evaluateRequest(mockNode, envelope, context, 'ForwardUpstream');

      expect(result.effect).toBe('allow');
      expect(result.matchedRule).toBe('upstream-rule');
      expect(result.evaluationTrace).toHaveLength(3);
    });
  });

  describe('when clause handling', () => {
    it('should skip rules with when clause', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [
            {
              id: 'with-when',
              effect: 'allow',
              when: 'claims.role == "admin"',
            },
            { id: 'fallback', effect: 'allow' },
          ],
        },
      });

      const envelope = makeEnvelope();
      const result = await policy.evaluateRequest(mockNode, envelope);

      expect(result.matchedRule).toBe('fallback');
      expect(result.evaluationTrace).toContainEqual(
        expect.objectContaining({
          ruleId: 'with-when',
          result: false,
          expression: expect.stringContaining('when clause'),
        })
      );
    });

    it('should not skip rules with empty when clause', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [{ id: 'empty-when', effect: 'allow', when: '' }],
        },
      });

      const envelope = makeEnvelope();
      const result = await policy.evaluateRequest(mockNode, envelope);

      expect(result.matchedRule).toBe('empty-when');
    });
  });

  describe('evaluation trace', () => {
    it('should include all evaluated rules in trace', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [
            { id: 'rule1', effect: 'deny', action: 'Connect' },
            { id: 'rule2', effect: 'deny', address: 'other.*' },
            { id: 'rule3', effect: 'allow' },
          ],
        },
      });

      const envelope = makeEnvelope({ to: 'service.api' });
      const context = makeContext({ originType: DeliveryOriginType.LOCAL });

      const result = await policy.evaluateRequest(
        mockNode,
        envelope,
        context,
        'ForwardUpstream'
      );

      expect(result.evaluationTrace).toHaveLength(3);
      expect(result.evaluationTrace![0].ruleId).toBe('rule1');
      expect(result.evaluationTrace![0].result).toBe(false);
      expect(result.evaluationTrace![1].ruleId).toBe('rule2');
      expect(result.evaluationTrace![1].result).toBe(false);
      expect(result.evaluationTrace![2].ruleId).toBe('rule3');
      expect(result.evaluationTrace![2].result).toBe(true);
    });

    it('should include bound values in matching rule trace', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [{ id: 'match', effect: 'allow' }],
        },
      });

      const envelope = makeEnvelope({ to: 'target.address' });
      const context = makeContext({
        originType: DeliveryOriginType.LOCAL,
        security: {
          authorization: makeAuthContext({ grantedScopes: ['read'] }),
        },
      });

      const result = await policy.evaluateRequest(
        mockNode,
        envelope,
        context,
        'ForwardUpstream'
      );

      const matchingStep = result.evaluationTrace!.find((s) => s.result);
      expect(matchingStep?.boundValues).toEqual({
        action: 'ForwardUpstream',
        address: 'target.address',
        grantedScopes: ['read'],
      });
    });
  });

  describe('rule description in reason', () => {
    it('should use rule description as reason when provided', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [
            {
              id: 'my-rule',
              description: 'Allow all authenticated requests',
              effect: 'allow',
            },
          ],
        },
      });

      const envelope = makeEnvelope();
      const result = await policy.evaluateRequest(mockNode, envelope);

      expect(result.reason).toBe('Allow all authenticated requests');
    });

    it('should use default reason when no description', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [{ id: 'my-rule', effect: 'allow' }],
        },
      });

      const envelope = makeEnvelope();
      const result = await policy.evaluateRequest(mockNode, envelope);

      expect(result.reason).toBe('Matched rule: my-rule');
    });
  });

  describe('unknown field warnings', () => {
    it('should not throw on unknown policy fields', () => {
      expect(() => {
        new BasicAuthorizationPolicy({
          policyDefinition: {
            version: '1',
            default_effect: 'allow',
            rules: [],
            unknown_field: 'ignored',
          } as AuthorizationPolicyDefinition,
        });
      }).not.toThrow();
    });

    it('should not throw on unknown rule fields', () => {
      expect(() => {
        new BasicAuthorizationPolicy({
          policyDefinition: {
            version: '1',
            default_effect: 'allow',
            rules: [
              {
                effect: 'allow',
                custom_field: 'ignored',
              } as any,
            ],
          },
        });
      }).not.toThrow();
    });

    it('should respect warnOnUnknownFields option', () => {
      // Just verify it doesn't throw - actual logging would need to be mocked
      expect(() => {
        new BasicAuthorizationPolicy({
          policyDefinition: {
            version: '1',
            default_effect: 'allow',
            rules: [],
            extra: 'field',
          } as AuthorizationPolicyDefinition,
          warnOnUnknownFields: false,
        });
      }).not.toThrow();
    });
  });

  describe('complex scenarios', () => {
    it('should handle combined action, address, and scope conditions', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [
            {
              id: 'admin-api',
              effect: 'allow',
              action: 'ForwardUpstream',
              address: 'admin.**',
              scope: 'admin',
            },
            {
              id: 'user-api',
              effect: 'allow',
              action: 'ForwardUpstream',
              address: 'api.**',
              scope: { any_of: ['user', 'admin'] },
            },
          ],
        },
      });

      const envelope = makeEnvelope({ to: 'api.users.list' });
      const context = makeContext({
        originType: DeliveryOriginType.LOCAL,
        security: {
          authorization: makeAuthContext({ grantedScopes: ['user'] }),
        },
      });

      const result = await policy.evaluateRequest(
        mockNode,
        envelope,
        context,
        'ForwardUpstream'
      );

      expect(result.effect).toBe('allow');
      expect(result.matchedRule).toBe('user-api');
    });

    it('should deny when all conditions not met', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [
            {
              id: 'restricted',
              effect: 'allow',
              action: 'ForwardUpstream',
              address: 'restricted.*',
              scope: 'superadmin',
            },
          ],
        },
      });

      // Has correct action and address, but wrong scope
      const envelope = makeEnvelope({ to: 'restricted.endpoint' });
      const context = makeContext({
        originType: DeliveryOriginType.LOCAL,
        security: {
          authorization: makeAuthContext({ grantedScopes: ['admin'] }),
        },
      });

      const result = await policy.evaluateRequest(
        mockNode,
        envelope,
        context,
        'ForwardUpstream'
      );

      expect(result.effect).toBe('deny');
    });

    it('should handle nested scope requirements', async () => {
      const policy = new BasicAuthorizationPolicy({
        policyDefinition: {
          version: '1',
          default_effect: 'deny',
          rules: [
            {
              id: 'complex-scope',
              effect: 'allow',
              scope: {
                all_of: [
                  'base',
                  { any_of: ['feature-a', 'feature-b'] },
                ],
              },
            },
          ],
        },
      });

      const context = makeContext({
        security: {
          authorization: makeAuthContext({ grantedScopes: ['base', 'feature-a'] }),
        },
      });

      const envelope = makeEnvelope();
      const result = await policy.evaluateRequest(mockNode, envelope, context);

      expect(result.effect).toBe('allow');
    });
  });
});
