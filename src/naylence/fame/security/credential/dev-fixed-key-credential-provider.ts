import type { CredentialProvider } from "./credential-provider.js";

const DEFAULT_KEY_LENGTH = 32;

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length % 2 !== 0 ||
    !/^([0-9a-f]{2})+$/u.test(normalized)
  ) {
    throw new Error("Invalid hex string");
  }

  const result = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < normalized.length; i += 2) {
    result[i / 2] = parseInt(normalized.slice(i, i + 2), 16);
  }
  return result;
}

function base64ToBytes(value: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(value);
    const buffer = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      buffer[i] = binary.charCodeAt(i);
    }
    return buffer;
  }

  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(value, "base64"));
  }

  throw new Error("Base64 decoding is not available in this environment");
}

export class DevFixedKeyCredentialProvider implements CredentialProvider {
  private readonly key: Uint8Array;

  constructor(key: Uint8Array) {
    if (key.byteLength !== DEFAULT_KEY_LENGTH) {
      throw new Error(`DevFixedKeyCredentialProvider requires a ${DEFAULT_KEY_LENGTH}-byte key`);
    }

    this.key = new Uint8Array(key);
  }

  public async get(): Promise<Uint8Array> {
    return new Uint8Array(this.key);
  }

  public static fromHex(hex: string): DevFixedKeyCredentialProvider {
    const bytes = hexToBytes(hex);
    if (bytes.byteLength !== DEFAULT_KEY_LENGTH) {
      throw new Error(`Hex value must decode to ${DEFAULT_KEY_LENGTH} bytes`);
    }
    return new DevFixedKeyCredentialProvider(bytes);
  }

  public static fromBase64(base64: string): DevFixedKeyCredentialProvider {
    const bytes = base64ToBytes(base64);
    if (bytes.byteLength !== DEFAULT_KEY_LENGTH) {
      throw new Error(`Base64 value must decode to ${DEFAULT_KEY_LENGTH} bytes`);
    }
    return new DevFixedKeyCredentialProvider(bytes);
  }
}
