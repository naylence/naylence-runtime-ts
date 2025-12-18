/**
 * Context provided to the connection retry policy for decision-making.
 */
export interface ConnectionRetryContext {
  /**
   * Whether a successful attach has occurred previously in this session.
   */
  hadSuccessfulAttach: boolean;

  /**
   * Number of attempts made so far (1-indexed, incremented before each attempt).
   */
  attemptNumber: number;

  /**
   * The error that caused the connection failure, if any.
   */
  error?: unknown;

  /**
   * Duration in milliseconds that the last connection was alive before failing.
   */
  connectionDurationMs?: number;
}

/**
 * Policy for determining whether to retry upstream connection attempts.
 *
 * This policy is stateless - all state needed for decision-making is passed
 * via the context parameter.
 */
export interface ConnectionRetryPolicy {
  /**
   * Determines whether to retry after a connection failure.
   *
   * @param context - Information about the current retry state
   * @returns `true` if a retry should be attempted, `false` if the error should be thrown
   */
  shouldRetry(context: ConnectionRetryContext): boolean;

  /**
   * Calculates the delay before the next retry attempt.
   *
   * @param context - Information about the current retry state
   * @param baseDelay - The base delay in seconds (may be adjusted by exponential backoff)
   * @returns Delay in seconds before the next attempt (including any jitter)
   */
  calculateRetryDelay(context: ConnectionRetryContext, baseDelay: number): number;
}
