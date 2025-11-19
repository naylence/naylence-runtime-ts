import type { CreateResourceOptions, ResourceConfig } from "@naylence/factory";
import {
  AbstractResourceFactory,
  createDefaultResource,
  createResource,
} from "@naylence/factory";

import type { TrustAnchor, TrustStoreProvider } from "./trust-store-provider.js";

export interface TrustStoreProviderConfig extends ResourceConfig {
  readonly type: string;
}

export interface TrustStoreProviderDependencies {
  readonly env?: Record<string, unknown> | null;
  readonly [key: string]: unknown;
}

export interface CreateTrustStoreProviderOptions
  extends Omit<CreateResourceOptions, "factoryArgs"> {
  readonly factoryArgs?: unknown[];
  readonly dependencies?: TrustStoreProviderDependencies;
}

const DEFAULT_UNCONFIGURED_MESSAGE =
  "Trust store is not configured. Set FAME_CA_CERTS to a PEM value, a file path, a data URI, or an HTTPS bundle URL.";

export const TRUST_STORE_PROVIDER_FACTORY_BASE_TYPE = "TrustStoreProviderFactory";

export abstract class TrustStoreProviderFactory<
  C extends TrustStoreProviderConfig = TrustStoreProviderConfig,
> extends AbstractResourceFactory<TrustStoreProvider, C> {
  public abstract create(
    config?: C | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<TrustStoreProvider>;

  protected createUnconfiguredProvider(reason?: string): TrustStoreProvider {
    return new NoopTrustStoreProvider(reason ?? DEFAULT_UNCONFIGURED_MESSAGE);
  }

  public static async createTrustStoreProvider<
    C extends TrustStoreProviderConfig = TrustStoreProviderConfig,
  >(
    config?: C | Record<string, unknown> | null,
    options: CreateTrustStoreProviderOptions = {},
  ): Promise<TrustStoreProvider> {
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
      const instance = await createResource<TrustStoreProvider>(
        TRUST_STORE_PROVIDER_FACTORY_BASE_TYPE,
        config,
        creationOptions,
      );
      return instance ?? new NoopTrustStoreProvider();
    }

    const instance = await createDefaultResource<TrustStoreProvider>(
      TRUST_STORE_PROVIDER_FACTORY_BASE_TYPE,
      null,
      creationOptions,
    );

    return instance ?? new NoopTrustStoreProvider();
  }
}

export class NoopTrustStoreProvider implements TrustStoreProvider {
  private readonly reason: string;

  public constructor(reason: string = DEFAULT_UNCONFIGURED_MESSAGE) {
    this.reason = reason;
  }

  public async getTrustStorePem(): Promise<string> {
    throw new Error(this.reason);
  }

  public async getRoots(): Promise<readonly TrustAnchor[]> {
    return [];
  }

  public async initialize(): Promise<void> {
    // No-op for the placeholder provider.
  }
}
