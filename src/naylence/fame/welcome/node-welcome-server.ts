#!/usr/bin/env node
/**
 * Node Welcome Server - Standalone HTTP server for admission control
 *
 * This server provides the welcome service endpoint for node admission,
 * including placement decisions, attach ticket issuance, and CA grants.
 *
 * Environment Variables:
 * - FAME_LOG_LEVEL: Log level (automatically applied by framework, default: INFO)
 *   Valid values: TRACE, DEBUG, INFO, WARNING, WARN, ERROR, CRITICAL
 * - FAME_APP_HOST: Server host (default: 0.0.0.0)
 * - FAME_APP_PORT: Server port (default: 8090)
 * - FAME_CONFIG: Path to fame-config.yml or inline YAML/JSON config
 */

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { WelcomeServiceFactory } from './welcome-service-factory.js';
import { nodeWelcomeRouter } from './node-welcome-router.js';
import { getLogger } from '../util/logging.js';
import { DefaultCryptoProvider } from '../security/crypto/providers/default-crypto-provider.js';
import type { CryptoProvider } from '../security/crypto/providers/crypto-provider.js';

const ENV_VAR_FAME_APP_HOST = 'FAME_APP_HOST';
const ENV_VAR_FAME_APP_PORT = 'FAME_APP_PORT';
const ENV_VAR_KEY_TYPES = 'FAME_JWKS_KEY_TYPES';

const logger = getLogger('naylence.fame.welcome.node_welcome_server');

/**
 * Get allowed key types from environment variable
 */
function getAllowedKeyTypes(): string[] | null {
  const envKeyTypes = process.env[ENV_VAR_KEY_TYPES];
  if (envKeyTypes) {
    return envKeyTypes
      .split(/[,\s]+/)
      .map((kty) => kty.trim())
      .filter((kty) => kty.length > 0);
  }
  return null;
}

/**
 * Filter JWKS keys by allowed key types
 */
function filterKeysByType(
  jwksData: { keys?: Array<Record<string, unknown>> },
  allowedTypes: string[] | null
): { keys: Array<Record<string, unknown>> } {
  const keys = jwksData.keys ?? [];

  // If no filtering is configured, return original data
  if (!allowedTypes || allowedTypes.length === 0) {
    return { keys };
  }

  const filteredKeys = keys.filter((key) => {
    const kty = key.kty as string | undefined;
    return kty && allowedTypes.includes(kty);
  });

  return { keys: filteredKeys };
}

async function createApp(): Promise<FastifyInstance> {
  // Fastify uses 'info' log level by default, which is reasonable
  const fastify = Fastify({
    logger: {
      level: 'info',
    },
  });

  // Create crypto provider at the top level - this is the single source of truth
  // All downstream components (welcome service, token issuer, etc.) will use this
  const cryptoProvider: CryptoProvider = await DefaultCryptoProvider.create();

  const jwksData = cryptoProvider.getJwks?.() ?? { keys: [] };
  console.log('🔑 Crypto provider created with keys:', {
    has_getJwks: !!cryptoProvider.getJwks,
    num_keys: jwksData.keys?.length ?? 0,
    keys_sample: jwksData.keys?.slice(0, 1),
  });

  logger.debug('crypto_provider_created', {
    has_jwks: !!cryptoProvider.getJwks,
    num_keys: jwksData.keys?.length ?? 0,
  });

  // Pass crypto provider to welcome service factory via factoryArgs
  const welcomeService = await WelcomeServiceFactory.createWelcomeService(
    undefined,
    { factoryArgs: [cryptoProvider] }
  );

  // Register welcome router
  await fastify.register(nodeWelcomeRouter, {
    welcomeService,
  });

  // Register JWKS endpoint using the same crypto provider
  // This provides the public keys for JWT verification
  const allowedKeyTypes = getAllowedKeyTypes();

  fastify.get('/fame/welcome/.well-known/jwks.json', async () => {
    const jwks = cryptoProvider.getJwks?.() ?? { keys: [] };
    const filtered = filterKeysByType(jwks, allowedKeyTypes);

    logger.debug('jwks_served', {
      total_keys: jwks.keys?.length ?? 0,
      filtered_keys: filtered.keys.length,
      allowed_types: allowedKeyTypes,
    });

    return filtered;
  });

  // Health check endpoint
  fastify.get('/health', async () => {
    return { status: 'healthy', service: 'node-welcome-server' };
  });

  return fastify;
}

async function main(): Promise<void> {
  try {
    const app = await createApp();

    const host = process.env[ENV_VAR_FAME_APP_HOST] || '0.0.0.0';
    const port = parseInt(process.env[ENV_VAR_FAME_APP_PORT] || '8090', 10);

    await app.listen({ host, port });

    logger.info('node_welcome_server_started', {
      host,
      port,
    });

    console.log(`Node Welcome Server listening on http://${host}:${port}`);
    console.log(
      `Welcome endpoint: http://${host}:${port}/fame/v1/welcome/hello`
    );
    console.log(
      `JWKS endpoint: http://${host}:${port}/fame/welcome/.well-known/jwks.json`
    );
  } catch (error) {
    logger.error('node_welcome_server_failed_to_start', {
      error: error instanceof Error ? error.message : String(error),
    });
    console.error('Failed to start Node Welcome Server:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  logger.info('node_welcome_server_shutting_down', { signal: 'SIGTERM' });
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('node_welcome_server_shutting_down', { signal: 'SIGINT' });
  process.exit(0);
});

// Start server if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { createApp };
