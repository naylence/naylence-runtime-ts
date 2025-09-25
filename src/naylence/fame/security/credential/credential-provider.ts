export interface CredentialProvider {
  /**
   * Retrieve the credential value.
   * Implementations encapsulate the lookup strategy (environment, static secret, etc.).
   *
   * @returns A promise resolving to the credential value or `null` when unavailable.
   */
  get(): Promise<string | null>;
}
