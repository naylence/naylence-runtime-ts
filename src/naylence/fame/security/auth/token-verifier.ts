import type { AuthorizationContext } from 'naylence-core';

/**
 * Validates bearer tokens and returns decoded authorization context claims.
 */
export interface TokenVerifier {
  verify(token: string, options?: { expectedAudience?: string }): Promise<AuthorizationContext>;
}
