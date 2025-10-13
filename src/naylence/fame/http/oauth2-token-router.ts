/**
 * OAuth2 client credentials grant flow router for Express
 * 
 * Provides /oauth/token endpoint for local development and testing
 * Implements OAuth2 client credentials grant with JWT token issuance
 */

import express, { type Router, type Request, type Response, type NextFunction } from 'express';
import type { CryptoProvider } from '../security/crypto/providers/crypto-provider.js';
import { JWTTokenIssuer } from '../security/auth/jwt-token-issuer.js';
import { getLogger } from '../util/logging.js';

const logger = getLogger('oauth2-token-router');

const DEFAULT_PREFIX = '/oauth';

const ENV_VAR_CLIENT_ID = 'FAME_JWT_CLIENT_ID';
const ENV_VAR_CLIENT_SECRET = 'FAME_JWT_CLIENT_SECRET';
const ENV_VAR_ALLOWED_SCOPES = 'FAME_JWT_ALLOWED_SCOPES';
const ENV_VAR_JWT_ISSUER = 'FAME_JWT_ISSUER';
const ENV_VAR_JWT_ALGORITHM = 'FAME_JWT_ALGORITHM';
const ENV_VAR_JWT_AUDIENCE = 'FAME_JWT_AUDIENCE';

const DEFAULT_JWT_ALGORITHM = 'EdDSA';

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

export interface CreateOAuth2TokenRouterOptions {
  /**
   * Crypto provider for JWT signing
   * Required for token issuance
   */
  cryptoProvider: CryptoProvider;

  /**
   * Router prefix (default: /oauth)
   */
  prefix?: string;

  /**
   * JWT issuer claim
   * Environment variable FAME_JWT_ISSUER takes priority
   * Default: https://auth.fame.fabric
   */
  issuer?: string;

  /**
   * JWT audience claim
   * Environment variable FAME_JWT_AUDIENCE takes priority
   * Default: fame-fabric
   */
  audience?: string;

  /**
   * Token TTL in seconds (default: 3600)
   */
  tokenTtlSec?: number;

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

interface ClientCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Parse Basic Auth header
 */
function parseBasicAuth(authHeader: string | undefined): ClientCredentials | null {
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return null;
  }

  try {
    const base64Credentials = authHeader.substring(6);
    const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
    const [clientId, clientSecret] = credentials.split(':');

    if (!clientId || !clientSecret) {
      return null;
    }

    return { clientId, clientSecret };
  } catch {
    return null;
  }
}

/**
 * Get configured client credentials from environment
 */
function getConfiguredClientCredentials(): ClientCredentials {
  const clientId = process.env[ENV_VAR_CLIENT_ID];
  const clientSecret = process.env[ENV_VAR_CLIENT_SECRET];

  if (!clientId || !clientSecret) {
    throw new Error(
      `Server configuration error: ${ENV_VAR_CLIENT_ID} and ${ENV_VAR_CLIENT_SECRET} must be set`
    );
  }

  return { clientId, clientSecret };
}

/**
 * Verify client credentials
 */
function verifyClientCredentials(
  requestCreds: ClientCredentials,
  configuredCreds: ClientCredentials
): boolean {
  return (
    requestCreds.clientId === configuredCreds.clientId &&
    requestCreds.clientSecret === configuredCreds.clientSecret
  );
}

/**
 * Parse and validate allowed scopes from environment or config
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
 * Validate requested scope and return granted scopes
 */
function validateScope(requestedScope: string | undefined, allowedScopes: string[]): string[] {
  if (!requestedScope) {
    return allowedScopes;
  }

  const requestedScopes = requestedScope.split(/\s+/);
  const grantedScopes = requestedScopes.filter((scope) => allowedScopes.includes(scope));

  return grantedScopes.length > 0 ? grantedScopes : allowedScopes;
}

/**
 * Create an Express router that implements OAuth2 client credentials grant
 * 
 * @param options - Router configuration options
 * @returns Express router with OAuth2 token endpoint
 * 
 * Environment Variables:
 *   FAME_JWT_CLIENT_ID: OAuth2 client identifier
 *   FAME_JWT_CLIENT_SECRET: OAuth2 client secret
 *   FAME_JWT_ISSUER: JWT issuer claim (optional)
 *   FAME_JWT_AUDIENCE: JWT audience claim (optional)
 *   FAME_JWT_ALGORITHM: JWT signing algorithm (optional, default: EdDSA)
 *   FAME_JWT_ALLOWED_SCOPES: Allowed scopes (optional, default: node.connect)
 * 
 * @example
 * ```typescript
 * import express from 'express';
 * import { createOAuth2TokenRouter } from 'naylence-runtime';
 * 
 * const app = express();
 * app.use(express.urlencoded({ extended: true }));
 * 
 * const cryptoProvider = new MyCryptoProvider();
 * app.use(createOAuth2TokenRouter({ cryptoProvider }));
 * ```
 */
export function createOAuth2TokenRouter(options: CreateOAuth2TokenRouterOptions): Router {
  const router = express.Router();

  const {
    cryptoProvider,
    prefix = DEFAULT_PREFIX,
    issuer,
    audience,
    tokenTtlSec = 3600,
    allowedScopes: configAllowedScopes,
    algorithm: configAlgorithm,
  } = options;

  // Resolve configuration with environment variable priority
  const defaultIssuer = process.env[ENV_VAR_JWT_ISSUER] ?? issuer ?? 'https://auth.fame.fabric';
  const defaultAudience = process.env[ENV_VAR_JWT_AUDIENCE] ?? audience ?? 'fame-fabric';
  const algorithm = process.env[ENV_VAR_JWT_ALGORITHM] ?? configAlgorithm ?? DEFAULT_JWT_ALGORITHM;
  const allowedScopes = getAllowedScopes(configAllowedScopes);

  logger.debug('oauth2_router_created', {
    prefix,
    issuer: defaultIssuer,
    audience: defaultAudience,
    algorithm,
    allowedScopes,
    tokenTtlSec,
  });

  // Token endpoint
  router.post(`${prefix}/token`, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { grant_type, client_id, client_secret, scope, audience: reqAudience } = req.body;

      // Validate grant type
      if (grant_type !== 'client_credentials') {
        res.status(400).json({
          error: 'unsupported_grant_type',
          error_description: 'Only client_credentials grant type is supported',
        });
        return;
      }

      // Get configured credentials
      let configuredCreds: ClientCredentials;
      try {
        configuredCreds = getConfiguredClientCredentials();
      } catch (error) {
        logger.error('oauth2_config_error', { error: (error as Error).message });
        res.status(500).json({
          error: 'server_error',
          error_description: 'Server configuration error',
        });
        return;
      }

      // Extract client credentials from request
      let requestCreds: ClientCredentials | null = null;

      // Try Basic Auth first
      const authHeader = req.headers.authorization;
      if (authHeader) {
        requestCreds = parseBasicAuth(authHeader);
      }

      // Fall back to form parameters
      if (!requestCreds && client_id && client_secret) {
        requestCreds = { clientId: client_id, clientSecret: client_secret };
      }

      if (!requestCreds) {
        res
          .status(401)
          .set('WWW-Authenticate', 'Basic')
          .json({
            error: 'invalid_client',
            error_description: 'Client credentials are required',
          });
        return;
      }

      // Verify client credentials
      if (!verifyClientCredentials(requestCreds, configuredCreds)) {
        logger.warning('oauth2_invalid_credentials', { clientId: requestCreds.clientId });
        res
          .status(401)
          .set('WWW-Authenticate', 'Basic')
          .json({
            error: 'invalid_client',
            error_description: 'Invalid client credentials',
          });
        return;
      }

      // Validate and determine granted scopes
      const grantedScopes = validateScope(scope, allowedScopes);

      // Get crypto provider keys
      if (!cryptoProvider.signingPrivatePem || !cryptoProvider.signatureKeyId) {
        logger.error('oauth2_missing_keys', {
          hasPrivateKey: !!cryptoProvider.signingPrivatePem,
          hasKeyId: !!cryptoProvider.signatureKeyId,
        });
        res.status(500).json({
          error: 'server_error',
          error_description: 'Server cryptographic configuration error',
        });
        return;
      }

      // Create token issuer
      const tokenIssuer = new JWTTokenIssuer({
        signingKeyPem: cryptoProvider.signingPrivatePem,
        kid: cryptoProvider.signatureKeyId,
        issuer: defaultIssuer,
        algorithm,
        ttlSec: tokenTtlSec,
        audience: defaultAudience,
      });

      // Build JWT claims
      const claims: Record<string, unknown> = {
        sub: requestCreds.clientId,
        client_id: requestCreds.clientId,
        scope: grantedScopes.join(' '),
      };

      // Add audience claim
      if (reqAudience) {
        claims.aud = reqAudience;
      } else if (defaultAudience) {
        claims.aud = defaultAudience;
      }

      // Issue the token (async)
      const accessToken = await tokenIssuer.issue(claims);

      logger.debug('oauth2_token_issued', {
        clientId: requestCreds.clientId,
        scopes: grantedScopes,
        algorithm,
      });

      // Return token response
      const response: TokenResponse = {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: tokenTtlSec,
      };

      if (grantedScopes.length > 0) {
        response.scope = grantedScopes.join(' ');
      }

      res.json(response);
    } catch (error) {
      logger.error('oauth2_token_error', { error: (error as Error).message });
      next(error);
    }
  });

  return router;
}
