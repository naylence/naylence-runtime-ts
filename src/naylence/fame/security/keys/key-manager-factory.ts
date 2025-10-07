import type { CreateResourceOptions, ResourceConfig } from 'naylence-factory';
import {
  AbstractResourceFactory,
  createDefaultResource,
  createResource,
} from 'naylence-factory';

import type { KeyManager } from './key-manager.js';
import type { KeyStore } from './key-store.js';

export const KEY_MANAGER_FACTORY_BASE_TYPE = 'KeyManagerFactory';

export interface KeyManagerConfig extends ResourceConfig {
  type: string;
  [key: string]: unknown;
}

export abstract class KeyManagerFactory<
  C extends KeyManagerConfig = KeyManagerConfig,
> extends AbstractResourceFactory<KeyManager, C> {
  public abstract create(
    config?: C | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<KeyManager>;

  public static async createKeyManager<
    C extends KeyManagerConfig = KeyManagerConfig,
  >(
    config?: C | Record<string, unknown> | null,
    options: CreateResourceOptions & {
      keyStore?: KeyStore | null;
    } = {}
  ): Promise<KeyManager> {
    const { keyStore, ...restOptions } = options;

    const factoryArgs = [...(restOptions.factoryArgs ?? [])];
    if (keyStore !== undefined) {
      factoryArgs.push(keyStore);
    }

    const creationOptions: CreateResourceOptions = {
      ...restOptions,
      factoryArgs,
    };

    const instance = config
      ? await createResource<KeyManager>(
          KEY_MANAGER_FACTORY_BASE_TYPE,
          config,
          creationOptions
        )
      : await createDefaultResource<KeyManager>(
          KEY_MANAGER_FACTORY_BASE_TYPE,
          null,
          creationOptions
        );

    if (!instance) {
      throw new Error('Failed to create key manager from configuration');
    }

    return instance;
  }
}
