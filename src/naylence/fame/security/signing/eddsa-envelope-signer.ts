import { sync, utils as edUtils } from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512.js';
import type { FameEnvelope, SecurityHeader, SignatureHeader } from 'naylence-core';
import { SigningMaterial } from 'naylence-core';
import { secureDigest, urlsafeBase64Encode } from '../../util/util.js';
import type { CryptoProvider } from '../crypto/providers/crypto-provider.js';
import { SigningConfig } from './signing-config.js';
import { frameDigest, immutableHeaders, canonicalJson } from './eddsa-signer-verifier.js';
import { encodeUtf8, parseEd25519PrivateKey, readStringProperty } from './eddsa-utils.js';

interface CertificateCapableCryptoProvider extends CryptoProvider {
  nodeJwk?: () => Record<string, unknown> | null | undefined;
}

if (!edUtils.sha512Sync) {
  edUtils.sha512Sync = (...messages: Uint8Array[]) => {
    if (messages.length === 1) {
      return sha512(messages[0]);
    }
    return sha512(edUtils.concatBytes(...messages));
  };
}

export interface EdDSAEnvelopeSignerOptions {
  cryptoProvider?: CryptoProvider | null;
  signingConfig?: SigningConfig | null;
  privateKeyPem?: string;
  keyId?: string;
}

export class EdDSAEnvelopeSigner {
  private readonly crypto: CryptoProvider;
  private readonly signingConfig: SigningConfig;
  private readonly explicitPrivateKey: string | undefined;
  private readonly explicitKeyId: string | undefined;

  public constructor(options: EdDSAEnvelopeSignerOptions = {}) {
    const provider = options.cryptoProvider ?? null;
    if (!provider) {
      throw new Error('No crypto provider is configured for signing');
    }
    this.crypto = provider;
    this.signingConfig = options.signingConfig ?? new SigningConfig();
    this.explicitPrivateKey = options.privateKeyPem;
    this.explicitKeyId = options.keyId;
  }

  public signEnvelope(envelope: FameEnvelope, { physicalPath }: { physicalPath: string }): FameEnvelope {
    if (!envelope.sid) {
      throw new Error('Envelope missing sid');
    }

    const frame = envelope.frame;
    if ((frame as { type?: string }).type === 'Data') {
      const dataFrame = frame as { payload?: unknown; pd?: string | null };
      if (!dataFrame.pd) {
        const payload = dataFrame.payload ?? '';
        const payloadString = payload === '' ? '' : canonicalJson(payload);
        dataFrame.pd = secureDigest(payloadString);
      }
    }

    const digest = frameDigest(frame);
    const immutable = canonicalJson(immutableHeaders(envelope));
    const sidDigest = secureDigest(physicalPath);

    const tbs = new Uint8Array(
      encodeUtf8(sidDigest).length + 1 + encodeUtf8(immutable).length + 1 + encodeUtf8(digest).length
    );

    const sidBytes = encodeUtf8(sidDigest);
    const immBytes = encodeUtf8(immutable);
    const digBytes = encodeUtf8(digest);
    let offset = 0;

    tbs.set(sidBytes, offset);
    offset += sidBytes.length;
    tbs[offset] = 0x1f;
    offset += 1;

    tbs.set(immBytes, offset);
    offset += immBytes.length;
    tbs[offset] = 0x1f;
    offset += 1;

    tbs.set(digBytes, offset);

    const privateKey = this.loadPrivateKey();
  const signatureBytes = sync.sign(tbs, privateKey);
    const signature = urlsafeBase64Encode(signatureBytes);

    const kid = this.determineKeyId();

    const signatureHeader: SignatureHeader = {
      kid,
      val: signature,
      alg: 'EdDSA',
    };

    const secHeader: SecurityHeader = envelope.sec ?? {};
    secHeader.sig = signatureHeader;
    envelope.sec = secHeader;

    return envelope;
  }

  private loadPrivateKey(): Uint8Array {
    const pem = this.explicitPrivateKey ?? readStringProperty(this.crypto, 'signingPrivatePem', 'signing_private_pem');
    if (!pem) {
      throw new Error('Crypto provider does not expose a signing private key');
    }
    return parseEd25519PrivateKey(pem);
  }

  private determineKeyId(): string {
    if (this.explicitKeyId) {
      return this.explicitKeyId;
    }

    if (this.signingConfig.signingMaterial === SigningMaterial.X509_CHAIN) {
      const certificateProvider = this.crypto as CertificateCapableCryptoProvider;
      const jwk = certificateProvider.nodeJwk?.();
      if (jwk && typeof jwk === 'object' && 'kid' in jwk && 'x5c' in jwk) {
        const kid = (jwk as Record<string, unknown>).kid;
        if (typeof kid === 'string' && kid.length > 0) {
          return kid;
        }
      }
    }

    const fallback = readStringProperty(this.crypto, 'signatureKeyId', 'signature_key_id');
    if (!fallback) {
      throw new Error('Crypto provider does not expose a signature key id');
    }
    return fallback;
  }
}
