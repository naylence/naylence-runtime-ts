import type { CreateResourceOptions, ResourceConfig } from '@naylence/factory';
import {
  AbstractResourceFactory,
  createDefaultResource,
  createResource,
} from '@naylence/factory';

import type { KeyManager } from './key-manager.js';
import type { KeyStore } from './key-store.js';

export const KEY_MANAGER_FACTORY_BASE_TYPE = 'KeyManagerFactory';
const DEFAULT_KEY_MANAGER_FACTORY_TYPE = 'DefaultKeyManager';

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
    const { normalizedConfig, usedDefaultType } =
      KeyManagerFactory.normalizeConfig(config);

    const { keyStore, ...restOptions } = options;

    const factoryArgs = [...(restOptions.factoryArgs ?? [])];
    if (keyStore !== undefined) {
      factoryArgs.push(keyStore);
    }

    const creationOptions: CreateResourceOptions = {
      ...restOptions,
      factoryArgs,
    };

    const instance =
      normalizedConfig && !usedDefaultType
        ? await createResource<KeyManager>(
            KEY_MANAGER_FACTORY_BASE_TYPE,
            normalizedConfig,
            creationOptions
          )
        : await createDefaultResource<KeyManager>(
            KEY_MANAGER_FACTORY_BASE_TYPE,
            normalizedConfig,
            creationOptions
          );

    if (!instance) {
      throw new Error('Failed to create key manager from configuration');
    }

    return instance;
  }

  private static normalizeConfig(
    config?: KeyManagerConfig | Record<string, unknown> | null
  ): {
    normalizedConfig: Record<string, unknown> | null;
    usedDefaultType: boolean;
  } {
    if (!config) {
      return { normalizedConfig: null, usedDefaultType: false };
    }

    if (typeof config !== 'object') {
      throw new TypeError('Key manager configuration must be an object');
    }

    const clonedConfig = KeyManagerFactory.cloneConfig(config);
    const hasExplicitType =
      typeof clonedConfig.type === 'string' && clonedConfig.type.length > 0;

    if (!hasExplicitType) {
      clonedConfig.type = DEFAULT_KEY_MANAGER_FACTORY_TYPE;
      return { normalizedConfig: clonedConfig, usedDefaultType: true };
    }

    return { normalizedConfig: clonedConfig, usedDefaultType: false };
  }

  private static cloneConfig(
    config: KeyManagerConfig | Record<string, unknown>
  ): Record<string, unknown> {
    const maybeJson =
      typeof (config as { toJSON?: () => unknown }).toJSON === 'function'
        ? (config as { toJSON: () => unknown }).toJSON()
        : null;

    if (
      maybeJson &&
      typeof maybeJson === 'object' &&
      !Array.isArray(maybeJson)
    ) {
      return { ...(maybeJson as Record<string, unknown>) };
    }

    return { ...(config as Record<string, unknown>) };
  }
}
