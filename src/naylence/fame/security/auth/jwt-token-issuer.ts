import type {
  CryptoKey as JoseCryptoKey,
  JWTPayload,
  JWK,
  KeyObject,
} from 'jose';
import { getLogger } from '../../util/logging.js';
import type { TokenIssuer } from './token-issuer.js';

const logger = getLogger('naylence.fame.security.auth.jwt_token_issuer');

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
  signingKeyPem?: string;
  signing_key_pem?: string;
  kid?: string;
  issuer?: string;
  algorithm?: string;
  ttlSec?: number;
  ttl_sec?: number;
  audience?: string;
}

interface NormalizedJWTTokenIssuerOptions {
  signingKeyPem: string;
  kid: string;
  issuer: string;
  algorithm: string;
  ttlSec: number;
  audience?: string;
}

function normalizeOptions(
  options: JWTTokenIssuerOptions | null | undefined
): NormalizedJWTTokenIssuerOptions {
  if (!options || typeof options !== 'object') {
    throw new TypeError('JWTTokenIssuer options must be an object');
  }

  const signingKeyPem =
    typeof options.signingKeyPem === 'string' && options.signingKeyPem.trim()
      ? options.signingKeyPem.trim()
      : typeof options.signing_key_pem === 'string' &&
          options.signing_key_pem.trim().length > 0
        ? options.signing_key_pem.trim()
        : undefined;
  if (!signingKeyPem) {
    throw new Error('JWTTokenIssuer requires signingKeyPem');
  }

  const kid =
    typeof options.kid === 'string' && options.kid.trim().length > 0
      ? options.kid.trim()
      : undefined;
  if (!kid) {
    throw new Error('JWTTokenIssuer requires kid');
  }

  const issuer =
    typeof options.issuer === 'string' && options.issuer.trim().length > 0
      ? options.issuer.trim()
      : undefined;
  if (!issuer) {
    throw new Error('JWTTokenIssuer requires issuer');
  }

  const algorithm =
    typeof options.algorithm === 'string' && options.algorithm.trim().length > 0
      ? options.algorithm.trim()
      : 'EdDSA';

  const ttlCandidate =
    typeof options.ttlSec === 'number'
      ? options.ttlSec
      : typeof options.ttl_sec === 'number'
        ? options.ttl_sec
        : undefined;
  const ttlSec = Number.isFinite(ttlCandidate) ? Number(ttlCandidate) : 3600;

  const audience =
    typeof options.audience === 'string' && options.audience.trim().length > 0
      ? options.audience.trim()
      : undefined;

  return {
    signingKeyPem,
    kid,
    issuer,
    algorithm,
    ttlSec,
    audience,
  };
}

export class JWTTokenIssuer implements TokenIssuer {
  private readonly signingKeyPem: string;
  private readonly kid: string;
  private readonly algorithm: string;
  private readonly ttlSec: number;
  private readonly audience: string | undefined;
  private signingKey?: Promise<SigningKey>;

  constructor(options: JWTTokenIssuerOptions) {
    const normalized = normalizeOptions(options);

    this.signingKeyPem = normalized.signingKeyPem;
    this.kid = normalized.kid;
    this.issuerId = normalized.issuer;
    this.algorithm = normalized.algorithm;
    this.ttlSec = normalized.ttlSec;
    this.audience = normalized.audience;

    logger.debug('created_jwt_token_issuer', {
      issuer: normalized.issuer,
      kid: normalized.kid,
      audience: normalized.audience ?? null,
      algorithm: normalized.algorithm,
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
