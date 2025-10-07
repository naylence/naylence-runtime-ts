import type {
  CryptoKey as JoseCryptoKey,
  JWTPayload,
  JWK,
  KeyObject,
} from 'jose';
import { getLogger } from '../../util/logging.js';
import type { TokenIssuer } from './token-issuer.js';

const logger = getLogger('jwt-token-issuer');

let joseModulePromise: Promise<typeof import('jose')> | null = null;

async function requireJose(): Promise<typeof import('jose')> {
  if (!joseModulePromise) {
    joseModulePromise = import('jose').catch(() => {
      joseModulePromise = null;
      throw new Error(
        'The "jose" dependency is required for JWT token functionality. Install it with: npm install jose'
      );
    });
  }

  return joseModulePromise;
}

function isHmacAlgorithm(algorithm: string): boolean {
  return algorithm.toUpperCase().startsWith('HS');
}

function isPkcs8Algorithm(algorithm: string): boolean {
  const upper = algorithm.toUpperCase();
  return (
    upper === 'EDDSA' ||
    upper.startsWith('RS') ||
    upper.startsWith('PS') ||
    upper.startsWith('ES')
  );
}

type SigningKey = JoseCryptoKey | KeyObject | JWK | Uint8Array;

export interface JWTTokenIssuerOptions {
  signingKeyPem: string;
  kid: string;
  issuer: string;
  algorithm?: string;
  ttlSec?: number;
  audience?: string;
}

export class JWTTokenIssuer implements TokenIssuer {
  private readonly signingKeyPem: string;
  private readonly kid: string;
  private readonly algorithm: string;
  private readonly ttlSec: number;
  private readonly audience: string | undefined;
  private signingKey?: Promise<SigningKey>;

  constructor({
    signingKeyPem,
    kid,
    issuer,
    algorithm = 'EdDSA',
    ttlSec = 3600,
    audience,
  }: JWTTokenIssuerOptions) {
    this.signingKeyPem = signingKeyPem;
    this.kid = kid;
    this.issuerId = issuer;
    this.algorithm = algorithm;
    this.ttlSec = ttlSec;
    this.audience = audience;

    logger.debug('created_jwt_token_issuer', {
      issuer,
      kid,
      audience: audience ?? null,
      algorithm,
    });
  }

  private readonly issuerId: string;

  get issuer(): string {
    return this.issuerId;
  }

  async issue(claims: Record<string, unknown>): Promise<string> {
    const jose = await requireJose();
    const signingKey = await this.resolveSigningKey(jose);

    const nowSeconds = Math.floor(Date.now() / 1000);
    const payload = this.buildTokenClaims(claims, nowSeconds);

    const signer = new jose.SignJWT(payload).setProtectedHeader({
      alg: this.algorithm,
      kid: this.kid,
      typ: 'JWT',
    });

    return signer.sign(signingKey);
  }

  private async resolveSigningKey(
    jose: typeof import('jose')
  ): Promise<SigningKey> {
    if (!this.signingKey) {
      this.signingKey = this.loadSigningKey(jose);
    }

    return this.signingKey;
  }

  private async loadSigningKey(
    jose: typeof import('jose')
  ): Promise<SigningKey> {
    if (isHmacAlgorithm(this.algorithm)) {
      return new TextEncoder().encode(this.signingKeyPem);
    }

    if (isPkcs8Algorithm(this.algorithm)) {
      return jose.importPKCS8(this.signingKeyPem, this.algorithm);
    }

    throw new Error(`Unsupported JWT algorithm: ${this.algorithm}`);
  }

  private buildTokenClaims(
    claims: Record<string, unknown>,
    nowSeconds: number
  ): JWTPayload {
    const baseClaims: JWTPayload = {
      iss: this.issuerId,
      iat: nowSeconds,
      nbf: nowSeconds,
      exp: nowSeconds + this.ttlSec,
    };

    if (this.audience !== undefined && !('aud' in claims)) {
      baseClaims.aud = this.audience;
    }

    for (const [key, value] of Object.entries(claims)) {
      if (value !== undefined) {
        baseClaims[key] = value;
      }
    }

    return baseClaims;
  }
}
