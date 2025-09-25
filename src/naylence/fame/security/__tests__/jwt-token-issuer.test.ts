import { JWTTokenIssuer } from '../auth/jwt-token-issuer.js';

const HS_SECRET = 'test-secret';
const BASE_OPTIONS = {
  signingKeyPem: HS_SECRET,
  kid: 'test-kid',
  issuer: 'test-issuer',
  algorithm: 'HS256',
  ttlSec: 120,
  audience: 'default-audience',
} as const;

describe('JWTTokenIssuer', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('issues tokens with base claims and default audience', async () => {
    const issuer = new JWTTokenIssuer({ ...BASE_OPTIONS });
    const expectedIssuedAt = Math.floor(Date.now() / 1000);

    const token = await issuer.issue({ sub: 'user-123', role: 'admin' });

    const jose = await import('jose');
    const verificationKey = new TextEncoder().encode(HS_SECRET);

    const { payload, protectedHeader } = await jose.jwtVerify(token, verificationKey, {
      issuer: BASE_OPTIONS.issuer,
      audience: BASE_OPTIONS.audience,
      algorithms: [BASE_OPTIONS.algorithm],
    });

    expect(issuer.issuer).toBe(BASE_OPTIONS.issuer);
    expect(protectedHeader).toMatchObject({
      alg: BASE_OPTIONS.algorithm,
      kid: BASE_OPTIONS.kid,
      typ: 'JWT',
    });

    expect(payload).toMatchObject({
      iss: BASE_OPTIONS.issuer,
      sub: 'user-123',
      role: 'admin',
      aud: BASE_OPTIONS.audience,
      iat: expectedIssuedAt,
      nbf: expectedIssuedAt,
    });
    expect(payload.exp).toBe(expectedIssuedAt + BASE_OPTIONS.ttlSec);
  });

  it('preserves caller supplied audience claims', async () => {
    const issuer = new JWTTokenIssuer({ ...BASE_OPTIONS });
    const token = await issuer.issue({ aud: 'custom-audience', scope: 'read:all' });

    const jose = await import('jose');
    const verificationKey = new TextEncoder().encode(HS_SECRET);

    const { payload } = await jose.jwtVerify(token, verificationKey, {
      issuer: BASE_OPTIONS.issuer,
      audience: 'custom-audience',
      algorithms: [BASE_OPTIONS.algorithm],
    });

    expect(payload.aud).toBe('custom-audience');
    expect(payload.scope).toBe('read:all');
  });

  it('rejects unsupported signing algorithms', async () => {
    const issuer = new JWTTokenIssuer({
      ...BASE_OPTIONS,
      algorithm: 'unsupported',
    });

    await expect(issuer.issue({})).rejects.toThrow('Unsupported JWT algorithm: unsupported');
  });
});
