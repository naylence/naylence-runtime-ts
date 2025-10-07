import type { FameEnvelope } from 'naylence-core';

import type { DeliveryPolicyOptions } from './delivery-policy.js';
import { DeliveryPolicy } from './delivery-policy.js';

export type AtLeastOnceDeliveryPolicyOptions = DeliveryPolicyOptions;

/**
 * Message delivery policy that ensures envelopes are delivered at least once.
 */
export class AtLeastOnceDeliveryPolicy extends DeliveryPolicy {
  constructor(options: AtLeastOnceDeliveryPolicyOptions = {}) {
    super(options);
  }

  public override isAckRequired(envelope: FameEnvelope): boolean {
    const frame = envelope?.frame as { type?: string } | undefined;
    const frameType = typeof frame?.type === 'string' ? frame.type : null;

    if (!frameType) {
      return false;
    }

    return frameType === 'Data' || frameType === 'DataFrame';
  }
}
