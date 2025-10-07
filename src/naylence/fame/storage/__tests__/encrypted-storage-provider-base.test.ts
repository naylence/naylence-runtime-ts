import {
  EncryptedKeyValueStore,
  EncryptedStorageProviderBase,
  EncryptedValue,
  StorageAESEncryptionManager,
  type StorageEncryptionManager,
} from '../encrypted-storage-provider-base.js';
import type { KeyValueStore } from '../key-value-store.js';
import type { CredentialProvider } from '../../security/credential/credential-provider.js';

describe('StorageAESEncryptionManager', () => {
  const encoder = new TextEncoder();

  it.each([
    ['32-byte', Uint8Array.from({ length: 32 }, (_, i) => i + 1)],
    ['short', encoder.encode('short-key')],
    ['long', encoder.encode('a'.repeat(40))],
  ])('encrypts and decrypts with %s key', async (_, key) => {
    const manager = new StorageAESEncryptionManager();
    const plaintext = encoder.encode('plain-text-payload');

    const ciphertext = await manager.encrypt(plaintext, key);
    expect(ciphertext.byteLength).toBeGreaterThan(plaintext.byteLength);

    const decrypted = await manager.decrypt(ciphertext, key);
    expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
  });

  it('falls back to node random bytes when WebCrypto random values unavailable', async () => {
    const manager = new StorageAESEncryptionManager();
    const encoder = new TextEncoder();
    const plaintext = encoder.encode('payload');
    const key = encoder.encode('short');

    const originalCrypto = globalThis.crypto;
    const originalGetRandomValues =
      originalCrypto?.getRandomValues?.bind(originalCrypto);
    if (originalCrypto) {
      (originalCrypto as any).getRandomValues = undefined;
    }

    try {
      const ciphertext = await manager.encrypt(plaintext, key);
      expect(ciphertext.byteLength).toBeGreaterThan(plaintext.byteLength);
    } finally {
      if (originalCrypto && originalGetRandomValues) {
        (originalCrypto as any).getRandomValues = originalGetRandomValues;
      }
    }
  });

  it('throws when ciphertext is shorter than IV length', async () => {
    const manager = new StorageAESEncryptionManager();
    const key = new TextEncoder().encode('key');
    const shortCiphertext = new Uint8Array(12);

    await expect(manager.decrypt(shortCiphertext, key)).rejects.toThrow(
      'Ciphertext too short to contain IV'
    );
  });
});

class MemoryStore<V> implements KeyValueStore<V> {
  private readonly data = new Map<string, V>();

  async set(key: string, value: V): Promise<void> {
    this.data.set(key, value);
  }

  async update(key: string, value: V): Promise<void> {
    this.data.set(key, value);
  }

  async get(key: string): Promise<V | undefined> {
    return this.data.get(key);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async list(): Promise<Record<string, V>> {
    return Object.fromEntries(this.data.entries());
  }

  snapshot(): Record<string, V> {
    return Object.fromEntries(this.data.entries());
  }
}

describe('EncryptedKeyValueStore', () => {
  const createCredentialProvider = (
    value: string | null
  ): CredentialProvider => ({
    get: jest.fn(async () => value),
  });

  const createEncryptionManager = () => {
    const manager: StorageEncryptionManager & {
      encrypt: jest.Mock<Promise<Uint8Array>, [Uint8Array, Uint8Array]>;
      decrypt: jest.Mock<Promise<Uint8Array>, [Uint8Array, Uint8Array]>;
    } = {
      encrypt: jest.fn(
        async (plaintext: Uint8Array, _key: Uint8Array) => plaintext
      ),
      decrypt: jest.fn(
        async (ciphertext: Uint8Array, _key: Uint8Array) => ciphertext
      ),
    };
    return manager;
  };

  const toHex = (input: string): string =>
    Buffer.from(input, 'utf8').toString('hex');

  it('serializes values with toJSON and caches decrypted results', async () => {
    const store = new MemoryStore<EncryptedValue>();
    const encryptionManager = createEncryptionManager();
    const credentialProvider = createCredentialProvider('master-secret');

    class JsonModel {
      public value: string;
      constructor(input: string | { value: string }) {
        this.value = typeof input === 'string' ? input : input.value;
      }
      toJSON() {
        return { value: this.value };
      }
    }

    const encryptedStore = new EncryptedKeyValueStore<JsonModel>({
      underlyingStore: store,
      masterKeyProvider: credentialProvider,
      encryptionManager,
      modelCtor: JsonModel,
      enableCaching: true,
    });

    await encryptedStore.set('key', new JsonModel('alpha'));
    const persisted = store.snapshot()['key'];
    expect(persisted).toBeInstanceOf(EncryptedValue);
    const expectedJson = JSON.stringify({ value: 'alpha' });
    expect(persisted?.ciphertext).toBe(toHex(expectedJson));

    await encryptedStore.clearCache();
    encryptionManager.decrypt.mockClear();
    const first = await encryptedStore.get('key');
    expect(first).toBeInstanceOf(JsonModel);
    expect(encryptionManager.decrypt).toHaveBeenCalledTimes(1);

    const second = await encryptedStore.get('key');
    expect(second).toBe(first);
    expect(encryptionManager.decrypt).toHaveBeenCalledTimes(1);
  });

  it('updates values and refreshes cache', async () => {
    const store = new MemoryStore<EncryptedValue>();
    const encryptionManager = createEncryptionManager();
    const credentialProvider = createCredentialProvider('master-secret');

    class Model {
      public name: string;
      constructor(input: string | { name: string }) {
        this.name = typeof input === 'string' ? input : input.name;
      }
      static fromJSON(data: { name: string }) {
        return new Model(data.name);
      }
    }

    const encryptedStore = new EncryptedKeyValueStore<Model>({
      underlyingStore: store,
      masterKeyProvider: credentialProvider,
      encryptionManager,
      modelCtor: Model,
      enableCaching: true,
    });

    await encryptedStore.set('key', new Model('first'));
    await encryptedStore.update('key', new Model('second'));

    const value = await encryptedStore.get('key');
    expect(value?.name).toBe('second');
  });

  it('returns undefined when item missing and handles invalid encrypted value', async () => {
    const store = new MemoryStore<EncryptedValue>();
    const encryptionManager = createEncryptionManager();
    const credentialProvider = createCredentialProvider('master-secret');

    class SimpleModel {
      constructor(public id: string) {}
    }

    const encryptedStore = new EncryptedKeyValueStore<SimpleModel>({
      underlyingStore: store,
      masterKeyProvider: credentialProvider,
      encryptionManager,
      modelCtor: SimpleModel,
    });

    expect(await encryptedStore.get('missing')).toBeUndefined();

    // Inject invalid record
    await store.set('bad', {} as unknown as EncryptedValue);
    await expect(encryptedStore.get('bad')).rejects.toThrow(
      'Expected EncryptedValue, got object'
    );
  });

  it('propagates errors when master key provider does not supply a key', async () => {
    const store = new MemoryStore<EncryptedValue>();
    const encryptionManager = createEncryptionManager();
    const credentialProvider = createCredentialProvider(null);

    class SimpleModel {
      constructor(public id: string) {}
    }

    const encryptedStore = new EncryptedKeyValueStore<SimpleModel>({
      underlyingStore: store,
      masterKeyProvider: credentialProvider,
      encryptionManager,
      modelCtor: SimpleModel,
    });

    await expect(
      encryptedStore.set('key', new SimpleModel('id'))
    ).rejects.toThrow('Master key provider must return a valid key');
  });

  it('throws when ciphertext has invalid hex encoding', async () => {
    const store = new MemoryStore<EncryptedValue>();
    const encryptionManager = createEncryptionManager();
    const credentialProvider = createCredentialProvider('master-secret');

    class SimpleModel {
      constructor(public id: string) {}
    }

    const encryptedStore = new EncryptedKeyValueStore<SimpleModel>({
      underlyingStore: store,
      masterKeyProvider: credentialProvider,
      encryptionManager,
      modelCtor: SimpleModel,
    });

    await store.set(
      'invalid-hex',
      new EncryptedValue({ keyId: 'k', ciphertext: 'abc', algorithm: 'algo' })
    );

    await expect(encryptedStore.get('invalid-hex')).rejects.toThrow(
      'Invalid hex string'
    );
  });

  it('lists values while skipping corrupt and non-encrypted entries', async () => {
    const store = new MemoryStore<EncryptedValue>();
    const encryptionManager = createEncryptionManager();
    const credentialProvider = createCredentialProvider('master-secret');

    class ListModel {
      public value: string;
      constructor(input: string | { value: string }) {
        this.value = typeof input === 'string' ? input : input.value;
      }
    }

    const encryptedStore = new EncryptedKeyValueStore<ListModel>({
      underlyingStore: store,
      masterKeyProvider: credentialProvider,
      encryptionManager,
      modelCtor: ListModel,
      enableCaching: true,
    });

    // Cached value to hit cache branch
    await encryptedStore.set('cached', new ListModel('cached-value'));
    await encryptedStore.get('cached');
    encryptionManager.decrypt.mockClear();
    encryptionManager.decrypt.mockImplementation(
      async (ciphertext: Uint8Array, _key: Uint8Array) => {
        if (ciphertext[0] === 0xff) {
          throw new Error('corrupt');
        }
        return ciphertext;
      }
    );

    await store.set('plain', 'not-encrypted' as unknown as EncryptedValue);
    await store.set(
      'corrupt',
      new EncryptedValue({ keyId: 'k', ciphertext: 'ff', algorithm: 'algo' })
    );
    await store.set(
      'valid',
      new EncryptedValue({
        keyId: 'k',
        ciphertext: toHex(JSON.stringify({ value: 'ok' })),
        algorithm: 'algo',
      })
    );

    const items = await encryptedStore.list();
    expect(Object.keys(items)).toEqual(['cached', 'valid']);
    expect(items.valid).toBeInstanceOf(ListModel);
    expect(encryptionManager.decrypt).toHaveBeenCalledTimes(2);
    expect(encryptionManager.decrypt.mock.calls[0][0][0]).toBe(0xff);
  });

  it('clears cache and removes deleted entries', async () => {
    const store = new MemoryStore<EncryptedValue>();
    const encryptionManager = createEncryptionManager();
    const credentialProvider = createCredentialProvider('master-secret');

    class Model {
      public value: string;
      constructor(input: string | { value: string }) {
        this.value = typeof input === 'string' ? input : input.value;
      }
      static fromJSON(data: { value: string }) {
        return new Model(data.value);
      }
    }

    const encryptedStore = new EncryptedKeyValueStore<Model>({
      underlyingStore: store,
      masterKeyProvider: credentialProvider,
      encryptionManager,
      modelCtor: Model,
      enableCaching: true,
    });

    await encryptedStore.set('key', new Model('value'));
    await encryptedStore.clearCache();

    await store.set(
      'key',
      new EncryptedValue({
        keyId: 'k',
        ciphertext: toHex('{"value":"fresh"}'),
        algorithm: 'algo',
      })
    );
    const fetched = await encryptedStore.get('key');
    expect(fetched?.value).toBe('fresh');

    await encryptedStore.delete('key');
    expect(Object.keys(await store.list())).toHaveLength(0);
  });

  it('supports modelCtor fromJSON, fromJson, deserialize, constructor, and prototype merge', async () => {
    const encryptionManager = createEncryptionManager();
    const credentialProvider = createCredentialProvider('master-secret');

    const createStore = <T>(modelCtor: new (...args: any[]) => T) => {
      const store = new MemoryStore<EncryptedValue>();
      const encryptedStore = new EncryptedKeyValueStore<T>({
        underlyingStore: store,
        masterKeyProvider: credentialProvider,
        encryptionManager,
        modelCtor,
      });
      return { store, encryptedStore };
    };

    class FromJSONModel {
      public value: string;
      static fromJSON(input: any) {
        return new FromJSONModel(input.value);
      }
      constructor(input: string | { value: string }) {
        this.value = typeof input === 'string' ? input : input.value;
      }
    }

    class FromJsonModel {
      public value: string;
      static fromJson(input: any) {
        return new FromJsonModel(input.value);
      }
      constructor(input: string | { value: string }) {
        this.value = typeof input === 'string' ? input : input.value;
      }
    }

    class DeserializeModel {
      public value: string;
      static deserialize(input: any) {
        return new DeserializeModel(input.value);
      }
      constructor(input: string | { value: string }) {
        this.value = typeof input === 'string' ? input : input.value;
      }
    }

    class ConstructibleModel {
      public value: string;
      constructor(data: { value: string }) {
        this.value = data.value;
      }
    }

    class FallbackModel {
      constructor() {
        throw new Error('cannot construct');
      }
    }

    const scenarios = [
      [FromJSONModel, 'from-json'],
      [FromJsonModel, 'fromJson'],
      [DeserializeModel, 'deserialize'],
      [ConstructibleModel, 'constructible'],
      [FallbackModel, 'fallback'],
    ] as const;

    for (const [Ctor, label] of scenarios) {
      const { store, encryptedStore } = createStore(Ctor);
      await store.set(
        label,
        new EncryptedValue({
          keyId: 'k',
          ciphertext: toHex('{"value":"' + label + '"}'),
          algorithm: 'algo',
        })
      );

      const value = await encryptedStore.get(label);
      expect(value).toBeDefined();
      if (label === 'fallback') {
        const prototype = (Ctor as any).prototype;
        expect(Object.getPrototypeOf(value!)).toBe(prototype);
      }
      expect((value as any).value).toBe(label);
    }
  });

  it('allows stores without caching to operate normally', async () => {
    const store = new MemoryStore<EncryptedValue>();
    const encryptionManager = createEncryptionManager();
    const credentialProvider = createCredentialProvider('master-secret');

    class Model {
      public value: string;
      constructor(input: string | { value: string }) {
        this.value = typeof input === 'string' ? input : input.value;
      }
      static fromJSON(data: { value: string }) {
        return new Model(data.value);
      }
    }

    const encryptedStore = new EncryptedKeyValueStore<Model>({
      underlyingStore: store,
      masterKeyProvider: credentialProvider,
      encryptionManager,
      modelCtor: Model,
      enableCaching: false,
    });

    await encryptedStore.set('key', new Model('value'));
    await encryptedStore.update('key', new Model('value-2'));
    const value = await encryptedStore.get('key');
    expect(value?.value).toBe('value-2');
  });
});

describe('EncryptedStorageProviderBase', () => {
  type ProviderOptions = {
    isEncrypted?: boolean;
    masterKeyProvider?: CredentialProvider | null;
    encryptionManager?: StorageEncryptionManager | null;
    enableCaching?: boolean;
  };

  class TestProvider extends EncryptedStorageProviderBase {
    private readonly stores = new Map<string, KeyValueStore<any>>();

    constructor(options: ProviderOptions = {}) {
      super(options);
    }

    protected async getUnderlyingKeyValueStore<T>(
      _modelCtor: new (...args: any[]) => T,
      namespace: string
    ): Promise<KeyValueStore<T>> {
      if (!this.stores.has(namespace)) {
        this.stores.set(namespace, new MemoryStore<T>());
      }
      return this.stores.get(namespace)! as KeyValueStore<T>;
    }
  }

  it('throws when encryption enabled without master key provider in non-browser environment', () => {
    const originalIndexedDB = (globalThis as { indexedDB?: IDBFactory })
      .indexedDB;
    const originalCrypto = globalThis.crypto;

    Object.defineProperty(globalThis, 'indexedDB', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'crypto', {
      value: undefined,
      configurable: true,
      writable: true,
    });

    try {
      expect(() => new TestProvider({ isEncrypted: true })).toThrow(
        'masterKeyProvider is required when encryption is enabled'
      );
    } finally {
      if (originalIndexedDB !== undefined) {
        Object.defineProperty(globalThis, 'indexedDB', {
          value: originalIndexedDB,
          configurable: true,
          writable: true,
        });
      } else {
        delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
      }

      Object.defineProperty(globalThis, 'crypto', {
        value: originalCrypto,
        configurable: true,
        writable: true,
      });
    }
  });

  it('creates default browser credential provider when available', () => {
    const originalIndexedDB = (globalThis as { indexedDB?: IDBFactory })
      .indexedDB;
    const originalCrypto = globalThis.crypto;

    const fakeIndexedDB = { open: jest.fn() } as unknown as IDBFactory;
    const fakeCrypto = {
      subtle: {} as SubtleCrypto,
      getRandomValues: jest.fn((buffer: Uint8Array) => buffer.fill(1)),
    } as unknown as Crypto;

    Object.defineProperty(globalThis, 'indexedDB', {
      value: fakeIndexedDB,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'crypto', {
      value: fakeCrypto,
      configurable: true,
      writable: true,
    });

    try {
      expect(() => new TestProvider({ isEncrypted: true })).not.toThrow();
    } finally {
      if (originalIndexedDB !== undefined) {
        Object.defineProperty(globalThis, 'indexedDB', {
          value: originalIndexedDB,
          configurable: true,
          writable: true,
        });
      } else {
        delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
      }

      Object.defineProperty(globalThis, 'crypto', {
        value: originalCrypto,
        configurable: true,
        writable: true,
      });
    }
  });

  it('returns underlying store when encryption disabled', async () => {
    const provider = new TestProvider({ isEncrypted: false });

    const store = await provider.getKeyValueStore(class Plain {}, 'namespace');
    expect(store).toBeInstanceOf(MemoryStore);
  });

  it('wraps stores in EncryptedKeyValueStore when encryption enabled', async () => {
    const credentials: CredentialProvider = {
      get: jest.fn(async () => 'master'),
    };
    const provider = new TestProvider({
      isEncrypted: true,
      masterKeyProvider: credentials,
      enableCaching: true,
    });

    const store = await provider.getKeyValueStore(class Model {}, 'secure');
    expect(store).toBeInstanceOf(EncryptedKeyValueStore);
    expect((store as any).cache).not.toBeNull();
  });

  it('throws when encryption manager becomes unavailable', async () => {
    const credentials: CredentialProvider = {
      get: jest.fn(async () => 'master'),
    };
    const provider = new TestProvider({
      isEncrypted: true,
      masterKeyProvider: credentials,
      encryptionManager: null,
    });

    (provider as any).encryptionManager = null;

    await expect(
      provider.getKeyValueStore(class Model {}, 'ns')
    ).rejects.toThrow(
      'Encryption is enabled but master key provider or encryption manager is missing'
    );
  });
});
