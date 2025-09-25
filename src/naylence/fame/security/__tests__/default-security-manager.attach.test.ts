import {
  DeliveryOriginType,
  type FameConnector,
} from 'naylence-core';

import { DefaultSecurityManager } from '../default-security-manager.js';
import type { SecurityPolicy } from '../policy/security-policy.js';
import { SecurityRequirements } from '../policy/security-policy.js';
import type { KeyManager } from '../keys/key-manager.js';
import type { EncryptionManager } from '../encryption/encryption-manager.js';
import type { CertificateManager } from '../cert/certificate-manager.js';
import type { NodeLike } from '../../node/node-like.js';

type ExtendedEncryptionManager = EncryptionManager & {
  onNodeInitialized?: jest.Mock;
  onNodeAttachToUpstream?: jest.Mock;
  onNodeAttachToPeer?: jest.Mock;
  onNodeStopped?: jest.Mock;
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
  requirements: jest.fn(() => new SecurityRequirements({
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
  })),
};

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
        validateAttachSecurityCompatibility: jest.fn(
          (): [boolean, string?] => [true]
        ),
      } as SecurityPolicy,
      null,
      null,
      encryption,
      keyManager
    );
    const retryPending = jest.fn(async () => undefined);
    (manager as any)._keyManagementHandler = { retryPendingKeyRequestsAfterAttachment: retryPending };
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
  expect(encryption.onNodeAttachToUpstream).toHaveBeenCalledWith(node, attachInfo);
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

    await expect(manager.onNodeAttachToUpstream(node, {} as any)).resolves.toBeUndefined();
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
    const manager = new DefaultSecurityManager(noopPolicy, null, null, encryption, keyManager, null, certificateManager);
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
    expect(certificateManager.onNodeAttachToPeer).toHaveBeenCalledWith(node, attachInfo, expect.any(Object));
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
    const manager = new DefaultSecurityManager(noopPolicy, null, null, encryption, keyManager, null, certificateManager);
    const stopSpy = jest.fn(async () => undefined);
    (manager as any)._keyFrameHandler = { stop: stopSpy };
    (manager as any)._keyManagementHandler = { stop: jest.fn(async () => undefined) };

    const node = createNode();
    await manager.onNodeInitialized(node);
    await manager.onNodeStopped(node);

    expect(keyManager.onNodeInitialized).toHaveBeenCalledWith(node);
    expect(certificateManager.onNodeStopped).toHaveBeenCalledWith(node);
  expect(encryption.onNodeStopped).toHaveBeenCalledWith(node);
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });
});
