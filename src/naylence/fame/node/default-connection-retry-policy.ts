import type {
  ConnectionRetryContext,
  ConnectionRetryPolicy,
} from './connection-retry-policy.js';

/**
 * Environment variable for overriding max initial attempts.
 */
export const ENV_VAR_SESSION_MAX_INITIAL_ATTEMPTS = 'FAME_SESSION_MAX_INITIAL_ATTEMPTS';

/**
 * Options for the default connection retry policy.
 */
export interface DefaultConnectionRetryPolicyOptions {
  /**
   * Maximum number of connection attempts before giving up (before first successful attach).
   * - `1` (default): Fail immediately on first error
   * - `0`: Unlimited retries with exponential backoff
   * - `N > 1`: Retry up to N times with exponential backoff
   *
   * Can be overridden via FAME_SESSION_MAX_INITIAL_ATTEMPTS environment variable.
   */
  maxInitialAttempts?: number;
}

/**
 * Default implementation of connection retry policy.
 *
 * Before first successful attach:
 * - Respects maxInitialAttempts configuration
 * - Uses exponential backoff with jitter
 *
 * After first successful attach:
 * - Always retries (unlimited) to maintain connection
 * - Resets backoff if connection was stable for >10 seconds
 */
export class DefaultConnectionRetryPolicy implements ConnectionRetryPolicy {
  public readonly maxInitialAttempts: number;

  constructor(options: DefaultConnectionRetryPolicyOptions = {}) {
    // Check for environment variable override
    const envValue = typeof process !== 'undefined'
      ? process.env?.[ENV_VAR_SESSION_MAX_INITIAL_ATTEMPTS]
      : undefined;

    if (envValue !== undefined && envValue !== '') {
      const parsed = parseInt(envValue, 10);
      this.maxInitialAttempts = isNaN(parsed) ? (options.maxInitialAttempts ?? 1) : parsed;
    } else {
      this.maxInitialAttempts = options.maxInitialAttempts ?? 1;
    }
  }

  shouldRetry(context: ConnectionRetryContext): boolean {
    // After first successful attach, always retry to maintain connection
    if (context.hadSuccessfulAttach) {
      return true;
    }

    // maxInitialAttempts = 0 means unlimited retries
    if (this.maxInitialAttempts === 0) {
      return true;
    }

    // Fail if we've exceeded the configured max attempts
    return context.attemptNumber < this.maxInitialAttempts;
  }

  calculateRetryDelay(_context: ConnectionRetryContext, baseDelay: number): number {
    // Add jitter to prevent thundering herd
    const jitter = Math.random() * baseDelay;
    return baseDelay + jitter;
  }
}
