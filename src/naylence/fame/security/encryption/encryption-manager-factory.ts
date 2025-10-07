import type { CreateResourceOptions, ResourceConfig } from 'naylence-factory';
import {
  AbstractResourceFactory,
  createDefaultResource,
  createResource,
} from 'naylence-factory';

import type { CryptoProvider } from '../crypto/providers/crypto-provider.js';
import type { KeyProvider } from '../keys/key-provider.js';
import type { SecureChannelManager } from './secure-channel-manager.js';
import type {
  EncryptionManager,
  EncryptionOptions,
} from './encryption-manager.js';

export interface EncryptionFactoryDependencies {
  readonly secureChannelManager?: SecureChannelManager | null;
  readonly cryptoProvider?: CryptoProvider | null;
  readonly keyProvider?: KeyProvider | null;
  readonly [key: string]: unknown;
}

export interface EncryptionManagerConfig extends ResourceConfig {
  type: string;
  supportedAlgorithms?: readonly string[] | null;
  encryptionType?: string | null;
  priority?: number | null;
  [key: string]: unknown;
}

export interface CreateEncryptionManagerOptions
  extends Omit<CreateResourceOptions, 'factoryArgs'> {
  factoryArgs?: unknown[];
  dependencies?: EncryptionFactoryDependencies;
}

export const ENCRYPTION_MANAGER_FACTORY_BASE_TYPE = 'EncryptionManagerFactory';

export abstract class EncryptionManagerFactory<
  C extends EncryptionManagerConfig = EncryptionManagerConfig,
> extends AbstractResourceFactory<EncryptionManager, C> {
  public abstract getSupportedAlgorithms(): readonly string[];

  public abstract getEncryptionType(): string;

  public abstract supportsOptions(opts?: EncryptionOptions | null): boolean;

  public getPriority(): number {
    return this.priority ?? 0;
  }

  public abstract create(
    config?: C | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<EncryptionManager>;

  public static async createEncryptionManager<
    C extends EncryptionManagerConfig = EncryptionManagerConfig,
  >(
    config?: C | Record<string, unknown> | null,
    options: CreateEncryptionManagerOptions = {}
  ): Promise<EncryptionManager | null> {
    // await import("./noop-encryption-manager-factory.js");

    const { dependencies, factoryArgs, ...restOptions } = options;
    const mergedFactoryArgs = [
      ...(dependencies ? [dependencies] : []),
      ...(factoryArgs ?? []),
    ];

    const creationOptions: CreateResourceOptions = {
      ...restOptions,
      factoryArgs: mergedFactoryArgs,
    };

    if (config) {
      const instance = await createResource<EncryptionManager>(
        ENCRYPTION_MANAGER_FACTORY_BASE_TYPE,
        config,
        creationOptions
      );

      if (instance) {
        return instance;
      }

      return null;
    }

    return await createDefaultResource<EncryptionManager>(
      ENCRYPTION_MANAGER_FACTORY_BASE_TYPE,
      null,
      creationOptions
    );
  }
}
