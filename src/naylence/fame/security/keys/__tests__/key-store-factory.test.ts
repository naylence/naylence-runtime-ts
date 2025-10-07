import { registerFactory, ResourceFactoryRegistry } from 'naylence-factory';
import { InMemoryKeyStore } from '../in-memory-key-store.js';
import {
  KeyStoreFactory,
  KEY_STORE_FACTORY_BASE_TYPE,
} from '../key-store-factory.js';
import type { KeyRecord } from '../key-store.js';

describe('KeyStoreFactory', () => {
  class TestKeyStoreFactory extends KeyStoreFactory {
    public readonly type = 'TestKeyStore';
    public readonly isDefault = true;

    public async create(): Promise<InMemoryKeyStore> {
      return new InMemoryKeyStore();
    }
  }

  beforeAll(() => {
    registerFactory(
      KEY_STORE_FACTORY_BASE_TYPE,
      'TestKeyStore',
      TestKeyStoreFactory,
      {
        isDefault: true,
        priority: 10,
      }
    );
  });

  afterEach(() => {
    ResourceFactoryRegistry.clearCache(KEY_STORE_FACTORY_BASE_TYPE);
  });

  it('creates key stores from configuration', async () => {
    const store = await KeyStoreFactory.createKeyStore({
      type: 'TestKeyStore',
    });
    await store.addKey('kid', {
      kid: 'kid',
      kty: 'OKP',
      crv: 'Ed25519',
      x: 'abc',
      use: 'sig',
      physical_path: '/path',
      sid: 'sid',
    } as KeyRecord);

    expect(await store.hasKey('kid')).toBe(true);
  });

  it('creates default key store when config omitted', async () => {
    const store = await KeyStoreFactory.createKeyStore();
    expect(store).toBeInstanceOf(InMemoryKeyStore);
  });
});
