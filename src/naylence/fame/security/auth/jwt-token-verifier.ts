import type { JWTPayload, KeyLike } from 'jose';
import type { AuthorizationContext } from 'naylence-core';
import { getLogger } from '../../util/logging.js';
import { TTL_NEVER_EXPIRES } from '../../constants/ttl-constants.js';
import { validateJwtTokenTtlSec } from '../../util/ttl-validation.js';
import type { TokenVerifier } from './token-verifier.js';
import { requireJose, type JWTVerifyOptions, type JoseModule } from './jose-loader.js';
import { buildAuthorizationContext, extractScopesFromPayload } from './jwt-authorization-utils.js';

const logger = getLogger('jwt-token-verifier');

type SigningKey = KeyLike | Uint8Array;

const DEFAULT_ALGORITHMS = ['EdDSA', 'RS256', 'HS256'] as const;

interface JWTTokenVerifierOptions {
  verificationKey: string | Uint8Array | KeyLike;
  issuer: string;
  ttlSec?: number;
  revokedCapacity?: number;
  requiredScopes?: string[];
  algorithms?: string[];
}

type RevokedEntry = string | null;

export class JWTTokenVerifier implements TokenVerifier {
  private readonly issuer: string;
  private readonly ttlSec: number;
  private readonly algorithms: readonly string[];
  private readonly requiredScopes: readonly string[];
  private readonly revokedCapacity: number;
  private readonly revokedTokens: RevokedEntry[];
  private revokedIndex = 0;
  private signingKeyPromise?: Promise<SigningKey>;

  constructor(private readonly options: JWTTokenVerifierOptions) {
    if (!options.verificationKey) {
      throw new Error('JWTTokenVerifier requires a verification key');
    }
    if (!options.issuer) {
      throw new Error('JWTTokenVerifier requires an issuer');
    }

    this.issuer = options.issuer;
    const requestedTtl = Number.isFinite(options.ttlSec) ? Number(options.ttlSec) : 3600;
    const validatedTtl = validateJwtTokenTtlSec(requestedTtl);
    this.ttlSec = typeof validatedTtl === 'number' ? validatedTtl : requestedTtl;
    if (this.ttlSec === TTL_NEVER_EXPIRES) {
      throw new Error('JWTTokenVerifier does not support tokens that never expire');
    }

    this.algorithms = (options.algorithms && options.algorithms.length > 0
      ? options.algorithms
      : Array.from(DEFAULT_ALGORITHMS)
    ).map((alg) => alg.toString().trim());

    this.requiredScopes = options.requiredScopes?.filter((scope) => scope.trim().length > 0) ?? [];
    this.revokedCapacity = Math.max(0, options.revokedCapacity ?? 1000);
    this.revokedTokens = new Array<RevokedEntry>(this.revokedCapacity).fill(null);

    logger.debug('jwt_token_verifier_initialized', {
      issuer: this.issuer,
      ttl_sec: this.ttlSec,
      revoked_capacity: this.revokedCapacity,
      required_scopes: this.requiredScopes,
      algorithms: this.algorithms,
    });
  }

  revoke(jti: string): void {
    if (!this.revokedCapacity) {
      return;
    }

    this.revokedTokens[this.revokedIndex] = jti;
    this.revokedIndex = (this.revokedIndex + 1) % this.revokedCapacity;
  }

  async verify(
    token: string,
    options: { expectedAudience?: string } = {}
  ): Promise<AuthorizationContext> {
    const jose = await requireJose();

    const unverified = jose.decodeJwt(token);
    const jti = typeof unverified.jti === 'string' ? unverified.jti : null;
    if (jti && this.isRevoked(jti)) {
      throw new Error('Token has been revoked');
    }

    const key = await this.resolveVerificationKey(jose);

    try {
      const verifyOptions: JWTVerifyOptions = {
        issuer: this.issuer,
        algorithms: Array.from(this.algorithms),
        maxTokenAge: `${this.ttlSec}s`,
      };

      if (options.expectedAudience !== undefined) {
        verifyOptions.audience = options.expectedAudience;
      }

      const { payload, protectedHeader } = await jose.jwtVerify(token, key, verifyOptions);

      this.ensureRequiredScopes(payload);

  return buildAuthorizationContext(payload, protectedHeader?.kid);
    } catch (error) {
      logger.warning('jwt_token_verifier_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw this.normalizeJoseError(error);
    }
  }

  private isRevoked(jti: string): boolean {
    if (!this.revokedCapacity) {
      return false;
    }

    return this.revokedTokens.includes(jti);
  }

  private ensureRequiredScopes(payload: JWTPayload): void {
    if (!this.requiredScopes.length) {
      return;
    }

    const tokenScopes = extractScopesFromPayload(payload);
    const missingScope = this.requiredScopes.find((scope) => !tokenScopes.has(scope));
    if (missingScope) {
      throw new Error(`Token missing required scope: ${missingScope}`);
    }
  }

  private async resolveVerificationKey(jose: JoseModule): Promise<SigningKey> {
    if (!this.signingKeyPromise) {
      this.signingKeyPromise = this.loadVerificationKey(jose);
    }
    return this.signingKeyPromise;
  }

  private async loadVerificationKey(jose: JoseModule): Promise<SigningKey> {
    const key = this.options.verificationKey;
    if (typeof key === 'string') {
      if (this.isSymmetricAlgorithm()) {
        return new TextEncoder().encode(key);
      }

      return jose.importSPKI(key, this.algorithms[0] ?? 'EdDSA');
    }

    return key as SigningKey;
  }

  private isSymmetricAlgorithm(): boolean {
    return this.algorithms.some((alg) => alg.toUpperCase().startsWith('HS'));
  }

  private normalizeJoseError(error: unknown): Error {
    if (error instanceof Error) {
      if ('code' in error) {
        switch ((error as { code?: string }).code) {
          case 'ERR_JWE_INVALID':
          case 'ERR_JWS_INVALID':
          case 'ERR_JWT_INVALID':
            return this.withCause('Invalid token', error);
          default:
            break;
        }
      }

      if (error.name === 'JWTExpired' || /\b(exp|expired|expiration)\b/i.test(error.message)) {
        return this.withCause('Token has expired', error);
      }
      if (error.name === 'JWTClaimValidationFailed') {
        const claim = (error as { claim?: string }).claim;
        if (claim === 'aud' || /audience/.test(error.message)) {
          return this.withCause('Invalid audience', error);
        }
        if (claim === 'iss' || /issuer/.test(error.message)) {
          return this.withCause('Invalid issuer', error);
        }
        if (claim === 'sub' || /subject/.test(error.message)) {
          return this.withCause('Invalid subject', error);
        }
      }

      return error;
    }

    return new Error('Token verification failed');
  }

  private withCause(message: string, cause: unknown): Error {
    const err = new Error(message);
    (err as Error & { cause?: unknown }).cause = cause;
    return err;
  }
}
