/**
 * JWKS (JSON Web Key Set) API plugin for Fastify
 *
 * Provides /.well-known/jwks.json endpoint for public key discovery
 * Used by OAuth2/JWT token verification
 */

import type { FastifyPluginAsync } from 'fastify';
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

interface NormalizedJwksRouterOptions {
  getJwksJson?: () => { keys: Array<Record<string, unknown>> };
  cryptoProvider?: CryptoProvider;
  prefix?: string;
  keyTypes?: string[];
}

function coerceString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function coerceStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const normalized = value
      .map((entry) => coerceString(entry))
      .filter((entry): entry is string => entry !== undefined);
    return normalized.length > 0 ? normalized : undefined;
  }

  const text = coerceString(value);
  if (text) {
    return text
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  return undefined;
}

function normalizeCreateJwksRouterOptions(
  options: CreateJwksRouterOptions | undefined
): NormalizedJwksRouterOptions {
  if (!options) {
    return {};
  }

  const descriptor = options as CreateJwksRouterOptions &
    Record<string, unknown>;

  const prefix =
    coerceString(descriptor.prefix) ?? coerceString(descriptor.prefix as any);
  const keyTypes =
    coerceStringArray(descriptor.keyTypes) ??
    coerceStringArray((descriptor as any).key_types);

  const getJwksJson =
    descriptor.getJwksJson ??
    (typeof (descriptor as any).get_jwks_json === 'function'
      ? ((descriptor as any).get_jwks_json as () => {
          keys: Array<Record<string, unknown>>;
        })
      : undefined);

  const cryptoProvider =
    descriptor.cryptoProvider ??
    ((descriptor as any).crypto_provider as CryptoProvider | undefined);

  return {
    getJwksJson,
    cryptoProvider,
    prefix,
    keyTypes: keyTypes ?? undefined,
  };
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
 * Create a Fastify plugin that exposes JWKS at /.well-known/jwks.json
 *
 * @param options - Router configuration options
 * @returns Fastify plugin with JWKS endpoint
 *
 * @example
 * ```typescript
 * import Fastify from 'fastify';
 * import { createJwksRouter } from '@naylence/runtime';
 *
 * const app = Fastify();
 * const cryptoProvider = new MyCryptoProvider();
 * app.register(createJwksRouter({ cryptoProvider }));
 * ```
 */
export function createJwksRouter(
  options: CreateJwksRouterOptions = {}
): FastifyPluginAsync {
  const {
    getJwksJson,
    cryptoProvider,
    prefix = DEFAULT_PREFIX,
    keyTypes,
  } = normalizeCreateJwksRouterOptions(options);

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

  const plugin: FastifyPluginAsync = async (instance) => {
    instance.get(`${prefix}/.well-known/jwks.json`, async (_request, reply) => {
      const filteredJwks = filterKeysByType(jwks, allowedKeyTypes);

      logger.debug('jwks_served', {
        total_keys: jwks.keys.length,
        filtered_keys: filteredJwks.keys.length,
      });

      reply.send(filteredJwks);
    });
  };

  return plugin;
}
