export interface TokenIssuer {
  /** Identifier to embed in issued tokens. */
  readonly issuer: string;

  /**
   * Issue a signed token with the provided claims payload.
   *
   * @param claims Arbitrary claims to encode within the token body.
   * @returns A promise resolving to the encoded token string.
   */
  issue(claims: Record<string, unknown>): Promise<string>;
}
