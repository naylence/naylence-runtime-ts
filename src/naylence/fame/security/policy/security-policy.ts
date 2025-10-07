import type {
  FameDeliveryContext,
  FameEnvelope,
  ResourceConfig,
} from 'naylence-core';

import { deepMerge } from '../../util/util.js';
import type { NodeLike } from '../../node/node-like.js';
import type { EncryptionOptions } from '../encryption/encryption-manager.js';
import { SigningMaterial } from 'naylence-core';

export enum CryptoLevel {
  PLAINTEXT = 'plaintext',
  CHANNEL = 'channel',
  SEALED = 'sealed',
}

export const CRYPTO_LEVEL_SECURITY_ORDER: Record<CryptoLevel, number> = {
  [CryptoLevel.PLAINTEXT]: 1,
  [CryptoLevel.CHANNEL]: 2,
  [CryptoLevel.SEALED]: 3,
};

export function compareCryptoLevels(a: CryptoLevel, b: CryptoLevel): number {
  return CRYPTO_LEVEL_SECURITY_ORDER[a] - CRYPTO_LEVEL_SECURITY_ORDER[b];
}

export enum SecurityAction {
  ALLOW = 'allow',
  REJECT = 'reject',
  NACK = 'nack',
}

export enum SignaturePolicy {
  REQUIRED = 'required',
  OPTIONAL = 'optional',
  DISABLED = 'disabled',
  FORBIDDEN = 'forbidden',
}

// export enum SigningMaterial {
//   RAW_KEY = "raw-key",
//   X509_CHAIN = "x509-chain",
// }

export interface SecurityPolicyConfig extends ResourceConfig {
  type: string;
  [key: string]: unknown;
}

export interface InboundCryptoRulesInit {
  allowPlaintext?: boolean;
  allowChannel?: boolean;
  allowSealed?: boolean;
  plaintextViolationAction?: SecurityAction;
  channelViolationAction?: SecurityAction;
  sealedViolationAction?: SecurityAction;
}

export interface InboundCryptoRules extends Required<InboundCryptoRulesInit> {}

const DEFAULT_INBOUND_CRYPTO_RULES: InboundCryptoRules = {
  allowPlaintext: true,
  allowChannel: true,
  allowSealed: true,
  plaintextViolationAction: SecurityAction.NACK,
  channelViolationAction: SecurityAction.NACK,
  sealedViolationAction: SecurityAction.NACK,
};

export function normalizeInboundCryptoRules(
  value?: InboundCryptoRules | InboundCryptoRulesInit | null
): InboundCryptoRules {
  if (!value) {
    return { ...DEFAULT_INBOUND_CRYPTO_RULES };
  }
  return {
    allowPlaintext:
      value.allowPlaintext ?? DEFAULT_INBOUND_CRYPTO_RULES.allowPlaintext,
    allowChannel:
      value.allowChannel ?? DEFAULT_INBOUND_CRYPTO_RULES.allowChannel,
    allowSealed: value.allowSealed ?? DEFAULT_INBOUND_CRYPTO_RULES.allowSealed,
    plaintextViolationAction:
      value.plaintextViolationAction ??
      DEFAULT_INBOUND_CRYPTO_RULES.plaintextViolationAction,
    channelViolationAction:
      value.channelViolationAction ??
      DEFAULT_INBOUND_CRYPTO_RULES.channelViolationAction,
    sealedViolationAction:
      value.sealedViolationAction ??
      DEFAULT_INBOUND_CRYPTO_RULES.sealedViolationAction,
  };
}

export interface ResponseCryptoRulesInit {
  mirrorRequestLevel?: boolean;
  minimumResponseLevel?: CryptoLevel;
  escalateSealedResponses?: boolean;
}

export interface ResponseCryptoRules
  extends Required<ResponseCryptoRulesInit> {}

const DEFAULT_RESPONSE_CRYPTO_RULES: ResponseCryptoRules = {
  mirrorRequestLevel: true,
  minimumResponseLevel: CryptoLevel.CHANNEL,
  escalateSealedResponses: false,
};

export function normalizeResponseCryptoRules(
  value?: ResponseCryptoRules | ResponseCryptoRulesInit | null
): ResponseCryptoRules {
  if (!value) {
    return { ...DEFAULT_RESPONSE_CRYPTO_RULES };
  }
  return {
    mirrorRequestLevel:
      value.mirrorRequestLevel ??
      DEFAULT_RESPONSE_CRYPTO_RULES.mirrorRequestLevel,
    minimumResponseLevel:
      value.minimumResponseLevel ??
      DEFAULT_RESPONSE_CRYPTO_RULES.minimumResponseLevel,
    escalateSealedResponses:
      value.escalateSealedResponses ??
      DEFAULT_RESPONSE_CRYPTO_RULES.escalateSealedResponses,
  };
}

export interface OutboundCryptoRulesInit {
  defaultLevel?: CryptoLevel;
  escalateIfPeerSupports?: boolean;
  preferSealedForSensitive?: boolean;
}

export interface OutboundCryptoRules
  extends Required<OutboundCryptoRulesInit> {}

const DEFAULT_OUTBOUND_CRYPTO_RULES: OutboundCryptoRules = {
  defaultLevel: CryptoLevel.CHANNEL,
  escalateIfPeerSupports: true,
  preferSealedForSensitive: true,
};

export function normalizeOutboundCryptoRules(
  value?: OutboundCryptoRules | OutboundCryptoRulesInit | null
): OutboundCryptoRules {
  if (!value) {
    return { ...DEFAULT_OUTBOUND_CRYPTO_RULES };
  }
  return {
    defaultLevel:
      value.defaultLevel ?? DEFAULT_OUTBOUND_CRYPTO_RULES.defaultLevel,
    escalateIfPeerSupports:
      value.escalateIfPeerSupports ??
      DEFAULT_OUTBOUND_CRYPTO_RULES.escalateIfPeerSupports,
    preferSealedForSensitive:
      value.preferSealedForSensitive ??
      DEFAULT_OUTBOUND_CRYPTO_RULES.preferSealedForSensitive,
  };
}

export interface EncryptionConfigInit {
  supportedChannelAlgorithms?: readonly string[];
  supportedSealedAlgorithms?: readonly string[];
  inbound?: InboundCryptoRules | InboundCryptoRulesInit | null;
  response?: ResponseCryptoRules | ResponseCryptoRulesInit | null;
  outbound?: OutboundCryptoRules | OutboundCryptoRulesInit | null;
  plaintextAlgorithms?: readonly string[];
  channelAlgorithms?: readonly string[];
  sealedAlgorithms?: readonly string[];
}

export interface EncryptionConfig
  extends Required<
    Omit<EncryptionConfigInit, 'inbound' | 'response' | 'outbound'>
  > {
  inbound: InboundCryptoRules;
  response: ResponseCryptoRules;
  outbound: OutboundCryptoRules;
}

const DEFAULT_ENCRYPTION_CONFIG: EncryptionConfig = {
  supportedChannelAlgorithms: ['chacha20-poly1305-channel'],
  supportedSealedAlgorithms: [
    'chacha20-poly1305',
    'aes-256-gcm',
    'ECDH-ES+A256GCM',
  ],
  inbound: { ...DEFAULT_INBOUND_CRYPTO_RULES },
  response: { ...DEFAULT_RESPONSE_CRYPTO_RULES },
  outbound: { ...DEFAULT_OUTBOUND_CRYPTO_RULES },
  plaintextAlgorithms: [],
  channelAlgorithms: [],
  sealedAlgorithms: [],
};

export function normalizeEncryptionConfig(
  value?:
    | EncryptionConfig
    | EncryptionConfigInit
    | EncryptionConfiguration
    | null
): EncryptionConfig {
  if (!value) {
    return {
      ...DEFAULT_ENCRYPTION_CONFIG,
      inbound: { ...DEFAULT_ENCRYPTION_CONFIG.inbound },
      response: { ...DEFAULT_ENCRYPTION_CONFIG.response },
      outbound: { ...DEFAULT_ENCRYPTION_CONFIG.outbound },
    };
  }

  if (value instanceof EncryptionConfiguration) {
    return value.toObject();
  }

  const merged = deepMerge(
    DEFAULT_ENCRYPTION_CONFIG,
    value as Record<string, unknown>
  );
  return {
    supportedChannelAlgorithms: Array.from(merged.supportedChannelAlgorithms),
    supportedSealedAlgorithms: Array.from(merged.supportedSealedAlgorithms),
    inbound: normalizeInboundCryptoRules(value.inbound ?? merged.inbound),
    response: normalizeResponseCryptoRules(value.response ?? merged.response),
    outbound: normalizeOutboundCryptoRules(value.outbound ?? merged.outbound),
    plaintextAlgorithms: Array.from(merged.plaintextAlgorithms ?? []),
    channelAlgorithms: Array.from(merged.channelAlgorithms ?? []),
    sealedAlgorithms: Array.from(merged.sealedAlgorithms ?? []),
  };
}

export class EncryptionConfiguration {
  public readonly supportedChannelAlgorithms: readonly string[];
  public readonly supportedSealedAlgorithms: readonly string[];
  public readonly inbound: InboundCryptoRules;
  public readonly response: ResponseCryptoRules;
  public readonly outbound: OutboundCryptoRules;
  public readonly plaintextAlgorithms: readonly string[];
  public readonly channelAlgorithms: readonly string[];
  public readonly sealedAlgorithms: readonly string[];

  constructor(init?: EncryptionConfig | EncryptionConfigInit | null) {
    const resolved = normalizeEncryptionConfig(init);
    this.supportedChannelAlgorithms = resolved.supportedChannelAlgorithms;
    this.supportedSealedAlgorithms = resolved.supportedSealedAlgorithms;
    this.inbound = resolved.inbound;
    this.response = resolved.response;
    this.outbound = resolved.outbound;
    this.plaintextAlgorithms = resolved.plaintextAlgorithms;
    this.channelAlgorithms = resolved.channelAlgorithms;
    this.sealedAlgorithms = resolved.sealedAlgorithms;
  }

  public static forDevelopment(): EncryptionConfiguration {
    return new EncryptionConfiguration({
      inbound: {
        allowPlaintext: true,
        allowChannel: false,
        allowSealed: false,
        plaintextViolationAction: SecurityAction.ALLOW,
        channelViolationAction: SecurityAction.NACK,
        sealedViolationAction: SecurityAction.NACK,
      },
      outbound: {
        defaultLevel: CryptoLevel.PLAINTEXT,
        escalateIfPeerSupports: false,
        preferSealedForSensitive: false,
      },
      response: {
        minimumResponseLevel: CryptoLevel.PLAINTEXT,
        mirrorRequestLevel: false,
        escalateSealedResponses: false,
      },
    });
  }

  public toObject(): EncryptionConfig {
    return {
      supportedChannelAlgorithms: [...this.supportedChannelAlgorithms],
      supportedSealedAlgorithms: [...this.supportedSealedAlgorithms],
      inbound: { ...this.inbound },
      response: { ...this.response },
      outbound: { ...this.outbound },
      plaintextAlgorithms: [...this.plaintextAlgorithms],
      channelAlgorithms: [...this.channelAlgorithms],
      sealedAlgorithms: [...this.sealedAlgorithms],
    };
  }
}

export interface InboundSigningRulesInit {
  signaturePolicy?: SignaturePolicy;
  unsignedViolationAction?: SecurityAction;
  invalidSignatureAction?: SecurityAction;
  missingKeyAction?: SecurityAction;
}

export interface InboundSigningRules
  extends Required<InboundSigningRulesInit> {}

const DEFAULT_INBOUND_SIGNING_RULES: InboundSigningRules = {
  signaturePolicy: SignaturePolicy.OPTIONAL,
  unsignedViolationAction: SecurityAction.ALLOW,
  invalidSignatureAction: SecurityAction.REJECT,
  missingKeyAction: SecurityAction.NACK,
};

export function normalizeInboundSigningRules(
  value?: InboundSigningRules | InboundSigningRulesInit | null
): InboundSigningRules {
  if (!value) {
    return { ...DEFAULT_INBOUND_SIGNING_RULES };
  }
  return {
    signaturePolicy:
      value.signaturePolicy ?? DEFAULT_INBOUND_SIGNING_RULES.signaturePolicy,
    unsignedViolationAction:
      value.unsignedViolationAction ??
      DEFAULT_INBOUND_SIGNING_RULES.unsignedViolationAction,
    invalidSignatureAction:
      value.invalidSignatureAction ??
      DEFAULT_INBOUND_SIGNING_RULES.invalidSignatureAction,
    missingKeyAction:
      value.missingKeyAction ?? DEFAULT_INBOUND_SIGNING_RULES.missingKeyAction,
  };
}

export interface ResponseSigningRulesInit {
  mirrorRequestSigning?: boolean;
  alwaysSignResponses?: boolean;
  signErrorResponses?: boolean;
}

export interface ResponseSigningRules
  extends Required<ResponseSigningRulesInit> {}

const DEFAULT_RESPONSE_SIGNING_RULES: ResponseSigningRules = {
  mirrorRequestSigning: false,
  alwaysSignResponses: false,
  signErrorResponses: false,
};

export function normalizeResponseSigningRules(
  value?: ResponseSigningRules | ResponseSigningRulesInit | null
): ResponseSigningRules {
  if (!value) {
    return { ...DEFAULT_RESPONSE_SIGNING_RULES };
  }
  return {
    mirrorRequestSigning:
      value.mirrorRequestSigning ??
      DEFAULT_RESPONSE_SIGNING_RULES.mirrorRequestSigning,
    alwaysSignResponses:
      value.alwaysSignResponses ??
      DEFAULT_RESPONSE_SIGNING_RULES.alwaysSignResponses,
    signErrorResponses:
      value.signErrorResponses ??
      DEFAULT_RESPONSE_SIGNING_RULES.signErrorResponses,
  };
}

export interface OutboundSigningRulesInit {
  defaultSigning?: boolean;
  signSensitiveOperations?: boolean;
  signIfRecipientExpects?: boolean;
}

export interface OutboundSigningRules
  extends Required<OutboundSigningRulesInit> {}

const DEFAULT_OUTBOUND_SIGNING_RULES: OutboundSigningRules = {
  defaultSigning: false,
  signSensitiveOperations: false,
  signIfRecipientExpects: true,
};

export function normalizeOutboundSigningRules(
  value?: OutboundSigningRules | OutboundSigningRulesInit | null
): OutboundSigningRules {
  if (!value) {
    return { ...DEFAULT_OUTBOUND_SIGNING_RULES };
  }
  return {
    defaultSigning:
      value.defaultSigning ?? DEFAULT_OUTBOUND_SIGNING_RULES.defaultSigning,
    signSensitiveOperations:
      value.signSensitiveOperations ??
      DEFAULT_OUTBOUND_SIGNING_RULES.signSensitiveOperations,
    signIfRecipientExpects:
      value.signIfRecipientExpects ??
      DEFAULT_OUTBOUND_SIGNING_RULES.signIfRecipientExpects,
  };
}

export interface SigningConfigInit {
  inbound?: InboundSigningRules | InboundSigningRulesInit | null;
  response?: ResponseSigningRules | ResponseSigningRulesInit | null;
  outbound?: OutboundSigningRules | OutboundSigningRulesInit | null;
  signingMaterial?: SigningMaterial;
  validateCertNameConstraints?: boolean;
  requireCertSidMatch?: boolean;
  requireCertLogicalMatch?: boolean;
}

export interface SigningConfig
  extends Required<
    Omit<SigningConfigInit, 'inbound' | 'response' | 'outbound'>
  > {
  inbound: InboundSigningRules;
  response: ResponseSigningRules;
  outbound: OutboundSigningRules;
}

const DEFAULT_SIGNING_CONFIG: SigningConfig = {
  inbound: { ...DEFAULT_INBOUND_SIGNING_RULES },
  response: { ...DEFAULT_RESPONSE_SIGNING_RULES },
  outbound: { ...DEFAULT_OUTBOUND_SIGNING_RULES },
  signingMaterial: SigningMaterial.RAW_KEY,
  validateCertNameConstraints: true,
  requireCertSidMatch: false,
  requireCertLogicalMatch: false,
};

export class SigningConfiguration {
  public readonly inbound: InboundSigningRules;
  public readonly response: ResponseSigningRules;
  public readonly outbound: OutboundSigningRules;
  public readonly signingMaterial: SigningMaterial;
  public readonly validateCertNameConstraints: boolean;
  public readonly requireCertSidMatch: boolean;
  public readonly requireCertLogicalMatch: boolean;

  constructor(init?: SigningConfig | SigningConfigInit | null) {
    const resolved = normalizeSigningConfig(init);
    this.inbound = resolved.inbound;
    this.response = resolved.response;
    this.outbound = resolved.outbound;
    this.signingMaterial = resolved.signingMaterial;
    this.validateCertNameConstraints = resolved.validateCertNameConstraints;
    this.requireCertSidMatch = resolved.requireCertSidMatch;
    this.requireCertLogicalMatch = resolved.requireCertLogicalMatch;
  }

  public static forDevelopment(): SigningConfiguration {
    return new SigningConfiguration({
      inbound: {
        signaturePolicy: SignaturePolicy.DISABLED,
        unsignedViolationAction: SecurityAction.ALLOW,
        invalidSignatureAction: SecurityAction.REJECT,
        missingKeyAction: SecurityAction.ALLOW,
      },
      outbound: {
        defaultSigning: false,
        signSensitiveOperations: false,
        signIfRecipientExpects: false,
      },
      response: {
        mirrorRequestSigning: false,
        alwaysSignResponses: false,
        signErrorResponses: false,
      },
      signingMaterial: SigningMaterial.RAW_KEY,
    });
  }

  public toObject(): SigningConfig {
    return {
      inbound: { ...this.inbound },
      response: { ...this.response },
      outbound: { ...this.outbound },
      signingMaterial: this.signingMaterial,
      validateCertNameConstraints: this.validateCertNameConstraints,
      requireCertSidMatch: this.requireCertSidMatch,
      requireCertLogicalMatch: this.requireCertLogicalMatch,
    };
  }
}

export function normalizeSigningConfig(
  value?: SigningConfig | SigningConfigInit | SigningConfiguration | null
): SigningConfig {
  if (!value) {
    return {
      ...DEFAULT_SIGNING_CONFIG,
      inbound: { ...DEFAULT_SIGNING_CONFIG.inbound },
      response: { ...DEFAULT_SIGNING_CONFIG.response },
      outbound: { ...DEFAULT_SIGNING_CONFIG.outbound },
    };
  }

  if (value instanceof SigningConfiguration) {
    return value.toObject();
  }

  const inbound = normalizeInboundSigningRules(
    value.inbound ?? DEFAULT_SIGNING_CONFIG.inbound
  );
  const response = normalizeResponseSigningRules(
    value.response ?? DEFAULT_SIGNING_CONFIG.response
  );
  const outbound = normalizeOutboundSigningRules(
    value.outbound ?? DEFAULT_SIGNING_CONFIG.outbound
  );

  const signingMaterial =
    value.signingMaterial ?? DEFAULT_SIGNING_CONFIG.signingMaterial;
  const validateCertNameConstraints =
    value.validateCertNameConstraints ??
    DEFAULT_SIGNING_CONFIG.validateCertNameConstraints;
  const requireCertSidMatch =
    value.requireCertSidMatch ?? DEFAULT_SIGNING_CONFIG.requireCertSidMatch;
  const requireCertLogicalMatch =
    value.requireCertLogicalMatch ??
    DEFAULT_SIGNING_CONFIG.requireCertLogicalMatch;

  if (signingMaterial === SigningMaterial.RAW_KEY) {
    if (
      validateCertNameConstraints !== true ||
      requireCertSidMatch !== false ||
      requireCertLogicalMatch !== false
    ) {
      throw new Error(
        'X.509 validation options present but signingMaterial is RAW_KEY'
      );
    }
  }

  return {
    inbound,
    response,
    outbound,
    signingMaterial,
    validateCertNameConstraints,
    requireCertSidMatch,
    requireCertLogicalMatch,
  };
}

export interface SecurityRequirementsInit {
  signingRequired?: boolean;
  verificationRequired?: boolean;
  supportedSigningAlgorithms?: ReadonlySet<string> | readonly string[];
  encryptionRequired?: boolean;
  decryptionRequired?: boolean;
  supportedEncryptionAlgorithms?: ReadonlySet<string> | readonly string[];
  requireKeyExchange?: boolean;
  requireSigningKeyExchange?: boolean;
  requireEncryptionKeyExchange?: boolean;
  requireNodeAuthorization?: boolean;
  requireCertificates?: boolean;
  minimumCryptoLevel?: CryptoLevel;
  preferredSigningAlgorithms?: readonly string[];
  preferredEncryptionAlgorithms?: readonly string[];
  preferredSigningAlgorithm?: string | null;
  preferredEncryptionAlgorithm?: string | null;
}

export class SecurityRequirements {
  public readonly signingRequired: boolean;
  public readonly verificationRequired: boolean;
  public readonly supportedSigningAlgorithms: ReadonlySet<string>;
  public readonly encryptionRequired: boolean;
  public readonly decryptionRequired: boolean;
  public readonly supportedEncryptionAlgorithms: ReadonlySet<string>;
  public readonly requireKeyExchange: boolean;
  public readonly requireSigningKeyExchange: boolean;
  public readonly requireEncryptionKeyExchange: boolean;
  public readonly requireNodeAuthorization: boolean;
  public readonly requireCertificates: boolean;
  public readonly minimumCryptoLevel: CryptoLevel;
  public readonly preferredSigningAlgorithms: readonly string[];
  public readonly preferredEncryptionAlgorithms: readonly string[];
  public readonly preferredSigningAlgorithm: string | null;
  public readonly preferredEncryptionAlgorithm: string | null;

  constructor(init?: SecurityRequirements | SecurityRequirementsInit | null) {
    const resolved = normalizeSecurityRequirements(init);
    this.signingRequired = resolved.signingRequired;
    this.verificationRequired = resolved.verificationRequired;
    this.supportedSigningAlgorithms = resolved.supportedSigningAlgorithms;
    this.encryptionRequired = resolved.encryptionRequired;
    this.decryptionRequired = resolved.decryptionRequired;
    this.supportedEncryptionAlgorithms = resolved.supportedEncryptionAlgorithms;
    this.requireKeyExchange = resolved.requireKeyExchange;
    this.requireSigningKeyExchange = resolved.requireSigningKeyExchange;
    this.requireEncryptionKeyExchange = resolved.requireEncryptionKeyExchange;
    this.requireNodeAuthorization = resolved.requireNodeAuthorization;
    this.requireCertificates = resolved.requireCertificates;
    this.minimumCryptoLevel = resolved.minimumCryptoLevel;
    this.preferredSigningAlgorithms = resolved.preferredSigningAlgorithms;
    this.preferredEncryptionAlgorithms = resolved.preferredEncryptionAlgorithms;
    this.preferredSigningAlgorithm = resolved.preferredSigningAlgorithm;
    this.preferredEncryptionAlgorithm = resolved.preferredEncryptionAlgorithm;
  }
}

const DEFAULT_SECURITY_REQUIREMENTS: Required<SecurityRequirementsInit> & {
  supportedSigningAlgorithms: ReadonlySet<string>;
  supportedEncryptionAlgorithms: ReadonlySet<string>;
  preferredSigningAlgorithm: string | null;
  preferredEncryptionAlgorithm: string | null;
} = {
  signingRequired: false,
  verificationRequired: false,
  supportedSigningAlgorithms: new Set(['EdDSA']),
  encryptionRequired: false,
  decryptionRequired: false,
  supportedEncryptionAlgorithms: new Set(['X25519', 'ChaCha20Poly1305']),
  requireKeyExchange: false,
  requireSigningKeyExchange: false,
  requireEncryptionKeyExchange: false,
  requireNodeAuthorization: false,
  requireCertificates: false,
  minimumCryptoLevel: CryptoLevel.PLAINTEXT,
  preferredSigningAlgorithms: ['EdDSA'],
  preferredEncryptionAlgorithms: ['X25519', 'ChaCha20Poly1305'],
  preferredSigningAlgorithm: 'EdDSA',
  preferredEncryptionAlgorithm: 'X25519',
};

export function normalizeSecurityRequirements(
  value?: SecurityRequirements | SecurityRequirementsInit | null
): Required<SecurityRequirementsInit> & {
  supportedSigningAlgorithms: ReadonlySet<string>;
  supportedEncryptionAlgorithms: ReadonlySet<string>;
  preferredSigningAlgorithm: string | null;
  preferredEncryptionAlgorithm: string | null;
} {
  if (!value) {
    return {
      ...DEFAULT_SECURITY_REQUIREMENTS,
      supportedSigningAlgorithms: new Set(
        DEFAULT_SECURITY_REQUIREMENTS.supportedSigningAlgorithms
      ),
      supportedEncryptionAlgorithms: new Set(
        DEFAULT_SECURITY_REQUIREMENTS.supportedEncryptionAlgorithms
      ),
      preferredSigningAlgorithms: [
        ...DEFAULT_SECURITY_REQUIREMENTS.preferredSigningAlgorithms,
      ],
      preferredEncryptionAlgorithms: [
        ...DEFAULT_SECURITY_REQUIREMENTS.preferredEncryptionAlgorithms,
      ],
    };
  }

  if (value instanceof SecurityRequirements) {
    return value;
  }

  const supportedSigningAlgorithms = Array.isArray(
    value.supportedSigningAlgorithms
  )
    ? new Set(value.supportedSigningAlgorithms)
    : value.supportedSigningAlgorithms
      ? new Set(value.supportedSigningAlgorithms)
      : new Set(DEFAULT_SECURITY_REQUIREMENTS.supportedSigningAlgorithms);

  const supportedEncryptionAlgorithms = Array.isArray(
    value.supportedEncryptionAlgorithms
  )
    ? new Set(value.supportedEncryptionAlgorithms)
    : value.supportedEncryptionAlgorithms
      ? new Set(value.supportedEncryptionAlgorithms)
      : new Set(DEFAULT_SECURITY_REQUIREMENTS.supportedEncryptionAlgorithms);

  return {
    signingRequired:
      value.signingRequired ?? DEFAULT_SECURITY_REQUIREMENTS.signingRequired,
    verificationRequired:
      value.verificationRequired ??
      DEFAULT_SECURITY_REQUIREMENTS.verificationRequired,
    supportedSigningAlgorithms,
    encryptionRequired:
      value.encryptionRequired ??
      DEFAULT_SECURITY_REQUIREMENTS.encryptionRequired,
    decryptionRequired:
      value.decryptionRequired ??
      DEFAULT_SECURITY_REQUIREMENTS.decryptionRequired,
    supportedEncryptionAlgorithms,
    requireKeyExchange:
      value.requireKeyExchange ??
      DEFAULT_SECURITY_REQUIREMENTS.requireKeyExchange,
    requireSigningKeyExchange:
      value.requireSigningKeyExchange ??
      DEFAULT_SECURITY_REQUIREMENTS.requireSigningKeyExchange,
    requireEncryptionKeyExchange:
      value.requireEncryptionKeyExchange ??
      DEFAULT_SECURITY_REQUIREMENTS.requireEncryptionKeyExchange,
    requireNodeAuthorization:
      value.requireNodeAuthorization ??
      DEFAULT_SECURITY_REQUIREMENTS.requireNodeAuthorization,
    requireCertificates:
      value.requireCertificates ??
      DEFAULT_SECURITY_REQUIREMENTS.requireCertificates,
    minimumCryptoLevel:
      value.minimumCryptoLevel ??
      DEFAULT_SECURITY_REQUIREMENTS.minimumCryptoLevel,
    preferredSigningAlgorithms:
      value.preferredSigningAlgorithms ??
      DEFAULT_SECURITY_REQUIREMENTS.preferredSigningAlgorithms,
    preferredEncryptionAlgorithms:
      value.preferredEncryptionAlgorithms ??
      DEFAULT_SECURITY_REQUIREMENTS.preferredEncryptionAlgorithms,
    preferredSigningAlgorithm:
      value.preferredSigningAlgorithm ??
      DEFAULT_SECURITY_REQUIREMENTS.preferredSigningAlgorithm,
    preferredEncryptionAlgorithm:
      value.preferredEncryptionAlgorithm ??
      DEFAULT_SECURITY_REQUIREMENTS.preferredEncryptionAlgorithm,
  };
}

export interface SecurityPolicy {
  shouldSignEnvelope(
    envelope: FameEnvelope,
    context?: FameDeliveryContext,
    nodeLike?: NodeLike
  ): Promise<boolean>;

  shouldEncryptEnvelope(
    envelope: FameEnvelope,
    context?: FameDeliveryContext,
    nodeLike?: NodeLike
  ): Promise<boolean>;

  getEncryptionOptions(
    envelope: FameEnvelope,
    context?: FameDeliveryContext,
    nodeLike?: NodeLike
  ): Promise<EncryptionOptions | undefined>;

  shouldVerifySignature(
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<boolean>;

  shouldDecryptEnvelope(
    envelope: FameEnvelope,
    context?: FameDeliveryContext,
    nodeLike?: NodeLike
  ): Promise<boolean>;

  classifyMessageCryptoLevel(
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): CryptoLevel;

  isInboundCryptoLevelAllowed(
    cryptoLevel: CryptoLevel,
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): boolean;

  getInboundViolationAction(
    cryptoLevel: CryptoLevel,
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): SecurityAction;

  decideResponseCryptoLevel(
    requestCryptoLevel: CryptoLevel,
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<CryptoLevel>;

  decideOutboundCryptoLevel(
    envelope: FameEnvelope,
    context?: FameDeliveryContext,
    nodeLike?: NodeLike
  ): Promise<CryptoLevel>;

  isSignatureRequired(
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): boolean;

  getUnsignedViolationAction(
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): SecurityAction;

  getInvalidSignatureViolationAction(
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): SecurityAction;

  requirements(): SecurityRequirements;

  validateAttachSecurityCompatibility?(options: {
    peerKeys?: Array<Record<string, unknown>>;
    peerRequirements?: SecurityRequirements;
    nodeLike?: NodeLike;
  }): [isCompatible: boolean, reason?: string];
}
