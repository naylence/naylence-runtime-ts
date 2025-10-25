/**
 * OpenID Connect Discovery configuration router for Express
 *
 * Provides /.well-known/openid-configuration endpoint for OAuth2/OIDC client auto-discovery
 */

import express, { type Router } from 'express';
import { getLogger } from '../util/logging.js';

const logger = getLogger('naylence.fame.http.openid_configuration_router');

const DEFAULT_PREFIX = '';

const ENV_VAR_JWT_ISSUER = 'FAME_JWT_ISSUER';
const ENV_VAR_ALLOWED_SCOPES = 'FAME_JWT_ALLOWED_SCOPES';
const ENV_VAR_JWT_ALGORITHM = 'FAME_JWT_ALGORITHM';

const DEFAULT_JWT_ALGORITHM = 'EdDSA';

interface OpenIDConfiguration {
  issuer: string;
  authorization_endpoint?: string;
  token_endpoint: string;
  jwks_uri: string;
  scopes_supported: string[];
  response_types_supported: string[];
  grant_types_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  subject_types_supported: string[];
  id_token_signing_alg_values_supported: string[];
}

export interface CreateOpenIDConfigurationRouterOptions {
  /**
   * Router prefix (default: empty string)
   */
  prefix?: string;

  /**
   * JWT issuer claim
   * Environment variable FAME_JWT_ISSUER takes priority
   * Default: https://auth.fame.fabric
   */
  issuer?: string;

  /**
   * Base URL for the server (defaults to issuer value)
   */
  baseUrl?: string;

  /**
   * Path to the token endpoint (default: /oauth/token)
   */
  tokenEndpointPath?: string;

  /**
   * Path to the JWKS endpoint (default: /.well-known/jwks.json)
   */
  jwksEndpointPath?: string;

  /**
   * Allowed scopes
   * Environment variable FAME_JWT_ALLOWED_SCOPES takes priority
   * Default: ['node.connect']
   */
  allowedScopes?: string[];

  /**
   * JWT signing algorithm
   * Environment variable FAME_JWT_ALGORITHM takes priority
   * Default: EdDSA
   */
  algorithm?: string;
}

/**
 * Parse allowed scopes from environment or config
 */
function getAllowedScopes(configScopes?: string[]): string[] {
  const envScopes = process.env[ENV_VAR_ALLOWED_SCOPES];
  if (envScopes) {
    return envScopes
      .replace(/,/g, ' ')
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  return configScopes ?? ['node.connect'];
}

/**
 * Create an Express router that implements OpenID Connect Discovery
 *
 * @param options - Router configuration options
 * @returns Express router with OpenID configuration endpoint
 *
 * Environment Variables:
 *   FAME_JWT_ISSUER: JWT issuer claim (optional)
 *   FAME_JWT_ALLOWED_SCOPES: Allowed scopes (optional, default: node.connect)
 *   FAME_JWT_ALGORITHM: JWT signing algorithm (optional, default: EdDSA)
 *
 * @example
 * ```typescript
 * import express from 'express';
 * import { createOpenIDConfigurationRouter } from '@naylence/runtime';
 *
 * const app = express();
 * app.use(createOpenIDConfigurationRouter({
 *   issuer: 'https://auth.example.com',
 * }));
 * ```
 */
export function createOpenIDConfigurationRouter(
  options: CreateOpenIDConfigurationRouterOptions = {}
): Router {
  const router = express.Router();

  const {
    prefix = DEFAULT_PREFIX,
    issuer,
    baseUrl,
    tokenEndpointPath = '/oauth/token',
    jwksEndpointPath = '/.well-known/jwks.json',
    allowedScopes: configAllowedScopes,
    algorithm: configAlgorithm,
  } = options;

  // Resolve configuration with environment variable priority
  const defaultIssuer =
    process.env[ENV_VAR_JWT_ISSUER] ?? issuer ?? 'https://auth.fame.fabric';
  const defaultBaseUrl = baseUrl ?? defaultIssuer;
  const algorithm =
    process.env[ENV_VAR_JWT_ALGORITHM] ??
    configAlgorithm ??
    DEFAULT_JWT_ALGORITHM;
  const allowedScopes = getAllowedScopes(configAllowedScopes);

  logger.debug('openid_config_router_created', {
    prefix: prefix || '/',
    issuer: defaultIssuer,
    baseUrl: defaultBaseUrl,
    algorithm,
    allowedScopes,
  });

  // OpenID Connect Discovery endpoint
  router.get(
    `${prefix}/.well-known/openid-configuration`,
    (_req: unknown, res: any) => {
      // Construct absolute URLs for endpoints
      const tokenEndpoint = `${defaultBaseUrl.replace(/\/$/, '')}${tokenEndpointPath}`;
      const jwksUri = `${defaultBaseUrl.replace(/\/$/, '')}${jwksEndpointPath}`;

      const config: OpenIDConfiguration = {
        issuer: defaultIssuer,
        token_endpoint: tokenEndpoint,
        jwks_uri: jwksUri,
        scopes_supported: allowedScopes,
        response_types_supported: ['token'],
        grant_types_supported: ['client_credentials'],
        token_endpoint_auth_methods_supported: [
          'client_secret_basic',
          'client_secret_post',
        ],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: [algorithm],
      };

      logger.debug('openid_config_served', { config });

      res.json(config);
    }
  );

  return router;
}
