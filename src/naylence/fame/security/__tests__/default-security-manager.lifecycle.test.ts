import type { FameEnvelope } from 'naylence-core';

import { DefaultSecurityManager } from '../default-security-manager.js';
import {
  CryptoLevel,
  SecurityAction,
  SecurityRequirements,
  type SecurityPolicy,
} from '../policy/security-policy.js';
import type { KeyManager } from '../keys/key-manager.js';
import type { NodeLike } from '../../node/node-like.js';
import type { EncryptionManager } from '../encryption/encryption-manager.js';
import type { Authorizer } from '../auth/authorizer.js';
import type { CertificateManager } from '../cert/certificate-manager.js';
import * as cryptoProviderModule from '../crypto/providers/crypto-provider.js';

const createKeyManagementInstance = () => ({
  start: jest.fn(async () => undefined),
  stop: jest.fn(async () => undefined),
  acceptKeyAnnounce: jest.fn(async () => undefined),
  acceptKeyRequest: jest.fn(async () => undefined),
  retryPendingKeyRequestsAfterAttachment: jest.fn(async () => undefined),
});

const createEnvelopeSecurityInstance = () => ({
  shouldDecryptEnvelope: jest.fn(async () => false),
  decryptEnvelope: jest.fn(async (env: FameEnvelope) => env),
  handleEnvelopeSecurity: jest.fn(async (env: FameEnvelope) => [env, true] as const),
  handleOutboundSecurity: jest.fn(async () => true),
});

const createSecureChannelInstance = () => ({
  handleSecureOpen: jest.fn(async () => undefined),
  handleSecureAccept: jest.fn(async () => undefined),
  handleSecureClose: jest.fn(async () => undefined),
});

const createKeyFrameInstance = () => ({
  start: jest.fn(async () => undefined),
  stop: jest.fn(async () => undefined),
  acceptKeyAnnounce: jest.fn(async () => undefined),
  acceptKeyRequest: jest.fn(async () => true),
});

jest.mock(
  '../keys/key-management-handler.js',
  () => {
    const instances: Array<ReturnType<typeof createKeyManagementInstance>> = [];
    const mock = jest.fn(() => {
      const instance = createKeyManagementInstance();
      instances.push(instance);
      return instance;
    });

    return {
      __esModule: true,
      KeyManagementHandler: mock,
      __mockInstances: instances,
    };
  },
  { virtual: true }
);

jest.mock(
  '../node/envelope-security-handler',
  () => {
    const instances: Array<ReturnType<typeof createEnvelopeSecurityInstance>> = [];
    const mock = jest.fn(() => {
      const instance = createEnvelopeSecurityInstance();
      instances.push(instance);
      return instance;
    });

    return {
      __esModule: true,
      EnvelopeSecurityHandler: mock,
      __mockInstances: instances,
    };
  },
  { virtual: true }
);

jest.mock(
  '../node/secure-channel-frame-handler',
  () => {
    const instances: Array<ReturnType<typeof createSecureChannelInstance>> = [];
    const mock = jest.fn(() => {
      const instance = createSecureChannelInstance();
      instances.push(instance);
      return instance;
    });

    return {
      __esModule: true,
      SecureChannelFrameHandler: mock,
      __mockInstances: instances,
    };
  },
  { virtual: true }
);

jest.mock(
  '../sentinel/key-frame-handler',
  () => {
    const instances: Array<ReturnType<typeof createKeyFrameInstance>> = [];
    const mock = jest.fn(() => {
      const instance = createKeyFrameInstance();
      instances.push(instance);
      return instance;
    });

    return {
      __esModule: true,
      KeyFrameHandler: mock,
      __mockInstances: instances,
    };
  },
  { virtual: true }
);

const {
  KeyManagementHandler: KeyManagementHandlerMock,
} = jest.requireMock('../keys/key-management-handler.js') as {
  KeyManagementHandler: jest.Mock;
};

const {
  EnvelopeSecurityHandler: EnvelopeSecurityHandlerMock,
} = jest.requireMock('../node/envelope-security-handler') as {
  EnvelopeSecurityHandler: jest.Mock;
};

const {
  SecureChannelFrameHandler: SecureChannelFrameHandlerMock,
} = jest.requireMock('../node/secure-channel-frame-handler') as {
  SecureChannelFrameHandler: jest.Mock;
};

const {
  KeyFrameHandler: KeyFrameHandlerMock,
} = jest.requireMock('../sentinel/key-frame-handler') as {
  KeyFrameHandler: jest.Mock;
};

function createPolicy(overrides: Partial<SecurityPolicy> = {}): SecurityPolicy {
  const requirements = new SecurityRequirements({
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
  });

  const base: SecurityPolicy = {
    shouldSignEnvelope: jest.fn(async () => false),
    shouldEncryptEnvelope: jest.fn(async () => false),
    getEncryptionOptions: jest.fn(async () => undefined),
    shouldVerifySignature: jest.fn(async () => false),
    shouldDecryptEnvelope: jest.fn(async () => false),
    classifyMessageCryptoLevel: jest.fn(() => CryptoLevel.PLAINTEXT),
    isInboundCryptoLevelAllowed: jest.fn(() => true),
    getInboundViolationAction: jest.fn(() => SecurityAction.ALLOW),
    getUnsignedViolationAction: jest.fn(() => SecurityAction.ALLOW),
    getInvalidSignatureViolationAction: jest.fn(() => SecurityAction.ALLOW),
    decideResponseCryptoLevel: jest.fn(async () => CryptoLevel.PLAINTEXT),
    decideOutboundCryptoLevel: jest.fn(async () => CryptoLevel.PLAINTEXT),
    isSignatureRequired: jest.fn(() => false),
    requirements: jest.fn(() => requirements),
  };

  return { ...base, ...overrides };
}

function createNode(overrides: Record<string, unknown> = {}): NodeLike {
  return {
    id: 'node-1',
    deliver: jest.fn(async () => undefined),
    envelopeFactory: {
      createEnvelope: jest.fn(() => ({
        id: 'generated',
        version: '1',
        ts: new Date(),
        frame: { type: 'DeliveryAck' },
      })),
    },
    ...overrides,
  } as unknown as NodeLike;
}

function createManager(options: {
  envelopeSigner?: unknown;
  envelopeVerifier?: unknown;
  encryption?: EncryptionManager | null;
  keyManager?: KeyManager | null;
  authorizer?: Authorizer | null;
  certificateManager?: CertificateManager | null;
  secureChannelManager?: unknown;
  keyValidator?: unknown;
  policy?: SecurityPolicy;
} = {}): DefaultSecurityManager {
  const policy = options.policy ?? createPolicy();
  return new DefaultSecurityManager(
    policy,
    (options.envelopeSigner ?? null) as any,
    (options.envelopeVerifier ?? null) as any,
    (options.encryption ?? null) as any,
    (options.keyManager ?? null) as any,
    (options.authorizer ?? null) as any,
    (options.certificateManager ?? null) as any,
    (options.secureChannelManager ?? null) as any,
    (options.keyValidator ?? null) as any
  );
}


describe('DefaultSecurityManager lifecycle', () => {
  beforeEach(() => {
    KeyManagementHandlerMock.mockClear();
    EnvelopeSecurityHandlerMock.mockClear();
    SecureChannelFrameHandlerMock.mockClear();
    KeyFrameHandlerMock.mockClear();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('throws when overlay security is enabled without key validator', async () => {
    const keyManagerStub = { onNodeStarted: jest.fn() };
    const manager = createManager({
      envelopeSigner: {},
      keyManager: keyManagerStub as unknown as KeyManager,
      secureChannelManager: {},
    });

    await expect(manager.onNodeStarted(createNode())).rejects.toThrow(
      'Key validator must be set when overlay security is enabled'
    );
  });

  it('initializes security handlers when overlay security is available', async () => {
    const keyManagerStub = { onNodeStarted: jest.fn(async () => undefined) };
    const encryptionStub = { onNodeStarted: jest.fn(async () => undefined) };
    const manager = createManager({
      envelopeSigner: {},
      envelopeVerifier: {},
      keyManager: keyManagerStub as unknown as KeyManager,
      encryption: encryptionStub as unknown as EncryptionManager,
      secureChannelManager: {},
      keyValidator: { validate: jest.fn() },
    });
    const handlerInstance = createKeyManagementInstance();
    KeyManagementHandlerMock.mockImplementationOnce(() => handlerInstance);

    await manager.onNodeStarted(createNode());

    expect(KeyManagementHandlerMock).toHaveBeenCalledTimes(1);
    expect(handlerInstance.start).toHaveBeenCalledTimes(1);
    expect(KeyManagementHandlerMock).toHaveBeenCalledTimes(1);
    expect(manager.envelopeSecurityHandler).not.toBeNull();
    expect(manager.secureChannelFrameHandler).not.toBeNull();
  });

  it('propagates lifecycle events to dependencies', async () => {
    const keyManagerStub = {
      onNodeStarted: jest.fn(async () => undefined),
      onNodeInitialized: jest.fn(async () => undefined),
      onNodeStopped: jest.fn(async () => undefined),
    };
    const certificateStub = {
      onNodeStarted: jest.fn(async () => undefined),
      onNodeInitialized: jest.fn(async () => undefined),
      onNodeStopped: jest.fn(async () => undefined),
    };
    const encryptionStub = {
      onNodeStarted: jest.fn(async () => undefined),
      onNodeInitialized: jest.fn(async () => undefined),
      onNodeStopped: jest.fn(async () => undefined),
    };

    const manager = createManager({
      keyManager: keyManagerStub as unknown as KeyManager,
      certificateManager: certificateStub as unknown as CertificateManager,
      encryption: encryptionStub as unknown as EncryptionManager,
      envelopeSigner: {},
      keyValidator: { validate: jest.fn() },
      secureChannelManager: {},
    });

    const node = createNode();
    await manager.onNodeStarted(node);
    await manager.onNodeInitialized(node);
    await manager.onNodeStopped(node);

    expect(keyManagerStub.onNodeStarted).toHaveBeenCalledTimes(1);
    expect(keyManagerStub.onNodeInitialized).toHaveBeenCalledTimes(1);
    expect(keyManagerStub.onNodeStopped).toHaveBeenCalledTimes(1);
    expect(certificateStub.onNodeStarted).toHaveBeenCalledTimes(1);
    expect(certificateStub.onNodeInitialized).toHaveBeenCalledTimes(1);
    expect(certificateStub.onNodeStopped).toHaveBeenCalledTimes(1);
    expect(encryptionStub.onNodeStarted).toHaveBeenCalledTimes(1);
    expect(encryptionStub.onNodeInitialized).toHaveBeenCalledTimes(1);
    expect(encryptionStub.onNodeStopped).toHaveBeenCalledTimes(1);
  });

  it('stops handlers during node shutdown', async () => {
    const keyManagerStub = {
      onNodeStarted: jest.fn(async () => undefined),
      onNodeStopped: jest.fn(async () => undefined),
    };
    const manager = createManager({
      envelopeSigner: {},
      envelopeVerifier: {},
      keyManager: keyManagerStub as unknown as KeyManager,
      keyValidator: { validate: jest.fn() },
      secureChannelManager: {},
    });

    await manager.onNodeStarted(createNode());
    const handlerInstance = KeyManagementHandlerMock.mock.results[0]?.value;
    if (!handlerInstance) {
      throw new Error('KeyManagementHandler was not instantiated');
    }

    await manager.onNodeStopped(createNode());

    expect(handlerInstance.stop).toHaveBeenCalledTimes(1);
  });

  it('shares keys when signer is configured', () => {
    const providerSpy = jest.spyOn(cryptoProviderModule, 'getCryptoProvider').mockReturnValue({
      encryptionKeyId: 'enc-key',
      signatureKeyId: 'sig-key',
      nodeJwk: () => ({ kid: 'sig-key', use: 'sig', kty: 'OKP', crv: 'Ed25519' }),
      getJwks: () => ({
        keys: [
          { kid: 'sig-key', use: 'sig', kty: 'OKP', crv: 'Ed25519' },
          { kid: 'enc-key', use: 'enc', kty: 'OKP', crv: 'X25519' },
        ],
      }),
    });
    const manager = createManager({ envelopeSigner: {} });
    const keys = manager.getShareableKeys();
    expect(keys).toEqual([
      { kid: 'sig-key', use: 'sig', kty: 'OKP', crv: 'Ed25519' },
      { kid: 'enc-key', use: 'enc', kty: 'OKP', crv: 'X25519' },
    ]);
    providerSpy.mockRestore();
  });

  it('returns undefined shareable keys when signer is missing', () => {
    const manager = createManager();
    expect(manager.getShareableKeys()).toBeUndefined();
  });

  it('skips upstream key announcement when key manager is missing', async () => {
    const policy = createPolicy();
    const manager = createManager({ policy });
    await expect(manager.onEpochChange(createNode(), 'epoch-1')).resolves.toBeUndefined();
  });

  it('requests upstream key announcement when key manager supports it', async () => {
    const announceKeysToUpstream = jest.fn(async () => undefined);
    const manager = createManager({
      keyManager: { announceKeysToUpstream } as unknown as KeyManager,
    });
    await manager.onEpochChange(createNode(), 'epoch-2');
    expect(announceKeysToUpstream).toHaveBeenCalledTimes(1);
  });

  it('returns encryption key id when crypto provider exposes it', () => {
    const providerSpy = jest.spyOn(cryptoProviderModule, 'getCryptoProvider').mockReturnValue({
      encryptionKeyId: 'enc-key',
      signatureKeyId: 'sig-key',
      nodeJwk: () => ({ kid: 'sig-key', use: 'sig', kty: 'OKP', crv: 'Ed25519' }),
      getJwks: () => ({ keys: [] }),
    });
    const manager = createManager({ envelopeSigner: {} });
    expect(manager.getEncryptionKeyId()).toBe('enc-key');
    providerSpy.mockRestore();
  });

  it('reports overlay security support correctly', () => {
    const withoutOverlay = createManager();
    const withOverlay = createManager({ envelopeSigner: {} });

    expect(withoutOverlay.supportsOverlaySecurity).toBe(false);
    expect(withOverlay.supportsOverlaySecurity).toBe(true);
  });
});

