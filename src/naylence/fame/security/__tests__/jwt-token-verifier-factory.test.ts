import { JWTTokenIssuer } from '../auth/jwt-token-issuer.js';
import { JWTTokenVerifier } from '../auth/jwt-token-verifier.js';
import { JWTTokenVerifierFactory } from '../auth/jwt-token-verifier-factory.js';
import { TokenVerifierFactory } from '../auth/token-verifier-factory.js';

describe('JWTTokenVerifierFactory', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-02T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('creates HMAC verifier via registry helper', async () => {
    const verifier = await TokenVerifierFactory.createTokenVerifier({
      type: 'JWTTokenVerifier',
      issuer: 'factory-issuer',
      hmacSecret: 'factory-secret',
    });

    expect(verifier).toBeInstanceOf(JWTTokenVerifier);

    const issuer = new JWTTokenIssuer({
      signingKeyPem: 'factory-secret',
      kid: 'factory-kid',
      issuer: 'factory-issuer',
      algorithm: 'HS256',
    });

    const token = await issuer.issue({ sub: 'factory-user' });
    const context = await verifier.verify(token);

    expect(context.principal).toBe('factory-user');
  });

  it('resolves secrets from environment variables', async () => {
    const envVar = 'JWT_FACTORY_SECRET';
    const previous = process.env[envVar];
    process.env[envVar] = 'env-factory-secret';

    try {
      const factory = new JWTTokenVerifierFactory();
      const verifier = await factory.create({
        type: 'JWTTokenVerifier',
        issuer: 'env-issuer',
        hmacSecret: `env://${envVar}`,
        algorithms: ['HS256'],
      });

      const issuer = new JWTTokenIssuer({
        signingKeyPem: 'env-factory-secret',
        kid: 'env-kid',
        issuer: 'env-issuer',
        algorithm: 'HS256',
      });

      const token = await issuer.issue({});
      const context = await verifier.verify(token);
      expect(context.authenticated).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env[envVar];
      } else {
        process.env[envVar] = previous;
      }
    }
  });

  it('applies custom algorithms when provided', async () => {
    const issuer = new JWTTokenIssuer({
      signingKeyPem: 'hs512-secret',
      kid: 'hs512-kid',
      issuer: 'hs512-issuer',
      algorithm: 'HS512',
    });

    const token = await issuer.issue({});

    const verifier = await TokenVerifierFactory.createTokenVerifier({
      type: 'JWTTokenVerifier',
      issuer: 'hs512-issuer',
      hmacSecret: 'hs512-secret',
      algorithms: ['HS512'],
    });

    await expect(verifier.verify(token)).resolves.toBeTruthy();
  });

  it('throws when verification material is missing', async () => {
    const factory = new JWTTokenVerifierFactory();

    await expect(
      factory.create({
        type: 'JWTTokenVerifier',
        issuer: 'missing-key-issuer',
      })
    ).rejects.toThrow('verification key');
  });
});
