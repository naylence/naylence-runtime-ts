import type { Authorizer } from './authorizer.js';
import type { AuthorizationPolicy } from './policy/authorization-policy.js';

/**
 * An authorizer that delegates authorization decisions to a pluggable policy.
 *
 * This interface extends the base `Authorizer` interface and adds access
 * to the underlying `AuthorizationPolicy` for inspection or debugging.
 */
export interface PolicyAuthorizer extends Authorizer {
  /** The currently active authorization policy */
  readonly policy: AuthorizationPolicy;
}
