import type {
  DataFrame,
  FameDeliveryContext,
  FameEnvelope,
  SecurityContext,
} from '@naylence/core';
import { DeliveryOriginType } from '@naylence/core';

import type {
  EncryptionManager,
  EncryptionOptions,
} from '../security/encryption/encryption-manager.js';
import { EncryptionStatus } from '../security/encryption/encryption-manager.js';
import type { KeyManagementHandler } from '../security/keys/key-management-handler.js';
import type { SecurityPolicy } from '../security/policy/security-policy.js';
import {
  CryptoLevel,
  SecurityAction,
} from '../security/policy/security-policy.js';
import type { EnvelopeSigner } from '../security/signing/envelope-signer.js';
import type { EnvelopeVerifier } from '../security/signing/envelope-verifier.js';
import type { NodeLike } from './node-like.js';
import { getLogger } from '../util/logging.js';

const logger = getLogger('naylence.fame.node.envelope_security_handler');

type EncryptionTarget = string;

type MessageType = 'response' | 'protocol-response';

const ENCRYPTION_OPTION_ALIAS_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['recipKid', 'recip_kid'],
  ['recipientKeyId', 'recipient_key_id'],
  ['recipPub', 'recip_pub'],
  ['recipientPublicKey', 'recipient_public_key'],
  ['privKey', 'priv_key'],
  ['privateKey', 'private_key'],
  ['channelKey', 'channel_key'],
  ['requestAddress', 'request_address'],
  ['encryptionType', 'encryption_type'],
];

function normalizeEncryptionOptions(options: EncryptionOptions): EncryptionOptions;
function normalizeEncryptionOptions(
  options?: EncryptionOptions
): EncryptionOptions | undefined {
  if (!options) {
    return undefined;
  }

  const normalized: Record<string, unknown> = { ...options };

  for (const [camelKey, snakeKey] of ENCRYPTION_OPTION_ALIAS_PAIRS) {
    const camelValue = normalized[camelKey];
    const snakeValue = normalized[snakeKey];

    if (camelValue !== undefined && snakeValue === undefined) {
      normalized[snakeKey] = camelValue;
      continue;
    }

    if (snakeValue !== undefined && camelValue === undefined) {
      normalized[camelKey] = snakeValue;
    }
  }

  return normalized as EncryptionOptions;
}

function isDataFrame(frame: FameEnvelope['frame']): frame is DataFrame {
  return frame.type === 'Data';
}

function isResponseMessage(type: string | undefined): type is MessageType {
  return type === 'response' || type === 'protocol-response';
}

export class EnvelopeSecurityHandler {
  private readonly node: NodeLike;
  private readonly envelopeSigner: EnvelopeSigner | null;
  private readonly envelopeVerifier: EnvelopeVerifier | null;
  private readonly encryptionManager: EncryptionManager | null;
  private readonly securityPolicy: SecurityPolicy;
  private readonly keyManagementHandler: KeyManagementHandler;

  constructor(options: {
    nodeLike: NodeLike;
    envelopeSigner: EnvelopeSigner | null;
    envelopeVerifier: EnvelopeVerifier | null;
    encryptionManager: EncryptionManager | null;
    securityPolicy: SecurityPolicy;
    keyManagementHandler: KeyManagementHandler;
  }) {
    this.node = options.nodeLike;
    this.envelopeSigner = options.envelopeSigner;
    this.envelopeVerifier = options.envelopeVerifier;
    this.encryptionManager = options.encryptionManager;
    this.securityPolicy = options.securityPolicy;
    this.keyManagementHandler = options.keyManagementHandler;
  }

  public async handleOutboundSecurity(
    envelope: FameEnvelope,
    context: FameDeliveryContext
  ): Promise<boolean> {
    const shouldSign = this.securityPolicy
      ? await this.securityPolicy.shouldSignEnvelope(
          envelope,
          context,
          this.node
        )
      : false;

    logger.debug('checking_signing', {
      has_signer: Boolean(this.envelopeSigner),
      should_sign: shouldSign,
      envp_id: envelope.id,
    });

    if (shouldSign) {
      if (!this.envelopeSigner) {
        throw new Error('EnvelopeSigner is not configured');
      }

      if (!envelope.sid) {
        const sid = this.node.sid ?? undefined;
        if (sid) {
          envelope.sid = sid;
        }
      }

      this.envelopeSigner.signEnvelope(envelope, {
        physicalPath: this.node.physicalPath,
      });
    }

    const shouldEncrypt = this.securityPolicy
      ? await this.securityPolicy.shouldEncryptEnvelope(
          envelope,
          context,
          this.node
        )
      : false;

    logger.debug('checking_encryption', {
      has_encryption_manager: Boolean(this.encryptionManager),
      should_encrypt: shouldEncrypt,
      envp_id: envelope.id,
      destination: envelope.to ? String(envelope.to) : undefined,
    });

    if (this.encryptionManager && this.securityPolicy) {
      if (envelope.sec?.enc) {
        logger.debug('skipping_encryption_already_encrypted', {
          envp_id: envelope.id,
          destination: envelope.to ? String(envelope.to) : undefined,
        });
        return true;
      }

      const messageType = context.meta?.['message-type'] as string | undefined;
      let desiredCryptoLevel: CryptoLevel;

      if (isResponseMessage(messageType)) {
        const requestCryptoLevel =
          (context.security?.inboundCryptoLevel as CryptoLevel | undefined) ??
          CryptoLevel.PLAINTEXT;

        desiredCryptoLevel =
          await this.securityPolicy.decideResponseCryptoLevel(
            requestCryptoLevel,
            envelope,
            context
          );

        logger.debug('response_crypto_level_decided', {
          envp_id: envelope.id,
          crypto_level: desiredCryptoLevel,
          destination: envelope.to ? String(envelope.to) : undefined,
          original_request_crypto_level: requestCryptoLevel,
          original_request_id: context.meta?.['response-to-id'],
        });
      } else {
        desiredCryptoLevel =
          await this.securityPolicy.decideOutboundCryptoLevel(
            envelope,
            context,
            this.node
          );

        logger.debug('outbound_crypto_level_decided', {
          envp_id: envelope.id,
          frame_type: envelope.frame.type,
          crypto_level: desiredCryptoLevel,
          destination: envelope.to ? String(envelope.to) : undefined,
        });
      }

      if (desiredCryptoLevel === CryptoLevel.SEALED) {
        logger.debug('applying_sealed_encryption', { envp_id: envelope.id });
        return await this.handleSealedEncryption(envelope, context);
      }

      if (desiredCryptoLevel === CryptoLevel.CHANNEL) {
        logger.debug('applying_channel_encryption', { envp_id: envelope.id });
        return await this.handleChannelEncryption(envelope, context);
      }
    } else if (this.encryptionManager && shouldEncrypt) {
      return await this.handleToBeEncryptedEnvelope(envelope, context);
    }

    return true;
  }

  public async handleEnvelopeSecurity(
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<[FameEnvelope, boolean]> {
    if (!context || context.originType === DeliveryOriginType.LOCAL) {
      return [envelope, true];
    }

    if (context && this.securityPolicy) {
      const inboundCryptoLevel = this.securityPolicy.classifyMessageCryptoLevel(
        envelope,
        context
      );
      const existingLevel = context.security?.inboundCryptoLevel as
        | CryptoLevel
        | undefined;

      let resolvedLevel = inboundCryptoLevel;
      if (existingLevel) {
        if (
          existingLevel === CryptoLevel.SEALED &&
          inboundCryptoLevel !== CryptoLevel.SEALED
        ) {
          resolvedLevel = existingLevel;
        } else if (
          existingLevel === CryptoLevel.CHANNEL &&
          inboundCryptoLevel === CryptoLevel.PLAINTEXT
        ) {
          resolvedLevel = existingLevel;
        }
      }

      if (!context.security) {
        context.security = {} as SecurityContext;
      }

      context.security.inboundCryptoLevel = resolvedLevel;
    }

    if (context) {
      if (!context.security) {
        context.security = {} as SecurityContext;
      }
      context.security.inboundWasSigned = this.isSigned(envelope, context);
    }

    if (this.isSigned(envelope, context) && context) {
      const verified = await this.handleSignedEnvelope(envelope, context);
      if (!verified) {
        return [envelope, false];
      }
    } else if (
      context &&
      this.securityPolicy.isSignatureRequired(envelope, context)
    ) {
      const frameType = envelope.frame.type;
      if (
        frameType === 'KeyRequest' ||
        frameType === 'KeyAnnounce' ||
        frameType === 'SecureOpen' ||
        frameType === 'SecureAccept'
      ) {
        logger.error('critical_frame_unsigned_rejected', {
          envp_id: envelope.id,
          frame_type: frameType,
          reason: 'critical_frames_must_be_signed',
        });
        return [envelope, false];
      }

      const action = this.securityPolicy.getUnsignedViolationAction(
        envelope,
        context
      );
      logger.warning('unsigned_envelope_violation', {
        envp_id: envelope.id,
        frame_type: frameType,
        action,
      });

      if (action === SecurityAction.REJECT || action === SecurityAction.NACK) {
        return [envelope, false];
      }
    }

    return [envelope, true];
  }

  public async handleChannelHandshakeComplete(
    channelId: string,
    destination: string
  ): Promise<void> {
    logger.debug('channel_handshake_completed', {
      channel_id: channelId,
      destination,
    });

    if (this.encryptionManager?.notifyChannelEstablished) {
      await this.encryptionManager.notifyChannelEstablished(channelId);
      logger.debug('notified_encryption_manager_channel_ready', {
        channel_id: channelId,
      });
    }
  }

  public async handleChannelHandshakeFailed(
    channelId: string,
    destination: string,
    reason = 'handshake_failed'
  ): Promise<void> {
    logger.debug('channel_handshake_failed', {
      channel_id: channelId,
      destination,
      reason,
    });

    if (this.encryptionManager?.notifyChannelFailed) {
      await this.encryptionManager.notifyChannelFailed(channelId, reason);
      logger.debug('notified_encryption_manager_channel_failed', {
        channel_id: channelId,
        reason,
      });
      return;
    }

    await this.handleFailedChannelEnvelopeCleanup(destination, reason);
  }

  public async shouldDecryptEnvelope(
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<boolean> {
    if (
      this.encryptionManager &&
      (await this.securityPolicy.shouldDecryptEnvelope(
        envelope,
        context,
        this.node
      ))
    ) {
      return true;
    }

    if (envelope.sec?.enc) {
      const cryptoLevel = this.securityPolicy.classifyMessageCryptoLevel(
        envelope,
        context
      );
      if (cryptoLevel === CryptoLevel.CHANNEL) {
        return true;
      }
    }

    return false;
  }

  public async decryptEnvelope(
    envelope: FameEnvelope,
    options?: EncryptionOptions
  ): Promise<FameEnvelope> {
    if (!this.encryptionManager) {
      throw new Error('No encryption manager available for decryption');
    }

    return await this.encryptionManager.decryptEnvelope(envelope, options);
  }

  private async handleSignedEnvelope(
    envelope: FameEnvelope,
    context: FameDeliveryContext
  ): Promise<boolean> {
    if (!context.originType) {
      throw new Error('Context origin type must be provided');
    }

    if (!envelope.sec?.sig) {
      throw new Error('Signed envelope missing signature header');
    }

    if (!this.envelopeVerifier) {
      throw new Error('EnvelopeVerifier is not configured');
    }

    const fromSystemId = context.fromSystemId ?? 'pending-attachment';
    const kid = envelope.sec.sig.kid;

    if (!kid) {
      throw new Error('Signature header missing key identifier');
    }

    if (await this.keyManagementHandler.hasKey(kid)) {
      const verified = await this.envelopeVerifier.verifyEnvelope(envelope, {
        checkPayload: false,
      });
      if (verified) {
        logger.debug('envelope_verified', {
          envp_id: envelope.id,
          sid: envelope.sid,
          kid,
        });
        return true;
      }

      throw new Error(`Envelope signature verification failed for kid=${kid}`);
    }

    this.keyManagementHandler.queuePendingSignedEnvelope(
      kid,
      envelope,
      context
    );
    await this.keyManagementHandler.maybeRequestSigningKey(
      kid,
      context.originType,
      fromSystemId
    );

    logger.debug('queued_envelope_missing_signing_key', {
      kid,
      envp_id: envelope.id,
    });
    return false;
  }

  private async handleSealedEncryption(
    envelope: FameEnvelope,
    context: FameDeliveryContext
  ): Promise<boolean> {
    if (!envelope.to) {
      logger.warning('sealed_encryption_requested_but_no_destination', {
        envp_id: envelope.id,
      });
      return true;
    }

    try {
      const rawOptions = await this.securityPolicy.getEncryptionOptions(
        envelope,
        context,
        this.node
      );
      const options = rawOptions
        ? normalizeEncryptionOptions(rawOptions)
        : undefined;

      if (options) {
        if (options.encryptionType === 'channel') {
          logger.warning('policy_returned_channel_for_sealed_request', {
            envp_id: envelope.id,
          });
          return await this.handleToBeEncryptedEnvelopeWithOptions(
            envelope,
            context,
            normalizeEncryptionOptions({
              requestAddress: envelope.to,
            })
          );
        }

        logger.debug('using_sealed_encryption_options', {
          envp_id: envelope.id,
          options,
        });
        return await this.handleToBeEncryptedEnvelopeWithOptions(
          envelope,
          context,
          options
        );
      }

      logger.debug('no_encryption_options_requesting_key', {
        envp_id: envelope.id,
      });
      return await this.handleToBeEncryptedEnvelopeWithOptions(
        envelope,
        context,
        normalizeEncryptionOptions({
          requestAddress: envelope.to,
        })
      );
    } catch (error) {
      logger.debug('sealed_key_lookup_failed_requesting', {
        envp_id: envelope.id,
        error: error instanceof Error ? error.message : String(error),
      });

      return await this.handleToBeEncryptedEnvelopeWithOptions(
        envelope,
        context,
        normalizeEncryptionOptions({
          requestAddress: envelope.to,
        })
      );
    }
  }

  private async handleChannelEncryption(
    envelope: FameEnvelope,
    context: FameDeliveryContext
  ): Promise<boolean> {
    if (!envelope.to) {
      logger.warning('channel_encryption_requested_but_no_destination', {
        envp_id: envelope.id,
      });
      return true;
    }

    return await this.handleToBeEncryptedEnvelopeWithOptions(
      envelope,
      context,
      normalizeEncryptionOptions({
        encryptionType: 'channel',
        destination: envelope.to,
      })
    );
  }

  private async handleToBeEncryptedEnvelope(
    envelope: FameEnvelope,
    context: FameDeliveryContext
  ): Promise<boolean> {
    if (!this.encryptionManager) {
      return true;
    }

    if (context.originType !== DeliveryOriginType.LOCAL) {
      logger.warning('envelope_encryption_rejected_non_local', {
        origin: context.originType,
      });
      return true;
    }

    if (!isDataFrame(envelope.frame)) {
      logger.trace('skipping_encryption_non_dataframe', {
        envp_id: envelope.id,
        frame_type: envelope.frame.type,
      });
      return true;
    }

    const rawOptions = await this.securityPolicy.getEncryptionOptions(
      envelope,
      context,
      this.node
    );
    const options = rawOptions
      ? normalizeEncryptionOptions(rawOptions)
      : undefined;
    if (!options) {
      logger.warning('no_encryption_options_provided', {
        envp_id: envelope.id,
      });
      return true;
    }

    return await this.performEncryption(envelope, context, options);
  }

  private async handleToBeEncryptedEnvelopeWithOptions(
    envelope: FameEnvelope,
    context: FameDeliveryContext,
    encryptionOptions: EncryptionOptions
  ): Promise<boolean> {
    if (!this.encryptionManager) {
      return true;
    }

    if (context.originType !== DeliveryOriginType.LOCAL) {
      logger.warning('envelope_encryption_rejected_non_local', {
        origin: context.originType,
      });
      return true;
    }

    if (!isDataFrame(envelope.frame)) {
      logger.trace('skipping_encryption_non_dataframe', {
        envp_id: envelope.id,
        frame_type: envelope.frame.type,
      });
      return true;
    }

    const normalizedOptions = normalizeEncryptionOptions(encryptionOptions);
    return await this.performEncryption(envelope, context, normalizedOptions);
  }

  private async performEncryption(
    envelope: FameEnvelope,
    context: FameDeliveryContext,
    encryptionOptions: EncryptionOptions
  ): Promise<boolean> {
    if (!this.encryptionManager) {
      return true;
    }

    const normalizedOptions = normalizeEncryptionOptions(encryptionOptions);

    // Skip encryption if envelope is already encrypted
    // This prevents re-queuing when replayed envelopes go through security again
    if (envelope.sec?.enc) {
      logger.debug('skipping_encryption_already_encrypted', {
        envp_id: envelope.id,
        destination: envelope.to ? String(envelope.to) : undefined,
      });
      return true;
    }

    try {
      const result = await this.encryptionManager.encryptEnvelope(
        envelope,
        normalizedOptions
      );

      if (result.status === EncryptionStatus.QUEUED) {
        logger.debug('envelope_queued_for_encryption', {
          envp_id: envelope.id,
        });
        await this.handleEncryptionQueueing(
          envelope,
          context,
          normalizedOptions
        );
        return false;
      }

      if (result.status === EncryptionStatus.OK) {
        logger.debug('envelope_encrypted', { envp_id: envelope.id });
        if (result.envelope) {
          envelope.frame = result.envelope.frame;
          envelope.sec = result.envelope.sec;
        }
        return true;
      }

      if (result.status === EncryptionStatus.SKIPPED) {
        logger.debug('envelope_encryption_skipped', { envp_id: envelope.id });
        return true;
      }

      logger.warning('unknown_encryption_status', {
        envp_id: envelope.id,
        status: result.status,
      });
      return true;
    } catch (error) {
      logger.error('encryption_failed', {
        envp_id: envelope.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  }

  private async handleEncryptionQueueing(
    envelope: FameEnvelope,
    context: FameDeliveryContext,
    options: EncryptionOptions
  ): Promise<void> {
    if (!context.originType) {
      throw new Error(
        'Delivery context must include origin type for encryption queueing'
      );
    }

    if (!this.encryptionManager) {
      return;
    }

    if (!this.keyManagementHandler) {
      return;
    }

    const fromSystemId = context.fromSystemId ?? 'unknown';
    const normalizedOptions = normalizeEncryptionOptions(options);

    if (
      normalizedOptions.recipKid ||
      normalizedOptions.recip_kid ||
      normalizedOptions.recipientKeyId
    ) {
      const kid = (normalizedOptions.recipKid ??
        normalizedOptions.recip_kid ??
        normalizedOptions.recipientKeyId) as EncryptionTarget;
      // Queue envelope for replay when key arrives
      this.keyManagementHandler.queuePendingEncryptionEnvelope(
        kid,
        envelope,
        context
      );
      await this.keyManagementHandler.maybeRequestEncryptionKey(
        kid,
        context.originType,
        fromSystemId
      );
      return;
    }

    if (normalizedOptions.requestAddress) {
      const addressKey = String(normalizedOptions.requestAddress);
      // Queue envelope for replay when key arrives
      this.keyManagementHandler.queuePendingEncryptionEnvelope(
        addressKey,
        envelope,
        context
      );
      // Trigger correlated KeyRequest for key arrival notification
      await this.keyManagementHandler.maybeRequestEncryptionKeyByAddress(
        normalizedOptions.requestAddress,
        context.originType,
        fromSystemId
      );
      return;
    }

    if (normalizedOptions.encryptionType === 'channel') {
      logger.debug('channel_encryption_queueing_handled_internally', {
        envp_id: envelope.id,
        destination: normalizedOptions.destination
          ? String(normalizedOptions.destination)
          : undefined,
      });
      return;
    }

    logger.warning('unknown_encryption_queueing_options', {
      envp_id: envelope.id,
      options: normalizedOptions,
    });
  }

  private async handleFailedChannelEnvelopeCleanup(
    destination: string,
    reason: string
  ): Promise<void> {
    logger.debug('channel_handshake_failure_cleanup_attempted', {
      destination,
      reason,
      note: 'envelope_cleanup_handled_by_encryption_manager',
    });
  }

  private isSigned(
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): boolean {
    return Boolean(envelope.sec?.sig && context);
  }
}
