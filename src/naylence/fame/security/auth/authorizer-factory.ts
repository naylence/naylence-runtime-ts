import type { CreateResourceOptions, ResourceConfig } from '@naylence/factory';
import {
  AbstractResourceFactory,
  createDefaultResource,
  createResource,
} from '@naylence/factory';
import type { Authorizer } from './authorizer.js';

export const AUTHORIZER_FACTORY_BASE_TYPE = 'AuthorizerFactory';

export interface AuthorizerConfig extends ResourceConfig {
  type: string;
  [key: string]: unknown;
}

export abstract class AuthorizerFactory<
  C extends AuthorizerConfig = AuthorizerConfig,
> extends AbstractResourceFactory<Authorizer, C> {
  public abstract create(
    config?: C | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<Authorizer>;

  public static async createAuthorizer<
    C extends AuthorizerConfig = AuthorizerConfig,
  >(
    config?: C | Record<string, unknown> | null,
    options: CreateResourceOptions = {}
  ): Promise<Authorizer | undefined> {
    if (config) {
      const authorizer = await createResource<Authorizer>(
        AUTHORIZER_FACTORY_BASE_TYPE,
        config,
        options
      );

      if (!authorizer) {
        throw new Error('Failed to create authorizer from configuration');
      }

      return authorizer;
    }

    const authorizer = await createDefaultResource<Authorizer>(
      AUTHORIZER_FACTORY_BASE_TYPE,
      null,
      options
    );

    return authorizer ?? undefined;
  }
}
