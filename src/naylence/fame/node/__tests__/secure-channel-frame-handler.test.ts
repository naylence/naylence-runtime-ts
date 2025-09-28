import { Buffer } from 'node:buffer';
import type { FameEnvelope, FameDeliveryContext } from 'naylence-core';
import { DeliveryOriginType, FameResponseType } from 'naylence-core';

import type { SecureOpenFrame, SecureAcceptFrame, SecureCloseFrame } from 'naylence-core';
import type { SecureChannelManager } from '../../security/encryption/secure-channel-manager.js';
import type { EnvelopeFactory } from 'naylence-core';
import type { EnvelopeSecurityHandler } from '../envelope-security-handler.js';
import { SecureChannelFrameHandler } from '../secure-channel-frame-handler.js';

const VALID_KEY = Buffer.alloc(32, 1).toString('base64');

type Mutable<T> = {
  -readonly [K in keyof T]: T[K];
};

function createManagerMock(): jest.Mocked<SecureChannelManager> {
  const manager: Partial<Mutable<SecureChannelManager>> = {
    channels: {},
    generateOpenFrame: jest.fn(),
    handleOpenFrame: jest.fn(),
    handleAcceptFrame: jest.fn(),
    handleCloseFrame: jest.fn(),
    isChannelEncrypted: jest.fn(),
    hasChannel: jest.fn(),
    getChannelInfo: jest.fn(),
    closeChannel: jest.fn(),
    cleanupExpiredChannels: jest.fn(),
    addChannel: jest.fn(),
    removeChannel: jest.fn(),
  };

  return manager as jest.Mocked<SecureChannelManager>;
}

function createEnvelopeFactoryMock(): jest.Mocked<EnvelopeFactory> {
  return {
    createEnvelope: jest.fn(),
  } as unknown as jest.Mocked<EnvelopeFactory>;
}

type SendFn = (envelope: FameEnvelope, context?: FameDeliveryContext | null) => Promise<void>;

function createSendCallbackMock(): jest.MockedFunction<SendFn> {
  return jest.fn<ReturnType<SendFn>, Parameters<SendFn>>().mockResolvedValue(undefined);
}

function createEnvelope<T extends SecureOpenFrame | SecureAcceptFrame | SecureCloseFrame>(
  frame: T,
  extras: Partial<FameEnvelope> = {}
): FameEnvelope {
  return {
    id: 'env-1',
    sid: 'sid-1',
    traceId: 'trace-1',
    frame,
    ts: new Date(),
    ...extras,
  } as FameEnvelope;
}

describe('SecureChannelFrameHandler', () => {
  it('throws when secure channel manager is missing on secure open', async () => {
    const handler = new SecureChannelFrameHandler({
      secureChannelManager: null,
      envelopeFactory: createEnvelopeFactoryMock(),
      sendCallback: jest.fn(),
    });

    const envelope = createEnvelope({
      type: 'SecureOpen',
      cid: 'auto-dest-123',
      ephPub: VALID_KEY,
      alg: 'CHACHA20P1305',
      opts: 0,
    });

    await expect(handler.handleSecureOpen(envelope)).rejects.toThrow('SecureChannelManager is not initialized');
  });

  it('throws when secure open frame has unexpected type', async () => {
    const manager = createManagerMock();
    const handler = new SecureChannelFrameHandler({
      secureChannelManager: manager,
      envelopeFactory: createEnvelopeFactoryMock(),
      sendCallback: jest.fn(),
    });

    const envelope = createEnvelope({
      type: 'SecureAccept',
      cid: 'auto-dest-123',
      ephPub: VALID_KEY,
      alg: 'CHACHA20P1305',
      ok: true,
    } as SecureAcceptFrame);

    await expect(handler.handleSecureOpen(envelope)).rejects.toThrow('Expected SecureOpen frame, got SecureAccept');
  });

  it('sends secure accept with stickiness and handshake when open succeeds', async () => {
    const manager = createManagerMock();
    const acceptFrame: SecureAcceptFrame = {
      type: 'SecureAccept',
      cid: 'auto-destination-123',
      ok: true,
      ephPub: VALID_KEY,
      alg: 'CHACHA20P1305',
    };
    manager.handleOpenFrame.mockResolvedValue(acceptFrame);

    const responseEnvelope = { id: 'resp', frame: acceptFrame } as FameEnvelope;
    const envelopeFactory = createEnvelopeFactoryMock();
    envelopeFactory.createEnvelope.mockReturnValue(responseEnvelope);

  const sendCallback = createSendCallbackMock();

    const securityHandler: Pick<EnvelopeSecurityHandler, 'handleChannelHandshakeComplete' | 'handleChannelHandshakeFailed'> = {
      handleChannelHandshakeComplete: jest.fn().mockResolvedValue(undefined),
      handleChannelHandshakeFailed: jest.fn().mockResolvedValue(undefined),
    };

    const handler = new SecureChannelFrameHandler({
      secureChannelManager: manager,
      envelopeFactory,
      sendCallback,
      envelopeSecurityHandler: securityHandler as EnvelopeSecurityHandler,
    });

    const openEnvelope = createEnvelope<SecureOpenFrame>({
      type: 'SecureOpen',
      cid: 'auto-destination-123',
      ephPub: VALID_KEY,
      alg: 'CHACHA20P1305',
      opts: 0,
    }, {
      replyTo: 'reply-address',
      corrId: 'corr-7',
    });

    await handler.handleSecureOpen(openEnvelope);

    expect(manager.handleOpenFrame).toHaveBeenCalledWith(openEnvelope.frame);
    expect(envelopeFactory.createEnvelope).toHaveBeenCalledWith({
      frame: acceptFrame,
      to: 'reply-address',
      corrId: 'corr-7',
    });
    expect(sendCallback).toHaveBeenCalledWith(responseEnvelope, {
      originType: DeliveryOriginType.LOCAL,
      stickinessRequired: true,
      stickySid: 'sid-1',
      expectedResponseType: FameResponseType.NONE,
    });
    expect(securityHandler.handleChannelHandshakeComplete).toHaveBeenCalledWith('auto-destination-123', 'destination');
    expect(securityHandler.handleChannelHandshakeFailed).not.toHaveBeenCalled();
  });

  it('does not notify handshake complete when channel id is not auto-derived', async () => {
    const manager = createManagerMock();
    const acceptFrame: SecureAcceptFrame = {
      type: 'SecureAccept',
      cid: 'manual-destination-123',
      ok: true,
      ephPub: VALID_KEY,
      alg: 'CHACHA20P1305',
    };
    manager.handleOpenFrame.mockResolvedValue(acceptFrame);

    const envelopeFactory = createEnvelopeFactoryMock();
    const responseEnvelope = { id: 'resp', frame: acceptFrame } as FameEnvelope;
    envelopeFactory.createEnvelope.mockReturnValue(responseEnvelope);

  const sendCallback = createSendCallbackMock();

    const securityHandler: Pick<EnvelopeSecurityHandler, 'handleChannelHandshakeComplete'> = {
      handleChannelHandshakeComplete: jest.fn().mockResolvedValue(undefined),
    };

    const handler = new SecureChannelFrameHandler({
      secureChannelManager: manager,
      envelopeFactory,
      sendCallback,
      envelopeSecurityHandler: securityHandler as EnvelopeSecurityHandler,
    });

    const openEnvelope = createEnvelope<SecureOpenFrame>({
      type: 'SecureOpen',
      cid: 'manual-destination-123',
      ephPub: VALID_KEY,
      alg: 'CHACHA20P1305',
      opts: 0,
    });

    await handler.handleSecureOpen(openEnvelope);

    expect(sendCallback).toHaveBeenCalledWith(responseEnvelope, expect.objectContaining({ stickinessRequired: true }));
    expect(securityHandler.handleChannelHandshakeComplete).not.toHaveBeenCalled();
  });

  it('sends accept without stickiness when handshake fails', async () => {
    const manager = createManagerMock();
    const acceptFrame: SecureAcceptFrame = {
      type: 'SecureAccept',
      cid: 'auto-destination-123',
      ok: false,
      ephPub: VALID_KEY,
      alg: 'CHACHA20P1305',
    };
    manager.handleOpenFrame.mockResolvedValue(acceptFrame);

    const envelopeFactory = createEnvelopeFactoryMock();
    const responseEnvelope = { id: 'resp', frame: acceptFrame } as FameEnvelope;
    envelopeFactory.createEnvelope.mockReturnValue(responseEnvelope);

  const sendCallback = createSendCallbackMock();

    const securityHandler: Pick<EnvelopeSecurityHandler, 'handleChannelHandshakeComplete'> = {
      handleChannelHandshakeComplete: jest.fn().mockResolvedValue(undefined),
    };

    const handler = new SecureChannelFrameHandler({
      secureChannelManager: manager,
      envelopeFactory,
      sendCallback,
      envelopeSecurityHandler: securityHandler as EnvelopeSecurityHandler,
    });

    const openEnvelope = createEnvelope<SecureOpenFrame>({
      type: 'SecureOpen',
      cid: 'auto-destination-123',
      ephPub: VALID_KEY,
      alg: 'CHACHA20P1305',
      opts: 0,
    });

    await handler.handleSecureOpen(openEnvelope);

    expect(sendCallback).toHaveBeenCalledWith(responseEnvelope, null);
    expect(securityHandler.handleChannelHandshakeComplete).not.toHaveBeenCalled();
  });

  it('logs warning when secure accept handling fails', async () => {
    const manager = createManagerMock();
    manager.handleAcceptFrame.mockResolvedValue(false);

    const handler = new SecureChannelFrameHandler({
      secureChannelManager: manager,
      envelopeFactory: createEnvelopeFactoryMock(),
      sendCallback: createSendCallbackMock(),
    });

    const envelope = createEnvelope<SecureAcceptFrame>({
      type: 'SecureAccept',
      cid: 'auto-destination-123',
      ok: true,
      ephPub: VALID_KEY,
      alg: 'CHACHA20P1305',
    });

    await handler.handleSecureAccept(envelope);

    expect(manager.handleAcceptFrame).toHaveBeenCalledWith(envelope.frame);
  });

  it('notifies both handshake completion and failure when accept is negative', async () => {
    const manager = createManagerMock();
    manager.handleAcceptFrame.mockResolvedValue(true);

    const securityHandler: Pick<EnvelopeSecurityHandler, 'handleChannelHandshakeComplete' | 'handleChannelHandshakeFailed'> = {
      handleChannelHandshakeComplete: jest.fn().mockResolvedValue(undefined),
      handleChannelHandshakeFailed: jest.fn().mockResolvedValue(undefined),
    };

    const handler = new SecureChannelFrameHandler({
      secureChannelManager: manager,
  envelopeFactory: createEnvelopeFactoryMock(),
  sendCallback: createSendCallbackMock(),
      envelopeSecurityHandler: securityHandler as EnvelopeSecurityHandler,
    });

    const envelope = createEnvelope<SecureAcceptFrame>({
      type: 'SecureAccept',
      cid: 'auto-destination-123',
      ok: false,
      ephPub: VALID_KEY,
      alg: 'CHACHA20P1305',
    });

    await handler.handleSecureAccept(envelope);

    expect(securityHandler.handleChannelHandshakeComplete).toHaveBeenCalledWith('auto-destination-123', 'destination');
    expect(securityHandler.handleChannelHandshakeFailed).toHaveBeenCalledWith(
      'auto-destination-123',
      'destination',
      'negative_secure_accept'
    );
  });

  it('establishes channel without failure notification when accept is positive', async () => {
    const manager = createManagerMock();
    manager.handleAcceptFrame.mockResolvedValue(true);

    const securityHandler: Pick<EnvelopeSecurityHandler, 'handleChannelHandshakeComplete' | 'handleChannelHandshakeFailed'> = {
      handleChannelHandshakeComplete: jest.fn().mockResolvedValue(undefined),
      handleChannelHandshakeFailed: jest.fn().mockResolvedValue(undefined),
    };

    const handler = new SecureChannelFrameHandler({
      secureChannelManager: manager,
  envelopeFactory: createEnvelopeFactoryMock(),
  sendCallback: createSendCallbackMock(),
      envelopeSecurityHandler: securityHandler as EnvelopeSecurityHandler,
    });

    const envelope = createEnvelope<SecureAcceptFrame>({
      type: 'SecureAccept',
      cid: 'auto-destination-123',
      ok: true,
      ephPub: VALID_KEY,
      alg: 'CHACHA20P1305',
    });

    await handler.handleSecureAccept(envelope);

    expect(securityHandler.handleChannelHandshakeComplete).toHaveBeenCalledTimes(1);
    expect(securityHandler.handleChannelHandshakeFailed).not.toHaveBeenCalled();
  });

  it('delegates secure close handling to the manager', async () => {
    const manager = createManagerMock();
    const handler = new SecureChannelFrameHandler({
      secureChannelManager: manager,
  envelopeFactory: createEnvelopeFactoryMock(),
  sendCallback: createSendCallbackMock(),
    });

    const envelope = createEnvelope<SecureCloseFrame>({
      type: 'SecureClose',
      cid: 'auto-destination-123',
      reason: 'shutdown',
    });

    await handler.handleSecureClose(envelope);

    expect(manager.handleCloseFrame).toHaveBeenCalledWith(envelope.frame);
  });
});
