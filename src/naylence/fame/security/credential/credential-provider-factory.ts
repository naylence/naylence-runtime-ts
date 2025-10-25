import type { CreateResourceOptions, ResourceConfig } from '@naylence/factory';
import {
  AbstractResourceFactory,
  createDefaultResource,
  createResource,
} from '@naylence/factory';

import type { CredentialProvider } from './credential-provider.js';

export const CREDENTIAL_PROVIDER_FACTORY_BASE_TYPE =
  'CredentialProviderFactory';

export interface CredentialProviderConfig extends ResourceConfig {
  type: string;
  [key: string]: unknown;
}

export abstract class CredentialProviderFactory<
  C extends CredentialProviderConfig = CredentialProviderConfig,
> extends AbstractResourceFactory<CredentialProvider, C> {
  public abstract create(
    config?: C | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<CredentialProvider>;

  public static async createCredentialProvider<
    C extends CredentialProviderConfig = CredentialProviderConfig,
  >(
    config?: C | Record<string, unknown> | null,
    options: CreateResourceOptions = {}
  ): Promise<CredentialProvider> {
    const instance = config
      ? await createResource<CredentialProvider>(
          CREDENTIAL_PROVIDER_FACTORY_BASE_TYPE,
          config,
          options
        )
      : await createDefaultResource<CredentialProvider>(
          CREDENTIAL_PROVIDER_FACTORY_BASE_TYPE,
          null,
          options
        );

    if (!instance) {
      throw new Error(
        'Failed to create credential provider from configuration'
      );
    }

    return instance;
  }
}
