import { Buffer } from 'node:buffer';
import { URLSearchParams } from 'node:url';

import {
  createFameFastifyServer,
  registerDefaultFameServerRoutes,
  normalizeFameServerConfig,
  type FameFastifyServer,
} from '../index.js';
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
  const headerSegment = Buffer.from(
    JSON.stringify({ alg: 'none', typ: 'JWT' })
  ).toString('base64url');
  const payloadSegment = Buffer.from(JSON.stringify(payload)).toString(
    'base64url'
  );
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
      expect.objectContaining({
        id: 'client',
        secret: 'secret',
        scopes: ['scope'],
      })
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
  let currentCryptoProvider: CryptoProvider | null;
  const dependencies = {
    resolveCryptoProvider: () => currentCryptoProvider ?? null,
  };

  afterEach(async () => {
    currentCryptoProvider = null;
    if (server) {
      await server.app.close();
      server = undefined;
    }
  });

  it('normalizes snake_case config and fastify options', () => {
    const snakeCaseOptions = {
      config: {
        base_path: ' /snake/ ',
        request_timeout_ms: '15000',
        keep_alive_timeout_ms: 2_500,
        enable_introspection: true,
        default_audience: ' snake-aud ',
        routes: {
          open_id_configuration: '/custom/openid',
          token: ' oauth/token ',
        },
        clients: [
          {
            client_id: 'snake-client',
            client_secret: 'secret',
            scopes: [' read ', 'write '],
          },
        ],
      },
      fastify_options: {
        disable_request_logging: false,
        trust_proxy: true,
        body_limit: 2_048,
        router_options: {
          case_sensitive: true,
          max_param_length: 64,
        },
      },
    } as any;

    server = createFameFastifyServer(snakeCaseOptions);

    expect(server.config.basePath).toBe('/snake');
    expect(server.config.requestTimeoutMs).toBe(15_000);
    expect(server.config.keepAliveTimeoutMs).toBe(2_500);
    expect(server.config.enableIntrospection).toBe(true);
    expect(server.config.defaultAudience).toBe('snake-aud');
    expect(server.config.routes.openIdConfiguration).toBe('/custom/openid');
    expect(server.config.routes.token).toBe('/oauth/token');
    expect(server.config.clients[0]).toEqual(
      expect.objectContaining({ id: 'snake-client', secret: 'secret' })
    );
    expect(server.config.clients[0]?.scopes).toEqual(['read', 'write']);

    const initialConfig = server.app.initialConfig as any;
    expect(initialConfig.disableRequestLogging).toBe(false);
    expect(initialConfig.bodyLimit).toBe(2_048);
    const routerOptions = initialConfig.router ?? initialConfig.routerOptions ?? {};
    expect(routerOptions.caseSensitive ?? initialConfig.caseSensitive).toBe(true);
    expect(routerOptions.maxParamLength ?? initialConfig.maxParamLength).toBe(64);
  });

  it('serves health endpoint with uptime data', async () => {
    const configWithNoClientScopes = {
      ...TEST_BASE_CONFIG,
      clients: [
        {
          clientId: 'client-empty',
          clientSecret: 'super-secret',
          scopes: [],
        },
      ],
    };

    server = createFameFastifyServer({ config: configWithNoClientScopes });
    expect(server.config.clients[0]?.scopes).toEqual([]);
    await registerDefaultFameServerRoutes(server, dependencies);

    const response = await server.app.inject({
      method: 'GET',
      url: '/api/healthz',
    });

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
    currentCryptoProvider = cryptoProvider;

    server = createFameFastifyServer({ config: TEST_BASE_CONFIG });
    await registerDefaultFameServerRoutes(server, dependencies);

    const response = await server.app.inject({
      method: 'GET',
      url: '/api/.well-known/jwks.json',
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(Array.isArray(payload.keys)).toBe(true);
    expect(payload.keys[0]).toHaveProperty('kid', 'sig-key');
  });

  it('returns 503 when JWKS are unavailable', async () => {
    currentCryptoProvider = { getJwks: () => ({ keys: [] }) } as CryptoProvider;

    server = createFameFastifyServer({ config: TEST_BASE_CONFIG });
    await registerDefaultFameServerRoutes(server, dependencies);

    const response = await server.app.inject({
      method: 'GET',
      url: '/api/.well-known/jwks.json',
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe('jwks_unavailable');
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
      getJwks: () => ({
        keys: [
          { kid: 'sig', use: 'sig', kty: 'OKP', crv: 'Ed25519', x: 'abcd' },
        ],
      }),
      issuer: 'https://issuer.test',
    } as CryptoProvider;
    currentCryptoProvider = cryptoProvider;

    server = createFameFastifyServer({ config: TEST_BASE_CONFIG });
    await registerDefaultFameServerRoutes(server, dependencies);

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

  it('serves metrics endpoint with placeholder content', async () => {
    server = createFameFastifyServer({ config: TEST_BASE_CONFIG });
    await registerDefaultFameServerRoutes(server, dependencies);

    const response = await server.app.inject({
      method: 'GET',
      url: '/api/metrics',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.payload).toContain('metrics_not_implemented');
  });

  it('rejects token requests with unauthorized scopes', async () => {
    const tokenIssuer: TokenIssuer = {
      issuer: 'https://issuer.test',
      issue: jest.fn(),
    };

    const cryptoProvider: CryptoProvider = {
      getTokenIssuer: () => tokenIssuer,
    } as CryptoProvider;
    currentCryptoProvider = cryptoProvider;

    server = createFameFastifyServer({ config: TEST_BASE_CONFIG });
    await registerDefaultFameServerRoutes(server, dependencies);

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

  it('rejects unsupported grant types', async () => {
    server = createFameFastifyServer({ config: TEST_BASE_CONFIG });
    await registerDefaultFameServerRoutes(server, dependencies);

    const payload = new URLSearchParams({
      grant_type: 'password',
    });

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/oauth/token',
      payload: payload.toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('unsupported_grant_type');
  });

  it('requires client credentials when missing', async () => {
    server = createFameFastifyServer({ config: TEST_BASE_CONFIG });
    await registerDefaultFameServerRoutes(server, dependencies);

    const payload = new URLSearchParams({ grant_type: 'client_credentials' });

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/oauth/token',
      payload: payload.toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('invalid_client');
  });

  it('rejects requests for unknown clients', async () => {
    currentCryptoProvider = {
      getTokenIssuer: () => ({ issuer: 'https://issuer', issue: jest.fn() }),
    } as CryptoProvider;

    server = createFameFastifyServer({ config: TEST_BASE_CONFIG });
    await registerDefaultFameServerRoutes(server, dependencies);

    const payload = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'unknown',
      client_secret: 'secret',
    });

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/oauth/token',
      payload: payload.toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects requests with invalid client secret', async () => {
    currentCryptoProvider = {
      getTokenIssuer: () => ({ issuer: 'https://issuer', issue: jest.fn() }),
    } as CryptoProvider;

    server = createFameFastifyServer({ config: TEST_BASE_CONFIG });
    await registerDefaultFameServerRoutes(server, dependencies);

    const payload = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'client-one',
      client_secret: 'wrong',
    });

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/oauth/token',
      payload: payload.toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns server error when token issuer missing', async () => {
    currentCryptoProvider = { getJwks: () => ({ keys: [] }) } as CryptoProvider;

    server = createFameFastifyServer({ config: TEST_BASE_CONFIG });
    await registerDefaultFameServerRoutes(server, dependencies);

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

  it('returns server error when token issuance fails', async () => {
    const tokenIssuer: TokenIssuer = {
      issuer: 'https://issuer.test',
      issue: jest.fn(() => {
        throw new Error('boom');
      }),
    };

    currentCryptoProvider = {
      getTokenIssuer: () => tokenIssuer,
    } as CryptoProvider;

    server = createFameFastifyServer({ config: TEST_BASE_CONFIG });
    await registerDefaultFameServerRoutes(server, dependencies);

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
    expect(response.json().error).toBe('server_error');
    expect(tokenIssuer.issue).toHaveBeenCalled();
  });

  it('provides OpenID configuration defaults', async () => {
    const tokenIssuer: TokenIssuer = {
      issuer: 'https://issuer.test',
      issue: jest.fn(),
    };
    const cryptoProvider: CryptoProvider = {
      getTokenIssuer: () => tokenIssuer,
      getJwks: () => ({
        keys: [
          { kid: 'sig', use: 'sig', kty: 'OKP', crv: 'Ed25519', x: 'abcd' },
        ],
      }),
      issuer: 'https://issuer.test',
    } as CryptoProvider;
    currentCryptoProvider = cryptoProvider;

    server = createFameFastifyServer({ config: TEST_BASE_CONFIG });
    await registerDefaultFameServerRoutes(server, dependencies);

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

  it('omits scope in token response when none requested', async () => {
    const token = createUnsignedJwt({
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const tokenIssuer: TokenIssuer = {
      issuer: 'https://issuer.test',
      issue: jest.fn().mockResolvedValue(token),
    };
    const issueMock = tokenIssuer.issue as jest.Mock;

    currentCryptoProvider = {
      getTokenIssuer: () => tokenIssuer,
    } as CryptoProvider;

    const configWithNoClientScopes = {
      ...TEST_BASE_CONFIG,
      clients: [
        {
          clientId: 'client-empty',
          clientSecret: 'super-secret',
          scopes: [],
        },
      ],
    };

    server = createFameFastifyServer({ config: configWithNoClientScopes });
    expect(server.config.clients[0]?.scopes).toEqual([]);
    await registerDefaultFameServerRoutes(server, dependencies);

    const payload = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'client-empty',
      client_secret: 'super-secret',
    });

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/oauth/token',
      payload: payload.toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(issueMock).toHaveBeenCalled();
    expect(issueMock.mock.calls[0]?.[0].scope).toBeUndefined();
    expect(body.scope).toBeUndefined();
  });

  it('accepts client credentials via Basic auth header', async () => {
    const token = createUnsignedJwt({
      exp: Math.floor(Date.now() / 1000) + 90,
    });
    const tokenIssuer: TokenIssuer = {
      issuer: 'https://issuer.test',
      issue: jest.fn().mockResolvedValue(token),
    };

    currentCryptoProvider = {
      getTokenIssuer: () => tokenIssuer,
    } as CryptoProvider;

    server = createFameFastifyServer({ config: TEST_BASE_CONFIG });
    await registerDefaultFameServerRoutes(server, dependencies);

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/oauth/token',
      payload: new URLSearchParams({
        grant_type: 'client_credentials',
      }).toString(),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from('client-one:super-secret').toString('base64')}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(tokenIssuer.issue).toHaveBeenCalled();
  });
});
