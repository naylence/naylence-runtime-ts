import type { FameDeliveryContext, FameEnvelope } from '@naylence/core';

export interface RetryEventHandler {
  onRetryNeeded(
    envelope: FameEnvelope,
    attempt: number,
    nextDelayMs: number,
    context?: FameDeliveryContext
  ): Promise<void>;
}
