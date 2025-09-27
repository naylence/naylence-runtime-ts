import type { CreateResourceOptions } from 'naylence-factory';
import {
  AbstractResourceFactory,
  createDefaultResource,
  createResource,
  registerFactory,
} from 'naylence-factory';

import type { DeliveryPolicy } from './delivery-policy.js';
import type { DeliveryPolicyConfig } from './delivery-policy-config.js';

export const DELIVERY_POLICY_FACTORY_BASE_TYPE = 'DeliveryPolicyFactory';

export abstract class DeliveryPolicyFactory<
  C extends DeliveryPolicyConfig = DeliveryPolicyConfig
> extends AbstractResourceFactory<DeliveryPolicy, C> {
  public abstract create(
    config?: C | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<DeliveryPolicy>;

  public static async createDeliveryPolicy(
    config?: DeliveryPolicyConfig | Record<string, unknown> | null,
    options: CreateResourceOptions = {}
  ): Promise<DeliveryPolicy | null> {
    if (config) {
      const policy = await createResource<DeliveryPolicy>(
        DELIVERY_POLICY_FACTORY_BASE_TYPE,
        config,
        options
      );

      if (policy) {
        return policy;
      }
    }

    const defaultPolicy = await createDefaultResource<DeliveryPolicy>(
      DELIVERY_POLICY_FACTORY_BASE_TYPE,
      null,
      options
    );

    return defaultPolicy ?? null;
  }
}

export function registerDeliveryPolicyFactory(
  type: string,
  factory: new (...args: unknown[]) => DeliveryPolicyFactory
): void {
  registerFactory(DELIVERY_POLICY_FACTORY_BASE_TYPE, type, factory);
}
