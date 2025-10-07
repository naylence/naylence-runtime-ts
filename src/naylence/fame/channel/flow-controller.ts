/**
 * flow_controller.ts - credit window management with cooperative back-pressure.
 *
 * This version restores the *original* test-driven semantics while still
 * preventing notifier task spam:
 *
 * * **addCredits**
 *   * accepts *any* integer `delta` (positive or negative) and clamps the
 *     resulting balance between 0 and `initialWindow`.
 *   * When called outside an event-loop (e.g. synchronous unit-tests), the
 *     credit balance is updated but waiter notification is skipped instead of
 *     raising *RuntimeError*.
 * * **consume**
 *   * clamps at zero rather than raising on under-flow, matching historical
 *     behaviour.
 * * **_wakeWaiters**
 *   * debounces the `notifyAll()` coroutine as before *but* quietly returns
 *     when no running loop is active.
 *
 * The race-safety we introduced earlier is preserved - we still use a per-flow
 * condition/promise and ensure at most one notifier coroutine exists for a
 * flow at any time.
 */

import { FlowFlags } from 'naylence-core';

/**
 * Simple condition variable implementation for TypeScript/Node.js
 * Similar to Python's asyncio.Condition
 */
class Condition {
  private waiters: Array<{
    resolve: () => void;
    reject: (reason?: any) => void;
  }> = [];

  /**
   * Wait for a notification
   */
  async wait(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  /**
   * Notify all waiting coroutines
   */
  notifyAll(): void {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      waiter.resolve();
    }
  }
}

/**
 * Sliding-window flow/credit accounting for *one* local endpoint.
 *
 * A *flow* is identified by a caller-chosen string `flowId`. Each flow
 * starts with `initialWindow` credits. Sending an envelope *consumes*
 * one credit; the peer replenishes credits via an "ACK/CreditUpdate"
 * envelope. When credits reach 0 local senders block in
 * `acquire` until more arrive.
 *
 * The controller is **event-loop safe** - multiple coroutines can call
 * `addCredits`, `consume`, and `acquire` without additional locks - but it is
 * **not** thread-safe.
 */
export class FlowController {
  public readonly initialWindow: number;
  public readonly lowWatermark: number;

  // flowId → remaining credit count
  private credits: Map<string, number> = new Map();
  // flowId → per-flow Condition (created lazily)
  private conditions: Map<string, Condition> = new Map();
  // flowId → outbound window counter
  private windowIds: Map<string, number> = new Map();
  // flows that must emit RESET|SYN on next envelope
  private resetRequested: Set<string> = new Set();
  // track active notifier tasks to prevent spam
  private activeNotifiers: Map<string, Promise<void>> = new Map();

  constructor(initialWindow: number, lowWatermarkRatio: number = 0.25) {
    if (initialWindow <= 0) {
      throw new Error('initial_window must be > 0');
    }

    this.initialWindow = initialWindow;
    this.lowWatermark = Math.floor(initialWindow * lowWatermarkRatio);
  }

  // ---------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------

  /**
   * Lazily create bookkeeping structures for *flowId*.
   */
  private ensureFlow(flowId: string): void {
    if (!this.credits.has(flowId)) {
      this.credits.set(flowId, this.initialWindow);
    }
    if (!this.conditions.has(flowId)) {
      this.conditions.set(flowId, new Condition());
    }
  }

  /**
   * Wake every coroutine blocked in `acquire` for *flowId*.
   *
   * We debounce - at most **one** notifier coroutine per flow can be alive.
   * If `FlowController` is used in synchronous code with no running loop
   * we silently skip the wake-up because nothing could be awaiting anyway.
   */
  private wakeWaiters(flowId: string): void {
    const condition = this.conditions.get(flowId);
    if (!condition) {
      return;
    }

    // Check if there's already an active notifier for this flow
    const existingNotifier = this.activeNotifiers.get(flowId);
    if (existingNotifier) {
      return; // Already scheduled
    }

    // Create a notifier promise
    const notifierPromise = (async (): Promise<void> => {
      try {
        // Use setImmediate to defer to next tick (similar to asyncio scheduling)
        await new Promise<void>((resolve) => setImmediate(resolve));
        condition.notifyAll();
      } finally {
        // Always clear the reference, even on error
        this.activeNotifiers.delete(flowId);
      }
    })();

    this.activeNotifiers.set(flowId, notifierPromise);
  }

  // ------------------------------------------------------------------
  // public API
  // ------------------------------------------------------------------

  /**
   * Return the current credit balance for *flowId*.
   */
  getCredits(flowId: string): number {
    this.ensureFlow(flowId);
    return this.credits.get(flowId)!;
  }

  /**
   * Add `delta` credits (positive *or* negative) to *flowId*.
   *
   * The balance is bounded between 0 and `initialWindow`. Returns the new balance.
   * If the balance transitions from `<=0` to `>0` we wake blocked
   * acquirers.
   */
  addCredits(flowId: string, delta: number): number {
    this.ensureFlow(flowId);
    const prev = this.credits.get(flowId)!;
    // clamp into [0, initialWindow]
    const newBalance = Math.max(0, Math.min(this.initialWindow, prev + delta));
    this.credits.set(flowId, newBalance);

    // wake waiters only if we crossed the zero boundary
    if (prev <= 0 && newBalance > 0) {
      this.wakeWaiters(flowId);
    }
    return newBalance;
  }

  /**
   * Block until at least one credit is available, then consume it.
   */
  async acquire(flowId: string): Promise<void> {
    this.ensureFlow(flowId);
    const condition = this.conditions.get(flowId)!;

    while (this.credits.get(flowId)! <= 0) {
      await condition.wait();
    }

    const current = this.credits.get(flowId)!;
    this.credits.set(flowId, current - 1);
  }

  /**
   * Consume *credits* immediately (non-blocking).
   *
   * If *credits* exceeds the current balance we clamp to **zero** (legacy
   * behaviour retained for existing tests).
   * Returns the remaining balance.
   */
  consume(flowId: string, credits: number = 1): number {
    if (credits < 0) {
      throw new Error('credits must be positive');
    }

    if (credits === 0) {
      return this.credits.get(flowId) ?? this.initialWindow;
    }

    this.ensureFlow(flowId);
    const current = this.credits.get(flowId)!;
    const remaining = Math.max(current - credits, 0);
    this.credits.set(flowId, remaining);
    return remaining;
  }

  /**
   * Return `true` if balance is at or below low-watermark.
   */
  needsRefill(flowId: string): boolean {
    return this.getCredits(flowId) <= this.lowWatermark;
  }

  // ---------------------------------------------------------------
  // flow-state (RESET / sequence) helpers
  // ---------------------------------------------------------------

  /**
   * Prepare a *RESET|SYN* flag for the next outbound envelope.
   */
  resetFlow(flowId: string): void {
    this.ensureFlow(flowId);
    this.resetRequested.add(flowId);
    this.windowIds.delete(flowId);
    this.credits.set(flowId, this.initialWindow);
    this.wakeWaiters(flowId);
  }

  /**
   * Return `[windowId, flags]` for the next outbound envelope.
   */
  nextWindow(flowId: string): [number, FlowFlags] {
    // RESET requested - emit RESET|SYN (window 0)
    if (this.resetRequested.has(flowId)) {
      this.resetRequested.delete(flowId);
      this.windowIds.set(flowId, 0);
      return [0, FlowFlags.RESET | FlowFlags.SYN];
    }

    // brand-new flow - start at window 0, emit SYN
    if (!this.windowIds.has(flowId)) {
      this.windowIds.set(flowId, 0);
      return [0, FlowFlags.SYN];
    }

    // subsequent envelope - increment window id
    const currentId = this.windowIds.get(flowId)!;
    const nextId = currentId + 1;
    this.windowIds.set(flowId, nextId);
    return [nextId, FlowFlags.NONE];
  }
}
