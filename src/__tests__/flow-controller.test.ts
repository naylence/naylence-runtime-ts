/**
 * Tests for FlowController.
 */

import { FlowController } from '../naylence/fame/channel/flow-controller';
import { FlowFlags } from 'naylence-core';

describe('FlowController', () => {
  describe('constructor', () => {
    it('should reject zero window', () => {
      expect(() => new FlowController(0)).toThrow('initial_window must be > 0');
    });

    it('should reject negative window', () => {
      expect(() => new FlowController(-5)).toThrow(
        'initial_window must be > 0'
      );
    });

    it('should set initial window and calculate low watermark', () => {
      const fc = new FlowController(8);
      expect(fc.initialWindow).toBe(8);
      expect(fc.lowWatermark).toBe(2); // 25% of 8 = 2
    });

    it('should respect custom low watermark ratio', () => {
      const fc = new FlowController(4, 0.5);
      expect(fc.lowWatermark).toBe(2); // 50% of 4 = 2
    });
  });

  describe('getCredits', () => {
    it('should return initial window for new flow', () => {
      const fc = new FlowController(5);
      const credits = fc.getCredits('test_flow_id');
      expect(credits).toBe(5);
    });

    it('should track different flows independently', () => {
      const fc = new FlowController(5);
      fc.consume('A', 1);
      fc.consume('B', 2);
      expect(fc.getCredits('A')).toBe(4);
      expect(fc.getCredits('B')).toBe(3);
    });
  });

  describe('addCredits', () => {
    it('should add credits and cap at initial window', () => {
      const fc = new FlowController(3);
      // Initial credits at creation
      expect(fc.getCredits('f1')).toBe(3);
      // Consume some credits
      const remaining = fc.consume('f1', 2);
      expect(remaining).toBe(1);
      // Refill beyond cap should cap at initial_window
      const updated = fc.addCredits('f1', 10);
      expect(updated).toBe(3);
      expect(fc.getCredits('f1')).toBe(3);
    });

    it('should handle negative delta and clamp to zero', () => {
      const fc = new FlowController(3);
      // Starting at 3, subtract 5 → clamps to 0
      const newBal = fc.addCredits('flowB', -5);
      expect(newBal).toBe(0);
      expect(fc.getCredits('flowB')).toBe(0);
    });
  });

  describe('consume', () => {
    it('should consume credits and return remaining balance', () => {
      const fc = new FlowController(5);
      const remaining = fc.consume('test', 2);
      expect(remaining).toBe(3);
      expect(fc.getCredits('test')).toBe(3);
    });

    it('should clamp to zero when consuming more than available', () => {
      const fc = new FlowController(2);
      const remaining = fc.consume('negflow', 5);
      expect(remaining).toBe(0);
      expect(fc.getCredits('negflow')).toBe(0);
    });

    it('should throw error for negative credits', () => {
      const fc = new FlowController(5);
      expect(() => fc.consume('test', -1)).toThrow('credits must be positive');
    });

    it('should return current balance when consuming zero credits', () => {
      const fc = new FlowController(5);
      fc.consume('test', 2); // reduce to 3
      const remaining = fc.consume('test', 0);
      expect(remaining).toBe(3);
    });

    it('should return initial window for non-existent flow when consuming zero', () => {
      const fc = new FlowController(5);
      const remaining = fc.consume('nonexistent', 0);
      expect(remaining).toBe(5);
    });
  });

  describe('needsRefill', () => {
    it('should return false when credits above watermark', () => {
      const fc = new FlowController(4, 0.5); // low_watermark = 2
      expect(fc.needsRefill('f2')).toBe(false);
    });

    it('should return true when credits at or below watermark', () => {
      const fc = new FlowController(4, 0.5); // low_watermark = 2
      fc.consume('f2', 3); // remaining = 1
      expect(fc.needsRefill('f2')).toBe(true);
    });

    it('should use default watermark ratio of 25%', () => {
      const fc = new FlowController(8); // low_watermark = 2
      fc.consume('flowA', 6); // remaining = 2
      expect(fc.needsRefill('flowA')).toBe(true);
    });
  });

  describe('nextWindow', () => {
    it('should start with window 0 and SYN flag for new flow', () => {
      const fc = new FlowController(5);
      const [wid, flags] = fc.nextWindow('f3');
      expect(wid).toBe(0);
      expect(flags & FlowFlags.SYN).toBeTruthy();
    });

    it('should increment window id for subsequent calls', () => {
      const fc = new FlowController(5);
      // First call
      const [wid1, flags1] = fc.nextWindow('f3');
      expect(wid1).toBe(0);
      expect(flags1 & FlowFlags.SYN).toBeTruthy();

      // Second call
      const [wid2, flags2] = fc.nextWindow('f3');
      expect(wid2).toBe(1);
      expect(flags2).toBe(FlowFlags.NONE);
    });

    it('should track different flows separately', () => {
      const fc = new FlowController(5);
      fc.nextWindow('f3'); // advance f3
      fc.nextWindow('f3'); // advance f3 again

      const [widOther, flagsOther] = fc.nextWindow('other');
      expect(widOther).toBe(0);
      expect(flagsOther & FlowFlags.SYN).toBeTruthy();
    });
  });

  describe('resetFlow', () => {
    it('should reset credits to initial window', () => {
      const fc = new FlowController(2);
      fc.consume('f4', 1); // reduce to 1
      fc.resetFlow('f4');
      expect(fc.getCredits('f4')).toBe(2);
    });

    it('should reset window sequence', () => {
      const fc = new FlowController(2);
      // Advance sequence
      fc.nextWindow('f4');
      fc.nextWindow('f4');
      const [wid] = fc.nextWindow('f4');
      expect(wid).toBe(2);

      // Reset flow
      fc.resetFlow('f4');

      // Next window should emit RESET|SYN at window 0
      const [wid2, flags] = fc.nextWindow('f4');
      expect(wid2).toBe(0);
      expect(flags & FlowFlags.RESET).toBeTruthy();
      expect(flags & FlowFlags.SYN).toBeTruthy();
    });
  });

  describe('async acquire', () => {
    it('should consume one credit when available', async () => {
      const fc = new FlowController(2);
      await fc.acquire('test');
      expect(fc.getCredits('test')).toBe(1);
    });

    it('should block when no credits available', async () => {
      const fc = new FlowController(1);
      // First acquire consumes the only credit
      await fc.acquire('f5');
      expect(fc.getCredits('f5')).toBe(0);

      // Second acquire should block
      const acquirePromise = fc.acquire('f5');

      // Give it a moment to potentially complete (it shouldn't)
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Add credit to unblock
      fc.addCredits('f5', 1);

      // Now it should complete
      await expect(acquirePromise).resolves.toBeUndefined();
      expect(fc.getCredits('f5')).toBe(0);
    });

    it('should allow concurrent acquires up to credit limit', async () => {
      const fc = new FlowController(2);

      // Start two acquire operations
      const promise1 = fc.acquire('flow');
      const promise2 = fc.acquire('flow');

      // Both should complete quickly
      await Promise.all([promise1, promise2]);
      expect(fc.getCredits('flow')).toBe(0);
    });

    it('should block third acquire when credits exhausted', async () => {
      const fc = new FlowController(2);

      // First two acquires should succeed
      await fc.acquire('flow');
      await fc.acquire('flow');
      expect(fc.getCredits('flow')).toBe(0);

      // Third acquire should block
      const thirdAcquire = fc.acquire('flow');

      // Give it a moment
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Add credit to unblock
      fc.addCredits('flow', 1);

      // Should complete now
      await expect(thirdAcquire).resolves.toBeUndefined();
    });

    it('should unblock when resetFlow is called', async () => {
      const fc = new FlowController(1);
      // Consume initial credit
      await fc.acquire('resetflow');
      expect(fc.getCredits('resetflow')).toBe(0);

      // Next acquire should block
      const acquirePromise = fc.acquire('resetflow');

      // Give it a moment
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Reset flow should unblock the acquire
      fc.resetFlow('resetflow');

      // Should complete
      await expect(acquirePromise).resolves.toBeUndefined();
      expect(fc.getCredits('resetflow')).toBe(0); // after reset and acquire
    });

    it('should unblock when credits go from zero to positive', async () => {
      const fc = new FlowController(2);
      // Drive balance to zero
      fc.addCredits('negFlow', -3);
      expect(fc.getCredits('negFlow')).toBe(0);

      // Acquire should block
      const acquirePromise = fc.acquire('negFlow');

      // Give it a moment
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Add enough credits to unblock
      fc.addCredits('negFlow', 5);

      // Should complete
      await expect(acquirePromise).resolves.toBeUndefined();
      expect(fc.getCredits('negFlow')).toBe(1); // clamped to initialWindow=2, then consumed 1
    });
  });

  describe('edge cases', () => {
    it('should handle multiple flows independently', () => {
      const fc = new FlowController(5);
      fc.consume('A', 1);
      fc.consume('B', 2);
      expect(fc.getCredits('A')).toBe(4);
      expect(fc.getCredits('B')).toBe(3);
      expect(fc.needsRefill('A')).toBe(false);
      expect(fc.needsRefill('B')).toBe(false);
    });

    it('should handle zero low watermark correctly', () => {
      const fc = new FlowController(1, 0.0); // lowWatermark = 0
      expect(fc.lowWatermark).toBe(0);
      expect(fc.needsRefill('test')).toBe(false); // 1 > 0
      fc.consume('test', 1);
      expect(fc.needsRefill('test')).toBe(true); // 0 <= 0
    });
  });
});
