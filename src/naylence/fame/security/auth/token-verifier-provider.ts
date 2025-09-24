import type { TokenVerifier } from './token-verifier.js';

/**
 * Authorizers that expose their internal token verifier implement this interface.
 */
export interface TokenVerifierProvider {
  readonly tokenVerifier: TokenVerifier;
}
