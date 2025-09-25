export function hasCryptoSupport(): boolean {
  return typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.subtle !== 'undefined';
}

export function requireCryptoSupport(): void {
  if (!hasCryptoSupport()) {
    throw new Error(
      "This functionality requires WebCrypto support. Ensure 'crypto.subtle' is available in your runtime or include a compatible polyfill."
    );
  }
}
