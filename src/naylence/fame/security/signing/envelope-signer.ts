import type { FameEnvelope } from 'naylence-core';

export interface EnvelopeSigner {
  signEnvelope(envelope: FameEnvelope, options: { physicalPath: string }): FameEnvelope;
}
