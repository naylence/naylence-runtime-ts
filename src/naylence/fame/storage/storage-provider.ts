import type { KeyValueStore } from './key-value-store.js';

export interface StorageProvider {
  getKeyValueStore<V>(
    model: new (...args: any[]) => V,
    namespace: string
  ): Promise<KeyValueStore<V>>;
}
