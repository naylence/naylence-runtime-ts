import { DeliveryOriginType, type FameDeliveryContext, type FameEnvelope } from 'naylence-core';

import type { NodeLike } from '../naylence/fame/node/node-like';
import {
  DefaultSecurityPolicy,
  type DefaultSecurityPolicyOptions,
} from '../naylence/fame/security/policy/default-security-policy';
import { DefaultSecurityPolicyFactory } from '../naylence/fame/security/policy/default-security-policy-factory';
import { NoSecurityPolicy } from '../naylence/fame/security/policy/no-security-policy';
import { NoSecurityPolicyFactory } from '../naylence/fame/security/policy/no-security-policy-factory';
import {
  CryptoLevel,
  SecurityAction,
  SignaturePolicy,
  SigningConfiguration,
  EncryptionConfiguration,
  SecurityRequirements,
  SigningMaterial,
  normalizeEncryptionConfig,
  normalizeSecurityRequirements,
  normalizeSigningConfig,
} from '../naylence/fame/security/policy/security-policy';
import {
  SECURITY_POLICY_FACTORY_BASE_TYPE,
  SecurityPolicyFactory,
} from '../naylence/fame/security/policy/security-policy-factory';
import { ResourceFactoryRegistry } from 'naylence-factory';
import { setCryptoProvider } from '../naylence/fame/security/crypto/providers/crypto-provider';

function makeEnvelope(overrides: Partial<FameEnvelope> = {}): FameEnvelope {
  const frame = overrides.frame ?? ({ type: 'Data', payload: {} } as any);
  return {
    id: overrides.id ?? `env-${Math.random().toString(36).slice(2)}`,
    frame: frame as FameEnvelope['frame'],
    meta: overrides.meta ?? {},
    sec: overrides.sec,
    to: overrides.to,
    flowFlags: overrides.flowFlags,
    ...overrides,
  } as FameEnvelope;
}

function makeContext(overrides: Partial<FameDeliveryContext> = {}): FameDeliveryContext {
  return {
    originType: DeliveryOriginType.LOCAL,
    meta: {},
    security: {},
    ...overrides,
  } as FameDeliveryContext;
}

function makePolicy(options: DefaultSecurityPolicyOptions = {}): DefaultSecurityPolicy {
  const signing =
    options.signing instanceof SigningConfiguration
      ? options.signing
      : new SigningConfiguration({
          inbound: {
            signaturePolicy: SignaturePolicy.OPTIONAL,
            unsignedViolationAction: SecurityAction.NACK,
            invalidSignatureAction: SecurityAction.REJECT,
            missingKeyAction: SecurityAction.NACK,
          },
          response: {
            mirrorRequestSigning: true,
            alwaysSignResponses: false,
            signErrorResponses: true,
          },
          outbound: {
            defaultSigning: true,
            signSensitiveOperations: false,
            signIfRecipientExpects: false,
          },
        });

  const encryption =
    options.encryption instanceof EncryptionConfiguration
      ? options.encryption
      : new EncryptionConfiguration({
          supportedChannelAlgorithms: ['channel-alg'],
          supportedSealedAlgorithms: ['sealed-alg'],
          inbound: {
            allowPlaintext: true,
            allowChannel: true,
            allowSealed: true,
            plaintextViolationAction: SecurityAction.ALLOW,
            channelViolationAction: SecurityAction.NACK,
            sealedViolationAction: SecurityAction.NACK,
          },
          response: {
            mirrorRequestLevel: true,
            minimumResponseLevel: CryptoLevel.CHANNEL,
            escalateSealedResponses: false,
          },
          outbound: {
            defaultLevel: CryptoLevel.CHANNEL,
            escalateIfPeerSupports: true,
            preferSealedForSensitive: false,
          },
        });

  return new DefaultSecurityPolicy({
    ...options,
    signing,
    encryption,
  });
}

const SAMPLE_KEY = {
  kid: 'key-1',
  use: 'enc',
  kty: 'OKP',
  crv: 'X25519',
  x: 'AAAAAAAAAAAAAAAAAAAAAA',
};

beforeEach(() => {
  setCryptoProvider(null);
});

afterEach(() => {
  jest.restoreAllMocks();
  ResourceFactoryRegistry.clearCache();
  setCryptoProvider(null);
});

describe('NoSecurityPolicy', () => {
  it('returns defaults for signing and encryption decisions', async () => {
    const policy = new NoSecurityPolicy();
    const envelope = makeEnvelope();

    expect(await policy.shouldSignEnvelope(envelope)).toBe(false);
    expect(await policy.shouldEncryptEnvelope(envelope)).toBe(false);
    expect(await policy.getEncryptionOptions(envelope)).toBeUndefined();
    expect(await policy.shouldVerifySignature(envelope)).toBe(false);
  });

  it('decrypts only encrypted envelopes and reports plaintext requirements', async () => {
    const policy = new NoSecurityPolicy();
    const plain = makeEnvelope();
    const encrypted = makeEnvelope({ sec: { enc: { alg: 'sealed' } } as any });

    expect(await policy.shouldDecryptEnvelope(plain)).toBe(false);
    expect(await policy.shouldDecryptEnvelope(encrypted)).toBe(true);
    expect(policy.classifyMessageCryptoLevel(encrypted)).toBe(CryptoLevel.PLAINTEXT);

    const requirements = policy.requirements();
    expect(requirements.signingRequired).toBe(false);
    expect(requirements.minimumCryptoLevel).toBe(CryptoLevel.PLAINTEXT);
  });

  it('allows inbound crypto and uses allow actions for unsigned cases', async () => {
    const policy = new NoSecurityPolicy();
    const envelope = makeEnvelope();

    expect(policy.isInboundCryptoLevelAllowed(CryptoLevel.SEALED, envelope)).toBe(true);
    expect(policy.getInboundViolationAction(CryptoLevel.CHANNEL, envelope)).toBe(
      SecurityAction.ALLOW
    );
    expect(await policy.decideResponseCryptoLevel(CryptoLevel.SEALED, envelope)).toBe(
      CryptoLevel.PLAINTEXT
    );
    expect(await policy.decideOutboundCryptoLevel(envelope)).toBe(CryptoLevel.PLAINTEXT);
    expect(policy.isSignatureRequired(envelope)).toBe(false);
    expect(policy.getUnsignedViolationAction(envelope)).toBe(SecurityAction.ALLOW);
    expect(policy.getInvalidSignatureViolationAction(envelope)).toBe(SecurityAction.ALLOW);
  });
});

describe('DefaultSecurityPolicy', () => {
  it('honors custom signing policy overrides', async () => {
    const customSigning = jest.fn().mockResolvedValue(true);
    const policy = makePolicy({ customSigningPolicy: customSigning });
    const envelope = makeEnvelope();

    expect(await policy.shouldSignEnvelope(envelope)).toBe(true);
    expect(customSigning).toHaveBeenCalledWith(envelope, undefined, undefined);
  });

  it('falls back to default signing when custom policy is non-boolean', async () => {
    const customSigning = jest.fn().mockResolvedValue('skip-it');
    const policy = makePolicy({ customSigningPolicy: customSigning });
    const encryptSpy = jest.spyOn(policy, 'shouldEncryptEnvelope').mockResolvedValue(false);
    const outboundSpy = jest
      .spyOn(policy as any, 'shouldSignOutboundRequest')
      .mockReturnValue(true);

    expect(await policy.shouldSignEnvelope(makeEnvelope(), makeContext())).toBe(true);
    expect(outboundSpy).toHaveBeenCalled();
    encryptSpy.mockRestore();
    outboundSpy.mockRestore();
  });

  it('skips signing when envelope already contains signature', async () => {
    const policy = makePolicy();
    const envelope = makeEnvelope({ sec: { sig: { alg: 'EdDSA' } } as any });

    expect(await policy.shouldSignEnvelope(envelope)).toBe(false);
  });

  it('requires signing when encryption will be applied', async () => {
    const policy = makePolicy({
      signing: new SigningConfiguration({
        inbound: {
          signaturePolicy: SignaturePolicy.OPTIONAL,
          unsignedViolationAction: SecurityAction.ALLOW,
          invalidSignatureAction: SecurityAction.REJECT,
          missingKeyAction: SecurityAction.NACK,
        },
        response: {
          mirrorRequestSigning: false,
          alwaysSignResponses: false,
          signErrorResponses: false,
        },
        outbound: {
          defaultSigning: false,
          signSensitiveOperations: false,
          signIfRecipientExpects: false,
        },
      }),
    });
    const envelope = makeEnvelope();
    const spy = jest.spyOn(policy, 'shouldEncryptEnvelope').mockResolvedValue(true);

    expect(await policy.shouldSignEnvelope(envelope, makeContext())).toBe(true);
    spy.mockRestore();
  });

  it('mirrors signatures for signed inbound responses', async () => {
    const policy = makePolicy({
      signing: new SigningConfiguration({
        inbound: {
          signaturePolicy: SignaturePolicy.OPTIONAL,
          unsignedViolationAction: SecurityAction.ALLOW,
          invalidSignatureAction: SecurityAction.REJECT,
          missingKeyAction: SecurityAction.NACK,
        },
        response: {
          mirrorRequestSigning: true,
          alwaysSignResponses: false,
          signErrorResponses: false,
        },
        outbound: {
          defaultSigning: false,
          signSensitiveOperations: false,
          signIfRecipientExpects: false,
        },
      }),
    });

    const envelope = makeEnvelope();
    const context = makeContext({
      meta: { 'message-type': 'response' },
      security: { inboundWasSigned: true },
    });

    expect(await policy.shouldSignEnvelope(envelope, context)).toBe(true);
  });

  it('mirrors signatures for responses to encrypted inbound requests', async () => {
    const policy = makePolicy({
      signing: new SigningConfiguration({
        inbound: {
          signaturePolicy: SignaturePolicy.OPTIONAL,
          unsignedViolationAction: SecurityAction.ALLOW,
          invalidSignatureAction: SecurityAction.REJECT,
          missingKeyAction: SecurityAction.NACK,
        },
        response: {
          mirrorRequestSigning: true,
          alwaysSignResponses: false,
          signErrorResponses: false,
        },
        outbound: {
          defaultSigning: false,
          signSensitiveOperations: false,
          signIfRecipientExpects: false,
        },
      }),
    });

    const context = makeContext({
      meta: { 'message-type': 'response' },
      security: { inboundCryptoLevel: CryptoLevel.CHANNEL },
    });

    expect(await policy.shouldSignEnvelope(makeEnvelope(), context)).toBe(true);
  });

  it('computes response signing using inbound signature flag', () => {
    const policy = makePolicy();
    const context = makeContext({
      meta: { 'message-type': 'response' },
      security: { inboundWasSigned: true },
    });

    expect((policy as any).shouldSignResponse(makeEnvelope(), context)).toBe(true);
  });

  it('computes response signing using inbound encryption level', () => {
    const policy = makePolicy();
    const context = makeContext({
      meta: { 'message-type': 'response' },
      security: { inboundCryptoLevel: CryptoLevel.SEALED },
    });

    expect((policy as any).shouldSignResponse(makeEnvelope(), context)).toBe(true);
  });

  it('returns false from response signing when no conditions match', () => {
    const policy = makePolicy();
    const context = makeContext({ meta: { 'message-type': 'response' } });

    expect((policy as any).shouldSignResponse(makeEnvelope(), context)).toBe(false);
  });

  it('signs error responses when configured to do so', async () => {
    const policy = makePolicy({
      signing: new SigningConfiguration({
        inbound: {
          signaturePolicy: SignaturePolicy.OPTIONAL,
          unsignedViolationAction: SecurityAction.ALLOW,
          invalidSignatureAction: SecurityAction.REJECT,
          missingKeyAction: SecurityAction.NACK,
        },
        response: {
          mirrorRequestSigning: false,
          alwaysSignResponses: false,
          signErrorResponses: true,
        },
        outbound: {
          defaultSigning: false,
          signSensitiveOperations: false,
          signIfRecipientExpects: false,
        },
      }),
    });

    const envelope = makeEnvelope({ frame: { type: 'Error' } as any });
    const context = makeContext({ meta: { 'message-type': 'response' } });

    expect(await policy.shouldSignEnvelope(envelope, context)).toBe(true);
  });

  it('always signs responses when configured without mirroring', async () => {
    const policy = makePolicy({
      signing: new SigningConfiguration({
        inbound: {
          signaturePolicy: SignaturePolicy.OPTIONAL,
          unsignedViolationAction: SecurityAction.ALLOW,
          invalidSignatureAction: SecurityAction.REJECT,
          missingKeyAction: SecurityAction.NACK,
        },
        response: {
          mirrorRequestSigning: false,
          alwaysSignResponses: true,
          signErrorResponses: false,
        },
        outbound: {
          defaultSigning: false,
          signSensitiveOperations: false,
          signIfRecipientExpects: false,
        },
      }),
    });

    const envelope = makeEnvelope();
    const context = makeContext({ meta: { 'message-type': 'response' } });
    expect(await policy.shouldSignEnvelope(envelope, context)).toBe(true);
  });

  it('consults response signing rules when encryption requires signing but mirroring is disabled', async () => {
    const policy = makePolicy({
      signing: new SigningConfiguration({
        inbound: {
          signaturePolicy: SignaturePolicy.OPTIONAL,
          unsignedViolationAction: SecurityAction.ALLOW,
          invalidSignatureAction: SecurityAction.REJECT,
          missingKeyAction: SecurityAction.NACK,
        },
        response: {
          mirrorRequestSigning: false,
          alwaysSignResponses: false,
          signErrorResponses: false,
        },
        outbound: {
          defaultSigning: false,
          signSensitiveOperations: false,
          signIfRecipientExpects: false,
        },
      }),
    });
    const encryptSpy = jest.spyOn(policy, 'shouldEncryptEnvelope').mockResolvedValue(true);
    const responseSpy = jest.spyOn(policy as any, 'shouldSignResponse').mockReturnValue(false);
    const context = makeContext({ meta: { 'message-type': 'response' } });

    expect(await policy.shouldSignEnvelope(makeEnvelope(), context)).toBe(false);
    expect(encryptSpy).toHaveBeenCalled();
    expect(responseSpy).toHaveBeenCalled();

    encryptSpy.mockRestore();
    responseSpy.mockRestore();
  });

  it('signs outbound sensitive operations when enabled', async () => {
    const policy = makePolicy({
      signing: new SigningConfiguration({
        inbound: {
          signaturePolicy: SignaturePolicy.OPTIONAL,
          unsignedViolationAction: SecurityAction.ALLOW,
          invalidSignatureAction: SecurityAction.REJECT,
          missingKeyAction: SecurityAction.NACK,
        },
        response: {
          mirrorRequestSigning: false,
          alwaysSignResponses: false,
          signErrorResponses: false,
        },
        outbound: {
          defaultSigning: false,
          signSensitiveOperations: true,
          signIfRecipientExpects: false,
        },
      }),
    });
    const sensitivitySpy = jest
      .spyOn(
        policy as unknown as { isSensitiveOperation: (envelope: FameEnvelope) => boolean },
        'isSensitiveOperation'
      )
      .mockReturnValue(true);

    const result = await policy.shouldSignEnvelope(makeEnvelope(), makeContext());
    expect(result).toBe(true);
    sensitivitySpy.mockRestore();
  });

  it('signs outbound requests when recipient expects signatures', async () => {
    const policy = makePolicy({
      signing: new SigningConfiguration({
        inbound: {
          signaturePolicy: SignaturePolicy.OPTIONAL,
          unsignedViolationAction: SecurityAction.ALLOW,
          invalidSignatureAction: SecurityAction.REJECT,
          missingKeyAction: SecurityAction.NACK,
        },
        response: {
          mirrorRequestSigning: false,
          alwaysSignResponses: false,
          signErrorResponses: false,
        },
        outbound: {
          defaultSigning: false,
          signSensitiveOperations: false,
          signIfRecipientExpects: true,
        },
      }),
    });

    expect(await policy.shouldSignEnvelope(makeEnvelope(), makeContext())).toBe(true);
  });

  it('determines encryption requirements based on context and headers', async () => {
    const policy = makePolicy();
    const envelope = makeEnvelope();

    expect(await policy.shouldEncryptEnvelope(envelope)).toBe(false);

    const downstreamContext = makeContext({ originType: DeliveryOriginType.DOWNSTREAM });
    expect(await policy.shouldEncryptEnvelope(envelope, downstreamContext)).toBe(false);

    const encryptedEnvelope = makeEnvelope({ sec: { enc: {} } as any });
    expect(await policy.shouldEncryptEnvelope(encryptedEnvelope, makeContext())).toBe(false);

    const decisionSpy = jest
      .spyOn(policy, 'decideOutboundCryptoLevel')
      .mockResolvedValue(CryptoLevel.SEALED);
    expect(await policy.shouldEncryptEnvelope(envelope, makeContext())).toBe(true);
    decisionSpy.mockRestore();
  });

  it('honors custom encryption policy decisions', async () => {
    const customEncryption = jest.fn().mockResolvedValue(false);
    const policy = makePolicy({ customEncryptionPolicy: customEncryption });
    const envelope = makeEnvelope();

    expect(await policy.shouldEncryptEnvelope(envelope, makeContext())).toBe(false);
    expect(customEncryption).toHaveBeenCalled();
  });

  it('falls back to outbound decision when custom encryption policy is non-boolean', async () => {
    const customEncryption = jest.fn().mockResolvedValue('escalate');
    const policy = makePolicy({ customEncryptionPolicy: customEncryption });
    const envelope = makeEnvelope();
    const outboundSpy = jest
      .spyOn(policy, 'decideOutboundCryptoLevel')
      .mockResolvedValue(CryptoLevel.CHANNEL);

    expect(await policy.shouldEncryptEnvelope(envelope, makeContext())).toBe(true);
    expect(outboundSpy).toHaveBeenCalled();
    outboundSpy.mockRestore();
  });

  it('encrypts responses when mirroring sealed requests', async () => {
    const policy = makePolicy({
      encryption: new EncryptionConfiguration({
        supportedChannelAlgorithms: ['channel-alg'],
        supportedSealedAlgorithms: ['sealed-alg'],
        inbound: {
          allowPlaintext: true,
          allowChannel: true,
          allowSealed: true,
          plaintextViolationAction: SecurityAction.ALLOW,
          channelViolationAction: SecurityAction.ALLOW,
          sealedViolationAction: SecurityAction.ALLOW,
        },
        response: {
          mirrorRequestLevel: true,
          minimumResponseLevel: CryptoLevel.PLAINTEXT,
          escalateSealedResponses: false,
        },
        outbound: {
          defaultLevel: CryptoLevel.PLAINTEXT,
          escalateIfPeerSupports: false,
          preferSealedForSensitive: false,
        },
      }),
    });

    const context = makeContext({
      originType: DeliveryOriginType.LOCAL,
      meta: { 'message-type': 'response' },
      security: { inboundCryptoLevel: CryptoLevel.SEALED },
    });

    expect(await policy.shouldEncryptEnvelope(makeEnvelope(), context)).toBe(true);
  });

  it('returns channel encryption options when channel should be used', async () => {
    const policy = makePolicy();
    const envelope = makeEnvelope({ to: 'peer@/channel' });
    const channelSpy = jest
      .spyOn(
        policy as unknown as { shouldUseChannelEncryption: (...args: any[]) => Promise<boolean> },
        'shouldUseChannelEncryption'
      )
      .mockResolvedValue(true);

    const options = await policy.getEncryptionOptions(envelope, makeContext());
    expect(options).toEqual({
      encryptionType: 'channel',
      destination: 'peer@/channel',
    });

    channelSpy.mockRestore();
  });

  it('evaluates channel encryption helper across scenarios', async () => {
    const policy = makePolicy();
    const helper = policy as unknown as {
      shouldUseChannelEncryption: (
        envelope: FameEnvelope,
        context?: FameDeliveryContext,
        nodeLike?: NodeLike
      ) => Promise<boolean>;
    };

    expect(
      await helper.shouldUseChannelEncryption(
        makeEnvelope(),
        makeContext({ originType: DeliveryOriginType.DOWNSTREAM })
      )
    ).toBe(false);

    expect(
      await helper.shouldUseChannelEncryption(
        makeEnvelope(),
        makeContext({
          originType: DeliveryOriginType.LOCAL,
          meta: { 'message-type': 'response' },
          security: { inboundCryptoLevel: CryptoLevel.SEALED },
        })
      )
    ).toBe(false);

    const desiredLevelPolicy = makePolicy({
      encryption: new EncryptionConfiguration({
        supportedChannelAlgorithms: ['channel-alg'],
        supportedSealedAlgorithms: ['sealed-alg'],
        inbound: {
          allowPlaintext: true,
          allowChannel: true,
          allowSealed: true,
          plaintextViolationAction: SecurityAction.ALLOW,
          channelViolationAction: SecurityAction.ALLOW,
          sealedViolationAction: SecurityAction.ALLOW,
        },
        response: {
          mirrorRequestLevel: false,
          minimumResponseLevel: CryptoLevel.PLAINTEXT,
          escalateSealedResponses: false,
        },
        outbound: {
          defaultLevel: CryptoLevel.PLAINTEXT,
          escalateIfPeerSupports: false,
          preferSealedForSensitive: false,
        },
      }),
    });
    const decideSpy = jest
      .spyOn(desiredLevelPolicy, 'decideOutboundCryptoLevel')
      .mockResolvedValue(CryptoLevel.CHANNEL);

    expect(
      await (
        desiredLevelPolicy as unknown as {
          shouldUseChannelEncryption: (
            envelope: FameEnvelope,
            context?: FameDeliveryContext,
            nodeLike?: NodeLike
          ) => Promise<boolean>;
        }
      ).shouldUseChannelEncryption(
        makeEnvelope(),
        makeContext({ originType: DeliveryOriginType.LOCAL })
      )
    ).toBe(true);

    expect(
      await (
        desiredLevelPolicy as unknown as {
          shouldUseChannelEncryption: (
            envelope: FameEnvelope,
            context?: FameDeliveryContext,
            nodeLike?: NodeLike
          ) => Promise<boolean>;
        }
      ).shouldUseChannelEncryption(
        makeEnvelope(),
        makeContext({
          originType: DeliveryOriginType.LOCAL,
          meta: { 'message-type': 'response' },
        })
      )
    ).toBe(true);

    decideSpy.mockRestore();
  });

  it('rejects channel encryption for non-data or pre-encrypted envelopes', async () => {
    const policy = makePolicy();
    const helper = policy as unknown as {
      shouldUseChannelEncryption: (
        envelope: FameEnvelope,
        context?: FameDeliveryContext,
        nodeLike?: NodeLike
      ) => Promise<boolean>;
    };

    expect(
      await helper.shouldUseChannelEncryption(
        makeEnvelope({ frame: { type: 'Error' } as any }),
        makeContext({ originType: DeliveryOriginType.LOCAL })
      )
    ).toBe(false);

    expect(
      await helper.shouldUseChannelEncryption(
        makeEnvelope({ sec: { enc: { alg: 'sealed' } } as any }),
        makeContext({ originType: DeliveryOriginType.LOCAL })
      )
    ).toBe(false);
  });

  it('fetches recipient encryption keys when available locally', async () => {
    const keyProvider = {
      getKey: jest.fn(),
      getKeysForPath: jest.fn(async () => [SAMPLE_KEY]),
    };
    const policy = makePolicy({ keyProvider });
    const envelope = makeEnvelope({ to: 'peer@/path' });
    const channelSpy = jest
      .spyOn(
        policy as unknown as { shouldUseChannelEncryption: (...args: any[]) => Promise<boolean> },
        'shouldUseChannelEncryption'
      )
      .mockResolvedValue(false);

    const options = await policy.getEncryptionOptions(envelope, makeContext());
    expect(options).toBeDefined();
    expect(options).toMatchObject({ recipientKeyId: 'key-1' });
    expect(options?.recipientPublicKey).toBeInstanceOf(Uint8Array);
    expect(keyProvider.getKeysForPath).toHaveBeenCalled();

    channelSpy.mockRestore();
  });

  it('falls back to upstream key request when no key is found', async () => {
    const policy = makePolicy({
      keyProvider: {
        getKey: jest.fn(),
        getKeysForPath: jest.fn(async () => []),
      },
    });
    const envelope = makeEnvelope({ to: 'peer@/path' });

    jest
      .spyOn(
        policy as unknown as { shouldUseChannelEncryption: (...args: any[]) => Promise<boolean> },
        'shouldUseChannelEncryption'
      )
      .mockResolvedValue(false);
    jest
      .spyOn(
        policy as unknown as {
          lookupRecipientEncryptionKey: (...args: any[]) => Promise<[string, Uint8Array]>;
        },
        'lookupRecipientEncryptionKey'
      )
      .mockRejectedValue(new Error('missing'));

    const options = await policy.getEncryptionOptions(envelope, makeContext());
    expect(options).toEqual({ requestAddress: 'peer@/path' });
  });

  it('returns undefined encryption options when destination is absent', async () => {
    const policy = makePolicy();
    expect(await policy.getEncryptionOptions(makeEnvelope({ to: undefined }))).toBeUndefined();
  });

  it('skips malformed keys when looking up recipient encryption material', async () => {
    const invalidMetadataKey = {
      kid: null,
      use: 'enc',
      kty: 'OKP',
      crv: 'X25519',
      x: 'AAAAAAAAAAAAAAAAAAAAAA',
    };
    const missingXKey = {
      kid: 'missing-x',
      use: 'enc',
      kty: 'OKP',
      crv: 'X25519',
    };
    const keyProvider = {
      getKey: jest.fn(),
      getKeysForPath: jest
        .fn()
        .mockResolvedValueOnce([invalidMetadataKey, missingXKey])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]),
    };
    const policy = makePolicy({ keyProvider });

    await expect(
      (
        policy as unknown as {
          lookupRecipientEncryptionKey: (
            address: string,
            nodePath?: string
          ) => Promise<[string, Uint8Array]>;
        }
      ).lookupRecipientEncryptionKey('peer@/path')
    ).rejects.toThrow('No encryption key found');

    expect(keyProvider.getKeysForPath).toHaveBeenCalledTimes(1);
  });

  it('looks up recipient keys across derived paths and participants', async () => {
    const pathKey = {
      kid: 'path-key',
      use: 'enc',
      kty: 'OKP',
      crv: 'X25519',
      x: 'AAAAAAAAAAAAAAAAAAAAAA',
    };
    const fallbackKeyProvider = {
      getKey: jest.fn(),
      getKeysForPath: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([pathKey])
        .mockResolvedValueOnce([]),
    };
    const policy = makePolicy({ keyProvider: fallbackKeyProvider });

    const [kid] = await (
      policy as unknown as {
        lookupRecipientEncryptionKey: (
          address: string,
          nodePath?: string
        ) => Promise<[string, Uint8Array]>;
      }
    ).lookupRecipientEncryptionKey('peer@/path');

    expect(kid).toBe('path-key');
    expect(fallbackKeyProvider.getKeysForPath).toHaveBeenCalledTimes(2);
  });

  it('fetches participant-level keys when direct and path lookups are empty', async () => {
    const participantKey = {
      kid: 'participant-key',
      use: 'enc',
      kty: 'OKP',
      crv: 'X25519',
      x: 'AAAAAAAAAAAAAAAAAAAAAA',
    };
    const keyProvider = {
      getKey: jest.fn(),
      getKeysForPath: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([participantKey]),
    };
    const policy = makePolicy({ keyProvider });

    const result = await (
      policy as unknown as {
        lookupRecipientEncryptionKey: (
          address: string,
          nodePath?: string
        ) => Promise<[string, Uint8Array]>;
      }
    ).lookupRecipientEncryptionKey('peer@/path');

    expect(result[0]).toBe('participant-key');
    expect(result[1]).toBeInstanceOf(Uint8Array);
    expect(keyProvider.getKeysForPath).toHaveBeenCalledTimes(3);
  });

  it('supports FameAddress-like objects during recipient key resolution', async () => {
    const keyProvider = {
      getKey: jest.fn(),
      getKeysForPath: jest.fn(async () => [SAMPLE_KEY]),
    };
    const policy = makePolicy({ keyProvider });
    const addressLike = { toString: () => 'peer@/path' } as any;

    const [kid, keyBytes] = await (
      policy as unknown as {
        lookupRecipientEncryptionKey: (
          address: string,
          nodePath?: string
        ) => Promise<[string, Uint8Array]>;
      }
    ).lookupRecipientEncryptionKey(addressLike);

    expect(kid).toBe('key-1');
    expect(keyBytes).toBeInstanceOf(Uint8Array);
  });

  it('throws when recipient address cannot be converted to a string', async () => {
    const keyProvider = {
      getKey: jest.fn(),
      getKeysForPath: jest.fn(),
    };
    const policy = makePolicy({ keyProvider });

    await expect(
      (
        policy as unknown as {
          lookupRecipientEncryptionKey: (
            address: string | undefined
          ) => Promise<[string, Uint8Array]>;
        }
      ).lookupRecipientEncryptionKey('' as unknown as string)
    ).rejects.toThrow('No recipient address in envelope');
  });

  it('returns null for mismatched local node paths during key resolution', async () => {
    const policy = makePolicy();
    const result = await (
      policy as unknown as {
        tryResolveLocalEncryptionKey: (
          path: string,
          nodePhysicalPath?: string
        ) => Promise<[string, Uint8Array] | null>;
      }
    ).tryResolveLocalEncryptionKey('/local/path', '/other/path');

    expect(result).toBeNull();
  });

  it('throws when recipient address lacks participant component', async () => {
    const policy = makePolicy({
      keyProvider: {
        getKey: jest.fn(),
        getKeysForPath: jest.fn(async () => []),
      },
    });

    await expect(
      (
        policy as unknown as {
          lookupRecipientEncryptionKey: (
            address: string,
            nodePath?: string
          ) => Promise<[string, Uint8Array]>;
        }
      ).lookupRecipientEncryptionKey('/invalid-address')
    ).rejects.toThrow(/Missing '@' in address/);
  });

  it('falls back to default key provider when none is configured', async () => {
    const keyModule = await import('../naylence/fame/security/keys/key-provider');
    const providerMock = {
      getKey: jest.fn(),
      getKeysForPath: jest.fn(async () => [SAMPLE_KEY]),
    };
    const getProviderSpy = jest
      .spyOn(keyModule, 'getKeyProvider')
      .mockReturnValue(providerMock as any);
    const policy = makePolicy();

    const [kid] = await (
      policy as unknown as {
        lookupRecipientEncryptionKey: (
          address: string,
          nodePath?: string
        ) => Promise<[string, Uint8Array]>;
      }
    ).lookupRecipientEncryptionKey('peer@/path');

    expect(kid).toBe('key-1');
    expect(getProviderSpy).toHaveBeenCalled();
    getProviderSpy.mockRestore();
  });

  it('throws after exhausting all recipient key lookup strategies', async () => {
    const keyProvider = {
      getKey: jest.fn(),
      getKeysForPath: jest.fn(async () => []),
    };
    const policy = makePolicy({ keyProvider });

    await expect(
      (
        policy as unknown as {
          lookupRecipientEncryptionKey: (
            address: string,
            nodePath?: string
          ) => Promise<[string, Uint8Array]>;
        }
      ).lookupRecipientEncryptionKey('peer@/path')
    ).rejects.toThrow('No encryption key found for address peer@/path');
  });

  it('prefers local crypto provider keys when available', async () => {
    const policy = makePolicy({
      keyProvider: {
        getKey: jest.fn(),
        getKeysForPath: jest.fn(async () => []),
      },
    });
    setCryptoProvider({
      getJwks: () => ({
        keys: [
          { use: 'enc', kty: 'OKP', crv: 'X25519', kid: 'local', x: 'AAAAAAAAAAAAAAAAAAAAAA' },
        ],
      }),
    });

    const result = await (
      policy as unknown as {
        tryResolveLocalEncryptionKey: (
          path: string,
          nodePhysicalPath?: string
        ) => Promise<[string, Uint8Array] | null>;
      }
    ).tryResolveLocalEncryptionKey('/local/path', '/local/path');

    expect(result).toEqual(['local', expect.any(Uint8Array)]);
  });

  it('skips invalid local crypto provider keys', async () => {
    const policy = makePolicy();
    setCryptoProvider({
      getJwks: () => ({
        keys: [{ use: 'enc', kty: 'OKP', crv: 'X25519', kid: 'bad-local' }],
      }),
    });

    const result = await (
      policy as unknown as {
        tryResolveLocalEncryptionKey: (
          path: string,
          nodePhysicalPath?: string
        ) => Promise<[string, Uint8Array] | null>;
      }
    ).tryResolveLocalEncryptionKey('/local/path', '/local/path');

    expect(result).toBeNull();
  });

  it('ignores local crypto keys that fail validation', async () => {
    const policy = makePolicy({
      keyProvider: {
        getKey: jest.fn(),
        getKeysForPath: jest.fn(async () => []),
      },
    });
    setCryptoProvider({
      getJwks: () => ({
        keys: [
          {
            use: 'enc',
            kty: 'OKP',
            crv: 'Ed25519',
            kid: 'unsupported-curve',
            x: 'AAAAAAAAAAAAAAAAAAAAAA',
          },
        ],
      }),
    });

    const result = await (
      policy as unknown as {
        tryResolveLocalEncryptionKey: (
          path: string,
          nodePhysicalPath?: string
        ) => Promise<[string, Uint8Array] | null>;
      }
    ).tryResolveLocalEncryptionKey('/local/path', '/local/path');

    expect(result).toBeNull();
  });

  it('respects inbound signature policies', async () => {
    const requiredPolicy = makePolicy({
      signing: new SigningConfiguration({
        inbound: {
          signaturePolicy: SignaturePolicy.REQUIRED,
          unsignedViolationAction: SecurityAction.NACK,
          invalidSignatureAction: SecurityAction.REJECT,
          missingKeyAction: SecurityAction.NACK,
        },
        response: {
          mirrorRequestSigning: false,
          alwaysSignResponses: false,
          signErrorResponses: false,
        },
        outbound: {
          defaultSigning: false,
          signSensitiveOperations: false,
          signIfRecipientExpects: false,
        },
      }),
    });
    const unsigned = makeEnvelope();
    expect(await requiredPolicy.shouldVerifySignature(unsigned)).toBe(false);

    const optionalPolicy = makePolicy({
      signing: new SigningConfiguration({
        inbound: {
          signaturePolicy: SignaturePolicy.OPTIONAL,
          unsignedViolationAction: SecurityAction.ALLOW,
          invalidSignatureAction: SecurityAction.REJECT,
          missingKeyAction: SecurityAction.NACK,
        },
        response: {
          mirrorRequestSigning: false,
          alwaysSignResponses: false,
          signErrorResponses: false,
        },
        outbound: {
          defaultSigning: false,
          signSensitiveOperations: false,
          signIfRecipientExpects: false,
        },
      }),
    });
    const signed = makeEnvelope({ sec: { sig: { alg: 'EdDSA' } } as any });
    expect(await optionalPolicy.shouldVerifySignature(signed)).toBe(true);

    const disabledPolicy = makePolicy({
      signing: new SigningConfiguration({
        inbound: {
          signaturePolicy: SignaturePolicy.DISABLED,
          unsignedViolationAction: SecurityAction.ALLOW,
          invalidSignatureAction: SecurityAction.REJECT,
          missingKeyAction: SecurityAction.NACK,
        },
        response: {
          mirrorRequestSigning: false,
          alwaysSignResponses: false,
          signErrorResponses: false,
        },
        outbound: {
          defaultSigning: false,
          signSensitiveOperations: false,
          signIfRecipientExpects: false,
        },
      }),
    });
    expect(await disabledPolicy.shouldVerifySignature(signed)).toBe(false);

    const forbiddenPolicy = makePolicy({
      signing: new SigningConfiguration({
        inbound: {
          signaturePolicy: SignaturePolicy.FORBIDDEN,
          unsignedViolationAction: SecurityAction.ALLOW,
          invalidSignatureAction: SecurityAction.REJECT,
          missingKeyAction: SecurityAction.NACK,
        },
        response: {
          mirrorRequestSigning: false,
          alwaysSignResponses: false,
          signErrorResponses: false,
        },
        outbound: {
          defaultSigning: false,
          signSensitiveOperations: false,
          signIfRecipientExpects: false,
        },
      }),
    });
    expect(await forbiddenPolicy.shouldVerifySignature(signed)).toBe(false);
  });

  it('decrypts local destinations but leaves forwarding traffic encrypted', async () => {
    const policy = makePolicy();
    const node = {
      physicalPath: '/local/path',
      hasLocal: jest.fn().mockReturnValue(true),
    } as unknown as NodeLike;

    const encrypted = makeEnvelope({
      to: 'peer@/local/path',
      sec: { enc: { alg: 'sealed-alg' } } as any,
    });

    expect(await policy.shouldDecryptEnvelope(encrypted, undefined, node)).toBe(true);

    (node.hasLocal as jest.Mock).mockReturnValue(false);
    expect(await policy.shouldDecryptEnvelope(encrypted, undefined, node)).toBe(false);

    const fallback = makeEnvelope({ sec: { enc: { alg: 'sealed-alg' } } as any });
    expect(await policy.shouldDecryptEnvelope(fallback)).toBe(true);
  });

  it('treats address conversion failures as non-local', () => {
    const policy = makePolicy();
    const node = { hasLocal: jest.fn() } as unknown as NodeLike;
    const badAddress = {
      toString: () => {
        throw new Error('boom');
      },
    } as any;

    expect((policy as any).isLocalAddress(badAddress, node)).toBe(false);
    expect(node.hasLocal as jest.Mock).not.toHaveBeenCalled();
  });

  it('classifies crypto level according to advertised algorithms', () => {
    const policy = makePolicy({
      encryption: new EncryptionConfiguration({
        supportedChannelAlgorithms: ['channel-alg'],
        supportedSealedAlgorithms: ['sealed-alg'],
        inbound: {
          allowPlaintext: true,
          allowChannel: true,
          allowSealed: true,
          plaintextViolationAction: SecurityAction.ALLOW,
          channelViolationAction: SecurityAction.ALLOW,
          sealedViolationAction: SecurityAction.ALLOW,
        },
        response: {
          mirrorRequestLevel: true,
          minimumResponseLevel: CryptoLevel.PLAINTEXT,
          escalateSealedResponses: false,
        },
        outbound: {
          defaultLevel: CryptoLevel.PLAINTEXT,
          escalateIfPeerSupports: false,
          preferSealedForSensitive: false,
        },
      }),
    });

    const channelEnvelope = makeEnvelope({ sec: { enc: { alg: 'channel-alg' } } as any });
    expect(policy.classifyMessageCryptoLevel(channelEnvelope)).toBe(CryptoLevel.CHANNEL);

    const sealedEnvelope = makeEnvelope({ sec: { enc: { alg: 'sealed-alg' } } as any });
    expect(policy.classifyMessageCryptoLevel(sealedEnvelope)).toBe(CryptoLevel.SEALED);

    const unknownAlgorithm = makeEnvelope({ sec: { enc: { alg: 'unknown' } } as any });
    expect(policy.classifyMessageCryptoLevel(unknownAlgorithm)).toBe(CryptoLevel.SEALED);

    const missingAlgorithm = makeEnvelope({ sec: { enc: {} } as any });
    expect(policy.classifyMessageCryptoLevel(missingAlgorithm)).toBe(CryptoLevel.SEALED);

    expect(policy.classifyMessageCryptoLevel(makeEnvelope())).toBe(CryptoLevel.PLAINTEXT);
  });

  it('evaluates inbound crypto allowances and violation actions', () => {
    const policy = makePolicy({
      encryption: new EncryptionConfiguration({
        supportedChannelAlgorithms: [],
        supportedSealedAlgorithms: ['sealed-alg'],
        inbound: {
          allowPlaintext: true,
          allowChannel: false,
          allowSealed: true,
          plaintextViolationAction: SecurityAction.ALLOW,
          channelViolationAction: SecurityAction.REJECT,
          sealedViolationAction: SecurityAction.NACK,
        },
        response: {
          mirrorRequestLevel: false,
          minimumResponseLevel: CryptoLevel.PLAINTEXT,
          escalateSealedResponses: false,
        },
        outbound: {
          defaultLevel: CryptoLevel.PLAINTEXT,
          escalateIfPeerSupports: false,
          preferSealedForSensitive: false,
        },
      }),
    });

    const envelope = makeEnvelope();
    expect(policy.isInboundCryptoLevelAllowed(CryptoLevel.PLAINTEXT, envelope)).toBe(true);
    expect(policy.isInboundCryptoLevelAllowed(CryptoLevel.CHANNEL, envelope)).toBe(false);
    expect(policy.isInboundCryptoLevelAllowed(CryptoLevel.SEALED, envelope)).toBe(true);
    expect(policy.isInboundCryptoLevelAllowed('unexpected' as CryptoLevel, envelope)).toBe(false);
    expect(policy.getInboundViolationAction(CryptoLevel.CHANNEL, envelope)).toBe(
      SecurityAction.REJECT
    );
    expect(policy.getInboundViolationAction(CryptoLevel.SEALED, envelope)).toBe(
      SecurityAction.NACK
    );
    expect(policy.getInboundViolationAction('unexpected' as CryptoLevel, envelope)).toBe(
      SecurityAction.NACK
    );
  });

  it('decides response crypto level using mirror and escalation rules', async () => {
    const basePolicy = makePolicy({
      encryption: new EncryptionConfiguration({
        supportedChannelAlgorithms: ['channel-alg'],
        supportedSealedAlgorithms: ['sealed-alg'],
        inbound: {
          allowPlaintext: true,
          allowChannel: true,
          allowSealed: true,
          plaintextViolationAction: SecurityAction.ALLOW,
          channelViolationAction: SecurityAction.ALLOW,
          sealedViolationAction: SecurityAction.ALLOW,
        },
        response: {
          mirrorRequestLevel: true,
          minimumResponseLevel: CryptoLevel.CHANNEL,
          escalateSealedResponses: false,
        },
        outbound: {
          defaultLevel: CryptoLevel.PLAINTEXT,
          escalateIfPeerSupports: false,
          preferSealedForSensitive: false,
        },
      }),
    });

    const dataResponse = makeEnvelope({ frame: { type: 'Data' } as any });
    expect(await basePolicy.decideResponseCryptoLevel(CryptoLevel.PLAINTEXT, dataResponse)).toBe(
      CryptoLevel.CHANNEL
    );

    const escalatePolicy = makePolicy({
      encryption: new EncryptionConfiguration({
        supportedChannelAlgorithms: [],
        supportedSealedAlgorithms: ['sealed-alg'],
        inbound: {
          allowPlaintext: true,
          allowChannel: true,
          allowSealed: true,
          plaintextViolationAction: SecurityAction.ALLOW,
          channelViolationAction: SecurityAction.ALLOW,
          sealedViolationAction: SecurityAction.ALLOW,
        },
        response: {
          mirrorRequestLevel: true,
          minimumResponseLevel: CryptoLevel.CHANNEL,
          escalateSealedResponses: true,
        },
        outbound: {
          defaultLevel: CryptoLevel.PLAINTEXT,
          escalateIfPeerSupports: false,
          preferSealedForSensitive: false,
        },
      }),
    });

    expect(await escalatePolicy.decideResponseCryptoLevel(CryptoLevel.CHANNEL, dataResponse)).toBe(
      CryptoLevel.SEALED
    );

    const heartbeat = makeEnvelope({ frame: { type: 'NodeHeartbeat' } as any });
    expect(await basePolicy.decideResponseCryptoLevel(CryptoLevel.SEALED, heartbeat)).toBe(
      CryptoLevel.PLAINTEXT
    );
  });

  it('escalates outbound crypto level when peer supports sealed messages', async () => {
    const keyProvider = {
      getKey: jest.fn(),
      getKeysForPath: jest.fn(async () => [SAMPLE_KEY]),
    };
    const policy = makePolicy({
      keyProvider,
      encryption: new EncryptionConfiguration({
        supportedChannelAlgorithms: ['channel-alg'],
        supportedSealedAlgorithms: ['sealed-alg'],
        inbound: {
          allowPlaintext: true,
          allowChannel: true,
          allowSealed: true,
          plaintextViolationAction: SecurityAction.ALLOW,
          channelViolationAction: SecurityAction.ALLOW,
          sealedViolationAction: SecurityAction.ALLOW,
        },
        response: {
          mirrorRequestLevel: true,
          minimumResponseLevel: CryptoLevel.PLAINTEXT,
          escalateSealedResponses: false,
        },
        outbound: {
          defaultLevel: CryptoLevel.PLAINTEXT,
          escalateIfPeerSupports: true,
          preferSealedForSensitive: false,
        },
      }),
    });

    const envelope = makeEnvelope({ to: 'peer@/path' });
    expect(await policy.decideOutboundCryptoLevel(envelope, makeContext())).toBe(
      CryptoLevel.SEALED
    );
  });

  it('keeps outbound crypto plaintext for non-data frames', async () => {
    const policy = makePolicy();
    const envelope = makeEnvelope({ frame: { type: 'NodeAttach' } as any, to: 'peer@/path' });

    expect(await policy.decideOutboundCryptoLevel(envelope, makeContext())).toBe(
      CryptoLevel.PLAINTEXT
    );
  });

  it('prefers sealed crypto for sensitive operations when enabled', async () => {
    const policy = makePolicy({
      encryption: new EncryptionConfiguration({
        supportedChannelAlgorithms: ['channel-alg'],
        supportedSealedAlgorithms: ['sealed-alg'],
        inbound: {
          allowPlaintext: true,
          allowChannel: true,
          allowSealed: true,
          plaintextViolationAction: SecurityAction.ALLOW,
          channelViolationAction: SecurityAction.ALLOW,
          sealedViolationAction: SecurityAction.ALLOW,
        },
        response: {
          mirrorRequestLevel: false,
          minimumResponseLevel: CryptoLevel.PLAINTEXT,
          escalateSealedResponses: false,
        },
        outbound: {
          defaultLevel: CryptoLevel.CHANNEL,
          escalateIfPeerSupports: false,
          preferSealedForSensitive: true,
        },
      }),
    });
    const sensitiveSpy = jest.spyOn(policy as any, 'isSensitiveOperation').mockReturnValue(true);

    expect(
      await policy.decideOutboundCryptoLevel(makeEnvelope({ to: 'peer@/path' }), makeContext())
    ).toBe(CryptoLevel.SEALED);

    sensitiveSpy.mockRestore();
  });

  it('determines signature requirement based on frame type and inbound policy', () => {
    const policy = makePolicy({
      signing: new SigningConfiguration({
        inbound: {
          signaturePolicy: SignaturePolicy.REQUIRED,
          unsignedViolationAction: SecurityAction.NACK,
          invalidSignatureAction: SecurityAction.REJECT,
          missingKeyAction: SecurityAction.NACK,
        },
        response: {
          mirrorRequestSigning: false,
          alwaysSignResponses: false,
          signErrorResponses: false,
        },
        outbound: {
          defaultSigning: true,
          signSensitiveOperations: false,
          signIfRecipientExpects: false,
        },
      }),
    });

    expect(policy.isSignatureRequired(makeEnvelope({ frame: { type: 'KeyRequest' } as any }))).toBe(
      true
    );
    expect(policy.isSignatureRequired(makeEnvelope({ frame: { type: 'NodeAttach' } as any }))).toBe(
      false
    );
    expect(policy.isSignatureRequired(makeEnvelope({ frame: { type: 'Data' } as any }))).toBe(true);

    const forbidden = makePolicy({
      signing: new SigningConfiguration({
        inbound: {
          signaturePolicy: SignaturePolicy.FORBIDDEN,
          unsignedViolationAction: SecurityAction.ALLOW,
          invalidSignatureAction: SecurityAction.REJECT,
          missingKeyAction: SecurityAction.NACK,
        },
        response: {
          mirrorRequestSigning: false,
          alwaysSignResponses: false,
          signErrorResponses: false,
        },
        outbound: {
          defaultSigning: false,
          signSensitiveOperations: false,
          signIfRecipientExpects: false,
        },
      }),
    });
    const signedEnvelope = makeEnvelope({
      frame: { type: 'Data' } as any,
      sec: { sig: { alg: 'EdDSA' } } as any,
    });
    expect(forbidden.isSignatureRequired(signedEnvelope)).toBe(true);
  });

  it('reports inbound signature enforcement actions', () => {
    const policy = makePolicy({
      signing: new SigningConfiguration({
        inbound: {
          signaturePolicy: SignaturePolicy.REQUIRED,
          unsignedViolationAction: SecurityAction.REJECT,
          invalidSignatureAction: SecurityAction.NACK,
          missingKeyAction: SecurityAction.REJECT,
        },
        response: {
          mirrorRequestSigning: false,
          alwaysSignResponses: false,
          signErrorResponses: false,
        },
        outbound: {
          defaultSigning: true,
          signSensitiveOperations: false,
          signIfRecipientExpects: false,
        },
      }),
    });
    const envelope = makeEnvelope();

    expect(policy.getUnsignedViolationAction(envelope)).toBe(SecurityAction.REJECT);
    expect(policy.getInvalidSignatureViolationAction(envelope)).toBe(SecurityAction.NACK);
    expect(policy.isSignatureRequired(envelope)).toBe(true);
  });

  it('summarizes security requirements from configuration', () => {
    const policy = makePolicy();
    const requirements = policy.requirements();
    expect(requirements.signingRequired).toBe(true);
    expect(requirements.verificationRequired).toBe(true);
    expect(requirements.encryptionRequired).toBe(true);
    expect(requirements.requireKeyExchange).toBe(true);
  });

  it('computes strict requirements for certificate-based policy', () => {
    const policy = makePolicy({
      signing: new SigningConfiguration({
        inbound: {
          signaturePolicy: SignaturePolicy.REQUIRED,
          unsignedViolationAction: SecurityAction.REJECT,
          invalidSignatureAction: SecurityAction.REJECT,
          missingKeyAction: SecurityAction.REJECT,
        },
        response: {
          mirrorRequestSigning: false,
          alwaysSignResponses: true,
          signErrorResponses: true,
        },
        outbound: {
          defaultSigning: false,
          signSensitiveOperations: true,
          signIfRecipientExpects: true,
        },
        signingMaterial: SigningMaterial.X509_CHAIN,
        validateCertNameConstraints: true,
        requireCertSidMatch: true,
        requireCertLogicalMatch: true,
      }),
      encryption: new EncryptionConfiguration({
        supportedChannelAlgorithms: [],
        supportedSealedAlgorithms: ['sealed-alg'],
        inbound: {
          allowPlaintext: false,
          allowChannel: false,
          allowSealed: true,
          plaintextViolationAction: SecurityAction.NACK,
          channelViolationAction: SecurityAction.REJECT,
          sealedViolationAction: SecurityAction.ALLOW,
        },
        response: {
          mirrorRequestLevel: false,
          minimumResponseLevel: CryptoLevel.SEALED,
          escalateSealedResponses: true,
        },
        outbound: {
          defaultLevel: CryptoLevel.SEALED,
          escalateIfPeerSupports: true,
          preferSealedForSensitive: true,
        },
      }),
    });

    const requirements = policy.requirements();
    expect(requirements.requireCertificates).toBe(true);
    expect(requirements.minimumCryptoLevel).toBe(CryptoLevel.SEALED);
    expect(requirements.signingRequired).toBe(true);
    expect(requirements.encryptionRequired).toBe(true);
    expect(requirements.requireSigningKeyExchange).toBe(true);
    expect(requirements.requireEncryptionKeyExchange).toBe(true);
    expect(requirements.supportedEncryptionAlgorithms.has('sealed-alg')).toBe(true);
  });

  it('validates peer attachment security compatibility', () => {
    const policy = makePolicy();

    const [missingSigning, msg1] = policy.validateAttachSecurityCompatibility({
      peerKeys: [],
    });
    expect(missingSigning).toBe(false);
    expect(msg1).toMatch(/signing key exchange/);

    const [missingEncryption, msg2] = policy.validateAttachSecurityCompatibility({
      peerKeys: [{ use: 'sig', kty: 'OKP', crv: 'Ed25519' }],
    });
    expect(missingEncryption).toBe(false);
    expect(msg2).toMatch(/encryption key exchange/);

    const peerKeys = [
      { use: 'sig', kty: 'OKP', crv: 'Ed25519' },
      { use: 'enc', kty: 'OKP', crv: 'X25519' },
    ];

    const [noCommonEncryption, msg3] = policy.validateAttachSecurityCompatibility({
      peerKeys,
      peerRequirements: new SecurityRequirements({
        signingRequired: true,
        verificationRequired: true,
        supportedSigningAlgorithms: new Set(['EdDSA']),
        encryptionRequired: true,
        decryptionRequired: true,
        supportedEncryptionAlgorithms: new Set(['UnknownAlg']),
        minimumCryptoLevel: CryptoLevel.SEALED,
      }),
    });
    expect(noCommonEncryption).toBe(false);
    expect(msg3).toMatch(/No compatible encryption algorithms/);

    const [noCommonSigning, msg4] = policy.validateAttachSecurityCompatibility({
      peerKeys,
      peerRequirements: new SecurityRequirements({
        signingRequired: true,
        verificationRequired: true,
        supportedSigningAlgorithms: new Set(['RSA']),
        encryptionRequired: false,
        decryptionRequired: false,
        supportedEncryptionAlgorithms: new Set(['sealed-alg']),
        minimumCryptoLevel: CryptoLevel.PLAINTEXT,
      }),
    });
    expect(noCommonSigning).toBe(false);
    expect(msg4).toMatch(/No compatible signing algorithms/);

    const [compatible] = policy.validateAttachSecurityCompatibility({
      peerKeys,
      peerRequirements: new SecurityRequirements({
        signingRequired: true,
        verificationRequired: true,
        supportedSigningAlgorithms: new Set(['EdDSA']),
        encryptionRequired: true,
        decryptionRequired: true,
        supportedEncryptionAlgorithms: new Set(['sealed-alg']),
        minimumCryptoLevel: CryptoLevel.CHANNEL,
      }),
    });
    expect(compatible).toBe(true);
  });

  it('rejects sealed-only peers when encryption disabled', () => {
    const policy = makePolicy({
      encryption: new EncryptionConfiguration({
        supportedChannelAlgorithms: [],
        supportedSealedAlgorithms: [],
        inbound: {
          allowPlaintext: true,
          allowChannel: false,
          allowSealed: false,
          plaintextViolationAction: SecurityAction.ALLOW,
          channelViolationAction: SecurityAction.REJECT,
          sealedViolationAction: SecurityAction.NACK,
        },
        response: {
          mirrorRequestLevel: false,
          minimumResponseLevel: CryptoLevel.PLAINTEXT,
          escalateSealedResponses: false,
        },
        outbound: {
          defaultLevel: CryptoLevel.PLAINTEXT,
          escalateIfPeerSupports: false,
          preferSealedForSensitive: false,
        },
      }),
    });

    const [ok, reason] = policy.validateAttachSecurityCompatibility({
      peerKeys: [
        { use: 'sig', kty: 'OKP', crv: 'Ed25519' },
        { use: 'enc', kty: 'OKP', crv: 'X25519', x: 'AAAAAAAAAAAAAAAAAAAAAA' },
      ],
      peerRequirements: new SecurityRequirements({
        minimumCryptoLevel: CryptoLevel.SEALED,
        signingRequired: false,
        verificationRequired: false,
        supportedSigningAlgorithms: new Set(['EdDSA']),
        encryptionRequired: false,
        decryptionRequired: false,
        supportedEncryptionAlgorithms: new Set(['X25519']),
      }),
    });

    expect(ok).toBe(false);
    expect(reason).toMatch(/Peer requires SEALED/);
  });
});

describe('SecurityPolicyFactory integration', () => {
  beforeEach(() => {
    ResourceFactoryRegistry.clearCache(SECURITY_POLICY_FACTORY_BASE_TYPE);
  });

  it('creates registered policies from configuration', async () => {
    const policy = await SecurityPolicyFactory.createSecurityPolicy({
      type: 'NoSecurityPolicy',
    });

    expect(policy).toBeInstanceOf(NoSecurityPolicy);
  });

  it('creates default security policy when no config is provided', async () => {
    const policy = await SecurityPolicyFactory.createSecurityPolicy();

    expect(policy).toBeInstanceOf(DefaultSecurityPolicy);
  });
});

describe('DefaultSecurityPolicyFactory', () => {
  it('uses config-provided signing when overrides are absent', async () => {
    const factory = new DefaultSecurityPolicyFactory();
    const configSigning = new SigningConfiguration({
      inbound: {
        signaturePolicy: SignaturePolicy.OPTIONAL,
        unsignedViolationAction: SecurityAction.ALLOW,
        invalidSignatureAction: SecurityAction.REJECT,
        missingKeyAction: SecurityAction.NACK,
      },
      response: {
        mirrorRequestSigning: false,
        alwaysSignResponses: false,
        signErrorResponses: false,
      },
      outbound: {
        defaultSigning: false,
        signSensitiveOperations: false,
        signIfRecipientExpects: false,
      },
    }).toObject();

    const policy = await factory.create({
      type: 'DefaultSecurityPolicy',
      signing: configSigning,
    });

    const requirements = policy.requirements();
    expect(requirements.signingRequired).toBe(false);
  });

  it('prefers explicit overrides over normalized config', async () => {
    const factory = new DefaultSecurityPolicyFactory();
    const config = {
      type: 'DefaultSecurityPolicy',
      signing: new SigningConfiguration({
        response: {
          mirrorRequestSigning: false,
          alwaysSignResponses: false,
          signErrorResponses: false,
        },
        outbound: {
          defaultSigning: false,
          signSensitiveOperations: false,
          signIfRecipientExpects: false,
        },
      }).toObject(),
    };

    const overrideSigning = new SigningConfiguration({
      response: {
        mirrorRequestSigning: true,
        alwaysSignResponses: true,
        signErrorResponses: true,
      },
      outbound: {
        defaultSigning: true,
        signSensitiveOperations: true,
        signIfRecipientExpects: true,
      },
    });

    const policy = await factory.create(config, { signing: overrideSigning });
    const requirements = policy.requirements();
    expect(requirements.signingRequired).toBe(true);
  });

  it('throws when provided config has mismatched type', async () => {
    const factory = new DefaultSecurityPolicyFactory();
    await expect(factory.create({ type: 'NotDefaultPolicy' } as any)).rejects.toThrow(
      /DefaultSecurityPolicyFactory expects type "DefaultSecurityPolicy"/
    );
  });

  it('hydrates encryption from config when overrides omit it', async () => {
    const factory = new DefaultSecurityPolicyFactory();
    const config = {
      type: 'DefaultSecurityPolicy',
      encryption: new EncryptionConfiguration({
        outbound: { defaultLevel: CryptoLevel.SEALED },
      }).toObject(),
    };

    const policy = await factory.create(config);
    expect(await policy.shouldEncryptEnvelope(makeEnvelope(), makeContext())).toBe(true);
  });

  it('returns default config when none is provided', async () => {
    const factory = new DefaultSecurityPolicyFactory();
    const policy = await factory.create();
    expect(policy).toBeInstanceOf(DefaultSecurityPolicy);
  });

  it('retains explicit null encryption values in config normalization', async () => {
    const factory = new DefaultSecurityPolicyFactory();
    const policy = await factory.create({
      type: 'DefaultSecurityPolicy',
      encryption: null,
    });

    const requirements = policy.requirements();
    // Null encryption config should fall back to development defaults
    expect(requirements.encryptionRequired).toBe(false);
  });
});

describe('NoSecurityPolicyFactory', () => {
  it('creates policy regardless of config extras', async () => {
    const factory = new NoSecurityPolicyFactory();
    const policy = await factory.create({ type: 'NoSecurityPolicy' });
    expect(policy).toBeInstanceOf(NoSecurityPolicy);
  });

  it('throws when provided type is invalid', async () => {
    const factory = new NoSecurityPolicyFactory();
    await expect(factory.create({ type: 'UnexpectedPolicy' } as any)).rejects.toThrow(
      /NoSecurityPolicyFactory expects type "NoSecurityPolicy"/
    );
  });
});

describe('Security policy normalization utilities', () => {
  it('normalizes encryption config with defaults and overrides', () => {
    const normalized = normalizeEncryptionConfig({
      supportedChannelAlgorithms: ['custom-channel'],
      inbound: { allowPlaintext: false },
      plaintextAlgorithms: ['plain'],
    });

    expect(normalized.inbound.allowPlaintext).toBe(false);
    expect(normalized.supportedChannelAlgorithms).toEqual(
      expect.arrayContaining(['custom-channel'])
    );
    expect(normalized.plaintextAlgorithms).toEqual(expect.arrayContaining(['plain']));
  });

  it('returns object form when encryption configuration instance provided', () => {
    const base = new EncryptionConfiguration();
    const normalized = normalizeEncryptionConfig(base);
    expect(normalized).toEqual(base.toObject());
  });

  it('throws when raw-key signing config mixes certificate validation options', () => {
    expect(() =>
      normalizeSigningConfig({
        signingMaterial: SigningMaterial.RAW_KEY,
        requireCertSidMatch: true,
      })
    ).toThrow(/X\.509 validation options/);
  });

  it('normalizes signing config for certificate-based material', () => {
    const normalized = normalizeSigningConfig({
      signingMaterial: SigningMaterial.X509_CHAIN,
      validateCertNameConstraints: false,
      requireCertSidMatch: true,
      requireCertLogicalMatch: true,
    });

    expect(normalized.signingMaterial).toBe(SigningMaterial.X509_CHAIN);
    expect(normalized.requireCertSidMatch).toBe(true);
    expect(normalized.requireCertLogicalMatch).toBe(true);
  });

  it('provides default normalization when configs are omitted', () => {
    const encryptionDefaults = normalizeEncryptionConfig();
    expect(encryptionDefaults.inbound.allowPlaintext).toBe(true);
    expect(encryptionDefaults.outbound.defaultLevel).toBe(CryptoLevel.CHANNEL);

    const signingDefaults = normalizeSigningConfig();
    expect(signingDefaults.signingMaterial).toBe(SigningMaterial.RAW_KEY);
    expect(signingDefaults.response.mirrorRequestSigning).toBe(false);
  });

  it('normalizes signing config instances and outbound rules', () => {
    const base = new SigningConfiguration({
      outbound: {
        defaultSigning: true,
        signSensitiveOperations: true,
        signIfRecipientExpects: true,
      },
    });
    const normalized = normalizeSigningConfig(base);
    expect(normalized.outbound.signIfRecipientExpects).toBe(true);
    expect(normalized.outbound.defaultSigning).toBe(true);
  });

  it('returns existing security requirements instance as-is', () => {
    const existing = new SecurityRequirements({ signingRequired: true });
    expect(normalizeSecurityRequirements(existing)).toBe(existing);
  });

  it('normalizes security requirements from plain input', () => {
    const normalized = normalizeSecurityRequirements({
      signingRequired: true,
      verificationRequired: true,
      supportedSigningAlgorithms: ['Alg1', 'Alg2'],
      encryptionRequired: false,
      decryptionRequired: false,
      supportedEncryptionAlgorithms: ['Enc1'],
      requireKeyExchange: false,
      requireSigningKeyExchange: false,
      requireEncryptionKeyExchange: false,
      requireNodeAuthorization: false,
      requireCertificates: false,
      minimumCryptoLevel: CryptoLevel.CHANNEL,
      preferredSigningAlgorithms: ['Alg1'],
      preferredEncryptionAlgorithms: ['Enc1'],
      preferredSigningAlgorithm: 'Alg1',
      preferredEncryptionAlgorithm: 'Enc1',
    });

    expect(normalized.signingRequired).toBe(true);
    expect(Array.from(normalized.supportedSigningAlgorithms)).toEqual(
      expect.arrayContaining(['Alg1', 'Alg2'])
    );
    expect(Array.from(normalized.supportedEncryptionAlgorithms)).toEqual(
      expect.arrayContaining(['Enc1'])
    );
    expect(normalized.minimumCryptoLevel).toBe(CryptoLevel.CHANNEL);
  });

  it('supplies default security requirements when omitted', () => {
    const defaults = normalizeSecurityRequirements();
    expect(defaults.signingRequired).toBe(false);
    expect(defaults.supportedSigningAlgorithms.has('EdDSA')).toBe(true);
  });
});
