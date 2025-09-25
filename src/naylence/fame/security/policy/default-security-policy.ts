import {
  DeliveryOriginType,
  type FameAddress,
  type FameDeliveryContext,
  type FameEnvelope,
  parseAddress,
} from 'naylence-core';

import { getLogger } from '../../util/logging.js';
import { urlsafeBase64Decode } from '../../util/util.js';
import type { NodeLike } from '../../node/node-like.js';
import type { EncryptionOptions } from '../encryption/encryption-manager.js';
import { getCryptoProvider } from '../crypto/providers/crypto-provider.js';
import type { KeyProvider } from '../keys/key-provider.js';
import { getKeyProvider } from '../keys/key-provider.js';
import type { KeyRecord } from '../keys/key-store.js';
import { validateEncryptionKey, JWKValidationError } from '../crypto/jwk-validation.js';
import {
  CryptoLevel,
  SecurityAction,
  SignaturePolicy,
  SigningMaterial,
  type SecurityPolicy,
  SecurityRequirements,
  compareCryptoLevels,
  EncryptionConfiguration,
  SigningConfiguration,
  type EncryptionConfig,
  type SigningConfig,
} from './security-policy.js';

const logger = getLogger('default-security-policy');

export interface DefaultSecurityPolicyOptions {
  customSigningPolicy?: (
    envelope: FameEnvelope,
    context?: FameDeliveryContext | null,
    nodeLike?: NodeLike | null
  ) => boolean | Promise<boolean>;
  customEncryptionPolicy?: (
    envelope: FameEnvelope,
    context?: FameDeliveryContext | null,
    nodeLike?: NodeLike | null
  ) => boolean | Promise<boolean>;
  encryption?: EncryptionConfiguration | EncryptionConfig | null;
  signing?: SigningConfiguration | SigningConfig | null;
  keyProvider?: KeyProvider | null;
}

function asStringAddress(address: FameAddress | string | undefined): string | null {
  if (!address) {
    return null;
  }
  if (typeof address === 'string') {
    return address;
  }
  return address.toString();
}

function extractFrameType(envelope: FameEnvelope): string | undefined {
  const frame = envelope.frame as { type?: string } | undefined;
  return frame?.type;
}

async function toArray<T>(iterable: Promise<Iterable<T>>): Promise<T[]> {
  const resolved = await iterable;
  const items: T[] = [];
  for (const item of resolved) {
    items.push(item);
  }
  return items;
}

export class DefaultSecurityPolicy implements SecurityPolicy {
  private readonly customSigningPolicy?: DefaultSecurityPolicyOptions['customSigningPolicy'];
  private readonly customEncryptionPolicy?: DefaultSecurityPolicyOptions['customEncryptionPolicy'];
  private readonly encryption: EncryptionConfiguration;
  private readonly signing: SigningConfiguration;
  private readonly keyProvider: KeyProvider | null;

  constructor(options: DefaultSecurityPolicyOptions = {}) {
    this.customSigningPolicy = options.customSigningPolicy ?? undefined;
    this.customEncryptionPolicy = options.customEncryptionPolicy ?? undefined;
    this.encryption =
      options.encryption instanceof EncryptionConfiguration
        ? options.encryption
        : options.encryption
        ? new EncryptionConfiguration(options.encryption)
        : EncryptionConfiguration.forDevelopment();
    this.signing =
      options.signing instanceof SigningConfiguration
        ? options.signing
        : options.signing
        ? new SigningConfiguration(options.signing)
        : SigningConfiguration.forDevelopment();
    this.keyProvider = options.keyProvider ?? null;
  }

  public async shouldSignEnvelope(
    envelope: FameEnvelope,
    context?: FameDeliveryContext,
    nodeLike?: NodeLike
  ): Promise<boolean> {
    if (this.customSigningPolicy) {
      const customResult = await this.customSigningPolicy(envelope, context, nodeLike);
      if (typeof customResult === 'boolean') {
        return customResult;
      }
    }

    if (envelope.sec?.sig) {
      return false;
    }

    const shouldEncrypt = await this.shouldEncryptEnvelope(envelope, context, nodeLike);
    if (shouldEncrypt) {
      const isResponse = this.isResponseEnvelope(envelope, context);
      if (isResponse && !this.signing.response.mirrorRequestSigning) {
        logger.debug('envelope_encryption_without_signing_due_to_disabled_mirroring', {
          envelope_id: envelope.id,
          reason: 'response_signature_mirroring_disabled',
        });
      } else {
        logger.debug('envelope_requires_signing_due_to_encryption', {
          envelope_id: envelope.id,
          reason: 'outbound_encryption_requires_signing',
        });
        return true;
      }
    }

    if (this.isResponseEnvelope(envelope, context)) {
      return this.shouldSignResponse(envelope, context, nodeLike);
    }
    return this.shouldSignOutboundRequest(envelope, context, nodeLike);
  }

  public async shouldEncryptEnvelope(
    envelope: FameEnvelope,
    context?: FameDeliveryContext,
    nodeLike?: NodeLike
  ): Promise<boolean> {
    if (!context || context.originType !== DeliveryOriginType.LOCAL) {
      return false;
    }

    if (this.customEncryptionPolicy) {
      const customResult = await this.customEncryptionPolicy(envelope, context, nodeLike);
      if (typeof customResult === 'boolean') {
        return customResult;
      }
    }

    if (envelope.sec?.enc) {
      return false;
    }

    const desiredLevel = this.isResponseEnvelope(envelope, context)
      ? await this.decideResponseCryptoLevel(
          context?.security?.inboundCryptoLevel ?? CryptoLevel.PLAINTEXT,
          envelope,
          context
        )
      : await this.decideOutboundCryptoLevel(envelope, context, nodeLike);

    return desiredLevel === CryptoLevel.CHANNEL || desiredLevel === CryptoLevel.SEALED;
  }

  public async getEncryptionOptions(
    envelope: FameEnvelope,
    context?: FameDeliveryContext,
    nodeLike?: NodeLike
  ): Promise<EncryptionOptions | undefined> {
    if (!envelope.to) {
      logger.debug('no_encryption_options_no_recipient', { envelope_id: envelope.id });
      return undefined;
    }

    const useChannel = await this.shouldUseChannelEncryption(envelope, context, nodeLike);
    logger.debug('encryption_decision_debug', {
      envelope_id: envelope.id,
      should_use_channel: useChannel,
      context_meta: context?.meta,
      has_context: Boolean(context),
      context_inbound_level: context?.security?.inboundCryptoLevel,
      context_origin: context?.originType,
    });

    if (useChannel) {
      return {
        encryptionType: 'channel',
        destination: envelope.to,
      } satisfies EncryptionOptions;
    }

    try {
      const [recipientKeyId, recipientPublicKey] = await this.lookupRecipientEncryptionKey(
        envelope.to,
        nodeLike?.physicalPath
      );
      logger.debug('found_encryption_key_for_recipient', {
        envelope_id: envelope.id,
        recipient_key_id: recipientKeyId,
        recipient: envelope.to,
      });
      return {
        recipientKeyId,
        recipientPublicKey,
      } satisfies EncryptionOptions;
    } catch (error) {
      logger.debug('encryption_key_not_found_locally_will_request_by_address', {
        envelope_id: envelope.id,
        recipient: envelope.to,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        requestAddress: envelope.to,
      } satisfies EncryptionOptions;
    }
  }

  public async shouldVerifySignature(
    envelope: FameEnvelope,
    _context?: FameDeliveryContext
  ): Promise<boolean> {
    const rules = this.signing.inbound;

    if (!envelope.sec?.sig) {
      if (rules.signaturePolicy === SignaturePolicy.REQUIRED) {
        logger.warning('unsigned_envelope_but_signatures_required', {
          envelope_id: envelope.id,
          action: rules.unsignedViolationAction,
        });
      }
      return false;
    }

    switch (rules.signaturePolicy) {
      case SignaturePolicy.REQUIRED:
        return true;
      case SignaturePolicy.OPTIONAL:
        return true;
      case SignaturePolicy.DISABLED:
        return false;
      case SignaturePolicy.FORBIDDEN:
        return false;
      default:
        return true;
    }
  }

  public async shouldDecryptEnvelope(
    envelope: FameEnvelope,
    _context?: FameDeliveryContext,
    nodeLike?: NodeLike
  ): Promise<boolean> {
    if (!envelope.sec?.enc) {
      return false;
    }

    if (envelope.to) {
      if (this.isLocalAddress(envelope.to, nodeLike)) {
        logger.debug('should_decrypt_envelope_local', {
          envelope_id: envelope.id,
          destination: envelope.to,
          reason: 'destination_is_local_binding',
        });
        return true;
      }
      logger.debug('should_not_decrypt_envelope_forwarding', {
        envelope_id: envelope.id,
        destination: envelope.to,
        reason: 'destination_not_local_forwarding_only',
      });
      return false;
    }

    logger.debug('should_decrypt_envelope_fallback', {
      envelope_id: envelope.id,
      reason: 'no_destination_using_default_policy',
    });
    return true;
  }

  public classifyMessageCryptoLevel(
    envelope: FameEnvelope,
    _context?: FameDeliveryContext
  ): CryptoLevel {
    const algorithm = envelope.sec?.enc?.alg;
    if (algorithm) {
      if (this.encryption.supportedChannelAlgorithms.includes(algorithm)) {
        logger.debug('classified_as_channel_encryption', {
          envelope_id: envelope.id,
          algorithm,
        });
        return CryptoLevel.CHANNEL;
      }

      if (this.encryption.supportedSealedAlgorithms.includes(algorithm)) {
        logger.debug('classified_as_sealed_encryption', {
          envelope_id: envelope.id,
          algorithm,
        });
        return CryptoLevel.SEALED;
      }

      logger.warning('unknown_encryption_algorithm', {
        envelope_id: envelope.id,
        algorithm,
        supported_channel: this.encryption.supportedChannelAlgorithms,
        supported_sealed: this.encryption.supportedSealedAlgorithms,
        defaulting_to: 'SEALED',
      });
      return CryptoLevel.SEALED;
    }

    if (envelope.sec?.enc) {
      logger.warning('encryption_present_but_no_algorithm', {
        envelope_id: envelope.id,
        defaulting_to: 'SEALED',
      });
      return CryptoLevel.SEALED;
    }

    logger.debug('classified_as_plaintext', {
      envelope_id: envelope.id,
      reason: 'no_encryption_headers',
    });
    return CryptoLevel.PLAINTEXT;
  }

  public isInboundCryptoLevelAllowed(
    cryptoLevel: CryptoLevel,
    _envelope: FameEnvelope,
    _context?: FameDeliveryContext
  ): boolean {
    const rules = this.encryption.inbound;
    switch (cryptoLevel) {
      case CryptoLevel.PLAINTEXT:
        return rules.allowPlaintext;
      case CryptoLevel.CHANNEL:
        return rules.allowChannel;
      case CryptoLevel.SEALED:
        return rules.allowSealed;
      default:
        return false;
    }
  }

  public getInboundViolationAction(
    cryptoLevel: CryptoLevel,
    _envelope: FameEnvelope,
    _context?: FameDeliveryContext
  ): SecurityAction {
    const rules = this.encryption.inbound;
    switch (cryptoLevel) {
      case CryptoLevel.PLAINTEXT:
        return rules.plaintextViolationAction;
      case CryptoLevel.CHANNEL:
        return rules.channelViolationAction;
      case CryptoLevel.SEALED:
        return rules.sealedViolationAction;
      default:
        return SecurityAction.NACK;
    }
  }

  public async decideResponseCryptoLevel(
    requestCryptoLevel: CryptoLevel,
    envelope: FameEnvelope,
    _context?: FameDeliveryContext
  ): Promise<CryptoLevel> {
    const frameType = extractFrameType(envelope);
    if (frameType && frameType !== 'Data') {
      return CryptoLevel.PLAINTEXT;
    }

    const rules = this.encryption.response;
    if (rules.escalateSealedResponses) {
      return CryptoLevel.SEALED;
    }

    let responseLevel = rules.mirrorRequestLevel ? requestCryptoLevel : rules.minimumResponseLevel;
    if (compareCryptoLevels(responseLevel, rules.minimumResponseLevel) < 0) {
      responseLevel = rules.minimumResponseLevel;
    }
    return responseLevel;
  }

  public async decideOutboundCryptoLevel(
    envelope: FameEnvelope,
    _context?: FameDeliveryContext,
    nodeLike?: NodeLike
  ): Promise<CryptoLevel> {
    const frameType = extractFrameType(envelope);
    if (frameType && frameType !== 'Data') {
      return CryptoLevel.PLAINTEXT;
    }

    const rules = this.encryption.outbound;
    let cryptoLevel = rules.defaultLevel;

    if (rules.escalateIfPeerSupports && envelope.to) {
      try {
        await this.lookupRecipientEncryptionKey(envelope.to, nodeLike?.physicalPath);
        cryptoLevel = CryptoLevel.SEALED;
      } catch {
        // Ignore errors; default level remains
      }
    }

    if (rules.preferSealedForSensitive && this.isSensitiveOperation(envelope)) {
      cryptoLevel = CryptoLevel.SEALED;
    }

    return cryptoLevel;
  }

  public isSignatureRequired(
    envelope: FameEnvelope,
    _context?: FameDeliveryContext
  ): boolean {
    const frameType = extractFrameType(envelope);

    if (frameType === 'KeyRequest' || frameType === 'KeyAnnounce' || frameType === 'SecureOpen' || frameType === 'SecureAccept') {
      return true;
    }

    if (frameType === 'NodeAttach' || frameType === 'NodeHeartbeat') {
      return false;
    }

    const rules = this.signing.inbound;
    if (rules.signaturePolicy === SignaturePolicy.REQUIRED) {
      return true;
    }

    if (rules.signaturePolicy === SignaturePolicy.FORBIDDEN) {
      return Boolean(envelope.sec?.sig);
    }

    return false;
  }

  public getUnsignedViolationAction(
    _envelope: FameEnvelope,
    _context?: FameDeliveryContext
  ): SecurityAction {
    return this.signing.inbound.unsignedViolationAction;
  }

  public getInvalidSignatureViolationAction(
    _envelope: FameEnvelope,
    _context?: FameDeliveryContext
  ): SecurityAction {
    return this.signing.inbound.invalidSignatureAction;
  }

  public requirements(): SecurityRequirements {
    let signingRequired = false;
    let verificationRequired = false;
    let encryptionRequired = false;
    let decryptionRequired = false;

    const outbound = this.signing.outbound;
    const response = this.signing.response;
    const inbound = this.signing.inbound;
    const encryption = this.encryption;

    if (
      outbound.defaultSigning ||
      outbound.signSensitiveOperations ||
      response.mirrorRequestSigning ||
      response.alwaysSignResponses ||
      response.signErrorResponses
    ) {
      signingRequired = true;
    }

    if (
      inbound.signaturePolicy === SignaturePolicy.REQUIRED ||
      inbound.signaturePolicy === SignaturePolicy.OPTIONAL
    ) {
      verificationRequired = true;
    }

    if (
      encryption.outbound.defaultLevel !== CryptoLevel.PLAINTEXT ||
      encryption.response.minimumResponseLevel !== CryptoLevel.PLAINTEXT
    ) {
      encryptionRequired = true;
    }

    if (encryption.inbound.allowChannel || encryption.inbound.allowSealed) {
      decryptionRequired = true;
    }

    const requireSigningKeyExchange = signingRequired;
    const requireEncryptionKeyExchange = encryptionRequired || decryptionRequired;

    let minimumCryptoLevel = CryptoLevel.PLAINTEXT;
    if (!encryption.inbound.allowPlaintext) {
      if (encryption.inbound.allowChannel) {
        minimumCryptoLevel = CryptoLevel.CHANNEL;
      } else if (encryption.inbound.allowSealed) {
        minimumCryptoLevel = CryptoLevel.SEALED;
      }
    }

    const requireCertificates = this.signing.signingMaterial === SigningMaterial.X509_CHAIN;

    const supportedEncryptionAlgorithms = new Set([
      ...encryption.supportedSealedAlgorithms,
      ...encryption.supportedChannelAlgorithms,
    ]);

    return new SecurityRequirements({
      signingRequired,
      verificationRequired,
      encryptionRequired,
      decryptionRequired,
      requireKeyExchange: requireSigningKeyExchange || requireEncryptionKeyExchange,
      requireSigningKeyExchange,
      requireEncryptionKeyExchange,
      requireNodeAuthorization: true,
      requireCertificates,
      minimumCryptoLevel,
      supportedSigningAlgorithms: new Set(['EdDSA']),
      supportedEncryptionAlgorithms,
      preferredSigningAlgorithms: ['EdDSA'],
      preferredEncryptionAlgorithms: ['X25519', 'ChaCha20Poly1305'],
      preferredSigningAlgorithm: 'EdDSA',
      preferredEncryptionAlgorithm: 'X25519',
    });
  }

  public validateAttachSecurityCompatibility(options: {
    peerKeys?: Array<Record<string, unknown>>;
    peerRequirements?: SecurityRequirements;
  _nodeLike?: NodeLike;
  }): [boolean, string?] {
    const { peerKeys, peerRequirements } = options;
    const requirements = this.requirements();

    if (requirements.requireSigningKeyExchange) {
      const hasSigningKey = peerKeys?.some((key) =>
        (key.use === 'sig' || key.use === undefined) && key.kty === 'OKP' && key.crv === 'Ed25519'
      );
      if (!hasSigningKey) {
        return [false, 'Policy requires signing key exchange but no signing keys provided'];
      }
    }

    if (requirements.requireEncryptionKeyExchange) {
      const hasEncKey = peerKeys?.some((key) =>
        (key.use === 'enc' || key.use === undefined) && key.kty === 'OKP' && key.crv === 'X25519'
      );
      if (!hasEncKey) {
        return [false, 'Policy requires encryption key exchange but no encryption keys provided'];
      }
    }

    if (peerRequirements) {
      if (compareCryptoLevels(peerRequirements.minimumCryptoLevel, requirements.minimumCryptoLevel) > 0) {
        if (
          peerRequirements.minimumCryptoLevel === CryptoLevel.SEALED &&
          !requirements.encryptionRequired
        ) {
          return [false, 'Peer requires SEALED but we do not support encryption'];
        }
      }

      if (peerRequirements.signingRequired && requirements.verificationRequired) {
        const commonSigning = new Set(
          [...peerRequirements.supportedSigningAlgorithms].filter((alg) =>
            requirements.supportedSigningAlgorithms.has(alg)
          )
        );
        if (commonSigning.size === 0) {
          return [
            false,
            `No compatible signing algorithms: peer supports ${Array.from(
              peerRequirements.supportedSigningAlgorithms
            ).join(', ')}, we support ${Array.from(requirements.supportedSigningAlgorithms).join(', ')}`,
          ];
        }
      }

      if (peerRequirements.encryptionRequired && requirements.decryptionRequired) {
        const commonEncryption = new Set(
          [...peerRequirements.supportedEncryptionAlgorithms].filter((alg) =>
            requirements.supportedEncryptionAlgorithms.has(alg)
          )
        );
        if (commonEncryption.size === 0) {
          return [
            false,
            `No compatible encryption algorithms: peer supports ${Array.from(
              peerRequirements.supportedEncryptionAlgorithms
            ).join(', ')}, we support ${Array.from(requirements.supportedEncryptionAlgorithms).join(', ')}`,
          ];
        }
      }
    }

    return [true];
  }

  private async shouldUseChannelEncryption(
    envelope: FameEnvelope,
    context?: FameDeliveryContext,
    _nodeLike?: NodeLike
  ): Promise<boolean> {
    if (!context || context.originType !== DeliveryOriginType.LOCAL) {
      logger.debug('channel_encryption_rejected_non_local', {
        envelope_id: envelope.id,
        has_context: Boolean(context),
        origin: context?.originType,
      });
      return false;
    }

    if (extractFrameType(envelope) !== 'Data') {
      logger.debug('channel_encryption_rejected_non_data', {
        envelope_id: envelope.id,
        frame_type: extractFrameType(envelope),
      });
      return false;
    }

    if (envelope.sec?.enc) {
      logger.debug('channel_encryption_rejected_already_encrypted', { envelope_id: envelope.id });
      return false;
    }

    const messageType = context?.meta?.['message-type'];
    const isResponse = messageType === 'response' || messageType === 'protocol-response';

    logger.debug('channel_encryption_response_check', {
      envelope_id: envelope.id,
      is_response: isResponse,
      context_meta: context?.meta,
      has_context: Boolean(context),
      context_inbound_crypto_level: context?.security?.inboundCryptoLevel,
      mirror_request_level: this.encryption.response.mirrorRequestLevel,
    });

    if (isResponse) {
      if (
        context?.security?.inboundCryptoLevel === CryptoLevel.SEALED &&
        this.encryption.response.mirrorRequestLevel
      ) {
        logger.debug('channel_encryption_rejected_sealed_mirror', {
          envelope_id: envelope.id,
          original_request_level: context.security.inboundCryptoLevel,
          mirror_enabled: this.encryption.response.mirrorRequestLevel,
        });
        return false;
      }

  const desiredLevel = await this.decideOutboundCryptoLevel(envelope, context, _nodeLike);
      logger.debug('channel_encryption_response_fallback', {
        envelope_id: envelope.id,
        desired_level: desiredLevel,
        result: desiredLevel === CryptoLevel.CHANNEL,
      });
      return desiredLevel === CryptoLevel.CHANNEL;
    }

  const desiredLevel = await this.decideOutboundCryptoLevel(envelope, context, _nodeLike);
    logger.debug('channel_encryption_outbound_decision', {
      envelope_id: envelope.id,
      desired_level: desiredLevel,
      result: desiredLevel === CryptoLevel.CHANNEL,
    });
    return desiredLevel === CryptoLevel.CHANNEL;
  }

  private isLocalAddress(address: FameAddress | string, nodeLike?: NodeLike): boolean {
    if (!nodeLike) {
      return false;
    }
    try {
      const fameAddress = typeof address === 'string' ? address : address.toString();
      return nodeLike.hasLocal(fameAddress as any);
    } catch {
      return false;
    }
  }

  private isResponseEnvelope(_envelope: FameEnvelope, context?: FameDeliveryContext): boolean {
    const messageType = context?.meta?.['message-type'];
    return messageType === 'response' || messageType === 'protocol-response';
  }

  private shouldSignResponse(
    envelope: FameEnvelope,
    context?: FameDeliveryContext,
    _nodeLike?: NodeLike
  ): boolean {
    const rules = this.signing.response;

    if (rules.alwaysSignResponses) {
      return true;
    }

    if (rules.signErrorResponses && this.isErrorResponse(envelope)) {
      return true;
    }

    if (rules.mirrorRequestSigning) {
      const inboundWasSigned = context?.security?.inboundWasSigned;
      if (inboundWasSigned) {
        logger.debug('mirroring_signature_due_to_signed_request', {
          envelope_id: envelope.id,
          reason: 'inbound_request_was_signed',
        });
        return true;
      }

      const inboundLevel = context?.security?.inboundCryptoLevel;
      if (inboundLevel && inboundLevel !== CryptoLevel.PLAINTEXT) {
        logger.debug('mirroring_signature_due_to_encrypted_request', {
          envelope_id: envelope.id,
          reason: 'inbound_request_was_encrypted',
          crypto_level: inboundLevel,
        });
        return true;
      }
    }

    return false;
  }

  private shouldSignOutboundRequest(
    envelope: FameEnvelope,
    _context?: FameDeliveryContext,
    _nodeLike?: NodeLike
  ): boolean {
    const rules = this.signing.outbound;

    if (rules.signSensitiveOperations && this.isSensitiveOperation(envelope)) {
      return true;
    }

    if (rules.signIfRecipientExpects) {
      return true;
    }

    return rules.defaultSigning;
  }

  private isErrorResponse(envelope: FameEnvelope): boolean {
    return extractFrameType(envelope) === 'Error';
  }

  private isSensitiveOperation(_envelope: FameEnvelope): boolean {
    return false;
  }

  private async lookupRecipientEncryptionKey(
    address: FameAddress | string,
    nodePhysicalPath?: string
  ): Promise<[string, Uint8Array]> {
    const addressStr = asStringAddress(address);
    if (!addressStr) {
      throw new Error('No recipient address in envelope');
    }

    const keyProvider = this.resolveKeyProvider();
    logger.debug('starting_recipient_encryption_key_lookup', { address: addressStr });

    const [participant, path] = parseAddress(addressStr);
    if (!participant) {
      throw new Error(`Cannot determine participant from address ${addressStr}`);
    }

    const localKey = await this.tryResolveLocalEncryptionKey(path, nodePhysicalPath);
    if (localKey) {
      return localKey;
    }

    const keysByAddress = await toArray(keyProvider.getKeysForPath(addressStr));
    const keys: KeyRecord[] = [...keysByAddress];

    if (keys.length === 0 && path) {
      const pathKeys = await toArray(keyProvider.getKeysForPath(path));
      keys.push(...pathKeys);
    }

    if (keys.length === 0) {
      const participantKeys = await toArray(keyProvider.getKeysForPath(participant));
      keys.push(...participantKeys);
    }

    for (const key of keys) {
      const kid = typeof key.kid === 'string' ? key.kid : '';
      const use = typeof key.use === 'string' ? key.use : undefined;
      const kty = typeof key.kty === 'string' ? key.kty : undefined;
      const crv = typeof key.crv === 'string' ? key.crv : undefined;

      logger.debug('examining_key', { key_id: kid, use, kty, crv });

      if (use === 'enc' && kty === 'OKP' && crv === 'X25519') {
        try {
          validateEncryptionKey(key as unknown as Record<string, unknown>);
        } catch (error) {
          if (error instanceof JWKValidationError) {
            logger.warning('invalid_encryption_key', { kid, error: error.message });
            continue;
          }
          throw error;
        }

        const x = typeof key.x === 'string' ? key.x : undefined;
        if (!x) {
          logger.warning('encryption_key_missing_x_parameter', { kid });
          continue;
        }

        const pubBytes = urlsafeBase64Decode(x);
        logger.debug('successfully_extracted_public_key', {
          kid,
          pub_key_length: pubBytes.length,
        });
        return [kid, pubBytes];
      }
    }

    logger.debug('no_local_encryption_key_found_will_request_from_upstream', {
      address: addressStr,
      participant,
      available_keys: keys.map((key) => (typeof key.kid === 'string' ? key.kid : 'unknown')),
    });

    throw new Error(`No encryption key found for address ${addressStr}`);
  }

  private resolveKeyProvider(): KeyProvider {
    if (this.keyProvider) {
      return this.keyProvider;
    }
    return getKeyProvider();
  }

  private async tryResolveLocalEncryptionKey(
    path: string,
    nodePhysicalPath?: string
  ): Promise<[string, Uint8Array] | null> {
    if (!nodePhysicalPath || path !== nodePhysicalPath) {
      return null;
    }

    const cryptoProvider = getCryptoProvider();
    const keys = cryptoProvider?.getJwks?.()?.keys;
    if (Array.isArray(keys)) {
      for (const key of keys) {
        if (key.use === 'enc' && key.kty === 'OKP' && key.crv === 'X25519' && typeof key.kid === 'string') {
          const x = typeof key.x === 'string' ? key.x : undefined;
          if (!x) {
            continue;
          }
          try {
            validateEncryptionKey(key as Record<string, unknown>);
            const pubBytes = urlsafeBase64Decode(x);
            logger.debug('found_local_node_encryption_key', {
              kid: key.kid,
              pub_key_length: pubBytes.length,
            });
            return [key.kid, pubBytes];
          } catch (error) {
            if (error instanceof JWKValidationError) {
              logger.warning('invalid_local_encryption_key', {
                kid: key.kid,
                error: error.message,
              });
              continue;
            }
            throw error;
          }
        }
      }
    }

    return null;
  }
}
