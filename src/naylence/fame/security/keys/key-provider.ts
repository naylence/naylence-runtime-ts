import type { KeyRecord, KeyStore } from './key-store.js';

export interface KeyProvider {
  getKey(kid: string): Promise<KeyRecord>;
  getKeysForPath(physicalPath: string): Promise<Iterable<KeyRecord>>;
}

export function getKeyProvider(): KeyProvider {
  const { getKeyStore } = require('./key-store.js') as {
    getKeyStore(): KeyStore;
  };
  return getKeyStore();
}
