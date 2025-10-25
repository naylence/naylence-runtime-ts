import { registerFactory, ResourceFactoryRegistry } from '@naylence/factory';

import { DefaultKeyManager } from '../default-key-manager.js';
import { InMemoryKeyStore } from '../in-memory-key-store.js';
import '../default-key-manager-factory.js';
import '../in-memory-key-store-factory.js';
import type { KeyManager } from '../key-manager.js';
import {
  KeyManagerFactory,
  KEY_MANAGER_FACTORY_BASE_TYPE,
} from '../key-manager-factory.js';
import type { KeyStore } from '../key-store.js';

class TestKeyManager implements KeyManager {
  public readonly priority = 50;
  public readonly addKeys = jest.fn<
    Promise<void>,
    [Parameters<KeyManager['addKeys']>[0]]
  >(async () => {});
  public readonly announceKeysToUpstream = jest.fn<Promise<void>, []>(
    async () => {}
  );
  public readonly getKey = jest.fn<Promise<any>, [string]>(
    async (kid: string) => ({ kid })
  );
  public readonly getKeysForPath = jest.fn<Promise<Iterable<any>>, [string]>(
    async () => []
  );
  public readonly handleKeyRequest = jest.fn<
    Promise<void>,
    [Parameters<KeyManager['handleKeyRequest']>[0]]
  >(async () => {});
  public readonly hasKey = jest.fn<Promise<boolean>, [string]>(
    async () => true
  );
  public readonly onNodeStarted = jest.fn<Promise<void>, [any]>(async () => {});
  public readonly onNodeStopped = jest.fn<Promise<void>, [any]>(async () => {});
  public readonly removeKeysForPath = jest.fn<Promise<number>, [string]>(
    async () => 0
  );

  constructor(public readonly receivedKeyStore: KeyStore | null) {}
}

class TestKeyManagerFactory extends KeyManagerFactory {
  public readonly type = 'TestKeyManager';
  public readonly isDefault = false;

  public async create(
    _config?: Record<string, unknown> | null,
    keyStore?: KeyStore | null
  ): Promise<KeyManager> {
    return new TestKeyManager(keyStore ?? null);
  }
}

describe('KeyManagerFactory', () => {
  beforeAll(() => {
    registerFactory(
      KEY_MANAGER_FACTORY_BASE_TYPE,
      'TestKeyManager',
      TestKeyManagerFactory,
      {
        priority: 200,
      }
    );
  });

  afterEach(() => {
    ResourceFactoryRegistry.clearCache(KEY_MANAGER_FACTORY_BASE_TYPE);
  });

  it('creates default key manager when config omitted', async () => {
    const manager = await KeyManagerFactory.createKeyManager();
    expect(manager).toBeInstanceOf(DefaultKeyManager);
  });

  it('creates configured key manager and forwards provided key store', async () => {
    const providedStore = new InMemoryKeyStore();

    const manager = await KeyManagerFactory.createKeyManager(
      { type: 'TestKeyManager' },
      { keyStore: providedStore }
    );

    expect(manager).toBeInstanceOf(TestKeyManager);
    expect((manager as TestKeyManager).receivedKeyStore).toBe(providedStore);
  });

  it('creates key manager using key store from config', async () => {
    const manager = await KeyManagerFactory.createKeyManager({
      type: 'DefaultKeyManager',
      keyStore: { type: 'InMemoryKeyStore' },
    });

    expect(manager).toBeInstanceOf(DefaultKeyManager);
  });
});
