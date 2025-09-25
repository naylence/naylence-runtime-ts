export interface Token {
  /** Raw token value suitable for HTTP headers or query params */
  value: string;
  /** Optional expiration timestamp expressed in epoch milliseconds */
  expiresAt?: number;
}

export function isTokenExpired(token: Token): boolean {
  if (typeof token.expiresAt !== 'number') {
    return false;
  }
  return token.expiresAt <= Date.now();
}

export function isTokenValid(token: Token): boolean {
  return !isTokenExpired(token);
}
