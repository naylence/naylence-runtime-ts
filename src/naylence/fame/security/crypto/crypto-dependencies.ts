let webCryptoAvailable: boolean | null = null;

function detectWebCrypto(): boolean {
  if (webCryptoAvailable !== null) {
    return webCryptoAvailable;
  }

  webCryptoAvailable =
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.subtle !== 'undefined';
  return webCryptoAvailable;
}

function detectNativeNodeCrypto(): boolean {
  if (
    typeof globalThis.process === 'undefined' ||
    typeof globalThis.process.versions?.node !== 'string'
  ) {
    return false;
  }

  const moduleId = `node:${'crypto'}`;

  try {
    const directRequire =
      typeof require === 'function'
        ? require
        : (globalThis as { require?: NodeRequire }).require;

    if (typeof directRequire === 'function') {
      const { webcrypto } = directRequire(
        moduleId
      ) as typeof import('node:crypto');
      return Boolean(webcrypto?.subtle);
    }

    const lazyRequire = Function(
      'return typeof require === "function" ? require : null'
    )();
    if (typeof lazyRequire === 'function') {
      const { webcrypto } = lazyRequire(
        moduleId
      ) as typeof import('node:crypto');
      return Boolean(webcrypto?.subtle);
    }
  } catch {
    // Ignore resolution errors and fall through to false
  }

  return false;
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
