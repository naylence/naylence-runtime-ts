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

    // Check if any encryption-related options are present
    const hasEncryptionOptions =
      opts.recipPub !== undefined ||
      opts.recip_pub !== undefined ||
      opts.recipientPublicKey !== undefined ||
      opts.privKey !== undefined ||
      opts.priv_key !== undefined ||
      opts.privateKey !== undefined ||
      opts.channelKey !== undefined ||
      opts.channel_key !== undefined ||
      opts.recipKid !== undefined ||
      opts.recip_kid !== undefined ||
      opts.recipientKeyId !== undefined ||
      opts.requestAddress !== undefined ||
      (opts.encryptionType && opts.encryptionType !== 'none');

    return !hasEncryptionOptions;
  }

  public async create(): Promise<EncryptionManager> {
    return new NoopEncryptionManager();
  }
}

export default NoopEncryptionManagerFactory;
