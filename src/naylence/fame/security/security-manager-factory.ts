import {
  AbstractResourceFactory,
  createDefaultResource,
} from '@naylence/factory';

import type { SecurityManager } from './security-manager.js';
import type { SecurityManagerConfig } from './security-manager-config.js';
import type { SecurityPolicy } from './policy/security-policy.js';
import type { EnvelopeSigner } from './signing/envelope-signer.js';
import type { EnvelopeVerifier } from './signing/envelope-verifier.js';
import type { EncryptionManager } from './encryption/encryption-manager.js';
import type { KeyManager } from './keys/key-manager.js';
import type { AttachmentKeyValidator } from './keys/attachment-key-validator.js';
import type { Authorizer } from './auth/authorizer.js';
import type { CertificateManager } from './cert/certificate-manager.js';
import type { SecureChannelManager } from './encryption/secure-channel-manager.js';
import type { NodeEventListener } from '../node/node-event-listener.js';
import type { CryptoProvider } from './crypto/providers/crypto-provider.js';

export const SECURITY_MANAGER_FACTORY_BASE_TYPE = 'SecurityManagerFactory';

export interface SecurityManagerComponentOverrides {
  policy?: SecurityPolicy | null;
  envelopeSigner?: EnvelopeSigner | null;
  envelopeVerifier?: EnvelopeVerifier | null;
  encryptionManager?: EncryptionManager | null;
  keyManager?: KeyManager | null;
  keyValidator?: AttachmentKeyValidator | null;
  authorizer?: Authorizer | null;
  certificateManager?: CertificateManager | null;
  secureChannelManager?: SecureChannelManager | null;
  eventListeners?: NodeEventListener[] | null;
  cryptoProvider?: CryptoProvider | null;
}

export abstract class SecurityManagerFactory<
  C extends SecurityManagerConfig = SecurityManagerConfig,
> extends AbstractResourceFactory<SecurityManager, C> {
  public abstract create(
    config?: C | Record<string, unknown> | null,
    overrides?: SecurityManagerComponentOverrides | null
  ): Promise<SecurityManager>;

  public static async createSecurityManager(
    overrides: SecurityManagerComponentOverrides = {}
  ): Promise<SecurityManager> {
    const factoryArgs = [overrides];
    const instance = await createDefaultResource<SecurityManager>(
      SECURITY_MANAGER_FACTORY_BASE_TYPE,
      null,
      { factoryArgs }
    );

    if (!instance) {
      throw new Error('Failed to create default SecurityManager instance');
    }

    return instance;
  }
}
