import { Buffer } from 'node:buffer';
import { URLSearchParams } from 'node:url';

import {
  createFameFastifyServer,
  registerDefaultFameServerRoutes,
  normalizeFameServerConfig,
  type FameFastifyServer,
} from '../index.js';
import { setCryptoProvider } from '../../security/crypto/providers/crypto-provider.js';
import type { CryptoProvider } from '../../security/crypto/providers/crypto-provider.js';
import type { TokenIssuer } from '../../security/auth/token-issuer.js';

const TEST_BASE_CONFIG = {
  basePath: '/api',
  clients: [
    {
      clientId: 'client-one',
      clientSecret: 'super-secret',
      scopes: ['read', 'write'],
    },
  ],
};

function createUnsignedJwt(payload: Record<string, unknown>): string {
  const headerSegment = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payloadSegment = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${headerSegment}.${payloadSegment}.`;
}

describe('normalizeFameServerConfig', () => {
  it('applies defaults and normalizes paths', () => {
    const config = normalizeFameServerConfig({
      basePath: ' /fame/ ',
      routes: {
        token: 'oauth/token/',
      },
      clients: [
        {
          clientId: 'client',
          clientSecret: 'secret',
          scopes: ['scope'],
        },
      ],
    });

    expect(config.basePath).toBe('/fame');
    expect(config.routes.token).toBe('/oauth/token');
    expect(config.routes.health).toBe('/healthz');
    expect(config.clients).toHaveLength(1);
    expect(config.clients[0]).toEqual(
      expect.objectContaining({ id: 'client', secret: 'secret', scopes: ['scope'] })
    );
  });

  it('throws when duplicate client ids are provided', () => {
    expect(() =>
      normalizeFameServerConfig({
        clients: [
          { clientId: 'dup', clientSecret: 'a' },
          { clientId: 'dup', clientSecret: 'b' },
        ],
      })
    ).toThrow(/duplicate oauth client id/i);
  });
});

describe('Fastify fame server routes', () => {
  let server: FameFastifyServer | undefined;

  afterEach(async () => {
    setCryptoProvider(null);
    if (server) {
      await server.app.close();
      server = undefined;
    }
  });

  it('serves health endpoint with uptime data', async () => {
    server = createFameFastifyServer({ config: TEST_BASE_CONFIG });
    await registerDefaultFameServerRoutes(server);

    const response = await server.app.inject({ method: 'GET', url: '/api/healthz' });

    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.status).toBe('ok');
    expect(typeof payload.uptime_sec).toBe('number');
    expect(typeof payload.timestamp).toBe('string');
  });

  it('returns JWKS from configured crypto provider', async () => {
    const cryptoProvider: CryptoProvider = {
      getJwks: () => ({
        keys: [
          { kid: 'sig-key', use: 'sig', kty: 'OKP', crv: 'Ed25519', x: 'abcd' },
        ],
      }),
    } as CryptoProvider;
    setCryptoProvider(cryptoProvider);

    server = createFameFastifyServer({ config: TEST_BASE_CONFIG });
    await registerDefaultFameServerRoutes(server);

    const response = await server.app.inject({ method: 'GET', url: '/api/.well-known/jwks.json' });

    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(Array.isArray(payload.keys)).toBe(true);
    expect(payload.keys[0]).toHaveProperty('kid', 'sig-key');
  });

  it('issues OAuth token with client credentials grant', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = createUnsignedJwt({ exp: nowSeconds + 120 });

    const tokenIssuer: TokenIssuer = {
      issuer: 'https://issuer.test',
      issue: jest.fn().mockResolvedValue(token),
    };

    const cryptoProvider: CryptoProvider = {
      getTokenIssuer: () => tokenIssuer,
      getJwks: () => ({ keys: [{ kid: 'sig', use: 'sig', kty: 'OKP', crv: 'Ed25519', x: 'abcd' }] }),
      issuer: 'https://issuer.test',
    } as CryptoProvider;
    setCryptoProvider(cryptoProvider);

    server = createFameFastifyServer({ config: TEST_BASE_CONFIG });
    await registerDefaultFameServerRoutes(server);

    const payload = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'client-one',
      client_secret: 'super-secret',
      scope: 'read',
    });

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/oauth/token',
      payload: payload.toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.access_token).toBe(token);
    expect(body.token_type).toBe('Bearer');
    expect(body.scope).toBe('read');
    expect(body.expires_in).toBeGreaterThanOrEqual(0);
    expect(body.expires_in).toBeLessThanOrEqual(120);
    expect(tokenIssuer.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        client_id: 'client-one',
        grant_type: 'client_credentials',
        scope: 'read',
      })
    );
  });

  it('rejects token requests with unauthorized scopes', async () => {
    const tokenIssuer: TokenIssuer = {
      issuer: 'https://issuer.test',
      issue: jest.fn(),
    };

    const cryptoProvider: CryptoProvider = {
      getTokenIssuer: () => tokenIssuer,
    } as CryptoProvider;
    setCryptoProvider(cryptoProvider);

    server = createFameFastifyServer({ config: TEST_BASE_CONFIG });
    await registerDefaultFameServerRoutes(server);

    const payload = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'client-one',
      client_secret: 'super-secret',
      scope: 'admin',
    });

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/oauth/token',
      payload: payload.toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error).toBe('invalid_scope');
    expect(tokenIssuer.issue).not.toHaveBeenCalled();
  });

  it('returns server error when token issuer missing', async () => {
    setCryptoProvider({ getJwks: () => ({ keys: [] }) } as CryptoProvider);

    server = createFameFastifyServer({ config: TEST_BASE_CONFIG });
    await registerDefaultFameServerRoutes(server);

    const payload = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'client-one',
      client_secret: 'super-secret',
    });

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/oauth/token',
      payload: payload.toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body.error).toBe('server_error');
  });

  it('provides OpenID configuration defaults', async () => {
    const tokenIssuer: TokenIssuer = {
      issuer: 'https://issuer.test',
      issue: jest.fn(),
    };
    const cryptoProvider: CryptoProvider = {
      getTokenIssuer: () => tokenIssuer,
      getJwks: () => ({ keys: [{ kid: 'sig', use: 'sig', kty: 'OKP', crv: 'Ed25519', x: 'abcd' }] }),
      issuer: 'https://issuer.test',
    } as CryptoProvider;
    setCryptoProvider(cryptoProvider);

    server = createFameFastifyServer({ config: TEST_BASE_CONFIG });
    await registerDefaultFameServerRoutes(server);

    const response = await server.app.inject({
      method: 'GET',
      url: '/api/.well-known/openid-configuration',
      headers: {
        host: 'example.test',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.issuer).toBe('https://issuer.test');
    expect(body.token_endpoint).toContain('/api/oauth/token');
    expect(body.jwks_uri).toContain('/api/.well-known/jwks.json');
    expect(body.grant_types_supported).toContain('client_credentials');
  });
});
