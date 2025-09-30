let webCryptoAvailable: boolean | null = null;

function detectWebCrypto(): boolean {
  if (webCryptoAvailable !== null) {
    return webCryptoAvailable;
  }

  webCryptoAvailable =
    typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.subtle !== "undefined";
  return webCryptoAvailable;
}

function detectNativeNodeCrypto(): boolean {
  if (typeof globalThis.process === "undefined") {
    return false;
  }

  try {
    const { webcrypto } = require("node:crypto") as typeof import("node:crypto");
    return Boolean(webcrypto?.subtle);
  } catch {
    return false;
  }
}

export function hasCryptoSupport(): boolean {
  return detectWebCrypto() || detectNativeNodeCrypto();
}

export function requireCryptoSupport(): void {
  if (!hasCryptoSupport()) {
    throw new Error(
      "This functionality requires WebCrypto support. Ensure 'crypto.subtle' is available in your runtime or include a compatible polyfill."
    );
  }
}
