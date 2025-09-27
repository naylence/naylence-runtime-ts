import type { DeliveryPolicy } from './delivery-policy.js';
import type { DeliveryPolicyConfig } from './delivery-policy-config.js';
import { DeliveryPolicyFactory, registerDeliveryPolicyFactory } from './delivery-policy-factory.js';
import { AtMostOnceDeliveryPolicy } from './at-most-once-delivery-policy.js';

export interface AtMostOnceDeliveryPolicyConfig extends DeliveryPolicyConfig {
  type: 'AtMostOnceDeliveryPolicy' | 'AtMostOnceMessageDeliveryPolicy';
}

export class AtMostOnceDeliveryPolicyFactory extends DeliveryPolicyFactory<AtMostOnceDeliveryPolicyConfig> {
  public readonly type = 'AtMostOnceDeliveryPolicy';

  public async create(
    _config?: AtMostOnceDeliveryPolicyConfig | Record<string, unknown> | null
  ): Promise<DeliveryPolicy> {
    return new AtMostOnceDeliveryPolicy();
  }
}

registerDeliveryPolicyFactory('AtMostOnceDeliveryPolicy', AtMostOnceDeliveryPolicyFactory);
registerDeliveryPolicyFactory(
  'AtMostOnceMessageDeliveryPolicy',
  AtMostOnceDeliveryPolicyFactory
);
