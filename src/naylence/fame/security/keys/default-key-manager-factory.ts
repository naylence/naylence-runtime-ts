import { DefaultKeyManager } from "./default-key-manager.js";
import type { KeyStore } from "./key-store.js";
import { getKeyStore } from "./key-store.js";
import { KeyStoreFactory, type KeyStoreConfig } from "./key-store-factory.js";
import {
  KeyManagerFactory,
  KEY_MANAGER_FACTORY_BASE_TYPE,
  type KeyManagerConfig,
} from "./key-manager-factory.js";

export interface DefaultKeyManagerConfig extends KeyManagerConfig {
  type: "DefaultKeyManager";
  hasUpstream?: boolean;
  nodeId?: string;
  keyStore?: KeyStoreConfig | null;
}

export const FACTORY_META = {
  base: KEY_MANAGER_FACTORY_BASE_TYPE,
  key: "DefaultKeyManager",
} as const;

export class DefaultKeyManagerFactory extends KeyManagerFactory<DefaultKeyManagerConfig> {
  public readonly type = "DefaultKeyManager";
  public readonly isDefault = true;
  public readonly priority = 100;

  public async create(
    config?: DefaultKeyManagerConfig | Record<string, unknown> | null,
    keyStore?: KeyStore | null
  ): Promise<DefaultKeyManager> {
    const resolvedConfig: DefaultKeyManagerConfig = {
      type: "DefaultKeyManager",
      ...(config ?? {}),
    } as DefaultKeyManagerConfig;

    let resolvedKeyStore: KeyStore | null = keyStore ?? null;

    if (!resolvedKeyStore && resolvedConfig.keyStore) {
      resolvedKeyStore = await KeyStoreFactory.createKeyStore(resolvedConfig.keyStore);
    }

    if (!resolvedKeyStore) {
      resolvedKeyStore = getKeyStore();
    }

    return new DefaultKeyManager({ keyStore: resolvedKeyStore });
  }
}

export default DefaultKeyManagerFactory;
