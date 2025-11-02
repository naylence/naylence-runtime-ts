import { getPublicKey } from '@noble/ed25519';
import {
  createFameEnvelope,
  type DataFrame,
  type FameEnvelope,
  SigningMaterial,
} from '@naylence/core';
import { secureDigest, urlsafeBase64Encode } from '../../util/util.js';
import type { CryptoProvider } from '../crypto/providers/crypto-provider.js';
import type { KeyProvider } from '../keys/key-provider.js';
import {
  EdDSAEnvelopeSigner,
  type EdDSAEnvelopeSignerOptions,
} from '../signing/eddsa-envelope-signer.js';
import {
  EdDSAEnvelopeVerifier,
  type EdDSAEnvelopeVerifierOptions,
} from '../signing/eddsa-envelope-verifier.js';
import { SigningConfig } from '../signing/signing-config.js';

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('Hex string must have an even length');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    const offset = i * 2;
    bytes[i] = parseInt(hex.slice(offset, offset + 2), 16);
  }
  return bytes;
}

const PRIVATE_KEY_HEX =
  '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const PRIVATE_KEY_BYTES = hexToBytes(PRIVATE_KEY_HEX);
const PRIVATE_KEY_BASE64 = Buffer.from(PRIVATE_KEY_BYTES).toString('base64');

let publicKeyB64Url: string;

const PHYSICAL_PATH = '/region/node/test';
const SID = secureDigest(PHYSICAL_PATH);
const SIGNING_KEY_ID = 'test-ed25519-kid';

const cryptoProvider: CryptoProvider & {
  signingPrivatePem: string;
  signatureKeyId: string;
} = {
  signingPrivatePem: PRIVATE_KEY_BASE64,
  signatureKeyId: SIGNING_KEY_ID,
};

const keyProvider: KeyProvider = {
  async getKey(kid: string) {
    if (kid !== SIGNING_KEY_ID) {
      throw new Error('unknown key id');
    }

    return {
      kid: SIGNING_KEY_ID,
      kty: 'OKP',
      crv: 'Ed25519',
      use: 'sig',
      x: publicKeyB64Url,
      sid: SID,
    };
  },
  async getKeysForPath(_physicalPath: string) {
    return [] as Array<Record<string, unknown> & { kid: string }>;
  },
};

function createSampleEnvelope(payload: Record<string, unknown>): FameEnvelope {
  const frame: DataFrame = {
    type: 'Data',
    payload,
  };

  return createFameEnvelope({
    frame,
    sid: SID,
  });
}

describe('EdDSA envelope signing', () => {
  beforeAll(async () => {
    const publicKeyBytes = await getPublicKey(PRIVATE_KEY_BYTES);
    publicKeyB64Url = urlsafeBase64Encode(publicKeyBytes);
  });

  test('signs DataFrame envelopes and verifier accepts them', async () => {
    const signer = new EdDSAEnvelopeSigner({ cryptoProvider });
    const verifier = new EdDSAEnvelopeVerifier(keyProvider);

    const envelope = createSampleEnvelope({ hello: 'world', count: 42 });
    const signed = signer.signEnvelope(envelope, {
      physicalPath: PHYSICAL_PATH,
    });

    expect(signed.sec?.sig).toBeDefined();
    expect(signed.frame.type).toBe('Data');
    expect((signed.frame as DataFrame).pd).toBeDefined();

    await expect(verifier.verifyEnvelope(signed)).resolves.toBe(true);
  });

  test('verifier detects payload tampering when digest mismatches', async () => {
    const signer = new EdDSAEnvelopeSigner({ cryptoProvider });
    const verifier = new EdDSAEnvelopeVerifier(keyProvider);

    const original = signer.signEnvelope(
      createSampleEnvelope({ value: 'initial' }),
      {
        physicalPath: PHYSICAL_PATH,
      }
    );

    const tampered: FameEnvelope = {
      ...original,
      frame: {
        ...(original.frame as DataFrame),
        payload: { value: 'tampered' },
      },
    };

    await expect(verifier.verifyEnvelope(tampered)).rejects.toThrow(
      'Payload digest mismatch'
    );
  });

  test('allows payload trust when checkPayload is false', async () => {
    const signer = new EdDSAEnvelopeSigner({ cryptoProvider });
    const verifier = new EdDSAEnvelopeVerifier(keyProvider);

    const signed = signer.signEnvelope(
      createSampleEnvelope({ status: 'intermediate' }),
      {
        physicalPath: PHYSICAL_PATH,
      }
    );

    const forwarded: FameEnvelope = {
      ...signed,
      frame: {
        ...(signed.frame as DataFrame),
        payload: { status: 'mutated' },
      },
    };

    await expect(
      verifier.verifyEnvelope(forwarded, { checkPayload: false })
    ).resolves.toBe(true);
  });

  test('accepts snake_case signer options and signing config', () => {
    const signer = new EdDSAEnvelopeSigner({
      crypto_provider: cryptoProvider,
      signing_config: {
        signing_material: 'x509-chain',
        validate_cert_name_constraints: false,
      },
      private_key_pem: PRIVATE_KEY_BASE64,
      key_id: 'alias-kid',
    } as unknown as EdDSAEnvelopeSignerOptions);

    const internals = signer as unknown as {
      signingConfig: SigningConfig;
      explicitPrivateKey?: string;
      explicitKeyId?: string;
    };

    expect(internals.signingConfig.signingMaterial).toBe(
      SigningMaterial.X509_CHAIN
    );
    expect(internals.signingConfig.validateCertNameConstraints).toBe(false);
    expect(internals.explicitPrivateKey).toBe(PRIVATE_KEY_BASE64);
    expect(internals.explicitKeyId).toBe('alias-kid');

    const envelope = signer.signEnvelope(
      createSampleEnvelope({ alias: true }),
      {
        physicalPath: PHYSICAL_PATH,
      }
    );
    expect(envelope.sec?.sig?.kid).toBe('alias-kid');
  });

  test('accepts snake_case verifier signing config', async () => {
    const signer = new EdDSAEnvelopeSigner({
      cryptoProvider,
    });
    const verifier = new EdDSAEnvelopeVerifier(keyProvider, {
      signing_config: {
        require_cert_sid_match: true,
      },
    } as unknown as EdDSAEnvelopeVerifierOptions);

    const internals = verifier as unknown as { signingConfig: SigningConfig };
    expect(internals.signingConfig.requireCertSidMatch).toBe(true);

    const envelope = signer.signEnvelope(
      createSampleEnvelope({ status: 'alias' }),
      {
        physicalPath: PHYSICAL_PATH,
      }
    );

    await expect(verifier.verifyEnvelope(envelope)).resolves.toBe(true);
  });
});
