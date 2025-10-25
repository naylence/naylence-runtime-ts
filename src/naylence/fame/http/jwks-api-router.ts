/**
 * JWKS (JSON Web Key Set) API router for Express
 *
 * Provides /.well-known/jwks.json endpoint for public key discovery
 * Used by OAuth2/JWT token verification
 */

import express, { type Router } from 'express';
import type { CryptoProvider } from '../security/crypto/providers/crypto-provider.js';
import { getLogger } from '../util/logging.js';

const logger = getLogger('naylence.fame.http.jwks_api_router');

const DEFAULT_PREFIX = '';
const ENV_VAR_KEY_TYPES = 'FAME_JWKS_KEY_TYPES';

export interface CreateJwksRouterOptions {
  /**
   * Optional function to get JWKS JSON
   * If not provided, uses the provided crypto provider's getJwks() method
   */
  getJwksJson?: () => { keys: Array<Record<string, unknown>> };

  /**
   * Crypto provider for getting JWKS data
   * Required if getJwksJson is not provided
   */
  cryptoProvider?: CryptoProvider;

  /**
   * Router prefix (default: empty string)
   */
  prefix?: string;

  /**
   * Optional list of key types to include (e.g., ['RSA', 'EC', 'OKP'])
   * If not provided, no filtering is applied
   */
  keyTypes?: string[];
}

/**
 * Get allowed key types from environment variable or parameter
 */
function getAllowedKeyTypes(paramKeyTypes?: string[]): string[] | null {
  // Environment variable takes priority
  const envKeyTypes = process.env[ENV_VAR_KEY_TYPES];
  if (envKeyTypes) {
    // Split by comma or space and strip whitespace
    return envKeyTypes
      .split(/[,\s]+/)
      .map((kty) => kty.trim())
      .filter((kty) => kty.length > 0);
  }

  // Fallback to parameter
  return paramKeyTypes ?? null;
}

/**
 * Filter JWKS keys by allowed key types
 */
function filterKeysByType(
  jwksData: { keys: Array<Record<string, unknown>> },
  allowedTypes: string[] | null
): { keys: Array<Record<string, unknown>> } {
  // If no filtering is configured, return original data
  if (!allowedTypes || allowedTypes.length === 0) {
    return jwksData;
  }

  const filteredKeys = jwksData.keys.filter((key) => {
    const kty = key.kty as string | undefined;
    return kty && allowedTypes.includes(kty);
  });

  return { ...jwksData, keys: filteredKeys };
}

/**
 * Create an Express router that exposes JWKS at /.well-known/jwks.json
 *
 * @param options - Router configuration options
 * @returns Express router with JWKS endpoint
 *
 * @example
 * ```typescript
 * import express from 'express';
 * import { createJwksRouter } from '@naylence/runtime';
 *
 * const app = express();
 * const cryptoProvider = new MyCryptoProvider();
 * app.use(createJwksRouter({ cryptoProvider }));
 * ```
 */
export function createJwksRouter(
  options: CreateJwksRouterOptions = {}
): Router {
  const router = express.Router();

  const {
    getJwksJson,
    cryptoProvider,
    prefix = DEFAULT_PREFIX,
    keyTypes,
  } = options;

  // Get JWKS data
  let jwks: { keys: Array<Record<string, unknown>> };
  if (getJwksJson) {
    jwks = getJwksJson();
  } else if (cryptoProvider?.getJwks) {
    const providerJwks = cryptoProvider.getJwks();
    if (!providerJwks) {
      throw new Error('Crypto provider returned null JWKS');
    }
    jwks = providerJwks as { keys: Array<Record<string, unknown>> };
  } else {
    throw new Error('Either getJwksJson or cryptoProvider must be provided');
  }

  const allowedKeyTypes = getAllowedKeyTypes(keyTypes);

  logger.debug('jwks_router_created', {
    prefix: prefix || '/',
    key_types: allowedKeyTypes,
    total_keys: jwks.keys.length,
  });

  // JWKS endpoint
  router.get(`${prefix}/.well-known/jwks.json`, (_req: unknown, res: any) => {
    const filteredJwks = filterKeysByType(jwks, allowedKeyTypes);

    logger.debug('jwks_served', {
      total_keys: jwks.keys.length,
      filtered_keys: filteredJwks.keys.length,
    });

    res.json(filteredJwks);
  });

  return router;
}
