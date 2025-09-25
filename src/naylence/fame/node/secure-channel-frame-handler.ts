import type { EnvelopeFactory, FameDeliveryContext, FameEnvelope } from 'naylence-core';
import { DeliveryOriginType, FameResponseType } from 'naylence-core';
import type { SecureAcceptFrame, SecureCloseFrame, SecureOpenFrame } from 'naylence-core';

import type { SecureChannelManager } from '../security/encryption/secure-channel-manager.js';
import type { EnvelopeSecurityHandler } from './envelope-security-handler.js';
import { getLogger } from '../util/logging.js';

const logger = getLogger('secure-channel-frame-handler');

type SendCallback = (envelope: FameEnvelope, context?: FameDeliveryContext | null) => Promise<void>;

type SecureFrame = SecureOpenFrame | SecureAcceptFrame | SecureCloseFrame;

type SecureFrameType = SecureFrame['type'];

function assertSecureChannelManager(manager: SecureChannelManager | null | undefined): asserts manager is SecureChannelManager {
  if (!manager) {
    throw new Error('SecureChannelManager is not initialized');
  }
}

function assertFrameType<T extends SecureFrameType>(frame: FameEnvelope['frame'], expectedType: T): asserts frame is Extract<SecureFrame, { type: T }> {
  if (frame.type !== expectedType) {
    throw new Error(`Expected ${expectedType} frame, got ${frame.type}`);
  }
}

function extractDestinationFromChannelId(channelId: string): string | null {
  if (!channelId.startsWith('auto-')) {
    return null;
  }

  const parts = channelId.split('-');
  if (parts.length < 3) {
    return null;
  }

  return parts.slice(1, -1).join('-');
}

export class SecureChannelFrameHandler {
  constructor(
    private readonly options: {
      secureChannelManager: SecureChannelManager | null;
      envelopeFactory: EnvelopeFactory;
      sendCallback: SendCallback;
      envelopeSecurityHandler?: EnvelopeSecurityHandler | null;
    }
  ) {}

  private get secureChannelManager(): SecureChannelManager | null {
    return this.options.secureChannelManager;
  }

  private get envelopeFactory(): EnvelopeFactory {
    return this.options.envelopeFactory;
  }

  private get sendCallback(): SendCallback {
    return this.options.sendCallback;
  }

  private get envelopeSecurityHandler(): EnvelopeSecurityHandler | null {
    return this.options.envelopeSecurityHandler ?? null;
  }

  public async handleSecureOpen(envelope: FameEnvelope, _context?: FameDeliveryContext | null): Promise<void> {
    assertSecureChannelManager(this.secureChannelManager);

    const frame = envelope.frame;
    assertFrameType(frame, 'SecureOpen');

    logger.debug('received_secure_open', { cid: frame.cid, algorithm: frame.alg });

    const acceptFrame = await this.secureChannelManager.handleOpenFrame(frame);

    const responseOptions: Parameters<EnvelopeFactory['createEnvelope']>[0] = {
      frame: acceptFrame,
    };

    if (envelope.replyTo !== undefined && envelope.replyTo !== null) {
      responseOptions.to = envelope.replyTo;
    }

    if (envelope.corrId !== undefined && envelope.corrId !== null) {
      responseOptions.corrId = envelope.corrId;
    }

    const responseEnvelope = this.envelopeFactory.createEnvelope(responseOptions);

    let responseContext: FameDeliveryContext | null = null;
    if (acceptFrame.ok) {
      responseContext = {
        originType: DeliveryOriginType.LOCAL,
        stickinessRequired: true,
        stickySid: envelope.sid ?? undefined,
        expectedResponseType: FameResponseType.NONE,
      };

      logger.debug('stickiness_requested_for_channel_encryption', {
        cid: frame.cid,
        reason: 'secure_channel_established',
      });
    }

    await this.sendCallback(responseEnvelope, responseContext);
    logger.debug('sent_secure_accept', { cid: frame.cid, ok: acceptFrame.ok });

    if (acceptFrame.ok && this.envelopeSecurityHandler) {
      const destination = extractDestinationFromChannelId(frame.cid);
      if (destination) {
        await this.envelopeSecurityHandler.handleChannelHandshakeComplete(frame.cid, destination);
      }
    }
  }

  public async handleSecureAccept(envelope: FameEnvelope, _context?: FameDeliveryContext | null): Promise<void> {
    assertSecureChannelManager(this.secureChannelManager);

    const frame = envelope.frame;
    assertFrameType(frame, 'SecureAccept');

    logger.debug('received_secure_accept', { cid: frame.cid, ok: frame.ok });

    const success = await this.secureChannelManager.handleAcceptFrame(frame);

    if (!success) {
      logger.warning('failed_to_complete_channel', { cid: frame.cid });
    } else {
      logger.debug('channel_established', { cid: frame.cid });

      if (this.envelopeSecurityHandler) {
        const destination = extractDestinationFromChannelId(frame.cid);
        if (destination) {
          await this.envelopeSecurityHandler.handleChannelHandshakeComplete(frame.cid, destination);
        }
      }
    }

    if (!frame.ok && this.envelopeSecurityHandler) {
      const destination = extractDestinationFromChannelId(frame.cid);
      if (destination) {
        await this.envelopeSecurityHandler.handleChannelHandshakeFailed(frame.cid, destination, 'negative_secure_accept');
        logger.debug('notified_handshake_failure', {
          cid: frame.cid,
          destination,
        });
      }
    }
  }

  public async handleSecureClose(envelope: FameEnvelope, _context?: FameDeliveryContext | null): Promise<void> {
    assertSecureChannelManager(this.secureChannelManager);

    const frame = envelope.frame;
    assertFrameType(frame, 'SecureClose');

    logger.debug('received_secure_close', { cid: frame.cid, reason: frame.reason });

    this.secureChannelManager.handleCloseFrame(frame);
  }
}
