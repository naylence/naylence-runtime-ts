import type { CreateResourceOptions, ResourceConfig } from 'naylence-factory';
import {
  AbstractResourceFactory,
  createDefaultResource,
  createResource,
} from 'naylence-factory';
import type { KeyStore } from './key-store.js';
import type { StorageProvider } from '../../storage/storage-provider.js';

export const KEY_STORE_FACTORY_BASE_TYPE = 'KeyStoreFactory';

export interface KeyStoreConfig extends ResourceConfig {
  type: string;
  [key: string]: unknown;
}

export abstract class KeyStoreFactory<
  C extends KeyStoreConfig = KeyStoreConfig,
> extends AbstractResourceFactory<KeyStore, C> {
  public abstract create(
    config?: C | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<KeyStore>;

  public static async createKeyStore<C extends KeyStoreConfig = KeyStoreConfig>(
    config?: C | Record<string, unknown> | null,
    options: CreateResourceOptions & {
      storageProvider?: StorageProvider | null;
    } = {}
  ): Promise<KeyStore> {
    const { storageProvider, ...restOptions } = options;

    const factoryArgs = [...(restOptions.factoryArgs ?? [])];
    if (storageProvider !== undefined) {
      factoryArgs.push(storageProvider);
    }

    const creationOptions: CreateResourceOptions = {
      ...restOptions,
      factoryArgs,
    };

    const instance = config
      ? await createResource<KeyStore>(
          KEY_STORE_FACTORY_BASE_TYPE,
          config,
          creationOptions
        )
      : await createDefaultResource<KeyStore>(
          KEY_STORE_FACTORY_BASE_TYPE,
          null,
          creationOptions
        );

    if (!instance) {
      throw new Error('Failed to create key store from configuration');
    }

    return instance;
  }
}
