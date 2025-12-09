import { TokenSubjectNodeIdentityPolicy } from '../token-subject-node-identity-policy.js';
import { TokenProviderFactory } from '../../security/auth/token-provider-factory.js';
import { generateIdAsync } from '@naylence/core';
import type { NodeIdentityPolicyContext } from '../node-identity-policy.js';

jest.mock('../../security/auth/token-provider-factory.js');
jest.mock('@naylence/core', () => ({
  ...jest.requireActual('@naylence/core'),
  generateIdAsync: jest.fn(),
}));

describe('TokenSubjectNodeIdentityPolicy', () => {
  let policy: TokenSubjectNodeIdentityPolicy;

  beforeEach(() => {
    policy = new TokenSubjectNodeIdentityPolicy();
    jest.clearAllMocks();
  });

  describe('resolveAdmissionNodeId', () => {
    it('should return current ID if no grants', async () => {
      const context: NodeIdentityPolicyContext = {
        currentNodeId: 'current-id',
        identities: [],
        grants: [],
      };

      const result = await policy.resolveAdmissionNodeId(context);
      expect(result).toBe('current-id');
    });

    it('should return current ID if no identity exposing provider found', async () => {
      const context: NodeIdentityPolicyContext = {
        currentNodeId: 'current-id',
        identities: [],
        grants: [
          {
            auth: {
              tokenProvider: { type: 'SomeProvider' },
            },
          },
        ],
      };

      const mockProvider = {
        getToken: jest.fn(),
        // No getIdentity method
      };

      (TokenProviderFactory.createTokenProvider as jest.Mock).mockResolvedValue(
        mockProvider
      );

      const result = await policy.resolveAdmissionNodeId(context);
      expect(result).toBe('current-id');
    });

    it('should return prefixed ID if identity found', async () => {
      const context: NodeIdentityPolicyContext = {
        currentNodeId: 'provisional-id',
        identities: [],
        grants: [
          {
            auth: {
              tokenProvider: { type: 'IdentityExposingProvider' },
            },
          },
        ],
      };

      const mockProvider = {
        getToken: jest.fn(),
        getIdentity: jest.fn().mockResolvedValue({ subject: 'user123' }),
      };

      (TokenProviderFactory.createTokenProvider as jest.Mock).mockResolvedValue(
        mockProvider
      );

      (generateIdAsync as jest.Mock).mockResolvedValue('hashed123');

      const result = await policy.resolveAdmissionNodeId(context);

      expect(generateIdAsync).toHaveBeenCalledWith({
        mode: 'fingerprint',
        material: 'user123',
        length: 8,
      });
      expect(result).toBe('hashed123-provisional-id');
    });
  });
});
