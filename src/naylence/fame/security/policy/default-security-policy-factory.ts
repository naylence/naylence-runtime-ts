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

  const signing = candidate.signing as
    | SigningConfiguration
    | SigningConfig
    | null
    | undefined;
  const encryption = candidate.encryption as
    | EncryptionConfiguration
    | EncryptionConfig
    | null
    | undefined;

  const result: DefaultSecurityPolicyConfig = { type: 'DefaultSecurityPolicy' };

  if (signing !== undefined) {
    result.signing = normalizeSigningCase(signing);
  }

  if (encryption !== undefined) {
    result.encryption = normalizeEncryptionCase(encryption);
  }

  return result;
}

function normalizeSigningCase(
  signing: SigningConfiguration | SigningConfig | null | undefined
): SigningConfiguration | SigningConfig | null {
  if (signing === undefined || signing === null) {
    return null;
  }

  if (signing instanceof SigningConfiguration) {
    return signing;
  }

  const normalized = { ...signing } as Record<string, unknown>;

  applyKeyMapping(normalized, {
    signing_material: 'signingMaterial',
    validate_cert_name_constraints: 'validateCertNameConstraints',
    require_cert_sid_match: 'requireCertSidMatch',
    require_cert_logical_match: 'requireCertLogicalMatch',
  });

  const inbound = mapNestedKeys(normalized.inbound, {
    signature_policy: 'signaturePolicy',
    unsigned_violation_action: 'unsignedViolationAction',
    invalid_signature_action: 'invalidSignatureAction',
    missing_key_action: 'missingKeyAction',
  });
  if (inbound) {
    normalized.inbound = inbound;
  }

  const response = mapNestedKeys(normalized.response, {
    mirror_request_signing: 'mirrorRequestSigning',
    always_sign_responses: 'alwaysSignResponses',
    sign_error_responses: 'signErrorResponses',
  });
  if (response) {
    normalized.response = response;
  }

  const outbound = mapNestedKeys(normalized.outbound, {
    default_signing: 'defaultSigning',
    sign_sensitive_operations: 'signSensitiveOperations',
    sign_if_recipient_expects: 'signIfRecipientExpects',
  });
  if (outbound) {
    normalized.outbound = outbound;
  }

  return normalized as unknown as SigningConfig;
}

function normalizeEncryptionCase(
  encryption: EncryptionConfiguration | EncryptionConfig | null | undefined
): EncryptionConfiguration | EncryptionConfig | null {
  if (encryption === undefined || encryption === null) {
    return null;
  }

  if (encryption instanceof EncryptionConfiguration) {
    return encryption;
  }

  const normalized = { ...encryption } as Record<string, unknown>;

  applyKeyMapping(normalized, {
    supported_channel_algorithms: 'supportedChannelAlgorithms',
    supported_sealed_algorithms: 'supportedSealedAlgorithms',
    plaintext_algorithms: 'plaintextAlgorithms',
    channel_algorithms: 'channelAlgorithms',
    sealed_algorithms: 'sealedAlgorithms',
  });

  const inbound = mapNestedKeys(normalized.inbound, {
    allow_plaintext: 'allowPlaintext',
    allow_channel: 'allowChannel',
    allow_sealed: 'allowSealed',
    plaintext_violation_action: 'plaintextViolationAction',
    channel_violation_action: 'channelViolationAction',
    sealed_violation_action: 'sealedViolationAction',
  });
  if (inbound) {
    normalized.inbound = inbound;
  }

  const response = mapNestedKeys(normalized.response, {
    mirror_request_level: 'mirrorRequestLevel',
    minimum_response_level: 'minimumResponseLevel',
    escalate_sealed_responses: 'escalateSealedResponses',
  });
  if (response) {
    normalized.response = response;
  }

  const outbound = mapNestedKeys(normalized.outbound, {
    default_level: 'defaultLevel',
    escalate_if_peer_supports: 'escalateIfPeerSupports',
    prefer_sealed_for_sensitive: 'preferSealedForSensitive',
  });
  if (outbound) {
    normalized.outbound = outbound;
  }

  return normalized as unknown as EncryptionConfig;
}

function mapNestedKeys(
  value: unknown,
  mapping: Record<string, string>
): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const result = { ...(value as Record<string, unknown>) };
  applyKeyMapping(result, mapping);
  return result;
}

function applyKeyMapping(
  target: Record<string, unknown>,
  mapping: Record<string, string>
): void {
  for (const [sourceKey, targetKey] of Object.entries(mapping)) {
    if (sourceKey in target && !(targetKey in target)) {
      target[targetKey] = target[sourceKey];
    }
    delete target[sourceKey];
  }
}
