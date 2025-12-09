import { FameNode } from '../node';

// Mock concrete implementation of abstract FameNode for testing
class TestNode extends FameNode {
    // Expose protected method for testing
    public testConfirmIdentity(systemId: string, source: string): void {
        // @ts-ignore - accessing protected method
        this.confirmIdentity(systemId, source);
    }

    public getConfirmedId(): string | null | undefined {
        // @ts-ignore - accessing private property
        return this._confirmedId;
    }
}

describe('FameNode Identity Confirmation', () => {
    let node: TestNode;

    beforeEach(() => {
        node = new TestNode({});
    });

    it('should set identity on first confirmation', () => {
        const systemId = 'node-1';
        node.testConfirmIdentity(systemId, 'test');
        expect(node.getConfirmedId()).toBe(systemId);
    });

    it('should allow re-confirmation with the same identity', () => {
        const systemId = 'node-1';
        node.testConfirmIdentity(systemId, 'first-call');
        
        // Should not throw
        expect(() => {
            node.testConfirmIdentity(systemId, 'second-call');
        }).not.toThrow();
        
        expect(node.getConfirmedId()).toBe(systemId);
    });

    it('should throw error when attempting to re-confirm with different identity', () => {
        const originalId = 'node-1';
        const newId = 'node-2';
        
        node.testConfirmIdentity(originalId, 'first-call');
        
        expect(() => {
            node.testConfirmIdentity(newId, 'malicious-call');
        }).toThrow(/Node identity mismatch/);
        
        // Identity should remain unchanged
        expect(node.getConfirmedId()).toBe(originalId);
    });
});
