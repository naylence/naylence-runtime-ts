/**
 * NoopFlowController - Flow control stub that provides infinite credits
 *
 * Used when flow control is disabled. Behaves as if infinite credits exist
 * for all flow IDs, so operations never block on credit availability.
 */

import { FlowController } from "../channel/flow-controller.js";

/**
 * Internal flow controller that provides infinite credits for all flows.
 * Used when BaseAsyncConnector is configured without flow control.
 */
export class _NoopFlowController
  implements
    Pick<FlowController, "acquire" | "addCredits" | "getCredits" | "consume" | "needsRefill">
{
  private readonly _infiniteCredits = 1_000_000;

  /**
   * Always resolves immediately - infinite credits available.
   */
  async acquire(_flowId: string): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Returns infinite credits (delta ignored).
   */
  addCredits(_flowId: string, _delta: number): number {
    return this._infiniteCredits;
  }

  /**
   * Always returns infinite credits.
   */
  getCredits(_flowId: string): number {
    return this._infiniteCredits;
  }

  /**
   * Always returns infinite credits (credits consumed ignored).
   */
  consume(_flowId: string, _credits: number = 1): number {
    return this._infiniteCredits;
  }

  /**
   * Never needs refill - infinite credits available.
   */
  needsRefill(_flowId: string): boolean {
    return false;
  }
}
