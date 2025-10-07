import type { CreateResourceOptions, ResourceConfig } from 'naylence-factory';
import {
  AbstractResourceFactory,
  createDefaultResource,
  createResource,
} from 'naylence-factory';

import type { SecureChannelManager } from './secure-channel-manager.js';

export interface SecureChannelManagerConfig extends ResourceConfig {
  type: string;
  [key: string]: unknown;
}

export interface CreateSecureChannelManagerOptions
  extends Omit<CreateResourceOptions, 'factoryArgs'> {
  factoryArgs?: unknown[];
}

export const SECURE_CHANNEL_MANAGER_FACTORY_BASE_TYPE =
  'SecureChannelManagerFactory';

export abstract class SecureChannelManagerFactory<
  C extends SecureChannelManagerConfig = SecureChannelManagerConfig,
> extends AbstractResourceFactory<SecureChannelManager, C> {
  public abstract create(
    config?: C | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<SecureChannelManager>;

  public static async createSecureChannelManager<
    C extends SecureChannelManagerConfig = SecureChannelManagerConfig,
  >(
    config?: C | Record<string, unknown> | null,
    options: CreateSecureChannelManagerOptions = {}
  ): Promise<SecureChannelManager | null> {
    await import('./noop-secure-channel-manager-factory.js');

    const { factoryArgs, ...rest } = options;
    const creationOptions: CreateResourceOptions = {
      ...rest,
      factoryArgs: factoryArgs ?? [],
    };

    if (config) {
      const instance = await createResource<SecureChannelManager>(
        SECURE_CHANNEL_MANAGER_FACTORY_BASE_TYPE,
        config,
        creationOptions
      );

      if (instance) {
        return instance;
      }

      return null;
    }

    return await createDefaultResource<SecureChannelManager>(
      SECURE_CHANNEL_MANAGER_FACTORY_BASE_TYPE,
      null,
      creationOptions
    );
  }
}
