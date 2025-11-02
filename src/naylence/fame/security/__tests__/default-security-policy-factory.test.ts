import {
  DefaultSecurityPolicyFactory,
} from '../policy/default-security-policy-factory.js';
import type { KeyProvider } from '../keys/key-provider.js';
import {
  CryptoLevel,
  SignaturePolicy,
  SigningConfiguration,
  EncryptionConfiguration,
} from '../policy/security-policy.js';

describe('DefaultSecurityPolicyFactory', () => {
  it('normalizes snake_case signing and encryption config', async () => {
    const factory = new DefaultSecurityPolicyFactory();

    const policy = await factory.create({
      type: 'DefaultSecurityPolicy',
      signing: {
        signing_material: 'x509-chain',
        inbound: {
          signature_policy: 'required',
          missing_key_action: 'allow',
        },
        response: {
          sign_error_responses: true,
        },
        outbound: {
          sign_if_recipient_expects: true,
        },
      },
      encryption: {
        inbound: {
          allow_channel: false,
          plaintext_violation_action: 'reject',
        },
        response: {
          minimum_response_level: 'sealed',
        },
        outbound: {
          default_level: 'sealed',
          prefer_sealed_for_sensitive: true,
        },
      },
    });

    const signing = (policy as any).signing as SigningConfiguration;
    const encryption = (policy as any).encryption as EncryptionConfiguration;

    expect(signing).toBeInstanceOf(SigningConfiguration);
    expect(signing.signingMaterial).toBe('x509-chain');
    expect(signing.inbound.signaturePolicy).toBe(SignaturePolicy.REQUIRED);
    expect(signing.inbound.missingKeyAction).toBe('allow');
    expect(signing.response.signErrorResponses).toBe(true);
    expect(signing.outbound.signIfRecipientExpects).toBe(true);

    expect(encryption).toBeInstanceOf(EncryptionConfiguration);
    expect(encryption.inbound.allowChannel).toBe(false);
    expect(encryption.inbound.plaintextViolationAction).toBe('reject');
    expect(encryption.response.minimumResponseLevel).toBe(CryptoLevel.SEALED);
    expect(encryption.outbound.defaultLevel).toBe(CryptoLevel.SEALED);
    expect(encryption.outbound.preferSealedForSensitive).toBe(true);
  });

  it('supports signing_config and encryption_config aliases with key provider', async () => {
    const factory = new DefaultSecurityPolicyFactory();
    const keyProvider: KeyProvider = {
      getKey: jest.fn(async () => {
        throw new Error('not implemented');
      }),
      getKeysForPath: jest.fn(async () => []),
    };

    const policy = await factory.create(
      {
        type: 'DefaultSecurityPolicy',
        signing_config: {
          signing_material: 'raw-key',
        },
        encryption_config: {
          outbound: {
            default_level: 'plaintext',
          },
        },
      } as any,
      keyProvider
    );

    const signing = (policy as any).signing as SigningConfiguration;
    const encryption = (policy as any).encryption as EncryptionConfiguration;
    const storedKeyProvider = (policy as any).keyProvider as KeyProvider | null;

    expect(signing.signingMaterial).toBe('raw-key');
    expect(encryption.outbound.defaultLevel).toBe(CryptoLevel.PLAINTEXT);
    expect(storedKeyProvider).toBe(keyProvider);
  });
});
