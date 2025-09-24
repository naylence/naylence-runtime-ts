import type { FameEnvelope } from 'naylence-core';

export interface EnvelopeVerifier {
  verifyEnvelope(
    envelope: FameEnvelope,
    options?: {
      checkPayload?: boolean;
      logical?: string;
    }
  ): Promise<boolean>;
}
