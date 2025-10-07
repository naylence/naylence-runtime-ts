import type { CreateResourceOptions } from 'naylence-factory';
import type { Authorizer } from './auth/authorizer.js';
import { AuthorizerFactory } from './auth/authorizer-factory.js';
import { NoopTokenVerifier } from './auth/noop-token-verifier.js';
import type { CertificateManager } from './cert/certificate-manager.js';
import { CertificateManagerFactory } from './cert/certificate-manager-factory.js';
import type { EncryptionManager } from './encryption/encryption-manager.js';
import { EncryptionManagerFactory } from './encryption/encryption-manager-factory.js';
import type { SecureChannelManager } from './encryption/secure-channel-manager.js';
import { SecureChannelManagerFactory } from './encryption/secure-channel-manager-factory.js';
import type { AttachmentKeyValidator } from './keys/attachment-key-validator.js';
import type { KeyManager } from './keys/key-manager.js';
import type { KeyStore } from './keys/key-store.js';
import { getKeyStore } from './keys/key-store.js';
import { KeyManagerFactory } from './keys/key-manager-factory.js';
import type { DefaultKeyManagerConfig } from './keys/default-key-manager-factory.js';
import type { SecurityPolicy } from './policy/security-policy.js';
import { SecurityPolicyFactory } from './policy/security-policy-factory.js';
import type { EnvelopeSigner } from './signing/envelope-signer.js';
import { EnvelopeSignerFactory } from './signing/envelope-signer.js';
import type { EnvelopeVerifier } from './signing/envelope-verifier.js';
import { EnvelopeVerifierFactory } from './signing/envelope-verifier.js';
import type { SigningConfig } from './signing/signing-config.js';
import { DefaultSecurityManager } from './default-security-manager.js';
import type { SecurityManager } from './security-manager.js';
import {
  SecurityManagerFactory,
  SECURITY_MANAGER_FACTORY_BASE_TYPE,
  type SecurityManagerComponentOverrides,
} from './security-manager-factory.js';
import type { SecurityManagerConfig } from './security-manager-config.js';
import type { NodeEventListener } from '../node/node-event-listener.js';
import { getLogger } from '../util/logging.js';
import type { CryptoProvider } from './crypto/providers/crypto-provider.js';

const logger = getLogger('default-security-manager-factory');

export interface DefaultSecurityManagerConfig extends SecurityManagerConfig {
  type: 'DefaultSecurityManager';
  policy?: SecurityPolicy | Record<string, unknown> | null;
  security_policy?: Record<string, unknown> | null;
  envelopeSigner?: EnvelopeSigner | Record<string, unknown> | null;
  envelope_signer?: Record<string, unknown> | null;
  envelopeVerifier?: EnvelopeVerifier | Record<string, unknown> | null;
  envelope_verifier?: Record<string, unknown> | null;
  encryption?: EncryptionManager | Record<string, unknown> | null;
  encryption_manager?: Record<string, unknown> | null;
  authorizer?: Authorizer | Record<string, unknown> | null;
  certificate_manager?: CertificateManager | Record<string, unknown> | null;
  secure_channel_manager?:
    | SecureChannelManager
    | Record<string, unknown>
    | null;
  key_store?: KeyStore | null;
  keyStore?: KeyStore | null;
  key_manager?: KeyManager | Record<string, unknown> | null;
  keyManager?: KeyManager | Record<string, unknown> | null;
  key_manager_config?: Record<string, unknown> | null;
  key_validator?: AttachmentKeyValidator | null;
  eventListeners?: NodeEventListener[] | null;
  event_listeners?: NodeEventListener[] | null;
  cryptoProvider?: CryptoProvider | null;
  crypto_provider?: CryptoProvider | null;
  [key: string]: unknown;
}

interface ResolvedComponents {
  policy: SecurityPolicy | null;
  envelopeSigner: EnvelopeSigner | null;
  envelopeVerifier: EnvelopeVerifier | null;
  encryptionManager: EncryptionManager | null;
  keyStore: KeyStore | null;
  keyManager: KeyManager | null;
  keyValidator: AttachmentKeyValidator | null;
  authorizer: Authorizer | null;
  certificateManager: CertificateManager | null;
  secureChannelManager: SecureChannelManager | null;
  eventListeners: NodeEventListener[] | null;
  cryptoProvider: CryptoProvider | null;
}

interface BuildSecurityManagerOptions extends ResolvedComponents {
  config: Record<string, unknown>;
  createOptions?: CreateResourceOptions | null;
}

export const FACTORY_META = {
  base: SECURITY_MANAGER_FACTORY_BASE_TYPE,
  key: 'DefaultSecurityManager',
} as const;

export class DefaultSecurityManagerFactory extends SecurityManagerFactory<DefaultSecurityManagerConfig> {
  public readonly type = 'DefaultSecurityManager';
  public readonly isDefault = true;

  public async create(
    config?: DefaultSecurityManagerConfig | Record<string, unknown> | null,
    overrides?: SecurityManagerComponentOverrides | null,
    createOptions: CreateResourceOptions | null = null
  ): Promise<SecurityManager> {
    const mergedConfig = this.mergeConfigWithOverrides(config, overrides);
    const resolved = this.resolveComponents(mergedConfig, overrides);

    return await DefaultSecurityManagerFactory.buildSecurityManager({
      config: mergedConfig,
      createOptions,
      ...resolved,
    });
  }

  private mergeConfigWithOverrides(
    config?: DefaultSecurityManagerConfig | Record<string, unknown> | null,
    overrides?: SecurityManagerComponentOverrides | null
  ): Record<string, unknown> {
    const base: Record<string, unknown> = config
      ? { ...(config as Record<string, unknown>) }
      : {};
    base.type = 'DefaultSecurityManager';

    if (overrides) {
      for (const [key, value] of Object.entries(overrides)) {
        if (value !== undefined) {
          base[key] = value as unknown;
        }
      }
    }

    return base;
  }

  private resolveComponents(
    config: Record<string, unknown>,
    overrides?: SecurityManagerComponentOverrides | null
  ): ResolvedComponents {
    const policy =
      DefaultSecurityManagerFactory.extractInstance<SecurityPolicy>(
        config,
        'policy'
      );
    const envelopeSigner =
      DefaultSecurityManagerFactory.extractInstance<EnvelopeSigner>(
        config,
        'envelopeSigner',
        'envelope_signer'
      );
    const envelopeVerifier =
      DefaultSecurityManagerFactory.extractInstance<EnvelopeVerifier>(
        config,
        'envelopeVerifier',
        'envelope_verifier'
      );
    const encryptionManager =
      DefaultSecurityManagerFactory.extractInstance<EncryptionManager>(
        config,
        'encryption',
        'encryption_manager'
      );
    const keyStore = DefaultSecurityManagerFactory.extractInstance<KeyStore>(
      config,
      'keyStore',
      'key_store'
    );
    const keyManager =
      DefaultSecurityManagerFactory.extractInstance<KeyManager>(
        config,
        'keyManager',
        'key_manager'
      );
    const keyValidator =
      DefaultSecurityManagerFactory.extractInstance<AttachmentKeyValidator>(
        config,
        'keyValidator',
        'key_validator'
      );
    const authorizer =
      DefaultSecurityManagerFactory.extractInstance<Authorizer>(
        config,
        'authorizer'
      );
    const certificateManager =
      DefaultSecurityManagerFactory.extractInstance<CertificateManager>(
        config,
        'certificateManager',
        'certificate_manager'
      );
    const secureChannelManager =
      DefaultSecurityManagerFactory.extractInstance<SecureChannelManager>(
        config,
        'secureChannelManager',
        'secure_channel_manager'
      );
    const cryptoProvider =
      DefaultSecurityManagerFactory.extractInstance<CryptoProvider>(
        config,
        'cryptoProvider',
        'crypto_provider'
      );

    const listenersSource =
      overrides?.eventListeners ??
      config.eventListeners ??
      config.event_listeners;
    const eventListeners = Array.isArray(listenersSource)
      ? listenersSource
      : null;

    return {
      policy,
      envelopeSigner,
      envelopeVerifier,
      encryptionManager,
      keyStore,
      keyManager,
      keyValidator: keyValidator ?? null,
      authorizer,
      certificateManager,
      secureChannelManager,
      eventListeners,
      cryptoProvider: cryptoProvider ?? null,
    };
  }

  private static async buildSecurityManager(
    options: BuildSecurityManagerOptions
  ): Promise<SecurityManager> {
    let {
      config,
      createOptions,
      policy,
      envelopeSigner,
      envelopeVerifier,
      encryptionManager,
      keyStore,
      keyManager,
      keyValidator,
      authorizer,
      certificateManager,
      secureChannelManager,
      eventListeners,
      cryptoProvider,
    } = options;

    if (!keyStore) {
      keyStore =
        DefaultSecurityManagerFactory.getKeyStoreFromConfig(config) ??
        getKeyStore();
    }

    if (!policy) {
      policy = await DefaultSecurityManagerFactory.createPolicyFromConfig(
        config,
        keyManager ?? keyStore,
        createOptions ?? null
      );
    }

    if (!policy) {
      throw new Error(
        'DefaultSecurityManagerFactory could not resolve a SecurityPolicy'
      );
    }

    if (!keyManager) {
      keyManager =
        await DefaultSecurityManagerFactory.createKeyManagerFromConfig(
          config,
          policy,
          keyStore
        );
    }

    if (!envelopeSigner) {
      envelopeSigner =
        await DefaultSecurityManagerFactory.createEnvelopeSignerFromConfig(
          config,
          policy,
          cryptoProvider ?? null
        );
    }

    if (!envelopeVerifier) {
      envelopeVerifier =
        await DefaultSecurityManagerFactory.createEnvelopeVerifierFromConfig(
          config,
          policy,
          keyManager
        );
    }

    if (!encryptionManager || !secureChannelManager) {
      const encryptionResult =
        await DefaultSecurityManagerFactory.createEncryptionManagerFromConfig(
          config,
          policy,
          keyManager,
          secureChannelManager,
          cryptoProvider ?? null
        );
      encryptionManager =
        encryptionManager ?? encryptionResult.encryptionManager;
      secureChannelManager =
        encryptionResult.secureChannelManager ?? secureChannelManager;
    }

    if (!authorizer) {
      authorizer =
        await DefaultSecurityManagerFactory.createAuthorizerFromConfig(
          config,
          policy
        );
    }

    if (
      authorizer &&
      eventListeners &&
      DefaultSecurityManagerFactory.isNodeEventListener(authorizer)
    ) {
      eventListeners.push(authorizer);
    }

    if (!certificateManager) {
      certificateManager =
        await DefaultSecurityManagerFactory.createCertificateManagerFromConfig(
          config,
          policy
        );
    }

    return new DefaultSecurityManager(
      policy,
      envelopeSigner,
      envelopeVerifier,
      encryptionManager,
      keyManager,
      authorizer,
      certificateManager,
      secureChannelManager,
      keyValidator ?? null
    );
  }

  private static getKeyStoreFromConfig(
    config: Record<string, unknown>
  ): KeyStore | null {
    const value = config.keyStore ?? config.key_store;
    return value && !DefaultSecurityManagerFactory.isConfigLike(value)
      ? (value as KeyStore)
      : null;
  }

  private static async createPolicyFromConfig(
    config: Record<string, unknown>,
    keyProvider: KeyManager | KeyStore | null,
    createOptions: CreateResourceOptions | null
  ): Promise<SecurityPolicy | null> {
    const policyConfig = config.security_policy ?? null;
    const factoryArgs = keyProvider ? [keyProvider] : [];
    const options = DefaultSecurityManagerFactory.mergeCreateOptions(
      factoryArgs,
      createOptions
    );

    if (
      policyConfig &&
      DefaultSecurityManagerFactory.isConfigLike(policyConfig)
    ) {
      return await SecurityPolicyFactory.createSecurityPolicy(
        policyConfig as Record<string, unknown>,
        options
      );
    }

    return await SecurityPolicyFactory.createSecurityPolicy(null, options);
  }

  private static async createEnvelopeSignerFromConfig(
    config: Record<string, unknown>,
    policy: SecurityPolicy,
    cryptoProviderOverride: CryptoProvider | null
  ): Promise<EnvelopeSigner | null> {
    const signerConfig =
      config.envelope_signer ?? config.envelopeSigner ?? null;
    if (
      signerConfig &&
      DefaultSecurityManagerFactory.isConfigLike(signerConfig)
    ) {
      return await EnvelopeSignerFactory.createEnvelopeSigner(
        signerConfig as Record<string, unknown>
      );
    }

    try {
      const requirements = policy.requirements?.();
      let shouldCreate = false;
      if (requirements) {
        shouldCreate = Boolean(
          requirements.signingRequired || requirements.verificationRequired
        );
      } else {
        const signing = (policy as { signing?: SigningConfig | null }).signing;
        shouldCreate = Boolean(signing);
      }

      if (!shouldCreate) {
        return null;
      }

      const cryptoProvider = cryptoProviderOverride ?? null;
      logger.debug('auto_create_envelope_signer', {
        has_crypto_override: Boolean(cryptoProviderOverride),
        override_constructor: cryptoProviderOverride
          ? (cryptoProviderOverride.constructor?.name ?? 'unknown')
          : null,
        has_private_key: Boolean(
          cryptoProvider &&
            (typeof (cryptoProvider as { signingPrivatePem?: unknown })
              .signingPrivatePem === 'string' ||
              typeof (cryptoProvider as { signing_private_pem?: unknown })
                .signing_private_pem === 'string')
        ),
      });
      const signing =
        (policy as { signing?: SigningConfig | null }).signing ?? null;

      const signerOptions = {
        cryptoProvider: cryptoProvider ?? null,
        signingConfig: signing ?? null,
      };
      return await EnvelopeSignerFactory.createEnvelopeSigner(null, {
        factoryArgs: [signerOptions],
      });
    } catch (error) {
      logger.error('failed_to_auto_create_envelope_signer', {
        error: error instanceof Error ? error.message : String(error),
        exc_info: true,
      });
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  private static async createEnvelopeVerifierFromConfig(
    config: Record<string, unknown>,
    policy: SecurityPolicy,
    keyManager: KeyManager | null
  ): Promise<EnvelopeVerifier | null> {
    const verifierConfig =
      config.envelope_verifier ?? config.envelopeVerifier ?? null;
    if (
      verifierConfig &&
      DefaultSecurityManagerFactory.isConfigLike(verifierConfig)
    ) {
      return await EnvelopeVerifierFactory.createEnvelopeVerifier(
        verifierConfig as Record<string, unknown>
      );
    }

    try {
      const requirements = policy.requirements?.();
      let shouldCreate = false;
      if (requirements) {
        shouldCreate = Boolean(requirements.verificationRequired);
      } else {
        const signing = (policy as { signing?: SigningConfig | null }).signing;
        shouldCreate = Boolean(signing);
      }

      if (!shouldCreate) {
        return null;
      }

      if (!keyManager) {
        throw new Error('EnvelopeVerifier requires a KeyManager instance');
      }

      const signing =
        (policy as { signing?: SigningConfig | null }).signing ?? null;

      return await EnvelopeVerifierFactory.createEnvelopeVerifier(null, {
        factoryArgs: [keyManager, signing ?? null],
      });
    } catch (error) {
      logger.error('failed_to_auto_create_envelope_verifier', {
        error: error instanceof Error ? error.message : String(error),
        exc_info: true,
      });
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  private static async createEncryptionManagerFromConfig(
    config: Record<string, unknown>,
    policy: SecurityPolicy,
    keyManager: KeyManager | null,
    secureChannelManager: SecureChannelManager | null,
    cryptoProviderOverride: CryptoProvider | null
  ): Promise<{
    encryptionManager: EncryptionManager | null;
    secureChannelManager: SecureChannelManager | null;
  }> {
    const encryptionConfig =
      config.encryption_manager ?? config.encryption ?? null;
    if (
      encryptionConfig &&
      DefaultSecurityManagerFactory.isConfigLike(encryptionConfig)
    ) {
      if (!keyManager) {
        logger.warning('encryption_manager_config_requires_key_manager');
        return { encryptionManager: null, secureChannelManager };
      }

      const manager = await EncryptionManagerFactory.createEncryptionManager(
        encryptionConfig as Record<string, unknown>,
        {
          dependencies: {
            keyProvider: keyManager,
            secureChannelManager: secureChannelManager ?? null,
          },
        }
      );
      return { encryptionManager: manager, secureChannelManager };
    }

    try {
      const requirements = policy.requirements?.();
      const shouldCreate = Boolean(
        requirements?.encryptionRequired || requirements?.decryptionRequired
      );

      if (!shouldCreate) {
        return { encryptionManager: null, secureChannelManager };
      }

      if (!secureChannelManager) {
        secureChannelManager =
          await SecureChannelManagerFactory.createSecureChannelManager();
      }

      if (!keyManager) {
        throw new Error(
          'EncryptionManager requires KeyManager to be available'
        );
      }

      const cryptoProvider = cryptoProviderOverride ?? null;

      const manager = await EncryptionManagerFactory.createEncryptionManager(
        null,
        {
          dependencies: {
            secureChannelManager,
            keyProvider: keyManager,
            cryptoProvider: cryptoProvider ?? null,
          },
        }
      );

      return { encryptionManager: manager, secureChannelManager };
    } catch (error) {
      logger.error('failed_to_auto_create_encryption_manager', {
        error: error instanceof Error ? error.message : String(error),
        exc_info: true,
      });
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  private static async createKeyManagerFromConfig(
    config: Record<string, unknown>,
    policy: SecurityPolicy,
    keyStore: KeyStore | null
  ): Promise<KeyManager | null> {
    let resolvedKeyStore =
      keyStore ?? DefaultSecurityManagerFactory.getKeyStoreFromConfig(config);
    if (!resolvedKeyStore) {
      resolvedKeyStore = getKeyStore();
    }

    const keyManagerConfig = config.key_manager_config ?? null;
    if (
      keyManagerConfig &&
      DefaultSecurityManagerFactory.isConfigLike(keyManagerConfig)
    ) {
      return await KeyManagerFactory.createKeyManager(
        keyManagerConfig as Record<string, unknown>,
        {
          keyStore: resolvedKeyStore,
        }
      );
    }

    try {
      const requirements = policy.requirements?.();
      const shouldCreate = requirements
        ? Boolean(requirements.requireKeyExchange)
        : true;

      if (!shouldCreate) {
        return null;
      }

      const defaultConfig: DefaultKeyManagerConfig = {
        type: 'DefaultKeyManager',
      };
      return await KeyManagerFactory.createKeyManager(defaultConfig, {
        keyStore: resolvedKeyStore,
      });
    } catch (error) {
      logger.error('failed_to_auto_create_key_manager', {
        error: error instanceof Error ? error.message : String(error),
        exc_info: true,
      });

      const fallbackConfig: DefaultKeyManagerConfig = {
        type: 'DefaultKeyManager',
      };
      return await KeyManagerFactory.createKeyManager(fallbackConfig, {
        keyStore: resolvedKeyStore,
      });
    }
  }

  private static async createAuthorizerFromConfig(
    config: Record<string, unknown>,
    policy: SecurityPolicy
  ): Promise<Authorizer | null> {
    let authorizerConfig = config.authorizer ?? null;
    if (!authorizerConfig) {
      authorizerConfig = config.authorizer_config ?? null;
    }

    if (
      authorizerConfig &&
      DefaultSecurityManagerFactory.isConfigLike(authorizerConfig)
    ) {
      return (
        (await AuthorizerFactory.createAuthorizer(
          authorizerConfig as Record<string, unknown>
        )) ?? null
      );
    }

    try {
      const requirements = policy.requirements?.();
      let shouldCreate = false;
      if (requirements) {
        shouldCreate = Boolean(requirements.requireNodeAuthorization);
      } else {
        shouldCreate = true;
      }

      if (!shouldCreate) {
        return null;
      }

      const tokenVerifier = new NoopTokenVerifier();
      return (
        (await AuthorizerFactory.createAuthorizer(null, {
          factoryArgs: [tokenVerifier],
        })) ?? null
      );
    } catch (error) {
      logger.error('failed_to_auto_create_authorizer', {
        error: error instanceof Error ? error.message : String(error),
        exc_info: true,
      });
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  private static async createCertificateManagerFromConfig(
    config: Record<string, unknown>,
    policy: SecurityPolicy
  ): Promise<CertificateManager | null> {
    const certificateConfig = config.certificate_manager ?? null;
    if (
      certificateConfig &&
      DefaultSecurityManagerFactory.isConfigLike(certificateConfig)
    ) {
      return await CertificateManagerFactory.createCertificateManager(
        certificateConfig as Record<string, unknown>
      );
    }

    try {
      const requirements = policy.requirements?.();
      const shouldCreate = Boolean(requirements?.requireCertificates);
      if (!shouldCreate) {
        return null;
      }

      const signing =
        (policy as { signing?: SigningConfig | null }).signing ?? null;
      return await CertificateManagerFactory.createCertificateManager(null, {
        signing: signing ?? null,
      });
    } catch (error) {
      logger.error('failed_to_auto_create_certificate_manager', {
        error: error instanceof Error ? error.message : String(error),
        exc_info: true,
      });
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  private static isNodeEventListener(
    candidate: unknown
  ): candidate is NodeEventListener {
    return Boolean(
      candidate && typeof (candidate as NodeEventListener).priority === 'number'
    );
  }

  private static mergeCreateOptions(
    factoryArgs: unknown[],
    createOptions: CreateResourceOptions | null
  ): CreateResourceOptions {
    const merged: CreateResourceOptions = {};

    if (factoryArgs.length > 0) {
      merged.factoryArgs = [...factoryArgs];
    }

    if (!createOptions) {
      return merged;
    }

    if (createOptions.env) {
      merged.env = { ...createOptions.env };
    }

    if (createOptions.config) {
      merged.config = { ...createOptions.config };
    }

    if (createOptions.variables) {
      merged.variables = { ...createOptions.variables };
    }

    if (createOptions.allowUnknownProperties !== undefined) {
      merged.allowUnknownProperties = createOptions.allowUnknownProperties;
    }

    if (createOptions.propertyValidators) {
      merged.propertyValidators = { ...createOptions.propertyValidators };
    }

    if (createOptions.policy !== undefined) {
      merged.policy = createOptions.policy;
    }

    if (createOptions.validate !== undefined) {
      merged.validate = createOptions.validate;
    }

    if (createOptions.validator) {
      merged.validator = createOptions.validator;
    }

    if (createOptions.factoryArgs?.length) {
      const existing = merged.factoryArgs ? [...merged.factoryArgs] : [];
      merged.factoryArgs = [...existing, ...createOptions.factoryArgs];
    }

    return merged;
  }

  private static extractInstance<T>(
    config: Record<string, unknown>,
    ...keys: string[]
  ): T | null {
    for (const key of keys) {
      const value = config[key];
      if (value === undefined || value === null) {
        continue;
      }
      if (!DefaultSecurityManagerFactory.isConfigLike(value)) {
        return value as T;
      }
    }
    return null;
  }

  private static isConfigLike(
    value: unknown
  ): value is Record<string, unknown> {
    return Boolean(
      value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        typeof (value as Record<string, unknown>).type === 'string'
    );
  }
}

export default DefaultSecurityManagerFactory;
