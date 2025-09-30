import type { KeyValueStore } from "./key-value-store.js";
import type { StorageProvider } from "./storage-provider.js";
import type { CredentialProvider } from "../security/credential/credential-provider.js";
import { BrowserAutoKeyCredentialProvider } from "../security/credential/browser-auto-key-credential-provider.js";

const DEFAULT_KEY_ID = "default";
const DEFAULT_ALGORITHM = "AES-GCM";
const GCM_IV_LENGTH = 12;

function isBrowserEnvironment(): boolean {
  return typeof indexedDB !== "undefined" && typeof globalThis.crypto !== "undefined";
}

function tryCreateBrowserAutoKeyCredentialProvider(): CredentialProvider | null {
  if (!isBrowserEnvironment()) {
    return null;
  }

  try {
    return new BrowserAutoKeyCredentialProvider();
  } catch {
    return null;
  }
}

let cachedNodeCrypto: typeof import("node:crypto") | null | undefined;
let cachedSubtle: SubtleCrypto | undefined;

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

async function getSubtleCrypto(): Promise<SubtleCrypto> {
  if (cachedSubtle) {
    return cachedSubtle;
  }

  if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.subtle) {
    cachedSubtle = globalThis.crypto.subtle;
    return cachedSubtle;
  }

  const nodeCrypto = await loadNodeCrypto();
  if (nodeCrypto?.webcrypto?.subtle) {
    cachedSubtle = nodeCrypto.webcrypto.subtle as unknown as SubtleCrypto;
    return cachedSubtle;
  }

  throw new Error("Web Crypto API is not available in this environment");
}

async function getRandomBytes(length: number): Promise<Uint8Array> {
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.getRandomValues === "function"
  ) {
    const buffer = new Uint8Array(length);
    globalThis.crypto.getRandomValues(buffer);
    return buffer;
  }

  const nodeCrypto = await loadNodeCrypto();
  if (nodeCrypto) {
    const buffer = nodeCrypto.randomBytes(length);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  throw new Error("Unable to generate secure random bytes in this environment");
}

function normalizeKey(key: Uint8Array): Uint8Array {
  if (key.length === 32) {
    return key;
  }

  if (key.length > 32) {
    return key.slice(0, 32);
  }

  const normalized = new Uint8Array(32);
  normalized.set(key);
  return normalized;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function utf8Encode(value: string): Uint8Array {
  return textEncoder.encode(value);
}

function utf8Decode(buffer: Uint8Array): string {
  return textDecoder.decode(buffer);
}

function toHex(data: Uint8Array): string {
  return Array.from(data)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const slice = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
  return slice as ArrayBuffer;
}

function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error("Invalid hex string");
  }

  const result = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    result[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return result;
}

function isEncryptedValue(candidate: unknown): candidate is EncryptedValue {
  if (!candidate || typeof candidate !== "object") {
    return false;
  }

  const record = candidate as Record<string, unknown>;
  return (
    typeof record.keyId === "string" &&
    typeof record.ciphertext === "string" &&
    typeof record.algorithm === "string"
  );
}

export interface StorageEncryptionManager {
  encrypt(plaintext: Uint8Array, key: Uint8Array): Promise<Uint8Array>;
  decrypt(ciphertext: Uint8Array, key: Uint8Array): Promise<Uint8Array>;
}

export class StorageAESEncryptionManager implements StorageEncryptionManager {
  async encrypt(plaintext: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
    const subtle = await getSubtleCrypto();
    const normalizedKey = normalizeKey(key);
    const keyBuffer = toArrayBuffer(normalizedKey);
    const cryptoKey = await subtle.importKey("raw", keyBuffer, { name: "AES-GCM" }, false, [
      "encrypt",
    ]);
    const iv = await getRandomBytes(GCM_IV_LENGTH);
    const ivBuffer = toArrayBuffer(iv);
    const ciphertextBuffer = await subtle.encrypt(
      { name: "AES-GCM", iv: ivBuffer },
      cryptoKey,
      toArrayBuffer(plaintext)
    );
    const ciphertext = new Uint8Array(ciphertextBuffer as ArrayBuffer);

    const result = new Uint8Array(iv.length + ciphertext.length);
    result.set(iv, 0);
    result.set(ciphertext, iv.length);
    return result;
  }

  async decrypt(ciphertext: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
    if (ciphertext.length <= GCM_IV_LENGTH) {
      throw new Error("Ciphertext too short to contain IV");
    }

    const subtle = await getSubtleCrypto();
    const normalizedKey = normalizeKey(key);
    const keyBuffer = toArrayBuffer(normalizedKey);
    const cryptoKey = await subtle.importKey("raw", keyBuffer, { name: "AES-GCM" }, false, [
      "decrypt",
    ]);

    const iv = ciphertext.slice(0, GCM_IV_LENGTH);
    const actualCiphertext = ciphertext.slice(GCM_IV_LENGTH);
    const ivBuffer = toArrayBuffer(iv);
    const cipherBuffer = toArrayBuffer(actualCiphertext);

    const plaintextBuffer = await subtle.decrypt(
      { name: "AES-GCM", iv: ivBuffer },
      cryptoKey,
      cipherBuffer
    );
    return new Uint8Array(plaintextBuffer as ArrayBuffer);
  }
}

export class EncryptedValue {
  public readonly keyId: string;
  public readonly ciphertext: string;
  public readonly algorithm: string;

  constructor(params: { keyId: string; ciphertext: string; algorithm: string }) {
    this.keyId = params.keyId;
    this.ciphertext = params.ciphertext;
    this.algorithm = params.algorithm;
  }
}

interface EncryptedKeyValueStoreOptions<V> {
  underlyingStore: KeyValueStore<EncryptedValue>;
  masterKeyProvider: CredentialProvider;
  encryptionManager: StorageEncryptionManager;
  modelCtor: new (...args: any[]) => V;
  enableCaching?: boolean;
  keyId?: string;
  algorithm?: string;
}

export class EncryptedKeyValueStore<V> implements KeyValueStore<V> {
  private readonly underlyingStore: KeyValueStore<EncryptedValue>;
  private readonly masterKeyProvider: CredentialProvider;
  private readonly encryptionManager: StorageEncryptionManager;
  private readonly modelCtor: new (...args: any[]) => V;
  private readonly cache: Map<string, V> | null;
  private readonly keyId: string;
  private readonly algorithm: string;

  constructor(options: EncryptedKeyValueStoreOptions<V>) {
    this.underlyingStore = options.underlyingStore;
    this.masterKeyProvider = options.masterKeyProvider;
    this.encryptionManager = options.encryptionManager;
    this.modelCtor = options.modelCtor;
    this.cache = options.enableCaching ? new Map() : null;
    this.keyId = options.keyId ?? DEFAULT_KEY_ID;
    this.algorithm = options.algorithm ?? DEFAULT_ALGORITHM;
  }

  private async getRawMasterKey(): Promise<Uint8Array> {
    const key = await this.masterKeyProvider.get();
    if (!key) {
      throw new Error("Master key provider must return a valid key");
    }

    if (key instanceof Uint8Array) {
      return key;
    }

    return utf8Encode(key);
  }

  private serialize(value: V): string {
    const candidate = value as unknown as { toJSON?: () => unknown };
    if (candidate && typeof candidate.toJSON === "function") {
      return JSON.stringify(candidate.toJSON());
    }

    return JSON.stringify(value);
  }

  private deserialize(json: string): V {
    const data = JSON.parse(json);

    const ctorAsAny = this.modelCtor as unknown as {
      fromJSON?: (input: unknown) => V;
      fromJson?: (input: unknown) => V;
      deserialize?: (input: unknown) => V;
    };

    if (typeof ctorAsAny.fromJSON === "function") {
      return ctorAsAny.fromJSON(data);
    }
    if (typeof ctorAsAny.fromJson === "function") {
      return ctorAsAny.fromJson(data);
    }
    if (typeof ctorAsAny.deserialize === "function") {
      return ctorAsAny.deserialize(data);
    }

    try {
      return new this.modelCtor(data);
    } catch {
      return Object.assign(Object.create(this.modelCtor.prototype), data);
    }
  }

  private cacheGet(key: string): V | undefined {
    return this.cache?.get(key);
  }

  private cacheSet(key: string, value: V): void {
    this.cache?.set(key, value);
  }

  private cacheDelete(key: string): void {
    this.cache?.delete(key);
  }

  async set(key: string, value: V): Promise<void> {
    const serialized = this.serialize(value);
    const plaintext = utf8Encode(serialized);
    const masterKey = await this.getRawMasterKey();
    const ciphertext = await this.encryptionManager.encrypt(plaintext, masterKey);

    const encryptedValue = new EncryptedValue({
      keyId: this.keyId,
      ciphertext: toHex(ciphertext),
      algorithm: this.algorithm,
    });

    await this.underlyingStore.set(key, encryptedValue);
    this.cacheSet(key, value);
  }

  async update(key: string, value: V): Promise<void> {
    const serialized = this.serialize(value);
    const plaintext = utf8Encode(serialized);
    const masterKey = await this.getRawMasterKey();
    const ciphertext = await this.encryptionManager.encrypt(plaintext, masterKey);

    const encryptedValue = new EncryptedValue({
      keyId: this.keyId,
      ciphertext: toHex(ciphertext),
      algorithm: this.algorithm,
    });

    await this.underlyingStore.update(key, encryptedValue);
    this.cacheSet(key, value);
  }

  async get(key: string): Promise<V | undefined> {
    const cached = this.cacheGet(key);
    if (cached !== undefined) {
      return cached;
    }

    const encryptedValue = await this.underlyingStore.get(key);
    if (!encryptedValue) {
      return undefined;
    }

    if (!isEncryptedValue(encryptedValue)) {
      throw new Error(`Expected EncryptedValue, got ${typeof encryptedValue}`);
    }

    const masterKey = await this.getRawMasterKey();
    const ciphertext = fromHex(encryptedValue.ciphertext);
    const plaintext = await this.encryptionManager.decrypt(ciphertext, masterKey);
    const json = utf8Decode(plaintext);
    const value = this.deserialize(json);
    this.cacheSet(key, value);
    return value;
  }

  async delete(key: string): Promise<void> {
    await this.underlyingStore.delete(key);
    this.cacheDelete(key);
  }

  async list(): Promise<Record<string, V>> {
    const encryptedItems = await this.underlyingStore.list();
    const masterKey = await this.getRawMasterKey();
    const result: Record<string, V> = {};

    for (const [key, encrypted] of Object.entries(encryptedItems)) {
      if (!isEncryptedValue(encrypted)) {
        continue;
      }

      const cached = this.cacheGet(key);
      if (cached !== undefined) {
        result[key] = cached;
        continue;
      }

      try {
        const ciphertext = fromHex(encrypted.ciphertext);
        const plaintext = await this.encryptionManager.decrypt(ciphertext, masterKey);
        const json = utf8Decode(plaintext);
        const value = this.deserialize(json);
        result[key] = value;
        this.cacheSet(key, value);
      } catch {
        // Skip corrupted entries
      }
    }

    return result;
  }

  async clearCache(): Promise<void> {
    this.cache?.clear();
  }
}

export abstract class EncryptedStorageProviderBase implements StorageProvider {
  private readonly isEncrypted: boolean;
  private readonly masterKeyProvider: CredentialProvider | null;
  private readonly encryptionManager: StorageEncryptionManager | null;
  private readonly enableCaching: boolean;

  protected constructor(
    options: {
      isEncrypted?: boolean;
      masterKeyProvider?: CredentialProvider | null;
      encryptionManager?: StorageEncryptionManager | null;
      enableCaching?: boolean;
    } = {}
  ) {
    const {
      isEncrypted = true,
      masterKeyProvider = null,
      encryptionManager = null,
      enableCaching = false,
    } = options;

    this.isEncrypted = isEncrypted;
    this.enableCaching = enableCaching;

    if (isEncrypted) {
      const resolvedProvider = masterKeyProvider ?? tryCreateBrowserAutoKeyCredentialProvider();

      if (!resolvedProvider) {
        throw new Error("masterKeyProvider is required when encryption is enabled");
      }

      this.masterKeyProvider = resolvedProvider;
      this.encryptionManager = encryptionManager ?? new StorageAESEncryptionManager();
    } else {
      this.masterKeyProvider = null;
      this.encryptionManager = null;
    }
  }

  async getKeyValueStore<V>(
    modelCtor: new (...args: any[]) => V,
    namespace: string
  ): Promise<KeyValueStore<V>> {
    if (!this.isEncrypted) {
      return this.getUnderlyingKeyValueStore(modelCtor, namespace);
    }

    if (!this.masterKeyProvider || !this.encryptionManager) {
      throw new Error(
        "Encryption is enabled but master key provider or encryption manager is missing"
      );
    }

    const underlyingStore = await this.getUnderlyingKeyValueStore(EncryptedValue, namespace);

    return new EncryptedKeyValueStore<V>({
      underlyingStore,
      masterKeyProvider: this.masterKeyProvider,
      encryptionManager: this.encryptionManager,
      modelCtor,
      enableCaching: this.enableCaching,
    });
  }

  protected abstract getUnderlyingKeyValueStore<T>(
    modelCtor: new (...args: any[]) => T,
    namespace: string
  ): Promise<KeyValueStore<T>>;
}
