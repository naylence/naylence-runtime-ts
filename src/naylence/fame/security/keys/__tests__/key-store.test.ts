import { secureDigest } from '../../../util/util.js';
import { InMemoryKeyStore } from '../in-memory-key-store.js';
import { KeyStore } from '../key-store.js';
import { getKeyStore, setKeyStore } from '../key-store.js';
import { getKeyProvider } from '../key-provider.js';
import type { KeyRecord } from '../key-store.js';

class TestKeyStore extends KeyStore {
  public readonly stored = new Map<string, KeyRecord>();

  public async addKey(kid: string, jwk: KeyRecord): Promise<void> {
    this.stored.set(kid, jwk);
  }

  public async getKey(kid: string): Promise<KeyRecord> {
    const key = this.stored.get(kid);
    if (!key) {
      throw new Error('missing');
    }
    return key;
  }

  public async hasKey(kid: string): Promise<boolean> {
    return this.stored.has(kid);
  }

  public async getKeys(): Promise<Iterable<KeyRecord>> {
    return this.stored.values();
  }

  public async getKeysForPath(physicalPath: string): Promise<Iterable<KeyRecord>> {
    return Array.from(this.stored.values()).filter((key) => key.physical_path === physicalPath);
  }

  public async getKeysGroupedByPath(): Promise<Record<string, KeyRecord[]>> {
    const grouped: Record<string, KeyRecord[]> = Object.create(null);
    for (const key of this.stored.values()) {
      const physicalPath = typeof key.physical_path === 'string' ? key.physical_path : null;
      if (!physicalPath) continue;
      grouped[physicalPath] = grouped[physicalPath] ?? [];
      grouped[physicalPath].push(key);
    }
    return grouped;
  }

  public async removeKeysForPath(physicalPath: string): Promise<number> {
    let count = 0;
    for (const key of Array.from(this.stored.values())) {
      if (key.physical_path === physicalPath && typeof key.kid === 'string') {
        this.stored.delete(key.kid);
        count += 1;
      }
    }
    return count;
  }

  public async removeKey(kid: string): Promise<boolean> {
    return this.stored.delete(kid);
  }
}

describe('KeyStore.addKeys', () => {
  const validKey = {
    kid: 'key-1',
    kty: 'OKP',
    crv: 'Ed25519',
    x: 'abc',
    use: 'sig',
  };

  const invalidKey = {
    kid: 'key-2',
    kty: 'OKP',
    crv: 'Ed25519',
    x: 'def',
  };

  it('adds valid keys and skips invalid ones while annotating metadata', async () => {
    const store = new TestKeyStore();
    const physicalPath = '/fame/node';

    await store.addKeys([validKey, invalidKey], physicalPath);

    expect(store.stored.size).toBe(1);
    const storedKey = store.stored.get('key-1');
    expect(storedKey).toBeDefined();
    expect(storedKey?.sid).toBe(secureDigest(physicalPath));
    expect(storedKey?.physical_path).toBe(physicalPath);
    expect(storedKey?.use).toBe('sig');
  });
});

describe('InMemoryKeyStore', () => {
  const baseKey = {
    kid: 'key-1',
    kty: 'OKP',
    crv: 'Ed25519',
    x: 'abc',
    use: 'sig',
    physical_path: '/fame/node',
  } as KeyRecord;

  it('stores and retrieves keys', async () => {
    const store = new InMemoryKeyStore();
    await store.addKey(baseKey.kid, baseKey);

    expect(await store.hasKey(baseKey.kid)).toBe(true);
    expect(await store.getKey(baseKey.kid)).toEqual(baseKey);
  });

  it('removes stale keys sharing physical path and use', async () => {
    const store = new InMemoryKeyStore();
    const firstKey = { ...baseKey, kid: 'first' };
    const staleKey = { ...baseKey, kid: 'stale' };
    await store.addKey(firstKey.kid, firstKey);
    await store.addKey(staleKey.kid, staleKey);

    const replacement = { ...baseKey, kid: 'replacement' };
    await store.addKey(replacement.kid, replacement);

    expect(await store.hasKey('first')).toBe(false);
    expect(await store.hasKey('stale')).toBe(false);
    expect(await store.hasKey('replacement')).toBe(true);
  });

  it('removes keys by path and individually', async () => {
    const store = new InMemoryKeyStore();
    const keyA = { ...baseKey, kid: 'A' };
    const keyB = { ...baseKey, kid: 'B', physical_path: '/other/path' };

    await store.addKey(keyA.kid, keyA);
    await store.addKey(keyB.kid, keyB);

    expect(await store.removeKeysForPath('/fame/node')).toBe(1);
    expect(await store.hasKey('A')).toBe(false);
    expect(await store.removeKey('B')).toBe(true);
    expect(await store.hasKey('B')).toBe(false);
  });
});

describe('KeyStore singleton helpers', () => {
  afterEach(() => {
    setKeyStore(null);
  });

  it('returns a singleton key store instance', () => {
    const storeA = getKeyStore();
    const storeB = getKeyStore();
    expect(storeA).toBe(storeB);
  });

  it('exposes key provider facade', async () => {
    const mockStore = new TestKeyStore();
    setKeyStore(mockStore);

    const provider = getKeyProvider();
    await mockStore.addKey('key', {
      kid: 'key',
      kty: 'OKP',
      crv: 'Ed25519',
      x: 'abc',
      use: 'sig',
      physical_path: '/path',
      sid: secureDigest('/path'),
    });

    expect(provider).toBe(mockStore);
    expect(await provider.getKey('key')).toHaveProperty('kid', 'key');
  });
});
