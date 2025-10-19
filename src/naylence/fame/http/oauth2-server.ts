#!/usr/bin/env node
/**
 * OAuth2/OIDC development server CLI
 *
 * Provides a complete OAuth2 server with:
 * - Token endpoint (client credentials grant)
 * - JWKS endpoint (public key discovery)
 * - OpenID Connect Discovery endpoint
 *
 * Usage:
 *   node --loader ts-node/esm oauth2-server.ts
 *   # Or after build:
 *   node dist/esm/naylence/fame/http/oauth2-server.js
 *
 * Environment Variables:
 *   APP_HOST: Server host (default: 0.0.0.0)
 *   APP_PORT: Server port (default: 8099)
 *   FAME_LOG_LEVEL: Logging level (default: INFO)
 *   FAME_JWT_CLIENT_ID: OAuth2 client ID (required)
 *   FAME_JWT_CLIENT_SECRET: OAuth2 client secret (required)
 *   FAME_JWT_ISSUER: JWT issuer (default: https://auth.fame.fabric)
 *   FAME_JWT_ALGORITHM: JWT algorithm (default: EdDSA)
 */

import express from 'express';
import type { CryptoProvider } from '../security/crypto/providers/crypto-provider.js';
import { createOAuth2TokenRouter } from './oauth2-token-router.js';
import { createJwksRouter } from './jwks-api-router.js';
import { createOpenIDConfigurationRouter } from './openid-configuration-router.js';
import { getLogger, LogLevel } from '../util/logging.js';

const logger = getLogger('naylence.fame.http.oauth2_server');

const ENV_VAR_APP_HOST = 'APP_HOST';
const ENV_VAR_APP_PORT = 'APP_PORT';
const ENV_VAR_LOG_LEVEL = 'FAME_LOG_LEVEL';

const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 8099;

/**
 * Get log level from environment variable
 */
function getLogLevel(): LogLevel {
  const levelStr = process.env[ENV_VAR_LOG_LEVEL]?.toUpperCase();
  if (levelStr && levelStr in LogLevel) {
    return LogLevel[levelStr as keyof typeof LogLevel];
  }
  return LogLevel.INFO;
}

/**
 * Get or create crypto provider
 *
 * This uses a lazy-loaded default crypto provider similar to Python's get_crypto_provider()
 */
async function getCryptoProvider(): Promise<CryptoProvider> {
  // Dynamic import to avoid circular dependencies
  const { DefaultCryptoProvider } = await import(
    '../security/crypto/providers/default-crypto-provider.js'
  );
  return DefaultCryptoProvider.create();
}

/**
 * Create and configure the OAuth2 Express application
 */
export async function createApp(): Promise<express.Application> {
  const app = express();

  // Middleware
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Get crypto provider
  const cryptoProvider = await getCryptoProvider();

  // Add routers
  app.use(createOAuth2TokenRouter({ cryptoProvider }));
  app.use(createJwksRouter({ cryptoProvider }));
  app.use(createOpenIDConfigurationRouter());

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  return app;
}

/**
 * Main entry point when run as CLI
 */
async function main(): Promise<void> {
  // Set log level
  const logLevel = getLogLevel();
  logger.setLevel(logLevel);

  // Get configuration
  const host = process.env[ENV_VAR_APP_HOST] ?? DEFAULT_HOST;
  const port = parseInt(
    process.env[ENV_VAR_APP_PORT] ?? String(DEFAULT_PORT),
    10
  );

  // Validate required environment variables
  if (!process.env.FAME_JWT_CLIENT_ID || !process.env.FAME_JWT_CLIENT_SECRET) {
    logger.error('oauth2_server_config_error', {
      error: 'FAME_JWT_CLIENT_ID and FAME_JWT_CLIENT_SECRET must be set',
    });
    process.exit(1);
  }

  // Create app
  logger.info('oauth2_server_starting', {
    host,
    port,
    logLevel: LogLevel[logLevel],
  });

  const app = await createApp();

  // Start server
  app.listen(port, host, () => {
    logger.info('oauth2_server_started', {
      host,
      port,
      endpoints: {
        token: '/oauth/token',
        jwks: '/.well-known/jwks.json',
        openid_config: '/.well-known/openid-configuration',
        health: '/health',
      },
    });
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    logger.info('oauth2_server_shutting_down', { signal: 'SIGINT' });
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    logger.info('oauth2_server_shutting_down', { signal: 'SIGTERM' });
    process.exit(0);
  });
}

// Export main for CLI usage
export { main };
