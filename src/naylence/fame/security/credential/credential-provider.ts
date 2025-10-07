export interface CredentialProvider {
  /**
   * Retrieve the credential value.
   * Implementations encapsulate the lookup strategy (environment, static secret, etc.).
   *
   * @returns A promise resolving to the credential value or `null` when unavailable.
   */
  get(): Promise<Uint8Array | string | null>;
}

const sharedTextDecoder =
  typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

export function credentialToString(
  value: Uint8Array | string | null | undefined
): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (sharedTextDecoder) {
    return sharedTextDecoder.decode(value);
  }

  if (typeof Buffer !== 'undefined') {
    return Buffer.from(value).toString('utf-8');
  }

  throw new Error(
    'Unable to decode credential bytes without TextDecoder support'
  );
}
