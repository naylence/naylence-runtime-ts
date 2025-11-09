import type { KeyRecord } from './key-store.js';
import { getKeyStore } from './key-store.js';

export interface KeyProvider {
  getKey(kid: string): Promise<KeyRecord>;
  getKeysForPath(physicalPath: string): Promise<Iterable<KeyRecord>>;
}

export function getKeyProvider(): KeyProvider {
  return getKeyStore();
}
