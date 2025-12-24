import type { AuthorizationPolicy } from './authorization-policy.js';

/**
 * Interface for sources that provide authorization policies.
 *
 * Policy sources abstract where the policy definition comes from,
 * allowing policies to be loaded from local files, remote stores,
 * or other sources.
 */
export interface AuthorizationPolicySource {
  /**
   * Loads and returns the authorization policy.
   *
   * This method may be called multiple times, for example when
   * reloading a policy after changes. Implementations should
   * handle caching internally if needed.
   *
   * @returns The loaded authorization policy
   */
  loadPolicy(): Promise<AuthorizationPolicy>;
}
