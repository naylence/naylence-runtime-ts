import type { TokenVerifier } from './token-verifier.js';
import type { AuthorizationContext } from 'naylence-core';

/**
 * Token verifier that always returns an empty authorization context.
 * Useful for development and testing environments where auth is optional.
 */
export class NoopTokenVerifier implements TokenVerifier {
  async verify(_token: string, _options?: { expectedAudience?: string }): Promise<AuthorizationContext> {
    return {
      authenticated: true,
      authorized: true,
      claims: {},
      grantedScopes: [],
      restrictions: {},
    };
  }
}
