import {
  DeliveryOriginType,
  type FameDeliveryContext,
  type FameEnvelope,
  SigningMaterial,
} from '@naylence/core';

import {
  DefaultSecurityPolicy,
  type DefaultSecurityPolicyOptions,
} from '../policy/default-security-policy.js';
import type { KeyProvider } from '../keys/key-provider.js';
import type { KeyRecord } from '../keys/key-store.js';
import {
  CryptoLevel,
  SignaturePolicy,
  EncryptionConfiguration,
  SigningConfiguration,
} from '../policy/security-policy.js';

function makeEnvelope(
  overrides: Partial<FameEnvelope> = {}
): FameEnvelope {
  return {
    id: 'env-1',
    frame: { type: 'Data' } as unknown,
    sec: undefined,
    meta: {},
    ...overrides,
  } as FameEnvelope;
}

function makeContext(
  overrides: Partial<FameDeliveryContext> = {}
): FameDeliveryContext {
  return {
    originType: DeliveryOriginType.LOCAL,
    meta: {},
    security: {},
    ...overrides,
  } as FameDeliveryContext;
}

describe('DefaultSecurityPolicy alias normalization', () => {
  it('accepts snake_case constructor options', async () => {
    const customSigningPolicy = jest.fn().mockResolvedValue(true);
    const customEncryptionPolicy = jest.fn().mockResolvedValue(false);
    const keyProvider: KeyProvider = {
      async getKey(kid: string): Promise<KeyRecord> {
        return { kid };
      },
      async getKeysForPath(): Promise<Iterable<KeyRecord>> {
        return [];
      },
    };

    const policy = new DefaultSecurityPolicy({
      custom_signing_policy: customSigningPolicy,
      custom_encryption_policy: customEncryptionPolicy,
      signing_config: {
        signing_material: 'x509-chain',
        inbound: {
          signature_policy: 'required',
        },
      },
      encryption_config: {
        outbound: {
          default_level: 'sealed',
        },
      },
      key_provider: keyProvider,
    } as unknown as DefaultSecurityPolicyOptions);

    const internals = policy as unknown as {
      signing: SigningConfiguration;
      encryption: EncryptionConfiguration;
      keyProvider: KeyProvider | null;
    };

    expect(internals.signing.signingMaterial).toBe(SigningMaterial.X509_CHAIN);
    expect(internals.signing.inbound.signaturePolicy).toBe(SignaturePolicy.REQUIRED);
    expect(internals.encryption.outbound.defaultLevel).toBe(CryptoLevel.SEALED);
    expect(internals.keyProvider).toBe(keyProvider);

    const envelope = makeEnvelope();
    await expect(policy.shouldSignEnvelope(envelope)).resolves.toBe(true);
    expect(customSigningPolicy).toHaveBeenCalledWith(envelope, undefined, undefined);

    const context = makeContext();
    await expect(policy.shouldEncryptEnvelope(envelope, context)).resolves.toBe(false);
    expect(customEncryptionPolicy).toHaveBeenCalledWith(
      envelope,
      context,
      undefined
    );
  });
});
