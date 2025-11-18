import fastify, { type FastifyInstance } from 'fastify';
import request from 'supertest';
import { createHash } from 'node:crypto';
import type { CryptoProvider } from '../../security/crypto/providers/crypto-provider.js';
import {
  createOAuth2TokenRouter,
  type CreateOAuth2TokenRouterOptions,
} from '../oauth2-token-router.js';

jest.mock('../../security/auth/jwt-token-issuer.js', () => {
  const issueMock = jest.fn();
  const ctorMock = jest.fn().mockImplementation(() => ({ issue: issueMock }));
  return {
    __esModule: true,
    JWTTokenIssuer: ctorMock,
    __mocks: { issueMock, ctorMock },
  };
});

const {
  __mocks: { issueMock, ctorMock: jwtTokenIssuerCtorMock },
} = jest.requireMock('../../security/auth/jwt-token-issuer.js') as {
  __mocks: {
    issueMock: jest.Mock<Promise<string>, [Record<string, unknown>]>;
    ctorMock: jest.Mock;
  };
};

const TEST_PROVIDER: CryptoProvider = {
  signingPrivatePem: 'test-private-key',
  signatureKeyId: 'test-kid',
};

function base64Url(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '');
}

function computeS256Challenge(verifier: string): string {
  const digest = createHash('sha256').update(verifier, 'utf8').digest();
  return base64Url(digest);
}

async function createApp(
  extraOptions?: Partial<CreateOAuth2TokenRouterOptions>
): Promise<FastifyInstance> {
  const app = fastify();
  await app.register(
    createOAuth2TokenRouter({
      cryptoProvider: TEST_PROVIDER,
      ...(extraOptions ?? {}),
    })
  );
  await app.ready();
  return app;
}

async function withApp(
  handler: (app: FastifyInstance, client: request.SuperTest<request.Test>) => Promise<void>,
  extraOptions?: Partial<CreateOAuth2TokenRouterOptions>
): Promise<void> {
  const app = await createApp(extraOptions);
  const client = request(app.server);
  try {
    await handler(app, client);
  } finally {
    await app.close();
  }
}

function setRequiredEnv(): void {
  process.env.FAME_JWT_CLIENT_ID = 'test-client';
  process.env.FAME_JWT_CLIENT_SECRET = 'test-secret';
  process.env.FAME_JWT_ALLOWED_SCOPES = 'node.connect telemetry.read';
}

describe('createOAuth2TokenRouter', () => {
  beforeEach(() => {
    setRequiredEnv();
    issueMock.mockReset().mockResolvedValue('mocked.jwt.token');
    jwtTokenIssuerCtorMock.mockClear();
  });

  afterEach(() => {
    delete process.env.FAME_JWT_CLIENT_ID;
    delete process.env.FAME_JWT_CLIENT_SECRET;
    delete process.env.FAME_JWT_ALLOWED_SCOPES;
    delete process.env.FAME_OAUTH_ALLOW_PUBLIC_CLIENTS;
    delete process.env.FAME_OAUTH_ENABLE_DEV_LOGIN;
    delete process.env.FAME_OAUTH_DEV_USERNAME;
    delete process.env.FAME_OAUTH_DEV_PASSWORD;
    delete process.env.FAME_OAUTH_SESSION_TTL_SEC;
    delete process.env.FAME_OAUTH_SESSION_COOKIE_NAME;
    delete process.env.FAME_OAUTH_SESSION_SECURE;
    delete process.env.FAME_OAUTH_LOGIN_TITLE;
  });

  it('issues tokens for authorization code with PKCE and prevents reuse', async () => {
    await withApp(async (_app, client) => {
      const codeVerifier =
        'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
      const codeChallenge = computeS256Challenge(codeVerifier);

      const authorizeResponse = await client
        .get('/oauth/authorize')
        .query({
          response_type: 'code',
          client_id: 'test-client',
          redirect_uri: 'http://localhost/callback',
          scope: 'node.connect',
          state: 'xyz',
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
        })
        .expect(302);

      const location = authorizeResponse.headers.location as string;
      expect(location).toContain('code=');
      const redirected = new URL(location);
      expect(redirected.searchParams.get('state')).toBe('xyz');
      const code = redirected.searchParams.get('code');
      expect(code).toBeTruthy();

      const tokenResponse = await client
        .post('/oauth/token')
        .type('form')
        .send({
          grant_type: 'authorization_code',
          client_id: 'test-client',
          code: code!,
          redirect_uri: 'http://localhost/callback',
          code_verifier: codeVerifier,
        })
        .expect(200);

      expect(tokenResponse.body).toMatchObject({
        access_token: 'mocked.jwt.token',
        token_type: 'Bearer',
        scope: 'node.connect',
      });
      expect(issueMock).toHaveBeenCalledTimes(1);

      issueMock.mockClear();

      const reuseResponse = await client
        .post('/oauth/token')
        .type('form')
        .send({
          grant_type: 'authorization_code',
          client_id: 'test-client',
          code: code!,
          redirect_uri: 'http://localhost/callback',
          code_verifier: codeVerifier,
        })
        .expect(400);

      expect(reuseResponse.body.error).toBe('invalid_grant');
      expect(issueMock).not.toHaveBeenCalled();
    });
  });

  it('rejects authorization code exchange with invalid PKCE verifier', async () => {
    await withApp(async (_app, client) => {
      const verifier =
        'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
      const challenge = computeS256Challenge(verifier);

      const authorizeResponse = await client
        .get('/oauth/authorize')
        .query({
          response_type: 'code',
          client_id: 'test-client',
          redirect_uri: 'http://localhost/callback',
          scope: 'node.connect',
          code_challenge: challenge,
          code_challenge_method: 'S256',
        })
        .expect(302);

      const code = new URL(authorizeResponse.headers.location as string).searchParams.get(
        'code'
      );
      expect(code).toBeTruthy();

      const response = await client
        .post('/oauth/token')
        .type('form')
        .send({
          grant_type: 'authorization_code',
          client_id: 'test-client',
          code: code!,
          redirect_uri: 'http://localhost/callback',
          code_verifier: `${verifier}invalid`,
        })
        .expect(400);

      expect(response.body.error).toBe('invalid_grant');
      expect(issueMock).not.toHaveBeenCalled();
    });
  });

  it('rejects PKCE token exchange when public clients are disabled', async () => {
    process.env.FAME_OAUTH_ALLOW_PUBLIC_CLIENTS = 'false';
    await withApp(async (_app, client) => {
      const verifier =
        'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
      const challenge = computeS256Challenge(verifier);

      const authorizeResponse = await client
        .get('/oauth/authorize')
        .query({
          response_type: 'code',
          client_id: 'test-client',
          redirect_uri: 'http://localhost/callback',
          scope: 'node.connect',
          code_challenge: challenge,
          code_challenge_method: 'S256',
        })
        .expect(302);

      const code = new URL(authorizeResponse.headers.location as string).searchParams.get(
        'code'
      );
      expect(code).toBeTruthy();

      const response = await client
        .post('/oauth/token')
        .type('form')
        .send({
          grant_type: 'authorization_code',
          client_id: 'test-client',
          code: code!,
          redirect_uri: 'http://localhost/callback',
          code_verifier: verifier,
        })
        .expect(401);

      expect(response.body.error).toBe('invalid_client');
      expect(issueMock).not.toHaveBeenCalled();
    });
  });

  it('issues tokens for client credentials grant', async () => {
    await withApp(async (_app, client) => {
      const response = await client
        .post('/oauth/token')
        .set(
          'Authorization',
          `Basic ${Buffer.from('test-client:test-secret').toString('base64')}`
        )
        .type('form')
        .send({
          grant_type: 'client_credentials',
          scope: 'node.connect telemetry.read',
        })
        .expect(200);

      expect(response.body).toMatchObject({
        access_token: 'mocked.jwt.token',
        token_type: 'Bearer',
      });
      expect(issueMock).toHaveBeenCalledTimes(1);
      expect(jwtTokenIssuerCtorMock).toHaveBeenCalled();
    });
  });

  it('requires developer login before issuing authorization codes when enabled', async () => {
    await withApp(
      async (app) => {
        const agent = request.agent(app.server);
        const authorizeQuery = {
          response_type: 'code',
          client_id: 'test-client',
          redirect_uri: 'http://localhost/callback',
          scope: 'node.connect',
          state: 'login-test',
          code_challenge_method: 'S256',
        } as const;

        const verifier =
          'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
        const challenge = computeS256Challenge(verifier);
        const authorizeParams = new URLSearchParams({
          ...authorizeQuery,
          code_challenge: challenge,
        });
        const authorizePath = `/oauth/authorize?${authorizeParams.toString()}`;

        const initialResponse = await agent
          .get('/oauth/authorize')
          .query({
            ...authorizeQuery,
            code_challenge: challenge,
          })
          .expect(302);

        const loginLocation = initialResponse.headers.location as string;
        expect(loginLocation).toMatch(/^\/oauth\/login\?return_to=/);

        const loginPage = await agent.get(loginLocation).expect(200);
        expect(loginPage.text).toContain('Developer Login');

        const failedLogin = await agent
          .post('/oauth/login')
          .type('form')
          .send({
            username: 'devuser',
            password: 'wrong',
            return_to: authorizePath,
          })
          .expect(401);
        expect(failedLogin.text).toContain('Invalid username or password');

        const loginResponse = await agent
          .post('/oauth/login')
          .type('form')
          .send({
            username: 'devuser',
            password: 'devpass',
            return_to: authorizePath,
          })
          .expect(302);

        expect(loginResponse.headers['set-cookie']).toBeDefined();
        const postLoginLocation = loginResponse.headers.location as string;
        expect(postLoginLocation).toContain('/oauth/authorize');

        const authorizeAfterLogin = await agent
          .get(postLoginLocation)
          .expect(302);

        const finalRedirect = authorizeAfterLogin.headers.location as string;
        const redirected = new URL(finalRedirect);
        const code = redirected.searchParams.get('code');
        expect(code).toBeTruthy();

        const tokenResponse = await agent
          .post('/oauth/token')
          .type('form')
          .send({
            grant_type: 'authorization_code',
            client_id: 'test-client',
            code: code!,
            redirect_uri: 'http://localhost/callback',
            code_verifier: verifier,
          })
          .expect(200);

        expect(tokenResponse.body.access_token).toBe('mocked.jwt.token');
      },
      {
        enableDevLogin: true,
        devLoginUsername: 'devuser',
        devLoginPassword: 'devpass',
        devLoginSessionTtlSec: 600,
      }
    );
  });
});
