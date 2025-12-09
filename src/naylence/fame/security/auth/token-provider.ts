import type { Token } from './token.js';
import type { AuthIdentity } from './auth-identity.js';

export interface TokenProvider {
  getToken(): Promise<Token>;
}

export interface IdentityExposingTokenProvider extends TokenProvider {
  getIdentity(): Promise<AuthIdentity | undefined>;
}

export function isTokenProvider(
  candidate: unknown
): candidate is TokenProvider {
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof (candidate as Partial<TokenProvider>).getToken === 'function'
  );
}

export function isIdentityExposingTokenProvider(
  candidate: unknown
): candidate is IdentityExposingTokenProvider {
  return (
    isTokenProvider(candidate) &&
    typeof (candidate as Partial<IdentityExposingTokenProvider>).getIdentity ===
      'function'
  );
}
