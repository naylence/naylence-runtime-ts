
import { DirectAdmissionClient } from '../direct-admission-client.js';
import { NodeIdentityPolicy } from '../../node-identity-policy.js';
import { GrantMaterializer } from '../../../grants/grant-materializer.js';
import { AuthIdentity } from '../../../security/auth/auth-identity.js';

// Mock the GrantMaterializer class
jest.mock('../../../grants/grant-materializer.js', () => {
    return {
        GrantMaterializer: {
            materialize: jest.fn()
        }
    };
});

describe('DirectAdmissionClient Identity Adjustment', () => {
    let client: DirectAdmissionClient;
    let mockNodeIdentityPolicy: jest.Mocked<NodeIdentityPolicy>;

    beforeEach(() => {
        jest.clearAllMocks();
        
        mockNodeIdentityPolicy = {
            resolveAdmissionNodeId: jest.fn()
        } as unknown as jest.Mocked<NodeIdentityPolicy>;
        
        // Setup default behavior for materialize
        (GrantMaterializer.materialize as jest.Mock).mockResolvedValue({
            grant: { type: 'materialized-grant' },
            identity: { subject: 'user-123', claims: { role: 'admin' } } as AuthIdentity
        });

        client = new DirectAdmissionClient({
            nodeIdentityPolicy: mockNodeIdentityPolicy,
            connectionGrants: [{ type: 'test-grant' }]
        });
    });

    it('should adjust the system ID using the policy', async () => {
        // Arrange
        const initialId = 'initial-id';
        const adjustedId = 'adjusted-system-id';

        mockNodeIdentityPolicy.resolveAdmissionNodeId.mockImplementation(async (ctx: any) => {
            // Verify context has initial ID
            expect(ctx.currentNodeId).toBe(initialId);
            // Verify context has identities
            expect(ctx.identities).toHaveLength(1);
            expect(ctx.identities[0].subject).toBe('user-123');
            
            return adjustedId;
        });

        // Act
        const envelope = await client.hello(initialId, 'instance-1', ['*']);

        // Assert
        // 1. Verify policy was called
        expect(mockNodeIdentityPolicy.resolveAdmissionNodeId).toHaveBeenCalledTimes(1);

        // 2. Verify the adjusted ID was used in the NodeWelcome frame
        const frame = envelope.frame;
        expect(frame.type).toBe('NodeWelcome');
        expect(frame.systemId).toBe(adjustedId);
    });

    it('should use the provided ID if policy returns it unchanged', async () => {
        // Arrange
        const initialId = 'initial-id';
        mockNodeIdentityPolicy.resolveAdmissionNodeId.mockImplementation(async (ctx: any) => {
            return ctx.currentNodeId;
        });

        // Act
        const envelope = await client.hello(initialId, 'instance-1', ['*']);

        // Assert
        expect(mockNodeIdentityPolicy.resolveAdmissionNodeId).toHaveBeenCalledTimes(1);
        
        const frame = envelope.frame;
        expect(frame.systemId).toBe(initialId);
    });
});
