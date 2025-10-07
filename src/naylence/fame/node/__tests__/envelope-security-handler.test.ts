import {
  DeliveryOriginType,
  type EnvelopeFactory,
  type FameDeliveryContext,
  type FameEnvelope,
  type DataFrame,
} from 'naylence-core';
import {
  EncryptionResult,
  EncryptionStatus,
  type EncryptionManager,
  type EncryptionOptions,
} from '../../security/encryption/encryption-manager.js';
import {
  CryptoLevel,
  SecurityAction,
  SecurityRequirements,
  type SecurityPolicy,
} from '../../security/policy/security-policy.js';
import { EnvelopeSecurityHandler } from '../envelope-security-handler.js';
import type { EnvelopeSigner } from '../../security/signing/envelope-signer.js';
import type { EnvelopeVerifier } from '../../security/signing/envelope-verifier.js';
import type { KeyManagementHandler } from '../../security/keys/key-management-handler.js';
import type { NodeLike } from '../node-like.js';
import type { StorageProvider } from '../../storage/storage-provider.js';

type KeyManagementHandlerMocks = {
  hasKey: jest.Mock<Promise<boolean>, [string]>;
  queuePendingSignedEnvelope: jest.Mock<
    void,
    [string, FameEnvelope, FameDeliveryContext]
  >;
  maybeRequestSigningKey: jest.Mock<
    Promise<void>,
    [string, DeliveryOriginType, string]
  >;
  queuePendingEncryptionEnvelope: jest.Mock<
    void,
    [string, FameEnvelope, FameDeliveryContext]
  >;
  maybeRequestEncryptionKey: jest.Mock<
    Promise<void>,
    [string, DeliveryOriginType, string]
  >;
  maybeRequestEncryptionKeyByAddress: jest.Mock<
    Promise<void>,
    [FameEnvelope['to'], DeliveryOriginType, string]
  >;
};

let envelopeCounter = 0;

function createEnvelope(overrides: Partial<FameEnvelope> = {}): FameEnvelope {
  envelopeCounter += 1;
  const frame: DataFrame = (overrides.frame ?? {
    type: 'Data',
    payload: {},
  }) as DataFrame;
  return {
    id: overrides.id ?? `env-${envelopeCounter}`,
    frame,
    ts: overrides.ts ?? new Date(),
    ...overrides,
  } as FameEnvelope;
}

function createContext(
  overrides: Partial<FameDeliveryContext> = {}
): FameDeliveryContext {
  return {
    originType: DeliveryOriginType.LOCAL,
    ...overrides,
  } as FameDeliveryContext;
}

function createNode(overrides: Partial<NodeLike> = {}): NodeLike {
  const envelopeFactory: EnvelopeFactory = {
    createEnvelope: jest.fn(),
  };

  const node: Partial<NodeLike> = {
    id: 'node-id',
    sid: 'sid-default',
    physicalPath: '/physical/node',
    acceptedLogicals: new Set<string>(),
    envelopeFactory,
    deliveryPolicy: null,
    defaultBindingPath: '/default',
    hasParent: false,
    securityManager: null,
    admissionClient: null,
    eventListeners: [],
    upstreamConnector: null,
    publicUrl: null,
    storageProvider: {} as StorageProvider,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
    bind: jest.fn(),
    unbind: jest.fn(),
    send: jest.fn(),
    listen: jest.fn(),
    listenRpc: jest.fn(),
    invoke: jest.fn(),
    invokeByCapability: jest.fn(),
    invokeByCapabilityStream: jest.fn(),
    invokeStream: jest.fn(),
    deliver: jest.fn(),
    deliverLocal: jest.fn(),
    forwardUpstream: jest.fn(),
    hasLocal: jest.fn(),
    gatherSupportedCallbackGrants: jest.fn(),
    dispatchEvent: jest.fn(),
    dispatchEnvelopeEvent: jest.fn(),
    ...overrides,
  };

  return node as NodeLike;
}

function createSecurityPolicyMock(): jest.Mocked<SecurityPolicy> {
  return {
    shouldSignEnvelope: jest.fn().mockResolvedValue(false),
    shouldEncryptEnvelope: jest.fn().mockResolvedValue(false),
    getEncryptionOptions: jest.fn().mockResolvedValue(undefined),
    shouldVerifySignature: jest.fn().mockResolvedValue(false),
    shouldDecryptEnvelope: jest.fn().mockResolvedValue(false),
    classifyMessageCryptoLevel: jest
      .fn()
      .mockReturnValue(CryptoLevel.PLAINTEXT),
    isInboundCryptoLevelAllowed: jest.fn().mockReturnValue(true),
    getInboundViolationAction: jest.fn().mockReturnValue(SecurityAction.ALLOW),
    decideResponseCryptoLevel: jest
      .fn()
      .mockResolvedValue(CryptoLevel.PLAINTEXT),
    decideOutboundCryptoLevel: jest
      .fn()
      .mockResolvedValue(CryptoLevel.PLAINTEXT),
    isSignatureRequired: jest.fn().mockReturnValue(false),
    getUnsignedViolationAction: jest.fn().mockReturnValue(SecurityAction.ALLOW),
    getInvalidSignatureViolationAction: jest
      .fn()
      .mockReturnValue(SecurityAction.ALLOW),
    requirements: jest.fn().mockReturnValue(new SecurityRequirements()),
    validateAttachSecurityCompatibility: jest.fn(),
  };
}

function createEncryptionManagerMock(): jest.Mocked<EncryptionManager> {
  return {
    encryptEnvelope: jest.fn(),
    decryptEnvelope: jest.fn(),
    notifyChannelEstablished: jest.fn(),
    notifyChannelFailed: jest.fn(),
    nodeStaticPublicKey: undefined,
  } as unknown as jest.Mocked<EncryptionManager>;
}

function createKeyManagementHandlerMock(): {
  instance: KeyManagementHandler;
  fns: KeyManagementHandlerMocks;
} {
  const fns: KeyManagementHandlerMocks = {
    hasKey: jest.fn<Promise<boolean>, [string]>(async () => true),
    queuePendingSignedEnvelope: jest.fn<
      void,
      [string, FameEnvelope, FameDeliveryContext]
    >(),
    maybeRequestSigningKey: jest.fn<
      Promise<void>,
      [string, DeliveryOriginType, string]
    >(async () => undefined),
    queuePendingEncryptionEnvelope: jest.fn<
      void,
      [string, FameEnvelope, FameDeliveryContext]
    >(),
    maybeRequestEncryptionKey: jest.fn<
      Promise<void>,
      [string, DeliveryOriginType, string]
    >(async () => undefined),
    maybeRequestEncryptionKeyByAddress: jest.fn<
      Promise<void>,
      [FameEnvelope['to'], DeliveryOriginType, string]
    >(async () => undefined),
  };

  return {
    instance: fns as unknown as KeyManagementHandler,
    fns,
  };
}

function createHandler(options?: {
  securityPolicy?: jest.Mocked<SecurityPolicy>;
  envelopeSigner?: EnvelopeSigner | null;
  envelopeVerifier?: EnvelopeVerifier | null;
  encryptionManager?: jest.Mocked<EncryptionManager> | null;
  keyManagement?: {
    instance: KeyManagementHandler;
    fns: KeyManagementHandlerMocks;
  };
  node?: NodeLike;
}) {
  const securityPolicy = options?.securityPolicy ?? createSecurityPolicyMock();
  const encryptionManager =
    options?.encryptionManager === undefined
      ? createEncryptionManagerMock()
      : options.encryptionManager;
  const keyManagement =
    options?.keyManagement ?? createKeyManagementHandlerMock();

  const defaultSignerMock = jest.fn((env: FameEnvelope) => env);
  const envelopeSigner =
    options?.envelopeSigner === undefined
      ? ({ signEnvelope: defaultSignerMock } as EnvelopeSigner)
      : options.envelopeSigner;

  const defaultVerifierMock = jest.fn().mockResolvedValue(true);
  const envelopeVerifier =
    options?.envelopeVerifier === undefined
      ? ({ verifyEnvelope: defaultVerifierMock } as EnvelopeVerifier)
      : options.envelopeVerifier;

  const handler = new EnvelopeSecurityHandler({
    nodeLike: options?.node ?? createNode(),
    envelopeSigner,
    envelopeVerifier,
    encryptionManager: encryptionManager as EncryptionManager | null,
    securityPolicy,
    keyManagementHandler: keyManagement.instance,
  });

  return {
    handler,
    securityPolicy,
    encryptionManager,
    keyManagement,
    envelopeSignerMock:
      envelopeSigner === options?.envelopeSigner ? null : defaultSignerMock,
    envelopeVerifierMock:
      envelopeVerifier === options?.envelopeVerifier
        ? null
        : defaultVerifierMock,
  };
}

describe('EnvelopeSecurityHandler', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('handleOutboundSecurity', () => {
    it('signs envelopes when the security policy requires signing', async () => {
      const securityPolicy = createSecurityPolicyMock();
      securityPolicy.shouldSignEnvelope.mockResolvedValue(true);

      const signerMock = jest.fn((env: FameEnvelope) => env);
      const node = createNode({
        sid: 'node-sid',
        physicalPath: '/physical/test',
      });
      const { handler } = createHandler({
        securityPolicy,
        envelopeSigner: { signEnvelope: signerMock } as EnvelopeSigner,
        node,
      });

      const envelope = createEnvelope({ sid: undefined });

      await handler.handleOutboundSecurity(envelope, createContext());

      expect(signerMock).toHaveBeenCalledWith(envelope, {
        physicalPath: node.physicalPath,
      });
      expect(envelope.sid).toBe('node-sid');
    });

    it('throws when signing is required but no signer is configured', async () => {
      const securityPolicy = createSecurityPolicyMock();
      securityPolicy.shouldSignEnvelope.mockResolvedValue(true);

      const { handler } = createHandler({
        securityPolicy,
        envelopeSigner: null,
      });

      await expect(
        handler.handleOutboundSecurity(createEnvelope(), createContext())
      ).rejects.toThrow('EnvelopeSigner is not configured');
    });

    it('skips encryption when the envelope already contains encryption headers', async () => {
      const securityPolicy = createSecurityPolicyMock();
      securityPolicy.shouldEncryptEnvelope.mockResolvedValue(true);

      const {
        handler,
        securityPolicy: policy,
        encryptionManager,
      } = createHandler({ securityPolicy });
      const envelope = createEnvelope({
        sec: { enc: { alg: 'x' } as unknown } as any,
      });

      const result = await handler.handleOutboundSecurity(
        envelope,
        createContext()
      );

      expect(result).toBe(true);
      expect(policy.decideOutboundCryptoLevel).not.toHaveBeenCalled();
      if (encryptionManager) {
        expect(encryptionManager.encryptEnvelope).not.toHaveBeenCalled();
      }
    });

    it('uses response crypto decisions for response envelopes', async () => {
      const securityPolicy = createSecurityPolicyMock();
      securityPolicy.shouldEncryptEnvelope.mockResolvedValue(true);
      securityPolicy.decideResponseCryptoLevel.mockResolvedValue(
        CryptoLevel.SEALED
      );

      const { handler } = createHandler({ securityPolicy });
      const originalSealed = (handler as any).handleSealedEncryption;
      const sealedMock = jest.fn().mockResolvedValue(true);
      (handler as any).handleSealedEncryption = sealedMock;

      const envelope = createEnvelope();
      const context = createContext({
        meta: {
          'message-type': 'response',
          'response-to-id': 'request-1',
        },
        security: { inboundCryptoLevel: CryptoLevel.CHANNEL },
      });

      try {
        await handler.handleOutboundSecurity(envelope, context);
        expect(sealedMock).toHaveBeenCalledWith(envelope, context);
      } finally {
        (handler as any).handleSealedEncryption = originalSealed;
      }
    });

    it('applies channel encryption when the policy requests channel level', async () => {
      const securityPolicy = createSecurityPolicyMock();
      securityPolicy.shouldEncryptEnvelope.mockResolvedValue(true);
      securityPolicy.decideOutboundCryptoLevel.mockResolvedValue(
        CryptoLevel.CHANNEL
      );

      const { handler } = createHandler({ securityPolicy });
      const originalChannel = (handler as any).handleChannelEncryption;
      const channelMock = jest.fn().mockResolvedValue(true);
      (handler as any).handleChannelEncryption = channelMock;

      const envelope = createEnvelope();
      const context = createContext({ meta: { 'message-type': 'request' } });

      try {
        await handler.handleOutboundSecurity(envelope, context);
        expect(channelMock).toHaveBeenCalledWith(envelope, context);
      } finally {
        (handler as any).handleChannelEncryption = originalChannel;
      }
    });

    it('returns true when encryption manager is missing even if encryption is requested', async () => {
      const securityPolicy = createSecurityPolicyMock();
      securityPolicy.shouldEncryptEnvelope.mockResolvedValue(true);

      const { handler, securityPolicy: policy } = createHandler({
        securityPolicy,
        encryptionManager: null,
      });

      const result = await handler.handleOutboundSecurity(
        createEnvelope(),
        createContext()
      );

      expect(result).toBe(true);
      expect(policy.decideOutboundCryptoLevel).not.toHaveBeenCalled();
    });

    it('returns true when desired crypto level is plaintext', async () => {
      const securityPolicy = createSecurityPolicyMock();
      securityPolicy.shouldEncryptEnvelope.mockResolvedValue(true);
      securityPolicy.decideOutboundCryptoLevel.mockResolvedValue(
        CryptoLevel.PLAINTEXT
      );

      const { handler } = createHandler({ securityPolicy });
      const originalSealed = (handler as any).handleSealedEncryption;
      const originalChannel = (handler as any).handleChannelEncryption;
      const sealedMock = jest.fn();
      const channelMock = jest.fn();
      (handler as any).handleSealedEncryption = sealedMock;
      (handler as any).handleChannelEncryption = channelMock;

      try {
        const result = await handler.handleOutboundSecurity(
          createEnvelope(),
          createContext()
        );
        expect(result).toBe(true);
        expect(sealedMock).not.toHaveBeenCalled();
        expect(channelMock).not.toHaveBeenCalled();
      } finally {
        (handler as any).handleSealedEncryption = originalSealed;
        (handler as any).handleChannelEncryption = originalChannel;
      }
    });

    it('consults response crypto decisions for protocol responses', async () => {
      const securityPolicy = createSecurityPolicyMock();
      securityPolicy.shouldEncryptEnvelope.mockResolvedValue(true);
      securityPolicy.decideResponseCryptoLevel.mockResolvedValue(
        CryptoLevel.PLAINTEXT
      );

      const { handler, securityPolicy: policy } = createHandler({
        securityPolicy,
      });
      const originalSealed = (handler as any).handleSealedEncryption;
      const originalChannel = (handler as any).handleChannelEncryption;
      (handler as any).handleSealedEncryption = jest.fn();
      (handler as any).handleChannelEncryption = jest.fn();

      const envelope = createEnvelope();
      const context = createContext({
        meta: {
          'message-type': 'protocol-response',
          'response-to-id': 'req-123',
        },
        security: { inboundCryptoLevel: CryptoLevel.SEALED },
      });

      try {
        const result = await handler.handleOutboundSecurity(envelope, context);
        expect(result).toBe(true);
        expect(policy.decideResponseCryptoLevel).toHaveBeenCalledWith(
          CryptoLevel.SEALED,
          envelope,
          context
        );
      } finally {
        (handler as any).handleSealedEncryption = originalSealed;
        (handler as any).handleChannelEncryption = originalChannel;
      }
    });
  });

  describe('handleEnvelopeSecurity', () => {
    it('returns the original envelope for local deliveries', async () => {
      const { handler } = createHandler();
      const envelope = createEnvelope();
      const context = createContext({ originType: DeliveryOriginType.LOCAL });

      const result = await handler.handleEnvelopeSecurity(envelope, context);

      expect(result).toEqual([envelope, true]);
    });

    it('retains the highest inbound crypto level seen on the context', async () => {
      const securityPolicy = createSecurityPolicyMock();
      securityPolicy.classifyMessageCryptoLevel.mockReturnValue(
        CryptoLevel.PLAINTEXT
      );

      const { handler } = createHandler({ securityPolicy });
      const envelope = createEnvelope();
      const context = createContext({
        originType: DeliveryOriginType.DOWNSTREAM,
        security: { inboundCryptoLevel: CryptoLevel.SEALED },
      });

      await handler.handleEnvelopeSecurity(envelope, context);

      expect(context.security?.inboundCryptoLevel).toBe(CryptoLevel.SEALED);
    });

    it('preserves channel crypto level when reclassified as plaintext', async () => {
      const securityPolicy = createSecurityPolicyMock();
      securityPolicy.classifyMessageCryptoLevel.mockReturnValue(
        CryptoLevel.PLAINTEXT
      );

      const { handler } = createHandler({ securityPolicy });
      const envelope = createEnvelope();
      const context = createContext({
        originType: DeliveryOriginType.DOWNSTREAM,
        security: { inboundCryptoLevel: CryptoLevel.CHANNEL },
      });

      await handler.handleEnvelopeSecurity(envelope, context);

      expect(context.security?.inboundCryptoLevel).toBe(CryptoLevel.CHANNEL);
    });

    it('initializes the security context when missing', async () => {
      const securityPolicy = createSecurityPolicyMock();
      securityPolicy.classifyMessageCryptoLevel.mockReturnValue(
        CryptoLevel.PLAINTEXT
      );

      const { handler } = createHandler({ securityPolicy });
      const envelope = createEnvelope();
      const context = createContext({
        originType: DeliveryOriginType.DOWNSTREAM,
        security: undefined,
      });

      await handler.handleEnvelopeSecurity(envelope, context);

      expect(context.security).toBeDefined();
      expect(context.security?.inboundWasSigned).toBe(false);
    });

    it('queues signed envelopes while waiting for missing signing keys', async () => {
      const securityPolicy = createSecurityPolicyMock();
      securityPolicy.isSignatureRequired.mockReturnValue(false);

      const keyManagement = createKeyManagementHandlerMock();
      keyManagement.fns.hasKey.mockResolvedValue(false);

      const envelopeVerifier: EnvelopeVerifier = {
        verifyEnvelope: jest.fn().mockResolvedValue(true),
      };

      const { handler } = createHandler({
        securityPolicy,
        keyManagement,
        envelopeVerifier,
      });

      const envelope = createEnvelope({
        sec: { sig: { kid: 'kid-123' } } as any,
      });
      const context = createContext({
        originType: DeliveryOriginType.UPSTREAM,
        fromSystemId: 'upstream-system',
        security: {},
      });

      const [, accepted] = await handler.handleEnvelopeSecurity(
        envelope,
        context
      );

      expect(accepted).toBe(false);
      expect(context.security?.inboundWasSigned).toBe(true);
      expect(keyManagement.fns.queuePendingSignedEnvelope).toHaveBeenCalledWith(
        'kid-123',
        envelope,
        context
      );
      expect(keyManagement.fns.maybeRequestSigningKey).toHaveBeenCalledWith(
        'kid-123',
        DeliveryOriginType.UPSTREAM,
        'upstream-system'
      );
    });

    it('rejects unsigned critical frames immediately', async () => {
      const securityPolicy = createSecurityPolicyMock();
      securityPolicy.isSignatureRequired.mockReturnValue(true);

      const { handler } = createHandler({ securityPolicy });
      const envelope = createEnvelope({ frame: { type: 'KeyRequest' } as any });
      const context = createContext({
        originType: DeliveryOriginType.DOWNSTREAM,
      });

      const [, accepted] = await handler.handleEnvelopeSecurity(
        envelope,
        context
      );

      expect(accepted).toBe(false);
      expect(securityPolicy.getUnsignedViolationAction).not.toHaveBeenCalled();
    });

    it('applies the unsigned violation action for non-critical frames', async () => {
      const securityPolicy = createSecurityPolicyMock();
      securityPolicy.isSignatureRequired.mockReturnValue(true);
      securityPolicy.getUnsignedViolationAction.mockReturnValue(
        SecurityAction.REJECT
      );

      const { handler } = createHandler({ securityPolicy });
      const envelope = createEnvelope();
      const context = createContext({
        originType: DeliveryOriginType.DOWNSTREAM,
      });

      const [, accepted] = await handler.handleEnvelopeSecurity(
        envelope,
        context
      );

      expect(accepted).toBe(false);
      expect(securityPolicy.getUnsignedViolationAction).toHaveBeenCalled();
    });
  });

  describe('channel handshake notifications', () => {
    it('notifies the encryption manager when a channel handshake succeeds', async () => {
      const encryptionManager = createEncryptionManagerMock();
      const { handler } = createHandler({ encryptionManager });

      await handler.handleChannelHandshakeComplete(
        'channel-42',
        'dest-address'
      );

      expect(encryptionManager.notifyChannelEstablished).toHaveBeenCalledWith(
        'channel-42'
      );
    });

    it('lets the encryption manager handle channel handshake failures when possible', async () => {
      const encryptionManager = createEncryptionManagerMock();
      const { handler } = createHandler({ encryptionManager });
      const originalCleanup = (handler as any)
        .handleFailedChannelEnvelopeCleanup;
      const cleanupMock = jest.fn().mockResolvedValue(undefined);
      (handler as any).handleFailedChannelEnvelopeCleanup = cleanupMock;

      try {
        await handler.handleChannelHandshakeFailed(
          'channel-7',
          'addr',
          'timeout'
        );
        expect(encryptionManager.notifyChannelFailed).toHaveBeenCalledWith(
          'channel-7',
          'timeout'
        );
        expect(cleanupMock).not.toHaveBeenCalled();
      } finally {
        (handler as any).handleFailedChannelEnvelopeCleanup = originalCleanup;
      }
    });

    it('falls back to cleanup when no encryption manager is available', async () => {
      const { handler } = createHandler({ encryptionManager: null });
      const originalCleanup = (handler as any)
        .handleFailedChannelEnvelopeCleanup;
      const cleanupMock = jest.fn().mockResolvedValue(undefined);
      (handler as any).handleFailedChannelEnvelopeCleanup = cleanupMock;

      try {
        await handler.handleChannelHandshakeFailed(
          'channel-8',
          'addr',
          'error'
        );
        expect(cleanupMock).toHaveBeenCalledWith('addr', 'error');
      } finally {
        (handler as any).handleFailedChannelEnvelopeCleanup = originalCleanup;
      }
    });
  });

  describe('shouldDecryptEnvelope', () => {
    it('returns true when the policy indicates decryption is required', async () => {
      const securityPolicy = createSecurityPolicyMock();
      securityPolicy.shouldDecryptEnvelope.mockResolvedValue(true);
      const encryptionManager = createEncryptionManagerMock();
      const { handler } = createHandler({ securityPolicy, encryptionManager });

      const envelope = createEnvelope();
      const context = createContext();

      await expect(
        handler.shouldDecryptEnvelope(envelope, context)
      ).resolves.toBe(true);
    });

    it('returns true for channel encrypted envelopes even without policy approval', async () => {
      const securityPolicy = createSecurityPolicyMock();
      securityPolicy.shouldDecryptEnvelope.mockResolvedValue(false);
      securityPolicy.classifyMessageCryptoLevel.mockReturnValue(
        CryptoLevel.CHANNEL
      );

      const { handler } = createHandler({
        securityPolicy,
        encryptionManager: null,
      });
      const envelope = createEnvelope({
        sec: { enc: { kid: 'abc' } as unknown } as any,
      });

      await expect(
        handler.shouldDecryptEnvelope(envelope, createContext())
      ).resolves.toBe(true);
    });

    it('returns false when neither policy nor headers require decryption', async () => {
      const securityPolicy = createSecurityPolicyMock();
      securityPolicy.shouldDecryptEnvelope.mockResolvedValue(false);
      securityPolicy.classifyMessageCryptoLevel.mockReturnValue(
        CryptoLevel.PLAINTEXT
      );

      const { handler } = createHandler({
        securityPolicy,
        encryptionManager: null,
      });

      await expect(
        handler.shouldDecryptEnvelope(createEnvelope(), createContext())
      ).resolves.toBe(false);
    });
  });

  describe('decryptEnvelope', () => {
    it('throws when no encryption manager is configured', async () => {
      const { handler } = createHandler({ encryptionManager: null });

      await expect(handler.decryptEnvelope(createEnvelope())).rejects.toThrow(
        'No encryption manager available for decryption'
      );
    });

    it('delegates to the encryption manager when present', async () => {
      const encryptionManager = createEncryptionManagerMock();
      const decrypted = createEnvelope({
        frame: { type: 'Data', payload: { ok: true } } as DataFrame,
      });
      encryptionManager.decryptEnvelope.mockResolvedValue(decrypted);

      const { handler } = createHandler({ encryptionManager });

      await expect(
        handler.decryptEnvelope(createEnvelope(), {
          requestAddress: 'naylence://peer',
        })
      ).resolves.toBe(decrypted);
      expect(encryptionManager.decryptEnvelope).toHaveBeenCalled();
    });
  });

  describe('performEncryption and queue handling', () => {
    it('queues envelopes by recipient key id when encryption manager defers encryption', async () => {
      const encryptionManager = createEncryptionManagerMock();
      encryptionManager.encryptEnvelope.mockResolvedValue(
        EncryptionResult.queued()
      );

      const keyManagement = createKeyManagementHandlerMock();
      const { handler } = createHandler({ encryptionManager, keyManagement });
      const originalQueue = (handler as any).handleEncryptionQueueing;
      const queueMock = jest.fn().mockResolvedValue(undefined);
      (handler as any).handleEncryptionQueueing = queueMock;

      const envelope = createEnvelope();
      const context = createContext({
        originType: DeliveryOriginType.LOCAL,
        fromSystemId: 'local',
      });
      const options: EncryptionOptions = { recipKid: 'target-kid' };

      let result = false;
      try {
        result = await (handler as any).performEncryption(
          envelope,
          context,
          options
        );
      } finally {
        (handler as any).handleEncryptionQueueing = originalQueue;
      }

      expect(result).toBe(false);
      expect(queueMock).toHaveBeenCalledWith(envelope, context, options);
    });

    it('handles queueing by request address when provided', async () => {
      const encryptionManager = createEncryptionManagerMock();
      encryptionManager.encryptEnvelope.mockResolvedValue(
        EncryptionResult.queued()
      );
      const keyManagement = createKeyManagementHandlerMock();
      const { handler } = createHandler({ encryptionManager, keyManagement });

      const envelope = createEnvelope();
      const context = createContext({
        originType: DeliveryOriginType.LOCAL,
        fromSystemId: 'system-2',
      });

      await (handler as any).handleEncryptionQueueing(envelope, context, {
        requestAddress: 'naylence://node/peer',
      });

      expect(
        keyManagement.fns.queuePendingEncryptionEnvelope
      ).toHaveBeenCalledWith('naylence://node/peer', envelope, context);
      expect(
        keyManagement.fns.maybeRequestEncryptionKeyByAddress
      ).toHaveBeenCalledWith(
        'naylence://node/peer',
        DeliveryOriginType.LOCAL,
        'system-2'
      );
    });

    it('skips queueing when channel encryption queueing is handled internally', async () => {
      const { handler, keyManagement } = createHandler();

      await (handler as any).handleEncryptionQueueing(
        createEnvelope(),
        createContext({
          originType: DeliveryOriginType.LOCAL,
          fromSystemId: 'system-3',
        }),
        {
          encryptionType: 'channel',
          destination: 'naylence://channel/123',
        }
      );

      expect(
        keyManagement.fns.queuePendingEncryptionEnvelope
      ).not.toHaveBeenCalled();
    });

    it('logs unknown queueing options without throwing', async () => {
      const { handler, keyManagement } = createHandler();

      await (handler as any).handleEncryptionQueueing(
        createEnvelope(),
        createContext({
          originType: DeliveryOriginType.LOCAL,
          fromSystemId: 'system-4',
        }),
        {}
      );

      expect(
        keyManagement.fns.queuePendingEncryptionEnvelope
      ).not.toHaveBeenCalled();
    });

    it('applies encrypted envelope data when encryption succeeds', async () => {
      const encryptionManager = createEncryptionManagerMock();
      const encryptedEnvelope = createEnvelope({
        frame: { type: 'Data', payload: { encrypted: true } } as DataFrame,
        sec: { enc: { alg: 'x' } as unknown } as any,
      });
      encryptionManager.encryptEnvelope.mockResolvedValue(
        EncryptionResult.ok(encryptedEnvelope)
      );

      const { handler } = createHandler({ encryptionManager });
      const envelope = createEnvelope();

      const result = await (handler as any).performEncryption(
        envelope,
        createContext({ originType: DeliveryOriginType.LOCAL }),
        {}
      );

      expect(result).toBe(true);
      expect(envelope.frame).toEqual(encryptedEnvelope.frame);
      expect(envelope.sec).toEqual(encryptedEnvelope.sec);
    });

    it('returns true when encryption is skipped by the manager', async () => {
      const encryptionManager = createEncryptionManagerMock();
      encryptionManager.encryptEnvelope.mockResolvedValue(
        EncryptionResult.skipped(createEnvelope())
      );

      const { handler } = createHandler({ encryptionManager });

      const result = await (handler as any).performEncryption(
        createEnvelope(),
        createContext({ originType: DeliveryOriginType.LOCAL }),
        {}
      );

      expect(result).toBe(true);
    });

    it('treats unknown encryption statuses as non-blocking', async () => {
      const encryptionManager = createEncryptionManagerMock();
      encryptionManager.encryptEnvelope.mockResolvedValue({
        status: 'UNKNOWN' as EncryptionStatus,
      } as EncryptionResult);

      const { handler } = createHandler({ encryptionManager });

      const result = await (handler as any).performEncryption(
        createEnvelope(),
        createContext({ originType: DeliveryOriginType.LOCAL }),
        {}
      );

      expect(result).toBe(true);
    });

    it('handles encryption errors gracefully', async () => {
      const encryptionManager = createEncryptionManagerMock();
      encryptionManager.encryptEnvelope.mockRejectedValue(new Error('boom'));

      const { handler } = createHandler({ encryptionManager });

      const result = await (handler as any).performEncryption(
        createEnvelope(),
        createContext({ originType: DeliveryOriginType.LOCAL }),
        {}
      );

      expect(result).toBe(true);
    });

    it('requires an origin type when queueing encryption work', async () => {
      const { handler } = createHandler();

      await expect(
        (handler as any).handleEncryptionQueueing(
          createEnvelope(),
          createContext({ originType: undefined }),
          {}
        )
      ).rejects.toThrow(
        'Delivery context must include origin type for encryption queueing'
      );
    });

    it('returns true when no encryption manager exists', async () => {
      const { handler } = createHandler({ encryptionManager: null });

      const result = await (handler as any).performEncryption(
        createEnvelope(),
        createContext({ originType: DeliveryOriginType.LOCAL }),
        {}
      );

      expect(result).toBe(true);
    });
  });

  describe('handleSignedEnvelope (private)', () => {
    it('throws when context origin type is missing', async () => {
      const { handler } = createHandler();
      const envelope = createEnvelope({
        sec: { sig: { kid: 'kid-1' } } as any,
      });
      const context = createContext({ originType: undefined });

      await expect(
        (handler as any).handleSignedEnvelope(envelope, context)
      ).rejects.toThrow('Context origin type must be provided');
    });

    it('throws when signature header is missing', async () => {
      const { handler } = createHandler();
      const envelope = createEnvelope({ sec: {} as any });
      const context = createContext({
        originType: DeliveryOriginType.UPSTREAM,
      });

      await expect(
        (handler as any).handleSignedEnvelope(envelope, context)
      ).rejects.toThrow('Signed envelope missing signature header');
    });

    it('throws when verifier is not configured', async () => {
      const { handler } = createHandler({ envelopeVerifier: null });
      const envelope = createEnvelope({
        sec: { sig: { kid: 'kid-2' } } as any,
      });
      const context = createContext({
        originType: DeliveryOriginType.UPSTREAM,
      });

      await expect(
        (handler as any).handleSignedEnvelope(envelope, context)
      ).rejects.toThrow('EnvelopeVerifier is not configured');
    });

    it('throws when signature header is missing key identifier', async () => {
      const { handler } = createHandler();
      const envelope = createEnvelope({ sec: { sig: {} } as any });
      const context = createContext({
        originType: DeliveryOriginType.UPSTREAM,
      });

      await expect(
        (handler as any).handleSignedEnvelope(envelope, context)
      ).rejects.toThrow('Signature header missing key identifier');
    });

    it('throws when signature verification fails', async () => {
      const keyManagement = createKeyManagementHandlerMock();
      keyManagement.fns.hasKey.mockResolvedValue(true);

      const envelopeVerifier: EnvelopeVerifier = {
        verifyEnvelope: jest.fn().mockResolvedValue(false),
      };

      const { handler } = createHandler({ keyManagement, envelopeVerifier });
      const envelope = createEnvelope({
        sec: { sig: { kid: 'kid-3' } } as any,
      });
      const context = createContext({
        originType: DeliveryOriginType.UPSTREAM,
      });

      await expect(
        (handler as any).handleSignedEnvelope(envelope, context)
      ).rejects.toThrow('Envelope signature verification failed for kid=kid-3');
    });

    it('returns true when verification succeeds', async () => {
      const { handler } = createHandler();
      const envelope = createEnvelope({
        sec: { sig: { kid: 'kid-4' } } as any,
      });
      const context = createContext({
        originType: DeliveryOriginType.UPSTREAM,
        fromSystemId: 'remote-system',
      });

      await expect(
        (handler as any).handleSignedEnvelope(envelope, context)
      ).resolves.toBe(true);
    });
  });

  describe('handleSealedEncryption (private)', () => {
    it('returns true when destination is missing', async () => {
      const { handler } = createHandler();

      const result = await (handler as any).handleSealedEncryption(
        createEnvelope(),
        createContext()
      );

      expect(result).toBe(true);
    });

    it('wraps channel encryption options into request address', async () => {
      const securityPolicy = createSecurityPolicyMock();
      securityPolicy.getEncryptionOptions.mockResolvedValue({
        encryptionType: 'channel',
      });
      const { handler } = createHandler({ securityPolicy });

      const original = (handler as any).handleToBeEncryptedEnvelopeWithOptions;
      const spy = jest.fn().mockResolvedValue(true);
      (handler as any).handleToBeEncryptedEnvelopeWithOptions = spy;

      const envelope = createEnvelope({ to: 'naylence://peer/1' });

      try {
        await (handler as any).handleSealedEncryption(
          envelope,
          createContext()
        );
        expect(spy).toHaveBeenCalledWith(envelope, expect.any(Object), {
          requestAddress: 'naylence://peer/1',
        });
      } finally {
        (handler as any).handleToBeEncryptedEnvelopeWithOptions = original;
      }
    });

    it('requests key lookup when options are missing', async () => {
      const securityPolicy = createSecurityPolicyMock();
      securityPolicy.getEncryptionOptions.mockResolvedValue(undefined);
      const { handler } = createHandler({ securityPolicy });
      const original = (handler as any).handleToBeEncryptedEnvelopeWithOptions;
      const spy = jest.fn().mockResolvedValue(true);
      (handler as any).handleToBeEncryptedEnvelopeWithOptions = spy;

      const envelope = createEnvelope({ to: 'naylence://peer/2' });

      try {
        await (handler as any).handleSealedEncryption(
          envelope,
          createContext()
        );
        expect(spy).toHaveBeenCalledWith(envelope, expect.any(Object), {
          requestAddress: 'naylence://peer/2',
        });
      } finally {
        (handler as any).handleToBeEncryptedEnvelopeWithOptions = original;
      }
    });

    it('falls back to request address when option lookup fails', async () => {
      const securityPolicy = createSecurityPolicyMock();
      securityPolicy.getEncryptionOptions.mockRejectedValue(
        new Error('lookup failed')
      );
      const { handler } = createHandler({ securityPolicy });

      const original = (handler as any).handleToBeEncryptedEnvelopeWithOptions;
      const spy = jest.fn().mockResolvedValue(true);
      (handler as any).handleToBeEncryptedEnvelopeWithOptions = spy;

      const envelope = createEnvelope({ to: 'naylence://peer/3' });

      try {
        await (handler as any).handleSealedEncryption(
          envelope,
          createContext()
        );
        expect(spy).toHaveBeenCalledWith(envelope, expect.any(Object), {
          requestAddress: 'naylence://peer/3',
        });
      } finally {
        (handler as any).handleToBeEncryptedEnvelopeWithOptions = original;
      }
    });

    it('uses provided options directly when not channel based', async () => {
      const securityPolicy = createSecurityPolicyMock();
      securityPolicy.getEncryptionOptions.mockResolvedValue({
        encryptionType: 'sealed',
        kid: 'abc',
      } as any);
      const { handler } = createHandler({ securityPolicy });
      const original = (handler as any).handleToBeEncryptedEnvelopeWithOptions;
      const spy = jest.fn().mockResolvedValue(true);
      (handler as any).handleToBeEncryptedEnvelopeWithOptions = spy;

      const envelope = createEnvelope({ to: 'naylence://peer/4' });

      try {
        await (handler as any).handleSealedEncryption(
          envelope,
          createContext()
        );
        expect(spy).toHaveBeenCalledWith(envelope, expect.any(Object), {
          encryptionType: 'sealed',
          kid: 'abc',
        });
      } finally {
        (handler as any).handleToBeEncryptedEnvelopeWithOptions = original;
      }
    });
  });

  describe('handleChannelEncryption (private)', () => {
    it('returns true when destination is missing', async () => {
      const { handler } = createHandler();

      const result = await (handler as any).handleChannelEncryption(
        createEnvelope(),
        createContext()
      );

      expect(result).toBe(true);
    });

    it('delegates to handleToBeEncryptedEnvelopeWithOptions when destination exists', async () => {
      const { handler } = createHandler();
      const original = (handler as any).handleToBeEncryptedEnvelopeWithOptions;
      const spy = jest.fn().mockResolvedValue(true);
      (handler as any).handleToBeEncryptedEnvelopeWithOptions = spy;

      const envelope = createEnvelope({ to: 'naylence://channel/88' });

      try {
        await (handler as any).handleChannelEncryption(
          envelope,
          createContext()
        );
        expect(spy).toHaveBeenCalledWith(envelope, expect.any(Object), {
          encryptionType: 'channel',
          destination: 'naylence://channel/88',
        });
      } finally {
        (handler as any).handleToBeEncryptedEnvelopeWithOptions = original;
      }
    });
  });

  describe('handleToBeEncryptedEnvelope (private)', () => {
    it('returns early when no encryption manager is present', async () => {
      const { handler } = createHandler({ encryptionManager: null });

      const result = await (handler as any).handleToBeEncryptedEnvelope(
        createEnvelope(),
        createContext()
      );

      expect(result).toBe(true);
    });

    it('allows non-local envelopes to pass without encryption', async () => {
      const { handler } = createHandler();

      const result = await (handler as any).handleToBeEncryptedEnvelope(
        createEnvelope(),
        createContext({ originType: DeliveryOriginType.UPSTREAM })
      );

      expect(result).toBe(true);
    });

    it('skips encryption for non-data frames', async () => {
      const { handler } = createHandler();
      const frame = { type: 'Ack' } as any;

      const result = await (handler as any).handleToBeEncryptedEnvelope(
        createEnvelope({ frame }),
        createContext()
      );

      expect(result).toBe(true);
    });

    it('returns true when encryption options are missing', async () => {
      const securityPolicy = createSecurityPolicyMock();
      securityPolicy.getEncryptionOptions.mockResolvedValue(undefined);
      const { handler } = createHandler({ securityPolicy });

      const result = await (handler as any).handleToBeEncryptedEnvelope(
        createEnvelope(),
        createContext()
      );

      expect(result).toBe(true);
    });

    it('passes resolved options to performEncryption', async () => {
      const securityPolicy = createSecurityPolicyMock();
      securityPolicy.getEncryptionOptions.mockResolvedValue({
        requestAddress: 'dest',
      });
      const { handler } = createHandler({ securityPolicy });
      const original = (handler as any).performEncryption;
      const spy = jest.fn().mockResolvedValue(true);
      (handler as any).performEncryption = spy;

      try {
        await (handler as any).handleToBeEncryptedEnvelope(
          createEnvelope(),
          createContext()
        );
        expect(spy).toHaveBeenCalledWith(
          expect.any(Object),
          expect.any(Object),
          {
            requestAddress: 'dest',
          }
        );
      } finally {
        (handler as any).performEncryption = original;
      }
    });
  });

  describe('handleToBeEncryptedEnvelopeWithOptions (private)', () => {
    it('returns early when no encryption manager is present', async () => {
      const { handler } = createHandler({ encryptionManager: null });

      const result = await (
        handler as any
      ).handleToBeEncryptedEnvelopeWithOptions(
        createEnvelope(),
        createContext(),
        {}
      );

      expect(result).toBe(true);
    });

    it('skips non-local envelopes', async () => {
      const { handler } = createHandler();

      const result = await (
        handler as any
      ).handleToBeEncryptedEnvelopeWithOptions(
        createEnvelope(),
        createContext({ originType: DeliveryOriginType.UPSTREAM }),
        {}
      );

      expect(result).toBe(true);
    });

    it('skips non-data frames', async () => {
      const { handler } = createHandler();
      const frame = { type: 'Ack' } as any;

      const result = await (
        handler as any
      ).handleToBeEncryptedEnvelopeWithOptions(
        createEnvelope({ frame }),
        createContext(),
        {}
      );

      expect(result).toBe(true);
    });

    it('delegates to performEncryption when conditions are met', async () => {
      const { handler } = createHandler();
      const original = (handler as any).performEncryption;
      const spy = jest.fn().mockResolvedValue(true);
      (handler as any).performEncryption = spy;

      try {
        await (handler as any).handleToBeEncryptedEnvelopeWithOptions(
          createEnvelope(),
          createContext(),
          { encryptionType: 'sealed' }
        );
        expect(spy).toHaveBeenCalledWith(
          expect.any(Object),
          expect.any(Object),
          {
            encryptionType: 'sealed',
          }
        );
      } finally {
        (handler as any).performEncryption = original;
      }
    });
  });

  describe('handleEncryptionQueueing variants (private)', () => {
    it('queues by recipKid option', async () => {
      const keyManagement = createKeyManagementHandlerMock();
      const { handler } = createHandler({ keyManagement });
      const envelope = createEnvelope();
      const context = createContext({ fromSystemId: 'sys-a' });

      await (handler as any).handleEncryptionQueueing(envelope, context, {
        recipKid: 'kid-1',
      });

      expect(
        keyManagement.fns.queuePendingEncryptionEnvelope
      ).toHaveBeenCalledWith('kid-1', envelope, context);
      expect(keyManagement.fns.maybeRequestEncryptionKey).toHaveBeenCalledWith(
        'kid-1',
        DeliveryOriginType.LOCAL,
        'sys-a'
      );
    });

    it('queues by recip_kid option', async () => {
      const keyManagement = createKeyManagementHandlerMock();
      const { handler } = createHandler({ keyManagement });
      const envelope = createEnvelope();
      const context = createContext({ fromSystemId: 'sys-b' });

      await (handler as any).handleEncryptionQueueing(envelope, context, {
        recip_kid: 'kid-2',
      });

      expect(
        keyManagement.fns.queuePendingEncryptionEnvelope
      ).toHaveBeenCalledWith('kid-2', envelope, context);
    });

    it('queues by recipientKeyId option', async () => {
      const keyManagement = createKeyManagementHandlerMock();
      const { handler } = createHandler({ keyManagement });
      const envelope = createEnvelope();
      const context = createContext({ fromSystemId: 'sys-c' });

      await (handler as any).handleEncryptionQueueing(envelope, context, {
        recipientKeyId: 'kid-3',
      });

      expect(
        keyManagement.fns.queuePendingEncryptionEnvelope
      ).toHaveBeenCalledWith('kid-3', envelope, context);
    });

    it('returns early when key management handler is missing', async () => {
      const { handler } = createHandler();
      (handler as any).keyManagementHandler = null;

      await expect(
        (handler as any).handleEncryptionQueueing(
          createEnvelope(),
          createContext({ fromSystemId: 'sys-d' }),
          { requestAddress: 'naylence://node/peer' }
        )
      ).resolves.toBeUndefined();
    });
  });

  describe('handleFailedChannelEnvelopeCleanup (private)', () => {
    it('logs cleanup attempts without throwing', async () => {
      const { handler } = createHandler();

      await expect(
        (handler as any).handleFailedChannelEnvelopeCleanup(
          'naylence://peer',
          'handshake-failed'
        )
      ).resolves.toBeUndefined();
    });
  });
});
