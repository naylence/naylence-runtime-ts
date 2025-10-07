import type { CredentialProvider } from './credential-provider.js';

const DEFAULT_DB_NAME = 'naylence-secrets';
const DEFAULT_STORE_NAME = 'auto-master-key';
const DEFAULT_KEY_ID = 'master';
const MASTER_KEY_LENGTH = 32;

export type BrowserAutoKeyCredentialProviderOptions = {
  dbName?: string;
  storeName?: string;
  keyId?: string;
  idbFactory?: { open: (name: string, version?: number) => IDBOpenDBRequest };
};

function isArrayBufferView(value: unknown): value is ArrayBufferView {
  return Boolean(value) && ArrayBuffer.isView(value as ArrayBufferView);
}

function toUint8Array(value: unknown): Uint8Array | null {
  if (!value) {
    return null;
  }

  if (value instanceof Uint8Array) {
    return new Uint8Array(value);
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  if (isArrayBufferView(value)) {
    const view = value as ArrayBufferView;
    return new Uint8Array(
      view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)
    );
  }

  return null;
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

async function readPersistedKey(
  db: IDBDatabase,
  storeName: string,
  keyId: string
): Promise<Uint8Array | null> {
  return new Promise<Uint8Array | null>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.get(keyId);

    request.onerror = () => {
      reject(
        request.error ?? new Error('Failed to read master key from IndexedDB')
      );
    };

    request.onsuccess = () => {
      resolve(toUint8Array(request.result));
    };
  });
}

async function persistKey(
  db: IDBDatabase,
  storeName: string,
  keyId: string,
  key: Uint8Array
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const buffer = key.buffer.slice(
      key.byteOffset,
      key.byteOffset + key.byteLength
    );
    const request = store.put(buffer, keyId);

    request.onerror = () => {
      reject(
        request.error ?? new Error('Failed to persist master key to IndexedDB')
      );
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => {
      reject(
        tx.error ?? new Error('Failed to persist master key to IndexedDB')
      );
    };
  });
}

function getRandomBytes(length: number): Uint8Array {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error(
      'crypto.getRandomValues is not available in this environment'
    );
  }

  const buffer = new Uint8Array(length);
  globalThis.crypto.getRandomValues(buffer);
  return buffer;
}

export class BrowserAutoKeyCredentialProvider implements CredentialProvider {
  private readonly dbName: string;
  private readonly storeName: string;
  private readonly keyId: string;
  private readonly idbFactory: {
    open: (name: string, version?: number) => IDBOpenDBRequest;
  };

  private cachedKey: Uint8Array | null = null;
  private inflight: Promise<Uint8Array> | null = null;

  constructor(options: BrowserAutoKeyCredentialProviderOptions = {}) {
    this.dbName = options.dbName ?? DEFAULT_DB_NAME;
    this.storeName = options.storeName ?? DEFAULT_STORE_NAME;
    this.keyId = options.keyId ?? DEFAULT_KEY_ID;

    if (options.idbFactory) {
      this.idbFactory = options.idbFactory;
    } else if (typeof indexedDB !== 'undefined') {
      this.idbFactory = indexedDB;
    } else {
      throw new Error('IndexedDB is not available in this environment');
    }
  }

  async get(): Promise<Uint8Array> {
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
      const existing = await readPersistedKey(db, this.storeName, this.keyId);
      if (existing) {
        return existing;
      }

      const masterKey = getRandomBytes(MASTER_KEY_LENGTH);
      await persistKey(db, this.storeName, this.keyId, masterKey);
      return masterKey;
    } finally {
      db.close();
    }
  }
}
