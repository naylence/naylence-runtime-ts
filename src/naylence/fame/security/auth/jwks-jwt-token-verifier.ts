import type { AuthorizationContext } from '@naylence/core';
import { DEFAULT_JWKS_CACHE_TTL_SEC } from '../../constants/ttl-constants.js';
import { getLogger } from '../../util/logging.js';
import type { TokenVerifier } from './token-verifier.js';
import {
  requireJose,
  type JWTVerifyOptions,
  type JoseModule,
} from './jose-loader.js';
import { buildAuthorizationContext } from './jwt-authorization-utils.js';

const logger = getLogger('naylence.fame.security.auth.jwks_jwt_token_verifier');

const DEFAULT_ALGORITHMS = ['RS256', 'ES256', 'EdDSA'] as const;

export interface JWKSJWTTokenVerifierOptions {
  issuer?: string;
  jwksUrl?: string;
  jwks_url?: string;
  cacheTtlSec?: number;
  cache_ttl_sec?: number;
  algorithms?: string[];
}

interface NormalizedJWKSJWTTokenVerifierOptions {
  issuer: string;
  jwksUrl: string;
  cacheTtlSec?: number;
  algorithms?: string[];
}

function normalizeOptions(
  options: JWKSJWTTokenVerifierOptions | null | undefined
): NormalizedJWKSJWTTokenVerifierOptions {
  if (!options || typeof options !== 'object') {
    throw new TypeError('JWKSJWTTokenVerifier options must be an object');
  }

  const issuer =
    typeof options.issuer === 'string' && options.issuer.trim().length > 0
      ? options.issuer.trim()
      : undefined;
  if (!issuer) {
    throw new Error('JWKSJWTTokenVerifier requires an issuer');
  }

  const jwksCandidate =
    typeof options.jwksUrl === 'string' && options.jwksUrl.trim().length > 0
      ? options.jwksUrl.trim()
      : typeof options.jwks_url === 'string' &&
          options.jwks_url.trim().length > 0
        ? options.jwks_url.trim()
        : undefined;
  if (!jwksCandidate) {
    throw new Error('JWKSJWTTokenVerifier requires a JWKS URL');
  }

  const cacheTtlSec =
    typeof options.cacheTtlSec === 'number'
      ? options.cacheTtlSec
      : typeof options.cache_ttl_sec === 'number'
        ? options.cache_ttl_sec
        : undefined;

  const algorithms = Array.isArray(options.algorithms)
    ? options.algorithms
    : undefined;

  return {
    issuer,
    jwksUrl: jwksCandidate,
    cacheTtlSec,
    algorithms,
  };
}

export class JWKSJWTTokenVerifier implements TokenVerifier {
  private readonly issuer: string;
  private readonly jwksUrl: URL;
  private readonly cacheTtlMs: number;
  private readonly algorithms: readonly string[];
  private remoteJwkSet?: ReturnType<JoseModule['createRemoteJWKSet']>;

  constructor(options: JWKSJWTTokenVerifierOptions) {
    const normalized = normalizeOptions(options);

    try {
      this.jwksUrl = new URL(normalized.jwksUrl);
    } catch (error) {
      throw new Error(`Invalid JWKS URL: ${normalized.jwksUrl}`);
    }

    this.issuer = normalized.issuer;
    this.cacheTtlMs = Math.max(
      1_000,
      (normalized.cacheTtlSec ?? DEFAULT_JWKS_CACHE_TTL_SEC) * 1_000
    );
    this.algorithms = (
      normalized.algorithms && normalized.algorithms.length > 0
        ? normalized.algorithms
        : Array.from(DEFAULT_ALGORITHMS)
    ).map((alg) => alg.toString().trim());

    logger.debug('jwks_jwt_token_verifier_initialized', {
      issuer: this.issuer,
      jwks_url: this.jwksUrl.toString(),
      cache_ttl_ms: this.cacheTtlMs,
      algorithms: this.algorithms,
    });
  }

  public async verify(
    token: string,
    options: { expectedAudience?: string } = {}
  ): Promise<AuthorizationContext> {
    const jose = await requireJose();

    try {
      const remoteJwkSet = await this.getRemoteJwkSet(jose);
      const verifyOptions: JWTVerifyOptions = {
        issuer: this.issuer,
        algorithms: Array.from(this.algorithms),
      };

      if (options.expectedAudience !== undefined) {
        verifyOptions.audience = options.expectedAudience;
      }

      const { payload, protectedHeader } = await jose.jwtVerify(
        token,
        remoteJwkSet,
        verifyOptions
      );

      return buildAuthorizationContext(payload, protectedHeader?.kid);
    } catch (error) {
      logger.warning('jwks_jwt_token_verifier_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw this.normalizeJoseError(error);
    }
  }

  private async getRemoteJwkSet(jose: JoseModule) {
    if (!this.remoteJwkSet) {
      this.remoteJwkSet = jose.createRemoteJWKSet(this.jwksUrl, {
        cacheMaxAge: this.cacheTtlMs,
        cooldownDuration: Math.min(this.cacheTtlMs / 2, 30_000),
      });
    }
    return this.remoteJwkSet;
  }

  private normalizeJoseError(error: unknown): Error {
    if (error instanceof Error) {
      if (error.name === 'JWTExpired' || /expir/i.test(error.message)) {
        return this.withCause('Token has expired', error);
      }
      if (error.name === 'JWTClaimValidationFailed') {
        const claim = (error as { claim?: string }).claim;
        if (claim === 'aud' || /audience/i.test(error.message)) {
          return this.withCause('Invalid audience', error);
        }
        if (claim === 'iss' || /issuer/i.test(error.message)) {
          return this.withCause('Invalid issuer', error);
        }
        if (claim === 'sub' || /subject/i.test(error.message)) {
          return this.withCause('Invalid subject', error);
        }
      }
      if ((error as { code?: string }).code === 'ERR_JWT_INVALID') {
        return this.withCause('Invalid token', error);
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
