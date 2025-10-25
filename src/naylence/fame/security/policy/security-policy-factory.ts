import type { CreateResourceOptions } from '@naylence/factory';
import {
  AbstractResourceFactory,
  createDefaultResource,
  createResource,
} from '@naylence/factory';

import type { SecurityPolicy } from './security-policy.js';
import type { SecurityPolicyConfig } from './security-policy.js';

export const SECURITY_POLICY_FACTORY_BASE_TYPE = 'SecurityPolicyFactory';

export abstract class SecurityPolicyFactory<
  C extends SecurityPolicyConfig = SecurityPolicyConfig,
> extends AbstractResourceFactory<SecurityPolicy, C> {
  public abstract create(
    config?: C | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<SecurityPolicy>;

  public static async createSecurityPolicy<
    C extends SecurityPolicyConfig = SecurityPolicyConfig,
  >(
    config?: C | Record<string, unknown> | null,
    options: CreateResourceOptions = {}
  ): Promise<SecurityPolicy | null> {
    if (config) {
      return (
        (await createResource<SecurityPolicy>(
          SECURITY_POLICY_FACTORY_BASE_TYPE,
          config,
          options
        )) ?? null
      );
    }

    return (
      (await createDefaultResource<SecurityPolicy>(
        SECURITY_POLICY_FACTORY_BASE_TYPE,
        null,
        options
      )) ?? null
    );
  }
}
