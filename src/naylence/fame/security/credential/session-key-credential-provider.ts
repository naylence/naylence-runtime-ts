import type { CredentialProvider } from "./credential-provider.js";

const DEFAULT_KEY_LENGTH = 32;

type CryptoLike = {
  getRandomValues<T extends ArrayBufferView | null>(array: T): T;
};

let cachedNodeCrypto: typeof import("node:crypto") | null | undefined;

async function loadNodeCrypto(): Promise<typeof import("node:crypto") | null> {
  if (cachedNodeCrypto !== undefined) {
    return cachedNodeCrypto;
  }

  try {
    cachedNodeCrypto = await import("node:crypto");
    return cachedNodeCrypto;
  } catch {
    cachedNodeCrypto = null;
    return null;
  }
}

async function getRandomBytes(length: number): Promise<Uint8Array> {
  if (typeof globalThis.crypto !== "undefined") {
    const cryptoObject = globalThis.crypto as CryptoLike;
    if (typeof cryptoObject.getRandomValues === "function") {
      const buffer = new Uint8Array(length);
      cryptoObject.getRandomValues(buffer);
      return buffer;
    }
  }

  const nodeCrypto = await loadNodeCrypto();
  if (nodeCrypto?.randomBytes) {
    const buffer = nodeCrypto.randomBytes(length);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  throw new Error("Unable to generate secure random bytes in this environment");
}

export class SessionKeyCredentialProvider implements CredentialProvider {
  private readonly length: number;
  private cached?: Uint8Array;

  constructor(length = DEFAULT_KEY_LENGTH) {
    if (!Number.isInteger(length) || length <= 0) {
      throw new Error("Session key length must be a positive integer");
    }
    this.length = length;
  }

  public async get(): Promise<Uint8Array> {
    if (!this.cached) {
      this.cached = await getRandomBytes(this.length);
    }

    return this.cached;
  }
}
