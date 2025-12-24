import type { CreateResourceOptions, ResourceConfig } from '@naylence/factory';
import {
  AbstractResourceFactory,
  createDefaultResource,
  createResource,
} from '@naylence/factory';
import type { AuthorizationPolicy } from './authorization-policy.js';

/**
 * Base type identifier for authorization policy factories.
 */
export const AUTHORIZATION_POLICY_FACTORY_BASE_TYPE =
  'AuthorizationPolicyFactory';

/**
 * Configuration for creating an authorization policy.
 */
export interface AuthorizationPolicyConfig extends ResourceConfig {
  type: string;
  [key: string]: unknown;
}

/**
 * Abstract factory base class for creating authorization policies.
 *
 * Implementations of this factory create specific types of authorization
 * policies (e.g., expression-based, rule-based, etc.).
 */
export abstract class AuthorizationPolicyFactory<
  C extends AuthorizationPolicyConfig = AuthorizationPolicyConfig,
> extends AbstractResourceFactory<AuthorizationPolicy, C> {
  /**
   * Creates an authorization policy from the given configuration.
   *
   * @param config - Configuration for the policy
   * @param factoryArgs - Additional factory arguments
   * @returns The created authorization policy
   */
  public abstract create(
    config?: C | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<AuthorizationPolicy>;

  /**
   * Static helper to create an authorization policy using the factory registry.
   *
   * @param config - Configuration for the policy
   * @param options - Resource creation options
   * @returns The created policy, or undefined if no factory matched
   */
  public static async createAuthorizationPolicy<
    C extends AuthorizationPolicyConfig = AuthorizationPolicyConfig,
  >(
    config?: C | Record<string, unknown> | null,
    options: CreateResourceOptions = {}
  ): Promise<AuthorizationPolicy | undefined> {
    if (config) {
      const policy = await createResource<AuthorizationPolicy>(
        AUTHORIZATION_POLICY_FACTORY_BASE_TYPE,
        config,
        options
      );

      if (!policy) {
        throw new Error(
          'Failed to create authorization policy from configuration'
        );
      }

      return policy;
    }

    const policy = await createDefaultResource<AuthorizationPolicy>(
      AUTHORIZATION_POLICY_FACTORY_BASE_TYPE,
      null,
      options
    );

    return policy ?? undefined;
  }
}
