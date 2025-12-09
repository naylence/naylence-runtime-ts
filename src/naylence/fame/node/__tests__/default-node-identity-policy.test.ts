import { DefaultNodeIdentityPolicy } from '../default-node-identity-policy.js';
import { generateIdAsync } from '@naylence/core';

jest.mock('@naylence/core', () => ({
  ...jest.requireActual('@naylence/core'),
  generateIdAsync: jest.fn(),
}));

describe('DefaultNodeIdentityPolicy', () => {
  let policy: DefaultNodeIdentityPolicy;

  beforeEach(() => {
    policy = new DefaultNodeIdentityPolicy();
    jest.clearAllMocks();
  });

  describe('resolveInitialNodeId', () => {
    it('returns configured ID if present', async () => {
      const id = await policy.resolveInitialNodeId({ configuredId: 'config-id' });
      expect(id).toBe('config-id');
    });

    it('returns persisted ID if present', async () => {
      const id = await policy.resolveInitialNodeId({ persistedId: 'persisted-id' });
      expect(id).toBe('persisted-id');
    });

    it('generates ID if neither present', async () => {
      (generateIdAsync as jest.Mock).mockResolvedValue('generated-id');
      const id = await policy.resolveInitialNodeId({});
      expect(id).toBe('generated-id');
      expect(generateIdAsync).toHaveBeenCalledWith({ mode: 'fingerprint' });
    });
  });

  describe('resolveAdmissionNodeId', () => {
    it('returns current ID if present', async () => {
      const id = await policy.resolveAdmissionNodeId({
        currentNodeId: 'current-id',
        identities: [],
      });
      expect(id).toBe('current-id');
    });

    it('generates ID if current ID is empty', async () => {
      (generateIdAsync as jest.Mock).mockResolvedValue('generated-admission-id');
      const id = await policy.resolveAdmissionNodeId({
        currentNodeId: '',
        identities: [],
      });
      expect(id).toBe('generated-admission-id');
      expect(generateIdAsync).toHaveBeenCalledWith({ mode: 'fingerprint' });
    });
  });
});
