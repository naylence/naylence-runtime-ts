import type { FameAddress, FameEnvelope } from '@naylence/core';

export const FIXED_PREFIX_LEN = 44; // 32-byte ephemeral public key + 12-byte nonce prefix

export interface EncryptionOptions {
  readonly recipPub?: Uint8Array;
  readonly recip_pub?: Uint8Array;
  readonly recipient_public_key?: Uint8Array;
  readonly recipientPublicKey?: Uint8Array;
  readonly privKey?: Uint8Array;
  readonly priv_key?: Uint8Array;
  readonly privateKey?: Uint8Array;
  readonly channelKey?: Uint8Array;
  readonly channel_key?: Uint8Array;
  readonly nonce?: Uint8Array;
  readonly recipKid?: string;
  readonly recip_kid?: string;
  readonly recipient_key_id?: string;
  readonly recipientKeyId?: string;
  readonly requestAddress?: FameAddress;
  readonly request_address?: FameAddress;
  readonly encryptionType?: 'standard' | 'channel' | string;
  readonly encryption_type?: 'standard' | 'channel' | string;
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

  constructor(
    public readonly status: EncryptionStatus,
    public readonly envelope?: FameEnvelope
  ) {}
}

export interface EncryptionManager {
  readonly nodeStaticPublicKey?: Uint8Array;

  encryptEnvelope(
    envelope: FameEnvelope,
    opts?: EncryptionOptions
  ): Promise<EncryptionResult>;

  decryptEnvelope(
    envelope: FameEnvelope,
    opts?: EncryptionOptions
  ): Promise<FameEnvelope>;

  notifyChannelEstablished?(channelId: string): Promise<void> | void;

  notifyChannelFailed?(
    channelId: string,
    reason?: string
  ): Promise<void> | void;
}
