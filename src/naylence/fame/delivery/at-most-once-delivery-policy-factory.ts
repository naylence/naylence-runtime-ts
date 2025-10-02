import type { DeliveryPolicy } from "./delivery-policy.js";
import type { DeliveryPolicyConfig } from "./delivery-policy-config.js";
import {
  DELIVERY_POLICY_FACTORY_BASE_TYPE,
  DeliveryPolicyFactory,
  registerDeliveryPolicyFactory,
} from "./delivery-policy-factory.js";
import { AtMostOnceDeliveryPolicy } from "./at-most-once-delivery-policy.js";

export interface AtMostOnceDeliveryPolicyConfig extends DeliveryPolicyConfig {
  type: "AtMostOnceDeliveryPolicy" | "AtMostOnceMessageDeliveryPolicy";
}

export class AtMostOnceDeliveryPolicyFactory extends DeliveryPolicyFactory<AtMostOnceDeliveryPolicyConfig> {
  public readonly type = "AtMostOnceDeliveryPolicy";

  public async create(
    _config?: AtMostOnceDeliveryPolicyConfig | Record<string, unknown> | null
  ): Promise<DeliveryPolicy> {
    return new AtMostOnceDeliveryPolicy();
  }
}

registerDeliveryPolicyFactory("AtMostOnceDeliveryPolicy", AtMostOnceDeliveryPolicyFactory);
registerDeliveryPolicyFactory("AtMostOnceMessageDeliveryPolicy", AtMostOnceDeliveryPolicyFactory);

export const FACTORY_META = {
  base: DELIVERY_POLICY_FACTORY_BASE_TYPE,
  key: "AtMostOnceDeliveryPolicy",
} as const;

export default AtMostOnceDeliveryPolicyFactory;
