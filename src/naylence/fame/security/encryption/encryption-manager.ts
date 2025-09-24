import type { FameAddress, FameEnvelope } from 'naylence-core';

export interface EncryptionOptions {
  readonly recipientPublicKey?: Uint8Array;
  readonly privateKey?: Uint8Array;
  readonly channelKey?: Uint8Array;
  readonly nonce?: Uint8Array;
  readonly recipientKeyId?: string;
  readonly requestAddress?: FameAddress;
  readonly encryptionType?: 'standard' | 'channel' | string;
  readonly destination?: FameAddress;
  readonly [key: string]: unknown;
}

export enum EncryptionStatus {
  OK = 'OK',
  SKIPPED = 'SKIPPED',
  QUEUED = 'QUEUED',
}

export class EncryptionResult {
  public static ok(envelope: FameEnvelope): EncryptionResult {
    return new EncryptionResult(EncryptionStatus.OK, envelope);
  }

  public static skipped(envelope: FameEnvelope): EncryptionResult {
    return new EncryptionResult(EncryptionStatus.SKIPPED, envelope);
  }

  public static queued(): EncryptionResult {
    return new EncryptionResult(EncryptionStatus.QUEUED, undefined);
  }

  constructor(public readonly status: EncryptionStatus, public readonly envelope?: FameEnvelope) {}
}

export interface EncryptionManager {
  encryptEnvelope(envelope: FameEnvelope, opts?: EncryptionOptions): Promise<EncryptionResult>;

  decryptEnvelope(envelope: FameEnvelope, opts?: EncryptionOptions): Promise<FameEnvelope>;

  notifyChannelEstablished?(channelId: string): Promise<void> | void;

  notifyChannelFailed?(channelId: string, reason?: string): Promise<void> | void;
}
