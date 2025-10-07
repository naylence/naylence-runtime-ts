import type { FameEnvelope } from 'naylence-core';
import {
  EncryptionResult,
  type EncryptionManager,
} from './encryption-manager.js';

export class NoopEncryptionManager implements EncryptionManager {
  public async encryptEnvelope(
    envelope: FameEnvelope
  ): Promise<EncryptionResult> {
    return EncryptionResult.skipped(envelope);
  }

  public async decryptEnvelope(envelope: FameEnvelope): Promise<FameEnvelope> {
    return envelope;
  }

  public async notifyChannelEstablished(): Promise<void> {
    // no-op
  }

  public async notifyChannelFailed(): Promise<void> {
    // no-op
  }
}
