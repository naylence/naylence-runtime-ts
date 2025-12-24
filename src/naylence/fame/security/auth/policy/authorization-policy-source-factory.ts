import type { CreateResourceOptions, ResourceConfig } from '@naylence/factory';
import {
  AbstractResourceFactory,
  createDefaultResource,
  createResource,
} from '@naylence/factory';
import type { AuthorizationPolicySource } from './authorization-policy-source.js';

/**
 * Base type identifier for authorization policy source factories.
 */
export const AUTHORIZATION_POLICY_SOURCE_FACTORY_BASE_TYPE =
  'AuthorizationPolicySourceFactory';

/**
 * Configuration for creating an authorization policy source.
 */
export interface AuthorizationPolicySourceConfig extends ResourceConfig {
  type: string;
  [key: string]: unknown;
}

/**
 * Abstract factory base class for creating authorization policy sources.
 *
 * Implementations of this factory create specific types of policy sources
 * (e.g., local file, remote store, in-memory, etc.).
 */
export abstract class AuthorizationPolicySourceFactory<
  C extends AuthorizationPolicySourceConfig = AuthorizationPolicySourceConfig,
> extends AbstractResourceFactory<AuthorizationPolicySource, C> {
  /**
   * Creates an authorization policy source from the given configuration.
   *
   * @param config - Configuration for the policy source
   * @param factoryArgs - Additional factory arguments
   * @returns The created authorization policy source
   */
  public abstract create(
    config?: C | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<AuthorizationPolicySource>;

  /**
   * Static helper to create an authorization policy source using the factory registry.
   *
   * @param config - Configuration for the policy source
   * @param options - Resource creation options
   * @returns The created policy source, or undefined if no factory matched
   */
  public static async createAuthorizationPolicySource<
    C extends AuthorizationPolicySourceConfig = AuthorizationPolicySourceConfig,
  >(
    config?: C | Record<string, unknown> | null,
    options: CreateResourceOptions = {}
  ): Promise<AuthorizationPolicySource | undefined> {
    if (config) {
      const source = await createResource<AuthorizationPolicySource>(
        AUTHORIZATION_POLICY_SOURCE_FACTORY_BASE_TYPE,
        config,
        options
      );

      if (!source) {
        throw new Error(
          'Failed to create authorization policy source from configuration'
        );
      }

      return source;
    }

    const source = await createDefaultResource<AuthorizationPolicySource>(
      AUTHORIZATION_POLICY_SOURCE_FACTORY_BASE_TYPE,
      null,
      options
    );

    return source ?? undefined;
  }
}
