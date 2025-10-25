import type { FameEnvelope } from '@naylence/core';

import { DeliveryPolicy } from './delivery-policy.js';

/**
 * Message delivery policy that ensures envelopes are delivered at most once.
 */
export class AtMostOnceDeliveryPolicy extends DeliveryPolicy {
  constructor() {
    super();
  }

  public override isAckRequired(_envelope: FameEnvelope): boolean {
    return false;
  }
}
