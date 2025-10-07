import { InMemoryKeyStore } from './in-memory-key-store.js';
import {
  KEY_STORE_FACTORY_BASE_TYPE,
  KeyStoreFactory,
  type KeyStoreConfig,
} from './key-store-factory.js';
import type { KeyRecord } from './key-store.js';

export interface InMemoryKeyStoreConfig extends KeyStoreConfig {
  type: 'InMemoryKeyStore';
  initialKeys?: Record<string, KeyRecord> | Map<string, KeyRecord> | null;
  initial_keys?: Record<string, KeyRecord> | null;
}

export const FACTORY_META = {
  base: KEY_STORE_FACTORY_BASE_TYPE,
  key: 'InMemoryKeyStore',
} as const;

export class InMemoryKeyStoreFactory extends KeyStoreFactory<InMemoryKeyStoreConfig> {
  public readonly type = 'InMemoryKeyStore';
  public readonly isDefault = true;
  public readonly priority = 100;

  public async create(
    config?: InMemoryKeyStoreConfig | Record<string, unknown> | null
  ): Promise<InMemoryKeyStore> {
    const initialKeys = this.resolveInitialKeys(config);
    return new InMemoryKeyStore(initialKeys ?? null);
  }

  private resolveInitialKeys(
    config?: InMemoryKeyStoreConfig | Record<string, unknown> | null
  ): Record<string, KeyRecord> | Map<string, KeyRecord> | null {
    if (!config || typeof config !== 'object') {
      return null;
    }

    const candidate = config as Partial<InMemoryKeyStoreConfig>;

    if (candidate.initialKeys instanceof Map) {
      return candidate.initialKeys;
    }

    if (candidate.initialKeys && typeof candidate.initialKeys === 'object') {
      return candidate.initialKeys as Record<string, KeyRecord>;
    }

    if (candidate.initial_keys && typeof candidate.initial_keys === 'object') {
      return candidate.initial_keys as Record<string, KeyRecord>;
    }

    return null;
  }
}

export default InMemoryKeyStoreFactory;
