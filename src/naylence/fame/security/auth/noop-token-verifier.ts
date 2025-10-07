import { createAuthorizationContext } from 'naylence-core';
import type { AuthorizationContext } from 'naylence-core';
import type { TokenVerifier } from './token-verifier.js';

/**
 * Token verifier that always returns an empty authorization context.
 * Useful for development and testing environments where auth is optional.
 */
export class NoopTokenVerifier implements TokenVerifier {
  async verify(
    _token: string,
    _options?: { expectedAudience?: string }
  ): Promise<AuthorizationContext> {
    return createAuthorizationContext({
      authenticated: true,
      authorized: true,
      authMethod: 'noop_token_verifier',
      claims: {},
      grantedScopes: [],
      restrictions: {},
    });
  }
}
