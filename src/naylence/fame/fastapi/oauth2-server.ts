#!/usr/bin/env node
/**
 * OAuth2 Development Server - Simple token server for local testing
 *
 * WARNING: This is a DEVELOPMENT ONLY server. Do NOT use in production!
 *
 * Provides a minimal OAuth2 client credentials flow implementation
 * for local testing and development of Fame applications.
 *
 * Environment Variables:
 * - FAME_LOG_LEVEL: Log level (default: trace)
 * - APP_HOST: Server host (default: 0.0.0.0)
 * - APP_PORT: Server port (default: 8099)
 * - FAME_JWT_CLIENT_ID: Expected OAuth2 client ID
 * - FAME_JWT_CLIENT_SECRET: Expected OAuth2 client secret
 * - FAME_JWT_ISSUER: JWT issuer (default: https://oauth2-server)
 * - FAME_JWT_AUDIENCE: JWT audience (default: fame.fabric)
 * - FAME_JWT_ALGORITHM: JWT algorithm (default: EdDSA)
 */

import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import formbody from '@fastify/formbody';
import * as jose from 'jose';
import { generateKeyPair } from 'crypto';
import { promisify } from 'util';
import { enableLogging, getLogger } from '../util/logging.js';

const generateKeyPairAsync = promisify(generateKeyPair);

const ENV_VAR_LOG_LEVEL = 'FAME_LOG_LEVEL';
const ENV_VAR_CLIENT_ID = 'FAME_JWT_CLIENT_ID';
const ENV_VAR_CLIENT_SECRET = 'FAME_JWT_CLIENT_SECRET';
const ENV_VAR_JWT_ISSUER = 'FAME_JWT_ISSUER';
const ENV_VAR_JWT_AUDIENCE = 'FAME_JWT_AUDIENCE';
const ENV_VAR_JWT_ALGORITHM = 'FAME_JWT_ALGORITHM';

const logger = getLogger('naylence.fame.fastapi.oauth2_server');

// Global keypair for signing tokens
let signingKey: any; // jose.KeyLike type not exported
let publicKey: any; // jose.KeyLike type not exported
let publicJWK: jose.JWK;

async function initializeKeys(): Promise<void> {
  const algorithm = process.env[ENV_VAR_JWT_ALGORITHM] || 'EdDSA';

  if (algorithm === 'EdDSA') {
    const { privateKey, publicKey: pubKey } = await generateKeyPairAsync(
      'ed25519',
      {
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      }
    );

    signingKey = await jose.importPKCS8(privateKey, 'EdDSA');
    publicKey = await jose.importSPKI(pubKey, 'EdDSA');
    publicJWK = await jose.exportJWK(publicKey);
    publicJWK.kid = 'dev-key-1';
    publicJWK.alg = 'EdDSA';
    publicJWK.use = 'sig';
  } else {
    // RS256 fallback
    const { privateKey, publicKey: pubKey } = await generateKeyPairAsync(
      'rsa',
      {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      }
    );

    signingKey = await jose.importPKCS8(privateKey, 'RS256');
    publicKey = await jose.importSPKI(pubKey, 'RS256');
    publicJWK = await jose.exportJWK(publicKey);
    publicJWK.kid = 'dev-key-1';
    publicJWK.alg = 'RS256';
    publicJWK.use = 'sig';
  }

  logger.info('oauth2_server_keys_initialized', { algorithm });
}

interface TokenRequest {
  Body: {
    grant_type?: string;
    client_id?: string;
    client_secret?: string;
    scope?: string;
  };
}

async function createApp(): Promise<FastifyInstance> {
  await initializeKeys();

  const logLevel = (process.env[ENV_VAR_LOG_LEVEL] || 'info').toLowerCase();
  const fastify = Fastify({
    logger: {
      level: logLevel === 'trace' ? 'debug' : logLevel,
    },
  });

  // Register formbody plugin to parse application/x-www-form-urlencoded
  await fastify.register(formbody);

  const issuer = process.env[ENV_VAR_JWT_ISSUER] || 'https://oauth2-server';
  const audience = process.env[ENV_VAR_JWT_AUDIENCE] || 'fame.fabric';
  const algorithm = process.env[ENV_VAR_JWT_ALGORITHM] || 'EdDSA';
  const expectedClientId = process.env[ENV_VAR_CLIENT_ID];
  const expectedClientSecret = process.env[ENV_VAR_CLIENT_SECRET];

  // OAuth2 token endpoint
  fastify.post(
    '/oauth/token',
    async (request: FastifyRequest<TokenRequest>, reply: FastifyReply) => {
      const { grant_type, client_id, client_secret, scope } = request.body;

      // Validate grant type
      if (grant_type !== 'client_credentials') {
        return reply.status(400).send({
          error: 'unsupported_grant_type',
          error_description: 'Only client_credentials grant type is supported',
        });
      }

      // Validate client credentials
      if (!expectedClientId || !expectedClientSecret) {
        logger.error('oauth2_server_missing_credentials', {
          message: 'FAME_JWT_CLIENT_ID and FAME_JWT_CLIENT_SECRET must be set',
        });
        return reply.status(500).send({
          error: 'server_error',
          error_description: 'Server not configured properly',
        });
      }

      if (
        client_id !== expectedClientId ||
        client_secret !== expectedClientSecret
      ) {
        return reply.status(401).send({
          error: 'invalid_client',
          error_description: 'Invalid client credentials',
        });
      }

      // Generate JWT
      const now = Math.floor(Date.now() / 1000);
      const expiresIn = 3600; // 1 hour

      const payload = {
        iss: issuer,
        sub: client_id,
        aud: audience,
        iat: now,
        exp: now + expiresIn,
        scope: scope || 'node.connect',
      };

      const token = await new jose.SignJWT(payload)
        .setProtectedHeader({ alg: algorithm, kid: 'dev-key-1' })
        .sign(signingKey);

      logger.debug('oauth2_token_issued', {
        client_id,
        scope: payload.scope,
        expires_in: expiresIn,
      });

      return {
        access_token: token,
        token_type: 'Bearer',
        expires_in: expiresIn,
        scope: payload.scope,
      };
    }
  );

  // JWKS endpoint for public key distribution
  fastify.get('/.well-known/jwks.json', async () => {
    return {
      keys: [publicJWK],
    };
  });

  // OpenID configuration endpoint
  fastify.get('/.well-known/openid-configuration', async () => {
    const baseUrl = issuer;
    return {
      issuer: baseUrl,
      token_endpoint: `${baseUrl}/oauth/token`,
      jwks_uri: `${baseUrl}/.well-known/jwks.json`,
      grant_types_supported: ['client_credentials'],
      response_types_supported: ['token'],
      token_endpoint_auth_methods_supported: [
        'client_secret_post',
        'client_secret_basic',
      ],
    };
  });

  // Health check
  fastify.get('/health', async () => {
    return { status: 'healthy', service: 'oauth2-dev-server' };
  });

  return fastify;
}

async function main(): Promise<void> {
  try {
    const logLevel = process.env[ENV_VAR_LOG_LEVEL] || 'trace';
    enableLogging(logLevel);

    const app = await createApp();

    const host = process.env.APP_HOST || '0.0.0.0';
    const port = parseInt(process.env.APP_PORT || '8099', 10);

    await app.listen({ host, port });

    logger.info('oauth2_dev_server_started', {
      host,
      port,
      logLevel,
    });

    console.log(`\n⚠️  OAuth2 Development Server (DO NOT USE IN PRODUCTION)`);
    console.log(`📍 Listening on http://${host}:${port}`);
    console.log(`🔑 Token endpoint: http://${host}:${port}/oauth/token`);
    console.log(
      `📜 JWKS endpoint: http://${host}:${port}/.well-known/jwks.json\n`
    );
  } catch (error) {
    logger.error('oauth2_dev_server_failed_to_start', {
      error: error instanceof Error ? error.message : String(error),
    });
    console.error('Failed to start OAuth2 Development Server:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  logger.info('oauth2_dev_server_shutting_down', { signal: 'SIGTERM' });
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('oauth2_dev_server_shutting_down', { signal: 'SIGINT' });
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
