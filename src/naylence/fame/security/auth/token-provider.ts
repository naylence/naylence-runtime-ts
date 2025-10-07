import type { Token } from './token.js';

export interface TokenProvider {
  getToken(): Promise<Token>;
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
