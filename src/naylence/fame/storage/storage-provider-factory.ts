import type { CreateResourceOptions, ResourceConfig } from "naylence-factory";
import {
  AbstractResourceFactory,
  createDefaultResource,
  createResource,
  registerFactory,
} from "naylence-factory";

import type { StorageProvider } from "./storage-provider.js";

export const STORAGE_PROVIDER_FACTORY_BASE_TYPE = "StorageProviderFactory";

export interface StorageProviderConfig extends ResourceConfig {
  /**
   * Optional backend-specific parameters. Retained for compatibility with Python implementation.
   */
  params?: Record<string, unknown> | null;
}

export abstract class StorageProviderFactory<
  C extends StorageProviderConfig = StorageProviderConfig,
> extends AbstractResourceFactory<StorageProvider, C> {
  public abstract create(
    config?: C | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<StorageProvider>;

  public static async createStorageProvider(
    config?: StorageProviderConfig | Record<string, unknown> | null,
    options: CreateResourceOptions = {}
  ): Promise<StorageProvider> {
    const instance = config
      ? await createResource<StorageProvider>(STORAGE_PROVIDER_FACTORY_BASE_TYPE, config, options)
      : await createDefaultResource<StorageProvider>(
          STORAGE_PROVIDER_FACTORY_BASE_TYPE,
          null,
          options
        );

    if (!instance) {
      throw new Error("Failed to create storage provider from configuration");
    }

    return instance;
  }
}

export function registerStorageProviderFactory(
  type: string,
  factory: new (...args: unknown[]) => StorageProviderFactory
): void {
  registerFactory(STORAGE_PROVIDER_FACTORY_BASE_TYPE, type, factory);
}
