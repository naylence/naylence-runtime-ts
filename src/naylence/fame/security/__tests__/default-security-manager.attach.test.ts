import {
  DeliveryOriginType,
  FameAddress,
  type FameConnector,
  type FameDeliveryContext,
  type FameEnvelope,
  type NodeWelcomeFrame,
} from '@naylence/core';

import { DefaultSecurityManager } from '../default-security-manager.js';
import { FameTransportClose } from '../../errors/errors.js';
import type { Authorizer } from '../auth/authorizer.js';
import type { SecurityManager } from '../security-manager.js';
import type { SecurityPolicy } from '../policy/security-policy.js';
import {
  CryptoLevel,
  SecurityAction,
  SecurityRequirements,
} from '../policy/security-policy.js';
import type { KeyManager } from '../keys/key-manager.js';
import type { EncryptionManager } from '../encryption/encryption-manager.js';
import type { CertificateManager } from '../cert/certificate-manager.js';
import type { NodeLike } from '../../node/node-like.js';
import type { EnvelopeVerifier } from '../signing/envelope-verifier.js';

type MockLogger = {
  debug: jest.Mock;
  error: jest.Mock;
  warning: jest.Mock;
};

type ExtendedEncryptionManager = EncryptionManager & {
  onNodeInitialized?: jest.Mock;
  onNodeAttachToUpstream?: jest.Mock;
  onNodeAttachToPeer?: jest.Mock;
  onNodeStopped?: jest.Mock;
};

jest.mock('../../util/logging.js', () => {
  const mockLogger: MockLogger = {
    debug: jest.fn(),
    error: jest.fn(),
    warning: jest.fn(),
  };

  return {
    __esModule: true,
    getLogger: () => mockLogger,
    __mockLogger: mockLogger,
  };
});

const { __mockLogger: mockLogger } = jest.requireMock(
  '../../util/logging.js'
) as {
  __mockLogger: MockLogger;
};

const noopPolicy: SecurityPolicy = {
  shouldSignEnvelope: jest.fn(),
  shouldEncryptEnvelope: jest.fn(),
  getEncryptionOptions: jest.fn(),
  shouldVerifySignature: jest.fn(),
  shouldDecryptEnvelope: jest.fn(),
  classifyMessageCryptoLevel: jest.fn(),
  isInboundCryptoLevelAllowed: jest.fn(),
  getInboundViolationAction: jest.fn(),
  getUnsignedViolationAction: jest.fn(),
  getInvalidSignatureViolationAction: jest.fn(),
  decideResponseCryptoLevel: jest.fn(),
  decideOutboundCryptoLevel: jest.fn(),
  isSignatureRequired: jest.fn(),
  requirements: jest.fn(
    () =>
      new SecurityRequirements({
        signingRequired: false,
        verificationRequired: false,
        encryptionRequired: false,
        decryptionRequired: false,
        requireKeyExchange: false,
        requireSigningKeyExchange: false,
        requireEncryptionKeyExchange: false,
        requireNodeAuthorization: false,
        requireCertificates: false,
        preferredSigningAlgorithms: [],
        preferredEncryptionAlgorithms: [],
        preferredSigningAlgorithm: null,
        preferredEncryptionAlgorithm: null,
      })
  ),
};

function createPermissivePolicy(
  overrides: Partial<SecurityPolicy> = {}
): SecurityPolicy {
  const policy = { ...noopPolicy } as SecurityPolicy;
  policy.classifyMessageCryptoLevel = jest.fn(
    () => CryptoLevel.CHANNEL
  ) as unknown as SecurityPolicy['classifyMessageCryptoLevel'];
  policy.isInboundCryptoLevelAllowed = jest.fn(
    () => true
  ) as unknown as SecurityPolicy['isInboundCryptoLevelAllowed'];
  policy.isSignatureRequired = jest.fn(() => false);
  policy.shouldVerifySignature = jest.fn(async () => false);
  policy.getUnsignedViolationAction = jest.fn(
    () => SecurityAction.ALLOW
  ) as unknown as SecurityPolicy['getUnsignedViolationAction'];
  policy.getInboundViolationAction = jest.fn(
    () => SecurityAction.ALLOW
  ) as unknown as SecurityPolicy['getInboundViolationAction'];
  policy.getInvalidSignatureViolationAction = jest.fn(
    () => SecurityAction.ALLOW
  ) as unknown as SecurityPolicy['getInvalidSignatureViolationAction'];
  return Object.assign(policy, overrides);
}

function createNode(overrides: Partial<NodeLike> = {}): NodeLike {
  return {
    id: 'node-attach',
    deliver: jest.fn(),
    envelopeFactory: {
      createEnvelope: jest.fn(),
    },
    ...overrides,
  } as unknown as NodeLike;
}

describe('DefaultSecurityManager attach lifecycle', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('adds parent keys and retries pending requests on upstream attach', async () => {
    const addKeys = jest.fn(async () => undefined);
    const keyManager = { addKeys } as unknown as KeyManager;
    const encryption: ExtendedEncryptionManager = {
      onNodeAttachToUpstream: jest.fn(async () => undefined),
      encryptEnvelope: jest.fn(),
      decryptEnvelope: jest.fn(),
    };
    const manager = new DefaultSecurityManager(
      {
        ...noopPolicy,
        validateAttachSecurityCompatibility: jest.fn((): [boolean, string?] => [
          true,
        ]),
      } as SecurityPolicy,
      null,
      null,
      encryption,
      keyManager
    );
    const retryPending = jest.fn(async () => undefined);
    (manager as any)._keyManagementHandler = {
      retryPendingKeyRequestsAfterAttachment: retryPending,
    };
    const node = createNode();
    const attachInfo = {
      parentKeys: [{ kid: 'k1' }],
      targetSystemId: 'sys-1',
      targetPhysicalPath: '/phy',
    } as any;

    await manager.onNodeAttachToUpstream(node, attachInfo);

    expect(addKeys).toHaveBeenCalledWith({
      keys: [{ kid: 'k1' }],
      physicalPath: '/phy',
      systemId: 'sys-1',
      origin: DeliveryOriginType.UPSTREAM,
    });
    expect(retryPending).toHaveBeenCalledTimes(1);
    expect(encryption.onNodeAttachToUpstream).toHaveBeenCalledWith(
      node,
      attachInfo
    );
  });

  it('warns when upstream attach lacks keys but policy requires exchange', async () => {
    const policy = {
      ...noopPolicy,
      requirements: jest.fn(
        () =>
          new SecurityRequirements({
            signingRequired: false,
            verificationRequired: false,
            encryptionRequired: false,
            decryptionRequired: false,
            requireKeyExchange: false,
            requireSigningKeyExchange: true,
            requireEncryptionKeyExchange: false,
            requireNodeAuthorization: false,
            requireCertificates: false,
            preferredSigningAlgorithms: [],
            preferredEncryptionAlgorithms: [],
            preferredSigningAlgorithm: null,
            preferredEncryptionAlgorithm: null,
          })
      ),
    } as SecurityPolicy;
    const manager = new DefaultSecurityManager(policy, null, null, null, null);
    const node = createNode();

    await expect(
      manager.onNodeAttachToUpstream(node, {} as any)
    ).resolves.toBeUndefined();
    expect(policy.requirements).toHaveBeenCalled();
  });

  it('adds peer keys and notifies dependencies on peer attach', async () => {
    const addKeys = jest.fn(async () => undefined);
    const keyManager = { addKeys } as unknown as KeyManager;
    const certificateManager = {
      onNodeAttachToPeer: jest.fn(async () => undefined),
    } as unknown as CertificateManager;
    const encryption: ExtendedEncryptionManager = {
      onNodeAttachToPeer: jest.fn(async () => undefined),
      encryptEnvelope: jest.fn(),
      decryptEnvelope: jest.fn(),
    };
    const manager = new DefaultSecurityManager(
      noopPolicy,
      null,
      null,
      encryption,
      keyManager,
      null,
      certificateManager
    );
    const node = createNode();
    const attachInfo = {
      parentKeys: [{ kid: 'peer-key' }],
      targetSystemId: 'peer-42',
      targetPhysicalPath: '/peer/path',
    } as any;

    await manager.onNodeAttachToPeer(node, attachInfo, {} as FameConnector);

    expect(addKeys).toHaveBeenCalledWith({
      keys: [{ kid: 'peer-key' }],
      physicalPath: '/peer/path',
      systemId: 'peer-42',
      origin: DeliveryOriginType.PEER,
    });
    expect(certificateManager.onNodeAttachToPeer).toHaveBeenCalledWith(
      node,
      attachInfo,
      expect.any(Object)
    );
    expect(encryption.onNodeAttachToPeer).toHaveBeenCalled();
  });

  it('propagates initialization and shutdown to dependencies', async () => {
    const keyManager = {
      onNodeInitialized: jest.fn(async () => undefined),
      onNodeStopped: jest.fn(async () => undefined),
    } as unknown as KeyManager;
    const certificateManager = {
      onNodeInitialized: jest.fn(async () => undefined),
      onNodeStopped: jest.fn(async () => undefined),
    } as unknown as CertificateManager;
    const encryption: ExtendedEncryptionManager = {
      onNodeInitialized: jest.fn(async () => undefined),
      onNodeStopped: jest.fn(async () => undefined),
      encryptEnvelope: jest.fn(),
      decryptEnvelope: jest.fn(),
    };
    const manager = new DefaultSecurityManager(
      noopPolicy,
      null,
      null,
      encryption,
      keyManager,
      null,
      certificateManager
    );
    const stopSpy = jest.fn(async () => undefined);
    (manager as any)._keyFrameHandler = { stop: stopSpy };
    (manager as any)._keyManagementHandler = {
      stop: jest.fn(async () => undefined),
    };

    const node = createNode();
    await manager.onNodeInitialized(node);
    await manager.onNodeStopped(node);

    expect(keyManager.onNodeInitialized).toHaveBeenCalledWith(node);
    expect(certificateManager.onNodeStopped).toHaveBeenCalledWith(node);
    expect(encryption.onNodeStopped).toHaveBeenCalledWith(node);
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });
});

describe('DefaultSecurityManager helper coverage', () => {
  const address = FameAddress.create('svc@/test');

  it('processes signed local delivery by creating local context and security state', async () => {
    const policy = createPermissivePolicy();
    const manager = new DefaultSecurityManager(policy);
    const node = createNode();
    const envelope = {
      id: 'env-data',
      frame: { type: 'Data' },
      sec: { sig: 'sig', enc: 'enc-token' },
    } as unknown as FameEnvelope;

    await expect(manager.onDeliverLocal(node, address, envelope)).resolves.toBe(
      envelope
    );

    expect(mockLogger.warning).toHaveBeenCalledWith(
      'deliver_local_missing_payload_digest',
      {
        envp_id: 'env-data',
      }
    );
    expect(policy.classifyMessageCryptoLevel).toHaveBeenCalled();
  });

  it('rejects unsigned critical frames from non-local origins', async () => {
    const policy = createPermissivePolicy();
    policy.isSignatureRequired = jest.fn(() => true);
    policy.getUnsignedViolationAction = jest.fn(() => SecurityAction.REJECT);
    const manager = new DefaultSecurityManager(policy);
    const envelope = {
      id: 'env-critical',
      frame: { type: 'KeyRequest' },
    } as unknown as FameEnvelope;
    const context = {
      originType: DeliveryOriginType.UPSTREAM,
    } as FameDeliveryContext;

    await expect(
      manager.onDeliver(createNode(), envelope, context)
    ).resolves.toBeNull();
    expect(mockLogger.error).toHaveBeenCalledWith(
      'critical_frame_unsigned_rejected',
      expect.any(Object)
    );
  });

  it('invokes optional lifecycle hooks via node listener helper', async () => {
    const keyManager = {
      onNodeStarted: jest.fn(async () => undefined),
    } as unknown as KeyManager;
    const certificateManager = {
      onNodeStarted: jest.fn(async () => undefined),
    } as unknown as CertificateManager;
    const encryptionStart = jest.fn(async () => undefined);
    const encryption = {
      onNodeStarted: encryptionStart,
      encryptEnvelope: jest.fn(),
      decryptEnvelope: jest.fn(),
    } as unknown as ExtendedEncryptionManager;
    const manager = new DefaultSecurityManager(
      createPermissivePolicy(),
      null,
      null,
      encryption,
      keyManager,
      null,
      certificateManager
    );
    const node = createNode();

    await manager.onNodeStarted(node);

    expect(keyManager.onNodeStarted).toHaveBeenCalledWith(node);
    expect(certificateManager.onNodeStarted).toHaveBeenCalledWith(node);
    expect(encryptionStart).toHaveBeenCalledWith(node);
  });

  it('normalizes missing delivery context fields before outbound security handling', async () => {
    const policy = createPermissivePolicy();
    const manager = new DefaultSecurityManager(policy);
    const handler = {
      handleOutboundSecurity: jest.fn(async () => true),
    };
    (manager as any)._envelopeSecurityHandler = handler;
    const node = createNode();
    const context = {
      originType: DeliveryOriginType.LOCAL,
    } as FameDeliveryContext;
    const envelope = {
      id: 'env-route',
      frame: { type: 'Data' },
    } as unknown as FameEnvelope;

    await manager.onForwardToRoute(node, 'segment-1', envelope, context);

    expect(handler.handleOutboundSecurity).toHaveBeenCalledWith(
      envelope,
      expect.objectContaining({
        originType: DeliveryOriginType.LOCAL,
        fromSystemId: node.id,
        expectedResponseType: expect.anything(),
      })
    );
  });
});

describe('DefaultSecurityManager onDeliverLocal enforcement', () => {
  const address = FameAddress.create('svc@/local');

  function createEnvelope(overrides: Partial<FameEnvelope> = {}): FameEnvelope {
    return {
      id: 'env-' + Math.random().toString(36).slice(2, 8),
      frame: { type: 'Data' } as FameEnvelope['frame'],
      sec: {},
      ...overrides,
    } as FameEnvelope;
  }

  function setupPolicy(): SecurityPolicy {
    const policy = { ...noopPolicy } as SecurityPolicy;
    policy.classifyMessageCryptoLevel = jest.fn(
      () => CryptoLevel.PLAINTEXT
    ) as unknown as SecurityPolicy['classifyMessageCryptoLevel'];
    policy.isInboundCryptoLevelAllowed = jest.fn(
      () => false
    ) as unknown as SecurityPolicy['isInboundCryptoLevelAllowed'];
    policy.getInboundViolationAction = jest.fn(
      () => SecurityAction.REJECT
    ) as unknown as SecurityPolicy['getInboundViolationAction'];
    policy.isSignatureRequired = jest.fn(() => false);
    policy.shouldVerifySignature = jest.fn(async () => false);
    policy.getUnsignedViolationAction = jest.fn(() => SecurityAction.ALLOW);
    policy.getInvalidSignatureViolationAction = jest.fn(
      () => SecurityAction.ALLOW
    );
    return policy;
  }

  it('rejects inbound messages when crypto level is not allowed', async () => {
    const policy = setupPolicy();
    const manager = new DefaultSecurityManager(policy);
    const envelope = createEnvelope({ id: 'env-reject' });

    await expect(
      manager.onDeliverLocal(createNode(), address, envelope)
    ).resolves.toBeNull();
    expect(mockLogger.error).toHaveBeenCalledWith('inbound_message_rejected', {
      envp_id: 'env-reject',
      crypto_level: CryptoLevel.PLAINTEXT,
    });
    expect(policy.getInboundViolationAction).toHaveBeenCalled();
  });

  it('sends NACK when crypto violation policy requests nack', async () => {
    const policy = setupPolicy();
    policy.getInboundViolationAction = jest.fn(
      () => SecurityAction.NACK
    ) as unknown as SecurityPolicy['getInboundViolationAction'];
    const manager = new DefaultSecurityManager(policy);
    const sendNack = jest
      .spyOn(manager as any, 'sendNack')
      .mockResolvedValue(undefined);
    const envelope = createEnvelope({ id: 'env-nack' });

    await expect(
      manager.onDeliverLocal(createNode(), address, envelope)
    ).resolves.toBeNull();
    expect(sendNack).toHaveBeenCalledWith(
      expect.any(Object),
      envelope,
      'crypto_level_violation'
    );
    expect(mockLogger.error).toHaveBeenCalledWith('inbound_message_nacked', {
      envp_id: 'env-nack',
      crypto_level: CryptoLevel.PLAINTEXT,
    });
  });

  it('sends NACK when signature is required but missing', async () => {
    const policy = setupPolicy();
    policy.isInboundCryptoLevelAllowed = jest.fn(
      () => true
    ) as unknown as SecurityPolicy['isInboundCryptoLevelAllowed'];
    policy.isSignatureRequired = jest.fn(() => true);
    policy.getUnsignedViolationAction = jest.fn(
      () => SecurityAction.NACK
    ) as unknown as SecurityPolicy['getUnsignedViolationAction'];
    const manager = new DefaultSecurityManager(policy);
    const sendNack = jest
      .spyOn(manager as any, 'sendNack')
      .mockResolvedValue(undefined);
    const envelope = createEnvelope({ id: 'env-sig' });

    await expect(
      manager.onDeliverLocal(createNode(), address, envelope)
    ).resolves.toBeNull();
    expect(sendNack).toHaveBeenCalledWith(
      expect.any(Object),
      envelope,
      'signature_required'
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      'inbound_message_nacked_unsigned',
      {
        envp_id: 'env-sig',
      }
    );
  });
});

describe('DefaultSecurityManager onDeliver dispatch', () => {
  it('rejects when authorizer denies remote envelope', async () => {
    const policy = createPermissivePolicy();
    const authorizer = {
      authorize: jest.fn(async () => false),
    } as unknown as Authorizer;
    const manager = new DefaultSecurityManager(
      policy,
      null,
      null,
      null,
      null,
      authorizer
    );
    const envelope = {
      id: 'env-auth-denied',
      frame: { type: 'Data' },
    } as unknown as FameEnvelope;

    await expect(
      manager.onDeliver(createNode(), envelope, {
        originType: DeliveryOriginType.PEER,
      } as FameDeliveryContext)
    ).resolves.toBeNull();

    expect(authorizer.authorize).toHaveBeenCalled();
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'envelope_authorization_failed',
      expect.objectContaining({
        envp_id: 'env-auth-denied',
      })
    );
  });

  it('logs and returns null when authorizer throws', async () => {
    const policy = createPermissivePolicy();
    const authorizer = {
      authorize: jest.fn(async () => {
        throw new Error('boom');
      }),
    } as unknown as Authorizer;
    const manager = new DefaultSecurityManager(
      policy,
      null,
      null,
      null,
      null,
      authorizer
    );
    const envelope = {
      id: 'env-auth-error',
      frame: { type: 'Data' },
    } as unknown as FameEnvelope;

    await expect(
      manager.onDeliver(createNode(), envelope, {
        originType: DeliveryOriginType.UPSTREAM,
      } as FameDeliveryContext)
    ).resolves.toBeNull();

    expect(mockLogger.error).toHaveBeenCalledWith(
      'envelope_authorization_error',
      expect.objectContaining({
        envp_id: 'env-auth-error',
        error: 'boom',
      })
    );
  });

  it('delegates KeyAnnounce frames to key frame handler', async () => {
    const manager = new DefaultSecurityManager(createPermissivePolicy());
    const acceptKeyAnnounce = jest.fn(async () => undefined);
    (manager as any)._keyFrameHandler = { acceptKeyAnnounce };
    const envelope = {
      id: 'env-announce',
      frame: { type: 'KeyAnnounce' },
    } as unknown as FameEnvelope;
    const context = {
      originType: DeliveryOriginType.LOCAL,
    } as FameDeliveryContext;

    await expect(
      manager.onDeliver(createNode(), envelope, context)
    ).resolves.toBeNull();
    expect(acceptKeyAnnounce).toHaveBeenCalledWith(envelope, context);
  });

  it('uses key frame handler for key requests and stops when handled locally', async () => {
    const manager = new DefaultSecurityManager(createPermissivePolicy());
    const acceptKeyRequest = jest.fn(async () => true);
    (manager as any)._keyFrameHandler = { acceptKeyRequest };
    const envelope = {
      id: 'env-keyreq',
      frame: { type: 'KeyRequest' },
      sec: { sig: 'sig' },
    } as unknown as FameEnvelope;
    const context = {
      originType: DeliveryOriginType.PEER,
    } as FameDeliveryContext;

    await expect(
      manager.onDeliver(createNode(), envelope, context)
    ).resolves.toBeNull();
    expect(acceptKeyRequest).toHaveBeenCalledWith(envelope, context);
  });

  it('falls back to child key request handler when sentry cannot handle locally', async () => {
    const policy = createPermissivePolicy();
    const manager = new DefaultSecurityManager(policy, null, null, null, {
      handleKeyRequest: jest.fn(async () => undefined),
    } as unknown as KeyManager);
    const handleChild = jest
      .spyOn(manager as any, 'handleChildKeyRequest')
      .mockResolvedValue(undefined);
    const envelope = {
      id: 'env-keyreq-fallback',
      frame: { type: 'KeyRequest' },
      sec: { sig: 'sig' },
    } as unknown as FameEnvelope;
    const context = {
      originType: DeliveryOriginType.PEER,
      fromSystemId: 'sid-1',
    } as FameDeliveryContext;

    await expect(
      manager.onDeliver(createNode(), envelope, context)
    ).resolves.toBeNull();
    expect(handleChild).toHaveBeenCalledWith(envelope, context);
  });
});

describe('DefaultSecurityManager.onChildAttach', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('removes stale keys on rebind and adds new child keys', async () => {
    const removeKeysForPath = jest.fn(async () => 2);
    const addKeys = jest.fn(async () => undefined);
    const keyManager = {
      removeKeysForPath,
      addKeys,
    } as unknown as KeyManager;
    const manager = new DefaultSecurityManager(
      noopPolicy,
      null,
      null,
      null,
      keyManager
    );
    jest
      .spyOn(
        manager as unknown as { _getKeysToProvide(): any },
        '_getKeysToProvide'
      )
      .mockReturnValue(null);

    const node = createNode();

    await manager.onChildAttach({
      childSystemId: 'child-1',
      childKeys: [{ kid: 'ck1' }],
      nodeLike: node,
      originType: DeliveryOriginType.PEER,
      assignedPath: '/new',
      oldAssignedPath: '/old',
      isRebind: true,
    });

    expect(removeKeysForPath).toHaveBeenCalledWith('/old');
    expect(addKeys).toHaveBeenCalledWith({
      keys: [{ kid: 'ck1' }],
      physicalPath: '/new',
      origin: DeliveryOriginType.PEER,
      systemId: 'child-1',
    });
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'removed_stale_keys_on_rebind',
      expect.objectContaining({
        system_id: 'child-1',
        old_path: '/old',
        removed_count: 2,
      })
    );
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'added_child_attach_keys',
      expect.objectContaining({
        child_system_id: 'child-1',
        assigned_path: '/new',
      })
    );
  });

  it('logs warnings when rebind cleanup fails and policy validation rejects keys', async () => {
    const removeKeysForPath = jest.fn(async () => {
      throw new Error('nope');
    });
    const keyManager = {
      removeKeysForPath,
      addKeys: jest.fn(),
    } as unknown as KeyManager;
    const manager = new DefaultSecurityManager(
      noopPolicy,
      null,
      null,
      null,
      keyManager
    );
    const ourKeys = [
      { kid: 'our-enc', use: 'enc', kty: 'RSA', crv: 'secp256k1' },
      { kid: 'our-sig', use: 'sig', kty: 'RSA', crv: 'P-256' },
    ];
    jest
      .spyOn(
        manager as unknown as { _getKeysToProvide(): any },
        '_getKeysToProvide'
      )
      .mockReturnValue(ourKeys);

    const sentinelPolicy = {
      validateAttachSecurityCompatibility: jest.fn<[boolean, string?], any[]>(
        (input: { peerKeys?: Array<Record<string, unknown>> }) => {
          if (input.peerKeys?.some((key) => key.kid === 'bad')) {
            return [false, 'bad-peer'];
          }
          return [false, 'bad-ours'];
        }
      ),
      requirements: jest.fn(() => ({
        requireSigningKeyExchange: true,
        requireEncryptionKeyExchange: true,
      })),
    } as unknown as SecurityPolicy;

    const node = createNode({
      securityManager: {
        policy: sentinelPolicy,
      } as unknown as SecurityManager,
    });

    await manager.onChildAttach({
      childSystemId: 'child-2',
      childKeys: [{ kid: 'bad' }],
      nodeLike: node,
      originType: DeliveryOriginType.UPSTREAM,
      assignedPath: '/child',
      oldAssignedPath: '/old',
      isRebind: true,
    });

    expect(mockLogger.warning).toHaveBeenCalledWith(
      'failed_to_remove_stale_keys_on_rebind',
      expect.objectContaining({
        system_id: 'child-2',
        old_path: '/old',
        error: 'nope',
      })
    );
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'attach_child_security_validation_failed',
      expect.objectContaining({
        reason: 'bad-peer',
        child_system_id: 'child-2',
      })
    );
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'attach_our_security_validation_warning',
      expect.objectContaining({
        reason: 'bad-ours',
        child_system_id: 'child-2',
      })
    );
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'attach_missing_signing_key',
      expect.objectContaining({
        child_system_id: 'child-2',
      })
    );
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'attach_missing_encryption_key',
      expect.objectContaining({
        child_system_id: 'child-2',
      })
    );
  });

  it('logs when no keys provided but policy requires exchange and handles transport errors', async () => {
    const addKeys = jest.fn(async () => {
      throw new FameTransportClose('closing', 4001);
    });
    const keyManager = {
      addKeys,
    } as unknown as KeyManager;
    const manager = new DefaultSecurityManager(
      noopPolicy,
      null,
      null,
      null,
      keyManager
    );
    jest
      .spyOn(
        manager as unknown as { _getKeysToProvide(): any },
        '_getKeysToProvide'
      )
      .mockReturnValue(null);

    const sentinelPolicy = {
      validateAttachSecurityCompatibility: jest.fn(
        () => [true, undefined] as [boolean, string | undefined]
      ),
      requirements: jest.fn(() => ({
        requireSigningKeyExchange: true,
        requireEncryptionKeyExchange: true,
      })),
    } as unknown as SecurityPolicy;

    const node = createNode({
      securityManager: {
        policy: sentinelPolicy,
      } as unknown as SecurityManager,
    });

    await manager.onChildAttach({
      childSystemId: 'child-3',
      childKeys: undefined,
      nodeLike: node,
      originType: DeliveryOriginType.LOCAL,
      assignedPath: '/child',
    });

    expect(mockLogger.warning).toHaveBeenCalledWith(
      'attach_no_keys_provided',
      expect.objectContaining({
        child_system_id: 'child-3',
      })
    );

    await manager.onChildAttach({
      childSystemId: 'child-3',
      childKeys: [{ kid: 'ck' }],
      nodeLike: node,
      originType: DeliveryOriginType.LOCAL,
      assignedPath: '/child',
    });

    expect(mockLogger.error).toHaveBeenCalledWith(
      'failed_to_add_attach_keys_will_retry_on_epoch_change',
      expect.objectContaining({
        parent_id: 'child-3',
      })
    );
  });
});

describe('DefaultSecurityManager forwarding flows', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('handles outbound security on upstream forwarding when keys pending', async () => {
    const policy = createPermissivePolicy();
    const manager = new DefaultSecurityManager(policy);
    const handler = {
      handleOutboundSecurity: jest.fn(async () => false),
    };
    (manager as any)._envelopeSecurityHandler = handler;
    const node = createNode();
    const envelope = {
      id: 'env-upstream',
      frame: { type: 'Data' },
      sec: { sig: 'sig' },
    } as unknown as FameEnvelope;
    const context = {
      originType: DeliveryOriginType.LOCAL,
    } as FameDeliveryContext;

    await expect(
      manager.onForwardUpstream(node, envelope, context)
    ).resolves.toBeNull();

    expect(handler.handleOutboundSecurity).toHaveBeenCalledWith(
      envelope,
      expect.objectContaining({
        originType: DeliveryOriginType.LOCAL,
      })
    );
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'on_forward_upstream_queued_for_keys',
      {
        envp_id: 'env-upstream',
      }
    );
  });

  it('warns when critical frame cannot be secured while forwarding to route', async () => {
    const policy = createPermissivePolicy();
    const manager = new DefaultSecurityManager(policy);
    const handler = {
      handleOutboundSecurity: jest.fn(async () => false),
    };
    (manager as any)._envelopeSecurityHandler = handler;
    const node = createNode();
    const envelope = {
      id: 'env-route-critical',
      frame: { type: 'KeyRequest' },
      sec: {},
    } as unknown as FameEnvelope;
    const context = {
      originType: DeliveryOriginType.PEER,
    } as FameDeliveryContext;

    await expect(
      manager.onForwardToRoute(node, 'seg-1', envelope, context)
    ).resolves.toBeNull();

    expect(handler.handleOutboundSecurity).toHaveBeenCalledWith(
      envelope,
      expect.objectContaining({
        fromSystemId: node.id,
        originType: DeliveryOriginType.LOCAL,
      })
    );
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'critical_frame_forwarding_failed_missing_keys',
      expect.objectContaining({
        envp_id: 'env-route-critical',
        next_segment: 'seg-1',
      })
    );
  });

  it('queues local route forwarding when keys are pending', async () => {
    const policy = createPermissivePolicy();
    const manager = new DefaultSecurityManager(policy);
    const handler = {
      handleOutboundSecurity: jest.fn(async () => false),
    };
    (manager as any)._envelopeSecurityHandler = handler;
    const node = createNode();
    const envelope = {
      id: 'env-route-local',
      frame: { type: 'Data' },
      sec: { sig: 'sig' },
    } as unknown as FameEnvelope;
    const context = {
      originType: DeliveryOriginType.LOCAL,
    } as FameDeliveryContext;

    await expect(
      manager.onForwardToRoute(node, 'seg-2', envelope, context)
    ).resolves.toBeNull();

    expect(handler.handleOutboundSecurity).toHaveBeenCalledWith(
      envelope,
      expect.objectContaining({ originType: DeliveryOriginType.LOCAL })
    );
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'on_forward_to_route_queued_for_keys',
      expect.objectContaining({
        envp_id: 'env-route-local',
        next_segment: 'seg-2',
      })
    );
  });

  it('errors when forwarding critical frame to peer without security handler', async () => {
    const policy = createPermissivePolicy();
    const manager = new DefaultSecurityManager(policy);
    const node = createNode();
    const envelope = {
      id: 'env-peer-critical',
      frame: { type: 'KeyRequest' },
    } as unknown as FameEnvelope;
    const context = {
      originType: DeliveryOriginType.PEER,
    } as FameDeliveryContext;

    await expect(
      manager.onForwardToPeer(node, 'peer-1', envelope, context)
    ).resolves.toBeNull();

    expect(mockLogger.error).toHaveBeenCalledWith(
      'critical_frame_forwarding_failed_no_security_handler',
      expect.objectContaining({
        envp_id: 'env-peer-critical',
        peer_segment: 'peer-1',
      })
    );
  });

  it('queues peer forwarding when local outbound security needs keys', async () => {
    const policy = createPermissivePolicy();
    const manager = new DefaultSecurityManager(policy);
    const handler = {
      handleOutboundSecurity: jest.fn(async () => false),
    };
    (manager as any)._envelopeSecurityHandler = handler;
    const node = createNode();
    const envelope = {
      id: 'env-peer-local',
      frame: { type: 'Data' },
      sec: { sig: 'sig' },
    } as unknown as FameEnvelope;
    const context = {
      originType: DeliveryOriginType.LOCAL,
    } as FameDeliveryContext;

    await expect(
      manager.onForwardToPeer(node, 'peer-2', envelope, context)
    ).resolves.toBeNull();

    expect(handler.handleOutboundSecurity).toHaveBeenCalledWith(
      envelope,
      context
    );
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'on_forward_to_peer_queued_for_keys',
      expect.objectContaining({
        envp_id: 'env-peer-local',
        peer_segment: 'peer-2',
      })
    );
  });

  it('completes forwarding to peers when security succeeds', async () => {
    const policy = createPermissivePolicy();
    const manager = new DefaultSecurityManager(policy);
    const handler = {
      handleOutboundSecurity: jest.fn(async () => true),
    };
    (manager as any)._envelopeSecurityHandler = handler;
    const node = createNode();
    const envelope = {
      id: 'env-peers',
      frame: { type: 'Data' },
      sec: { sig: 'sig' },
    } as unknown as FameEnvelope;
    const context = {
      originType: DeliveryOriginType.LOCAL,
    } as FameDeliveryContext;

    await expect(
      manager.onForwardToPeers(node, envelope, ['peer-a'], undefined, context)
    ).resolves.toBe(envelope);

    expect(handler.handleOutboundSecurity).toHaveBeenCalledWith(
      envelope,
      context
    );
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'on_forward_to_peers_security_processing_complete',
      expect.objectContaining({
        envp_id: 'env-peers',
      })
    );
  });
});

describe('DefaultSecurityManager welcome and heartbeat handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rethrows certificate validation failures from onWelcome', async () => {
    const certificateManager = {
      onWelcome: jest.fn(async () => {
        throw new Error('certificate validation failed: mismatch');
      }),
    } as unknown as CertificateManager;
    const manager = new DefaultSecurityManager(
      noopPolicy,
      null,
      null,
      null,
      null,
      null,
      certificateManager
    );
    const welcomeFrame = {
      system_id: 'child',
      assigned_path: '/path',
    } as unknown as NodeWelcomeFrame;

    await expect(manager.onWelcome(welcomeFrame)).rejects.toThrow(
      'certificate validation failed: mismatch'
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      'child_node_certificate_validation_failed_stopping_node',
      expect.objectContaining({
        node_id: 'child',
        assigned_path: '/path',
      })
    );
  });

  it('logs warning when certificate provisioning fails but continues', async () => {
    const certificateManager = {
      onWelcome: jest.fn(async () => {
        throw new Error('network issue');
      }),
    } as unknown as CertificateManager;
    const manager = new DefaultSecurityManager(
      noopPolicy,
      null,
      null,
      null,
      null,
      null,
      certificateManager
    );
    const welcomeFrame = {
      system_id: 'child',
      assigned_path: '/path',
    } as unknown as NodeWelcomeFrame;

    await expect(manager.onWelcome(welcomeFrame)).resolves.toBeUndefined();
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'certificate_provisioning_error_proceeding_without_cert',
      expect.objectContaining({
        error: 'network issue',
        node_id: 'child',
      })
    );
  });

  it('verifies heartbeat signatures when verifier is present', async () => {
    const envelopeVerifier = {
      verifyEnvelope: jest.fn(async () => undefined),
    } as unknown as EnvelopeVerifier;
    const manager = new DefaultSecurityManager(
      noopPolicy,
      null,
      envelopeVerifier
    );
    const envelope = {
      id: 'heartbeat-1',
      sec: { sig: 'sig' },
    } as unknown as FameEnvelope;

    await manager.onHeartbeatReceived(envelope);

    expect(envelopeVerifier.verifyEnvelope).toHaveBeenCalledWith(envelope);
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'heartbeat_ack_envelope_verified'
    );
  });

  it('warns when signature present but verifier missing and policy requires verification', async () => {
    const policy = { ...noopPolicy } as SecurityPolicy;
    policy.requirements = jest.fn(
      () =>
        new SecurityRequirements({
          verificationRequired: true,
        })
    ) as SecurityPolicy['requirements'];
    const manager = new DefaultSecurityManager(policy);
    const envelope = {
      id: 'heartbeat-2',
      sec: { sig: 'sig' },
    } as unknown as FameEnvelope;

    await manager.onHeartbeatReceived(envelope);

    expect(mockLogger.warning).toHaveBeenCalledWith(
      'heartbeat_signature_present_but_no_verifier_policy_requires_verification',
      expect.objectContaining({ envelope_id: 'heartbeat-2' })
    );
  });

  it('suppresses warning when requirements lookup throws', async () => {
    const policy = { ...noopPolicy } as SecurityPolicy;
    policy.requirements = jest.fn(() => {
      throw new Error('bad');
    }) as SecurityPolicy['requirements'];
    const manager = new DefaultSecurityManager(policy);
    const envelope = {
      id: 'heartbeat-3',
      sec: { sig: 'sig' },
    } as unknown as FameEnvelope;

    await manager.onHeartbeatReceived(envelope);

    expect(mockLogger.debug).toHaveBeenCalledWith(
      'could_not_determine_verification_policy_allowing_heartbeat',
      {
        envelope_id: 'heartbeat-3',
      }
    );
  });

  it('logs failure details when heartbeat signature verification throws', async () => {
    const envelopeVerifier = {
      verifyEnvelope: jest.fn(async () => {
        throw new Error('invalid signature');
      }),
    } as unknown as EnvelopeVerifier;
    const manager = new DefaultSecurityManager(
      noopPolicy,
      null,
      envelopeVerifier
    );
    const envelope = {
      id: 'heartbeat-4',
      sec: { sig: 'sig' },
    } as unknown as FameEnvelope;

    await manager.onHeartbeatReceived(envelope);

    expect(mockLogger.warning).toHaveBeenCalledWith(
      'heartbeat_envelope_verification_failed',
      expect.objectContaining({
        envelope_id: 'heartbeat-4',
        error: 'invalid signature',
        exc_info: true,
      })
    );
  });

  it('warns when verification required flag uses snake_case property', async () => {
    const policy = { ...noopPolicy } as SecurityPolicy;
    policy.requirements = jest.fn(
      () => ({ verification_required: true }) as unknown as SecurityRequirements
    ) as SecurityPolicy['requirements'];
    const manager = new DefaultSecurityManager(policy);
    const envelope = {
      id: 'heartbeat-5',
      sec: { sig: 'sig' },
    } as unknown as FameEnvelope;

    await manager.onHeartbeatReceived(envelope);

    expect(mockLogger.warning).toHaveBeenCalledWith(
      'heartbeat_signature_present_but_no_verifier_policy_requires_verification',
      { envelope_id: 'heartbeat-5' }
    );
  });
});

describe('DefaultSecurityManager epoch change handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('announces keys upstream when key manager supports it', async () => {
    const keyManager = {
      announceKeysToUpstream: jest.fn(async () => undefined),
    } as unknown as KeyManager;
    const manager = new DefaultSecurityManager(
      noopPolicy,
      null,
      null,
      null,
      keyManager
    );

    await manager.onEpochChange(createNode(), 'epoch-42');

    expect(mockLogger.debug).toHaveBeenCalledWith(
      'handle_epoch_change_security',
      {
        epoch: 'epoch-42',
      }
    );
    expect(keyManager.announceKeysToUpstream).toHaveBeenCalledTimes(1);
  });

  it('logs when key announcement is skipped due to missing key manager', async () => {
    const manager = new DefaultSecurityManager(noopPolicy);

    await manager.onEpochChange(createNode(), 'epoch-43');

    expect(mockLogger.debug).toHaveBeenCalledWith(
      'handle_epoch_change_security',
      {
        epoch: 'epoch-43',
      }
    );
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'skipping_key_announcement_no_key_manager'
    );
  });
});

describe('DefaultSecurityManager node shutdown handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('stops and clears all managed security components', async () => {
    const keyFrameHandler = { stop: jest.fn(async () => undefined) };
    const keyManagementHandler = { stop: jest.fn(async () => undefined) };
    const keyManager = {
      onNodeStopped: jest.fn(async () => undefined),
    } as unknown as KeyManager;
    const certificateManager = {
      onNodeStopped: jest.fn(async () => undefined),
    } as unknown as CertificateManager;
    const encryption = {
      onNodeStopped: jest.fn(async () => undefined),
    } as unknown as ExtendedEncryptionManager;

    const manager = new DefaultSecurityManager(
      noopPolicy,
      null,
      null,
      encryption,
      keyManager,
      null,
      certificateManager
    );
    (manager as any)._keyFrameHandler = keyFrameHandler;
    (manager as any)._keyManagementHandler = keyManagementHandler;

    const node = createNode();

    await manager.onNodeStopped(node);

    expect(mockLogger.debug).toHaveBeenCalledWith(
      'stopping_security_components',
      {
        node_id: node.id,
      }
    );
    expect(keyFrameHandler.stop).toHaveBeenCalledTimes(1);
    expect((manager as any)._keyFrameHandler).toBeNull();
    expect(keyManagementHandler.stop).toHaveBeenCalledTimes(1);
    expect((manager as any)._keyManagementHandler).toBeNull();
    expect(keyManager.onNodeStopped).toHaveBeenCalledWith(node);
    expect(certificateManager.onNodeStopped).toHaveBeenCalledWith(node);
    expect(encryption.onNodeStopped).toHaveBeenCalledWith(node);
  });
});

describe('DefaultSecurityManager welcome short-circuit', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns immediately when certificate manager is not configured', async () => {
    const manager = new DefaultSecurityManager(noopPolicy);

    await expect(
      manager.onWelcome({} as NodeWelcomeFrame)
    ).resolves.toBeUndefined();
    expect(mockLogger.error).not.toHaveBeenCalledWith(
      'child_node_certificate_validation_failed_stopping_node',
      expect.anything()
    );
    expect(mockLogger.warning).not.toHaveBeenCalledWith(
      'certificate_provisioning_error_proceeding_without_cert',
      expect.anything()
    );
  });
});
