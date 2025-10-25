import {
  DeliveryOriginType,
  FameAddress,
  type FameDeliveryContext,
  type FameEnvelope,
} from '@naylence/core';

import { DefaultSecurityManager } from '../default-security-manager.js';
import {
  CryptoLevel,
  SecurityAction,
  SecurityRequirements,
  type SecurityPolicy,
} from '../policy/security-policy.js';
import type { EnvelopeVerifier } from '../signing/envelope-verifier.js';
import type { NodeLike } from '../../node/node-like.js';

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

function createNode(overrides: Partial<NodeLike> = {}): NodeLike {
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

function createEnvelope(overrides: Partial<FameEnvelope> = {}): FameEnvelope {
  return {
    id: 'env-1',
    version: '1.0',
    ts: new Date(),
    frame: { type: 'Data' } as FameEnvelope['frame'],
    sec: undefined,
    ...overrides,
  };
}

function createContext(
  overrides: Partial<FameDeliveryContext> = {}
): FameDeliveryContext {
  return {
    originType: DeliveryOriginType.PEER,
    fromSystemId: 'peer-node',
    expectedResponseType: overrides.expectedResponseType ?? 0,
    ...overrides,
  } as FameDeliveryContext;
}

describe('DefaultSecurityManager.onDeliverLocal', () => {
  const address = FameAddress.create('service@/local');

  it('rejects inbound envelope when crypto level violation requires reject', async () => {
    const policy = createPolicy({
      classifyMessageCryptoLevel: jest.fn(() => CryptoLevel.SEALED),
      isInboundCryptoLevelAllowed: jest.fn(() => false),
      getInboundViolationAction: jest.fn(() => SecurityAction.REJECT),
    });
    const manager = new DefaultSecurityManager(policy);
    const node = createNode();
    const envelope = createEnvelope();

    const result = await manager.onDeliverLocal(node, address, envelope);

    expect(result).toBeNull();
    expect(policy.getInboundViolationAction).toHaveBeenCalledWith(
      CryptoLevel.SEALED,
      envelope,
      undefined
    );
  });

  it('nacks inbound envelope when crypto level violation requires nack', async () => {
    const policy = createPolicy({
      classifyMessageCryptoLevel: jest.fn(() => CryptoLevel.SEALED),
      isInboundCryptoLevelAllowed: jest.fn(() => false),
      getInboundViolationAction: jest.fn(() => SecurityAction.NACK),
    });
    const manager = new DefaultSecurityManager(policy);
    const node = createNode();
    const envelope = createEnvelope({
      replyTo: FameAddress.create('reply@/client'),
    });
    const sendNack = jest.fn(async () => undefined);
    (manager as any).sendNack = sendNack;

    const result = await manager.onDeliverLocal(node, address, envelope);

    expect(result).toBeNull();
    expect(sendNack).toHaveBeenCalledWith(
      node,
      envelope,
      'crypto_level_violation'
    );
  });

  it('rejects when signature is required but missing', async () => {
    const policy = createPolicy({
      isSignatureRequired: jest.fn(() => true),
      getUnsignedViolationAction: jest.fn(() => SecurityAction.REJECT),
    });
    const manager = new DefaultSecurityManager(policy);
    const result = await manager.onDeliverLocal(
      createNode(),
      address,
      createEnvelope()
    );
    expect(result).toBeNull();
    expect(policy.getUnsignedViolationAction).toHaveBeenCalled();
  });

  it('nacks when signature is missing and policy requests nack', async () => {
    const policy = createPolicy({
      isSignatureRequired: jest.fn(() => true),
      getUnsignedViolationAction: jest.fn(() => SecurityAction.NACK),
    });
    const manager = new DefaultSecurityManager(policy);
    const node = createNode();
    const envelope = createEnvelope({
      replyTo: FameAddress.create('reply@/client'),
    });
    const sendNack = jest.fn(async () => undefined);
    (manager as any).sendNack = sendNack;

    const result = await manager.onDeliverLocal(node, address, envelope);

    expect(result).toBeNull();
    expect(sendNack).toHaveBeenCalledWith(node, envelope, 'signature_required');
  });

  it('nacks when signature verification fails', async () => {
    const policy = createPolicy({
      shouldVerifySignature: jest.fn(async () => true),
      getInvalidSignatureViolationAction: jest.fn(() => SecurityAction.NACK),
    });
    const envelopeVerifier: EnvelopeVerifier = {
      verifyEnvelope: jest.fn(async () => {
        throw new Error('bad signature');
      }),
    };
    const manager = new DefaultSecurityManager(policy, null, envelopeVerifier);
    const node = createNode();
    const envelope = createEnvelope({
      sec: { sig: { val: 'sig-data' } } as FameEnvelope['sec'],
      replyTo: FameAddress.create('reply@/client'),
    });
    const sendNack = jest.fn(async () => undefined);
    (manager as any).sendNack = sendNack;

    const result = await manager.onDeliverLocal(node, address, envelope);

    expect(result).toBeNull();
    expect(sendNack).toHaveBeenCalledWith(
      node,
      envelope,
      'signature_verification_failed'
    );
  });

  it('throws when plaintext payload digest mismatches', async () => {
    const manager = new DefaultSecurityManager(createPolicy());
    const envelope = createEnvelope({
      sec: { sig: { val: 'sig-data' } } as FameEnvelope['sec'],
      frame: {
        type: 'Data',
        payload: { hello: 'world' },
        pd: 'invalid-digest',
      } as FameEnvelope['frame'],
    });

    await expect(
      manager.onDeliverLocal(createNode(), address, envelope)
    ).rejects.toThrow('Payload digest mismatch on final delivery');
  });

  it('decrypts envelope when handler requests decryption', async () => {
    const manager = new DefaultSecurityManager(createPolicy());
    const decrypted = createEnvelope({ id: 'decrypted' });
    (manager as any)._envelopeSecurityHandler = {
      shouldDecryptEnvelope: jest.fn(async () => true),
      decryptEnvelope: jest.fn(async () => decrypted),
    };

    const result = await manager.onDeliverLocal(
      createNode(),
      address,
      createEnvelope()
    );

    expect(result).toBe(decrypted);
    expect(
      (manager as any)._envelopeSecurityHandler.shouldDecryptEnvelope
    ).toHaveBeenCalled();
  });

  it('routes secure accept frames to secure channel handler', async () => {
    const manager = new DefaultSecurityManager(createPolicy());
    const handleSecureAccept = jest.fn(async () => undefined);
    (manager as any)._secureChannelFrameHandler = {
      handleSecureAccept,
      handleSecureOpen: jest.fn(),
      handleSecureClose: jest.fn(),
    };

    const envelope = createEnvelope({
      frame: { type: 'SecureAccept' } as FameEnvelope['frame'],
    });
    const result = await manager.onDeliverLocal(
      createNode(),
      address,
      envelope
    );

    expect(result).toBeNull();
    expect(handleSecureAccept).toHaveBeenCalledWith(envelope, null);
  });
});

describe('DefaultSecurityManager.onDeliver', () => {
  it('rejects unsigned critical frame from non-local origin', async () => {
    const policy = createPolicy();
    const manager = new DefaultSecurityManager(policy);
    const envelope = createEnvelope({
      frame: { type: 'SecureOpen' } as FameEnvelope['frame'],
    });
    const result = await manager.onDeliver(
      createNode(),
      envelope,
      createContext()
    );
    expect(result).toBeNull();
  });

  it('nacks unsigned envelope when policy requires signature', async () => {
    const policy = createPolicy({
      isSignatureRequired: jest.fn(() => true),
      getUnsignedViolationAction: jest.fn(() => SecurityAction.NACK),
    });
    const manager = new DefaultSecurityManager(policy);
    const result = await manager.onDeliver(
      createNode(),
      createEnvelope(),
      createContext()
    );
    expect(result).toBeNull();
  });

  it('authorizes envelope and stores authorization results in context', async () => {
    const policy = createPolicy();
    const authorize = jest.fn(async () => ({ principal: 'alice' }));
    const manager = new DefaultSecurityManager(policy, null, null, null, null, {
      authorize,
    } as any);

    const context = createContext();
    const envelope = createEnvelope({
      sec: { sig: { val: 'sig-data' } } as FameEnvelope['sec'],
    });

    const result = await manager.onDeliver(createNode(), envelope, context);

    expect(result).toBe(envelope);
    expect(authorize).toHaveBeenCalled();
    expect(context.security?.authorization?.principal).toBe('alice');
  });

  it('drops envelope when authorization throws', async () => {
    const policy = createPolicy();
    const authorize = jest.fn(async () => {
      throw new Error('denied');
    });
    const manager = new DefaultSecurityManager(policy, null, null, null, null, {
      authorize,
    } as any);

    const result = await manager.onDeliver(
      createNode(),
      createEnvelope(),
      createContext()
    );
    expect(result).toBeNull();
  });
});
