import type { FameDeliveryContext, FameEnvelope } from 'naylence-core';
import type { NodeLike } from '../../node/node-like.js';
import type { EncryptionOptions } from '../encryption/encryption-manager.js';

export enum CryptoLevel {
  PLAINTEXT = 'plaintext',
  CHANNEL = 'channel',
  SEALED = 'sealed',
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

export enum SigningMaterial {
  RAW_KEY = 'raw-key',
  X509_CHAIN = 'x509-chain',
}

export interface SecurityRequirements {
  readonly signingRequired?: boolean;
  readonly verificationRequired?: boolean;
  readonly supportedSigningAlgorithms?: ReadonlySet<string>;
  readonly encryptionRequired?: boolean;
  readonly decryptionRequired?: boolean;
  readonly supportedEncryptionAlgorithms?: ReadonlySet<string>;
  readonly requireKeyExchange?: boolean;
  readonly requireSigningKeyExchange?: boolean;
  readonly requireEncryptionKeyExchange?: boolean;
  readonly requireNodeAuthorization?: boolean;
  readonly requireCertificates?: boolean;
  readonly minimumCryptoLevel?: CryptoLevel;
  readonly preferredSigningAlgorithms?: readonly string[];
  readonly preferredEncryptionAlgorithms?: readonly string[];
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
