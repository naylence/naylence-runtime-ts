import { verify } from '@noble/ed25519';
import type { DataFrame, FameEnvelope } from 'naylence-core';
import { SigningMaterial } from 'naylence-core';
import { secureDigest } from '../../util/util.js';
import type { KeyProvider } from '../keys/key-provider.js';
import { SigningConfig } from './signing-config.js';
import {
  canonicalJson,
  decodeBase64Url,
  frameDigest,
  immutableHeaders,
} from './eddsa-signer-verifier.js';
import { encodeUtf8 } from './eddsa-utils.js';
import {
  validateSigningKey,
  JWKValidationError,
} from '../crypto/jwk-validation.js';

interface VerifierJwk extends Record<string, unknown> {
  kid?: string;
  sid?: string;
  x?: string;
  crv_x?: string;
  pub?: string;
  x5c?: unknown;
}

async function loadPublicKey(
  jwk: VerifierJwk,
  signingConfig: SigningConfig
): Promise<Uint8Array> {
  if (jwk.x5c) {
    if (signingConfig.signingMaterial !== SigningMaterial.X509_CHAIN) {
      throw new Error('Certificate keys are disabled by signing policy');
    }
    throw new Error(
      'Certificate-based Ed25519 verification is not implemented in the TypeScript runtime yet'
    );
  }

  const candidate =
    typeof jwk.x === 'string'
      ? jwk.x
      : typeof jwk.crv_x === 'string'
        ? jwk.crv_x
        : jwk.pub;
  if (typeof candidate !== 'string') {
    throw new Error('JWK missing public key material');
  }
  return decodeBase64Url(candidate);
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function isDataFrame(frame: FameEnvelope['frame']): frame is DataFrame {
  return (frame as { type?: string }).type === 'Data';
}

export interface EdDSAEnvelopeVerifierOptions {
  signingConfig?: SigningConfig | null;
}

export class EdDSAEnvelopeVerifier {
  private readonly keyProvider: KeyProvider;
  private readonly signingConfig: SigningConfig;

  public constructor(
    keyProvider: KeyProvider,
    options: EdDSAEnvelopeVerifierOptions = {}
  ) {
    this.keyProvider = keyProvider;
    this.signingConfig = options.signingConfig ?? new SigningConfig();
  }

  public async verifyEnvelope(
    envelope: FameEnvelope,
    options: { checkPayload?: boolean; logical?: string } = {}
  ): Promise<boolean> {
    const signatureHeader = envelope.sec?.sig;
    if (!signatureHeader) {
      throw new Error('Missing envelope.sec.sig header');
    }

    const kid = assertString(
      signatureHeader.kid,
      "Signature header missing 'kid'"
    );
    const signatureValue = assertString(
      signatureHeader.val,
      "Signature header missing 'val'"
    );

    const jwk = (await this.keyProvider.getKey(kid)) as VerifierJwk | null;
    if (!jwk) {
      throw new Error(`Unknown key id: ${kid}`);
    }

    try {
      validateSigningKey(jwk);
    } catch (error) {
      if (error instanceof JWKValidationError) {
        throw new Error(
          `Key ${kid} is not valid for signing: ${error.message}`
        );
      }
      throw error;
    }

    const checkPayload = options.checkPayload ?? true;

    let trustedDigest: string;
    if (isDataFrame(envelope.frame)) {
      if (checkPayload) {
        if (!envelope.frame.pd) {
          throw new Error('DataFrame missing payload digest (pd field)');
        }
        const payload = envelope.frame.payload ?? '';
        const payloadString = payload === '' ? '' : canonicalJson(payload);
        const actualDigest = secureDigest(payloadString);
        if (actualDigest !== envelope.frame.pd) {
          throw new Error('Payload digest mismatch in DataFrame');
        }
        trustedDigest = actualDigest;
      } else {
        if (!envelope.frame.pd) {
          throw new Error(
            'DataFrame missing payload digest (pd field) for intermediate verification'
          );
        }
        trustedDigest = envelope.frame.pd;
      }
    } else {
      trustedDigest = frameDigest(envelope.frame);
    }

    const sid = assertString(jwk.sid, 'Signing key missing sid');
    const immutable = canonicalJson(immutableHeaders(envelope));
    const tbs = new Uint8Array(
      encodeUtf8(sid).length +
        1 +
        encodeUtf8(immutable).length +
        1 +
        encodeUtf8(trustedDigest).length
    );

    const sidBytes = encodeUtf8(sid);
    const immBytes = encodeUtf8(immutable);
    const digestBytes = encodeUtf8(trustedDigest);
    let offset = 0;

    tbs.set(sidBytes, offset);
    offset += sidBytes.length;
    tbs[offset] = 0x1f;
    offset += 1;

    tbs.set(immBytes, offset);
    offset += immBytes.length;
    tbs[offset] = 0x1f;
    offset += 1;

    tbs.set(digestBytes, offset);

    const signatureBytes = decodeBase64Url(signatureValue);
    if (signatureBytes.length !== 64) {
      throw new Error('Signature must be 64 bytes for Ed25519');
    }

    const publicKey = await loadPublicKey(jwk, this.signingConfig);
    if (publicKey.length !== 32) {
      throw new Error('Ed25519 public key must be 32 bytes');
    }

    const valid = await verify(signatureBytes, tbs, publicKey);
    if (!valid) {
      throw new Error('Envelope signature verification failed');
    }

    return true;
  }
}
