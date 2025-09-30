export interface RetryPolicyOptions {
  readonly maxRetries?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly jitterMs?: number;
  readonly backoffFactor?: number;
}

/**
 * Configuration and helper for retry backoff behaviour.
 */
export class RetryPolicy {
  public readonly maxRetries: number;
  public readonly baseDelayMs: number;
  public readonly maxDelayMs: number;
  public readonly jitterMs: number;
  public readonly backoffFactor: number;

  constructor(options: RetryPolicyOptions = {}) {
    this.maxRetries = Math.max(0, Math.trunc(options.maxRetries ?? 0));
    this.baseDelayMs = Math.max(0, Math.trunc(options.baseDelayMs ?? 200));
    this.maxDelayMs = Math.max(this.baseDelayMs, Math.trunc(options.maxDelayMs ?? 10_000));
    this.jitterMs = Math.max(0, Math.trunc(options.jitterMs ?? 50));
    this.backoffFactor = Math.max(0, options.backoffFactor ?? 2.0);
  }

  /**
   * Calculate the next retry delay based on attempt number (0-indexed).
   */
  public nextDelayMs(attempt: number): number {
    const normalizedAttempt = Number.isFinite(attempt) ? Math.max(0, Math.trunc(attempt)) : 0;
    const base =
      normalizedAttempt <= 0
        ? this.baseDelayMs
        : Math.round(this.baseDelayMs * this.backoffFactor ** normalizedAttempt);

    const jitter = this.jitterMs > 0 ? Math.round((Math.random() * 2 - 1) * this.jitterMs) : 0;

    const withJitter = base + jitter;
    return Math.min(this.maxDelayMs, Math.max(0, withJitter));
  }
}
