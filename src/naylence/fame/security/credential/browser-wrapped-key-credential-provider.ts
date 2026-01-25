import type { CredentialProvider } from './credential-provider.js';

const DEFAULT_DB_NAME = 'naylence-secrets';
const DEFAULT_STORE_NAME = 'wrapped-master-key';
const DEFAULT_KEY_ID = 'master';
const DEFAULT_ITERATIONS = 200_000;
const WRAPPED_RECORD_VERSION = 1;
const MASTER_KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const GCM_IV_LENGTH = 12;

interface WrappedRecord {
  version: number;
  kdf: {
    algo: 'PBKDF2';
    hash: 'SHA-256';
    iterations: number;
    saltB64: string;
  };
  wrap: {
    algo: 'AES-GCM';
    ivB64: string;
    ciphertextB64: string;
  };
}

export type BrowserWrappedKeyCredentialProviderOptions = {
  dbName?: string;
  storeName?: string;
  keyId?: string;
  iterations?: number;
  promptPassphrase: () => Promise<string>;
  idbFactory?: { open: (name: string, version?: number) => IDBOpenDBRequest };
};

export class InvalidPassphraseError extends Error {
  constructor(
    message = 'Unable to decrypt master key with provided passphrase'
  ) {
    super(message);
    this.name = 'InvalidPassphraseError';
  }
}

type CryptoLike = {
  subtle: SubtleCrypto;
  getRandomValues<T extends ArrayBufferView | null>(array: T): T;
};

let cachedNodeCrypto: typeof import('node:crypto') | null | undefined;
let cachedCrypto: CryptoLike | null | undefined;

async function loadNodeCrypto(): Promise<typeof import('node:crypto') | null> {
  if (cachedNodeCrypto !== undefined) {
    return cachedNodeCrypto;
  }

  try {
    cachedNodeCrypto = await import('node:crypto');
    return cachedNodeCrypto;
  } catch {
    cachedNodeCrypto = null;
    return null;
  }
}

async function getCrypto(): Promise<CryptoLike> {
  if (cachedCrypto) {
    return cachedCrypto;
  }

  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    const cryptoObject = globalThis.crypto as CryptoLike;
    cachedCrypto = cryptoObject;
    return cryptoObject;
  }

  const nodeCrypto = await loadNodeCrypto();
  if (nodeCrypto?.webcrypto?.subtle) {
    const cryptoObject = nodeCrypto.webcrypto as unknown as CryptoLike;
    cachedCrypto = cryptoObject;
    return cryptoObject;
  }

  throw new Error('Web Crypto API is not available in this environment');
}

async function getRandomBytes(length: number): Promise<Uint8Array> {
  const cryptoObject = await getCrypto();
  if (typeof cryptoObject.getRandomValues === 'function') {
    const buffer = new Uint8Array(length);
    cryptoObject.getRandomValues(buffer);
    return buffer;
  }

  const nodeCrypto = await loadNodeCrypto();
  if (nodeCrypto?.randomBytes) {
    const buffer = nodeCrypto.randomBytes(length);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  throw new Error('Unable to generate secure random bytes in this environment');
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  return buffer;
}

function base64Encode(data: Uint8Array): string {
  if (typeof btoa === 'function') {
    let binary = '';
    for (let i = 0; i < data.length; i++) {
      binary += String.fromCharCode(data[i]);
    }
    return btoa(binary);
  }

  if (typeof Buffer !== 'undefined') {
    return Buffer.from(data).toString('base64');
  }

  throw new Error('Base64 encoding is not available in this environment');
}

function base64Decode(value: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(value);
    const buffer = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      buffer[i] = binary.charCodeAt(i);
    }
    return buffer;
  }

  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(value, 'base64'));
  }

  throw new Error('Base64 decoding is not available in this environment');
}

const UTF8_ENCODER = new TextEncoder();

async function deriveKEK(
  passphrase: string,
  salt: Uint8Array,
  iterations: number
): Promise<CryptoKey> {
  const cryptoObject = await getCrypto();
  const subtle = cryptoObject.subtle;

  const baseKey = await subtle.importKey(
    'raw',
    UTF8_ENCODER.encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  return subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as Uint8Array<ArrayBuffer>,
      iterations,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function aesGcmEncrypt(
  key: CryptoKey,
  data: Uint8Array
): Promise<{
  iv: Uint8Array;
  ciphertext: Uint8Array;
}> {
  const cryptoObject = await getCrypto();
  const subtle = cryptoObject.subtle;
  const iv = await getRandomBytes(GCM_IV_LENGTH);
  const ciphertextBuffer = await subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(data)
  );
  return { iv, ciphertext: new Uint8Array(ciphertextBuffer as ArrayBuffer) };
}

async function aesGcmDecrypt(
  key: CryptoKey,
  iv: Uint8Array,
  data: Uint8Array
): Promise<Uint8Array> {
  const cryptoObject = await getCrypto();
  const subtle = cryptoObject.subtle;
  const plaintextBuffer = await subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(data)
  );
  return new Uint8Array(plaintextBuffer as ArrayBuffer);
}

async function openDatabase(
  factory: { open: (name: string, version?: number) => IDBOpenDBRequest },
  dbName: string,
  storeName: string
): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(dbName, 1);

    request.onerror = () => {
      reject(request.error ?? new Error('Failed to open IndexedDB'));
    };

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(storeName)) {
        db.createObjectStore(storeName);
      }
    };

    request.onsuccess = () => {
      resolve(request.result);
    };
  });
}

async function readWrappedRecord(
  db: IDBDatabase,
  storeName: string,
  keyId: string
): Promise<WrappedRecord | null> {
  return new Promise<WrappedRecord | null>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.get(keyId);

    request.onerror = () => {
      reject(request.error ?? new Error('Failed to read wrapped master key'));
    };

    request.onsuccess = () => {
      resolve((request.result as WrappedRecord | undefined) ?? null);
    };
  });
}

async function writeWrappedRecord(
  db: IDBDatabase,
  storeName: string,
  keyId: string,
  record: WrappedRecord
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.put(record, keyId);

    request.onerror = () => {
      reject(
        request.error ?? new Error('Failed to persist wrapped master key')
      );
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => {
      reject(tx.error ?? new Error('Failed to persist wrapped master key'));
    };
  });
}

export class BrowserWrappedKeyCredentialProvider implements CredentialProvider {
  private readonly dbName: string;
  private readonly storeName: string;
  private readonly keyId: string;
  private readonly iterations: number;
  private readonly promptPassphrase: () => Promise<string>;
  private readonly idbFactory: {
    open: (name: string, version?: number) => IDBOpenDBRequest;
  };

  private cachedKey: Uint8Array | null = null;
  private inflight: Promise<Uint8Array> | null = null;

  constructor(options: BrowserWrappedKeyCredentialProviderOptions) {
    if (!options?.promptPassphrase) {
      throw new Error('promptPassphrase callback is required');
    }

    this.dbName = options.dbName ?? DEFAULT_DB_NAME;
    this.storeName = options.storeName ?? DEFAULT_STORE_NAME;
    this.keyId = options.keyId ?? DEFAULT_KEY_ID;
    this.iterations = options.iterations ?? DEFAULT_ITERATIONS;
    this.promptPassphrase = options.promptPassphrase;

    if (options.idbFactory) {
      this.idbFactory = options.idbFactory;
    } else if (typeof indexedDB !== 'undefined') {
      this.idbFactory = indexedDB;
    } else {
      throw new Error('IndexedDB is not available in this environment');
    }
  }

  public async get(): Promise<Uint8Array> {
    if (this.cachedKey) {
      return this.cachedKey;
    }

    if (this.inflight) {
      return this.inflight;
    }

    this.inflight = this.loadOrCreateKey();
    try {
      const key = await this.inflight;
      this.cachedKey = key;
      return key;
    } finally {
      this.inflight = null;
    }
  }

  private async loadOrCreateKey(): Promise<Uint8Array> {
    const db = await openDatabase(this.idbFactory, this.dbName, this.storeName);

    try {
      const existing = await readWrappedRecord(db, this.storeName, this.keyId);
      if (!existing) {
        return await this.createAndPersistKey(db);
      }
      return await this.unwrapExistingKey(existing);
    } finally {
      db.close();
    }
  }

  private async createAndPersistKey(db: IDBDatabase): Promise<Uint8Array> {
    const passphrase = (await this.promptPassphrase()).trim();
    if (!passphrase) {
      throw new Error('Passphrase must not be empty');
    }

    const salt = await getRandomBytes(SALT_LENGTH);
    const kek = await deriveKEK(passphrase, salt, this.iterations);
    const masterKey = await getRandomBytes(MASTER_KEY_LENGTH);
    const { iv, ciphertext } = await aesGcmEncrypt(kek, masterKey);

    const record: WrappedRecord = {
      version: WRAPPED_RECORD_VERSION,
      kdf: {
        algo: 'PBKDF2',
        hash: 'SHA-256',
        iterations: this.iterations,
        saltB64: base64Encode(salt),
      },
      wrap: {
        algo: 'AES-GCM',
        ivB64: base64Encode(iv),
        ciphertextB64: base64Encode(ciphertext),
      },
    };

    await writeWrappedRecord(db, this.storeName, this.keyId, record);
    return masterKey;
  }

  private async unwrapExistingKey(record: WrappedRecord): Promise<Uint8Array> {
    if (record.version !== WRAPPED_RECORD_VERSION) {
      throw new Error(`Unsupported wrapped key version: ${record.version}`);
    }

    if (record.kdf.algo !== 'PBKDF2' || record.kdf.hash !== 'SHA-256') {
      throw new Error('Unsupported KDF configuration for wrapped master key');
    }

    if (record.wrap.algo !== 'AES-GCM') {
      throw new Error('Unsupported wrapping algorithm for wrapped master key');
    }

    const passphrase = (await this.promptPassphrase()).trim();
    if (!passphrase) {
      throw new InvalidPassphraseError();
    }

    const { saltB64, iterations } = record.kdf;
    const { ivB64, ciphertextB64 } = record.wrap;

    const salt = base64Decode(saltB64);
    const iv = base64Decode(ivB64);
    const ciphertext = base64Decode(ciphertextB64);

    try {
      const kek = await deriveKEK(passphrase, salt, iterations);
      return await aesGcmDecrypt(kek, iv, ciphertext);
    } catch (error) {
      throw new InvalidPassphraseError(
        error instanceof Error ? error.message : 'Unable to decrypt master key'
      );
    }
  }
}
