import type { FameEnvelope } from 'naylence-core';

import type { RetryPolicy } from './retry-policy.js';

export interface DeliveryPolicyOptions {
  readonly senderRetryPolicy?: RetryPolicy;
  readonly receiverRetryPolicy?: RetryPolicy;
}

/**
 * Base abstraction for message delivery policies.
 */
export abstract class DeliveryPolicy {
  protected readonly senderPolicy: RetryPolicy | undefined;
  protected readonly receiverPolicy: RetryPolicy | undefined;

  protected constructor(options: DeliveryPolicyOptions = {}) {
    this.senderPolicy = options.senderRetryPolicy;
    this.receiverPolicy = options.receiverRetryPolicy;
  }

  /**
   * Determine if the policy requires an acknowledgement for the envelope.
   */
  public isAckRequired(_envelope: FameEnvelope): boolean {
    return false;
  }

  public get senderRetryPolicy(): RetryPolicy | undefined {
    return this.senderPolicy;
  }

  public get receiverRetryPolicy(): RetryPolicy | undefined {
    return this.receiverPolicy;
  }
}
