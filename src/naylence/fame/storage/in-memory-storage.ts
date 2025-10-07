import type { KeyValueStore } from './key-value-store.js';
import type { StorageProvider } from './storage-provider.js';

class InMemoryKeyValueStore<V> implements KeyValueStore<V> {
  private readonly store = new Map<string, V>();

  async set(key: string, value: V): Promise<void> {
    this.store.set(key, value);
  }

  async update(key: string, value: V): Promise<void> {
    if (!this.store.has(key)) {
      throw new Error(`Key '${key}' not found for update.`);
    }
    this.store.set(key, value);
  }

  async get(key: string): Promise<V | undefined> {
    return this.store.get(key);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(): Promise<Record<string, V>> {
    const result: Record<string, V> = {};
    for (const [key, value] of this.store.entries()) {
      result[key] = value;
    }
    return result;
  }
}

export class InMemoryStorageProvider implements StorageProvider {
  private readonly stores = new Map<
    string,
    Map<new (...args: any[]) => unknown, KeyValueStore<any>>
  >();

  async getKeyValueStore<V>(
    modelCtor: new (...args: any[]) => V,
    namespace: string
  ): Promise<KeyValueStore<V>> {
    let namespaceStores = this.stores.get(namespace);
    if (!namespaceStores) {
      namespaceStores = new Map();
      this.stores.set(namespace, namespaceStores);
    }

    const existing = namespaceStores.get(modelCtor);
    if (existing) {
      return existing as KeyValueStore<V>;
    }

    const store = new InMemoryKeyValueStore<V>();
    namespaceStores.set(modelCtor, store);
    return store;
  }
}

export { InMemoryKeyValueStore };
