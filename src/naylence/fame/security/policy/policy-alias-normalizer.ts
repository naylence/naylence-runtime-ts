import {
  EncryptionConfiguration,
  type EncryptionConfig,
  SigningConfiguration,
  type SigningConfig,
} from './security-policy.js';

export function resolveAlias<T>(
  source: Record<string, unknown>,
  keys: readonly string[]
): T | undefined {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      return source[key] as T;
    }
  }
  return undefined;
}

export function normalizeSigningCase(
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

export function normalizeEncryptionCase(
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
