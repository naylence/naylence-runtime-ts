import type { CreateResourceOptions, ResourceConfig } from '@naylence/factory';
import {
  AbstractResourceFactory,
  createDefaultResource,
  createResource,
} from '@naylence/factory';
import type { ConnectionRetryPolicy } from './connection-retry-policy.js';

export const CONNECTION_RETRY_POLICY_FACTORY_BASE_TYPE = 'ConnectionRetryPolicyFactory';

export interface ConnectionRetryPolicyConfig extends ResourceConfig {
  type: string;
  /**
   * Maximum number of connection attempts before giving up (before first successful attach).
   * - `1` (default): Fail immediately on first error
   * - `0`: Unlimited retries with exponential backoff
   * - `N > 1`: Retry up to N times with exponential backoff
   */
  maxInitialAttempts?: number | string;
  max_initial_attempts?: number | string;
  [key: string]: unknown;
}

export abstract class ConnectionRetryPolicyFactory<
  C extends ConnectionRetryPolicyConfig = ConnectionRetryPolicyConfig,
> extends AbstractResourceFactory<ConnectionRetryPolicy, C> {
  public abstract create(
    config?: C | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<ConnectionRetryPolicy>;

  public static async createConnectionRetryPolicy<
    C extends ConnectionRetryPolicyConfig = ConnectionRetryPolicyConfig,
  >(
    config?: C | Record<string, unknown> | null,
    options: CreateResourceOptions = {}
  ): Promise<ConnectionRetryPolicy> {
    if (config) {
      const policy = await createResource<ConnectionRetryPolicy>(
        CONNECTION_RETRY_POLICY_FACTORY_BASE_TYPE,
        config,
        options
      );

      if (!policy) {
        throw new Error('Failed to create connection retry policy from configuration');
      }

      return policy;
    }

    const policy = await createDefaultResource<ConnectionRetryPolicy>(
      CONNECTION_RETRY_POLICY_FACTORY_BASE_TYPE,
      null,
      options
    );

    if (!policy) {
      throw new Error('Failed to create default connection retry policy');
    }

    return policy;
  }
}
