import type {
  EncryptionManager,
  EncryptionOptions,
} from './encryption-manager.js';
import {
  ENCRYPTION_MANAGER_FACTORY_BASE_TYPE,
  EncryptionManagerFactory,
  type EncryptionManagerConfig,
} from './encryption-manager-factory.js';
import { NoopEncryptionManager } from './noop-encryption-manager.js';

export interface NoopEncryptionManagerConfig extends EncryptionManagerConfig {
  type: 'NoopEncryptionManager';
}

export const FACTORY_META = {
  base: ENCRYPTION_MANAGER_FACTORY_BASE_TYPE,
  key: 'NoopEncryptionManager',
} as const;

export class NoopEncryptionManagerFactory extends EncryptionManagerFactory<NoopEncryptionManagerConfig> {
  public readonly type = 'NoopEncryptionManager';
  public readonly isDefault = true;

  public getSupportedAlgorithms(): readonly string[] {
    return [];
  }

  public getEncryptionType(): string {
    return 'none';
  }

  public supportsOptions(opts?: EncryptionOptions | null): boolean {
    // NoopEncryptionManager only supports when no encryption is needed
    // (i.e., no options or empty options object)
    if (!opts) {
      return true;
    }

    const aliases = opts as Record<string, unknown>;

    const encryptionType = (opts.encryptionType ?? aliases.encryption_type) as
      | string
      | undefined;
    const normalizedEncryptionType =
      typeof encryptionType === 'string'
        ? encryptionType.toLowerCase()
        : undefined;

    const recipientKeyId =
      opts.recipientKeyId ?? (aliases.recipient_key_id as string | undefined);
    const recipientPublicKey =
      opts.recipientPublicKey ??
      (aliases.recipient_public_key as Uint8Array | undefined);
    const requestAddress =
      opts.requestAddress ??
      (aliases.request_address as EncryptionOptions['requestAddress']);

    // Check if any encryption-related options are present
    const hasEncryptionOptions =
      opts.recipPub !== undefined ||
      opts.recip_pub !== undefined ||
      recipientPublicKey !== undefined ||
      opts.privKey !== undefined ||
      opts.priv_key !== undefined ||
      opts.privateKey !== undefined ||
      opts.channelKey !== undefined ||
      opts.channel_key !== undefined ||
      opts.nonce !== undefined ||
      opts.recipKid !== undefined ||
      opts.recip_kid !== undefined ||
      recipientKeyId !== undefined ||
      requestAddress !== undefined ||
      (normalizedEncryptionType !== undefined &&
        normalizedEncryptionType !== 'none');

    return !hasEncryptionOptions;
  }

  public async create(): Promise<EncryptionManager> {
    return new NoopEncryptionManager();
  }
}

export default NoopEncryptionManagerFactory;
