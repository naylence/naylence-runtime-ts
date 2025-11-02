import type { KeyProvider } from '../keys/key-provider.js';
import {
  DefaultSecurityPolicy,
  type DefaultSecurityPolicyOptions,
} from './default-security-policy.js';
import {
  EncryptionConfiguration,
  type EncryptionConfig,
  SigningConfiguration,
  type SigningConfig,
  type SecurityPolicy,
  type SecurityPolicyConfig,
} from './security-policy.js';
import {
  SECURITY_POLICY_FACTORY_BASE_TYPE,
  SecurityPolicyFactory,
} from './security-policy-factory.js';
import {
  normalizeEncryptionCase,
  normalizeSigningCase,
  resolveAlias,
} from './policy-alias-normalizer.js';

export interface DefaultSecurityPolicyConfig extends SecurityPolicyConfig {
  type: 'DefaultSecurityPolicy';
  signing?: SigningConfiguration | SigningConfig | null;
  encryption?: EncryptionConfiguration | EncryptionConfig | null;
  [key: string]: unknown;
}

export const FACTORY_META = {
  base: SECURITY_POLICY_FACTORY_BASE_TYPE,
  key: 'DefaultSecurityPolicy',
} as const;

export class DefaultSecurityPolicyFactory extends SecurityPolicyFactory<DefaultSecurityPolicyConfig> {
  public readonly type = 'DefaultSecurityPolicy';
  public readonly isDefault = true;

  /**
   * Create a SecurityPolicy instance.
   *
   * @param config Configuration object
   * @param factoryArgs Additional factory arguments:
   *   - factoryArgs[0]: KeyProvider | null (optional) - Key provider for key lookups
   */
  public async create(
    config?: DefaultSecurityPolicyConfig | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<SecurityPolicy> {
    const prepared = normalizeConfig(config);
    const options: DefaultSecurityPolicyOptions = {};

    // Extract keyProvider from factoryArgs[0] (matches Python's key_provider kwarg)
    const keyProvider = factoryArgs[0] as KeyProvider | null | undefined;
    if (keyProvider) {
      options.keyProvider = keyProvider;
    }

    // Apply config settings to options
    if (prepared.signing !== undefined) {
      options.signing = prepared.signing;
    }

    if (prepared.encryption !== undefined) {
      options.encryption = prepared.encryption;
    }

    return new DefaultSecurityPolicy(options);
  }
}

export default DefaultSecurityPolicyFactory;

function normalizeConfig(
  config?: DefaultSecurityPolicyConfig | Record<string, unknown> | null
): DefaultSecurityPolicyConfig {
  if (!config) {
    return { type: 'DefaultSecurityPolicy' };
  }

  const candidate = config as Record<string, unknown>;
  const typeValue =
    typeof candidate.type === 'string'
      ? candidate.type
      : 'DefaultSecurityPolicy';

  if (typeValue !== 'DefaultSecurityPolicy') {
    throw new Error(
      `DefaultSecurityPolicyFactory expects type "DefaultSecurityPolicy", got "${String(candidate.type)}"`
    );
  }

  const signing = resolveAlias<
    SigningConfiguration | SigningConfig | null | undefined
  >(candidate, ['signing', 'signing_config', 'signingConfig']);
  const encryption = resolveAlias<
    EncryptionConfiguration | EncryptionConfig | null | undefined
  >(candidate, ['encryption', 'encryption_config', 'encryptionConfig']);

  const result: DefaultSecurityPolicyConfig = { type: 'DefaultSecurityPolicy' };

  if (signing !== undefined) {
    result.signing = normalizeSigningCase(signing);
  }

  if (encryption !== undefined) {
    result.encryption = normalizeEncryptionCase(encryption);
  }

  return result;
}
