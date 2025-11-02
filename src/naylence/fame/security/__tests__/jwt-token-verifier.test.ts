import { JWTTokenIssuer } from '../auth/jwt-token-issuer.js';
import { JWTTokenVerifier } from '../auth/jwt-token-verifier.js';

const HMAC_SECRET = 'verifier-secret';

describe('JWTTokenVerifier', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('verifies HMAC signed tokens and returns authorization context', async () => {
    const issuer = new JWTTokenIssuer({
      signingKeyPem: HMAC_SECRET,
      kid: 'test-kid',
      issuer: 'test-issuer',
      algorithm: 'HS256',
      ttlSec: 300,
    });

    const token = await issuer.issue({
      sub: 'user-123',
      scope: 'one two',
      jti: 'token-123',
    });

    const verifier = new JWTTokenVerifier({
      verificationKey: HMAC_SECRET,
      issuer: 'test-issuer',
      ttlSec: 300,
    });

    const context = await verifier.verify(token);

    expect(context.authenticated).toBe(true);
    expect(context.authorized).toBe(true);
    expect(context.principal).toBe('user-123');
    expect(context.grantedScopes).toEqual(
      expect.arrayContaining(['one', 'two'])
    );
    expect(context.claims.iss).toBe('test-issuer');
    expect(context.claims.jti).toBe('token-123');
  });

  it('tracks revoked tokens', async () => {
    const issuer = new JWTTokenIssuer({
      signingKeyPem: HMAC_SECRET,
      kid: 'revocation-kid',
      issuer: 'revocation-issuer',
      algorithm: 'HS256',
      ttlSec: 300,
    });

    const token = await issuer.issue({ jti: 'revoked-token' });

    const verifier = new JWTTokenVerifier({
      verificationKey: HMAC_SECRET,
      issuer: 'revocation-issuer',
      ttlSec: 300,
      revokedCapacity: 10,
    });

    verifier.revoke('revoked-token');

    await expect(verifier.verify(token)).rejects.toThrow(
      'Token has been revoked'
    );
  });

  it('enforces required scopes', async () => {
    const issuer = new JWTTokenIssuer({
      signingKeyPem: HMAC_SECRET,
      kid: 'scope-kid',
      issuer: 'scope-issuer',
      algorithm: 'HS256',
    });

    const token = await issuer.issue({ scope: 'profile:read' });

    const verifier = new JWTTokenVerifier({
      verificationKey: HMAC_SECRET,
      issuer: 'scope-issuer',
      requiredScopes: ['profile:write'],
    });

    await expect(verifier.verify(token)).rejects.toThrow(
      'Token missing required scope'
    );
  });

  it('rejects expired tokens based on TTL', async () => {
    const issuer = new JWTTokenIssuer({
      signingKeyPem: HMAC_SECRET,
      kid: 'ttl-kid',
      issuer: 'ttl-issuer',
      algorithm: 'HS256',
      ttlSec: 60,
    });

    const token = await issuer.issue({});

    const verifier = new JWTTokenVerifier({
      verificationKey: HMAC_SECRET,
      issuer: 'ttl-issuer',
      ttlSec: 60,
    });

    jest.advanceTimersByTime(61_000);

    await expect(verifier.verify(token)).rejects.toThrow('Token has expired');
  });

  it('validates audience when provided', async () => {
    const issuer = new JWTTokenIssuer({
      signingKeyPem: HMAC_SECRET,
      kid: 'aud-kid',
      issuer: 'aud-issuer',
      algorithm: 'HS256',
      ttlSec: 300,
    });

    const token = await issuer.issue({ aud: 'expected-audience' });

    const verifier = new JWTTokenVerifier({
      verificationKey: HMAC_SECRET,
      issuer: 'aud-issuer',
      ttlSec: 300,
    });

    await expect(
      verifier.verify(token, { expectedAudience: 'wrong-audience' })
    ).rejects.toThrow('Invalid audience');

    const context = await verifier.verify(token, {
      expectedAudience: 'expected-audience',
    });
    expect(context.claims.aud).toBe('expected-audience');
  });

  it('supports snake_case constructor options', async () => {
    const issuer = new JWTTokenIssuer({
      signingKeyPem: HMAC_SECRET,
      kid: 'snake-kid',
      issuer: 'snake-issuer',
      algorithm: 'HS256',
      ttlSec: 120,
    });

    const token = await issuer.issue({
      scope: 'profile:read profile:write',
      jti: 'snake-token',
    });

    const verifier = new JWTTokenVerifier({
      verification_key: HMAC_SECRET,
      issuer: 'snake-issuer',
      ttl_sec: 120,
      required_scopes: ['profile:read'],
      revoked_capacity: 5,
    });

    const context = await verifier.verify(token);
    expect(context.authenticated).toBe(true);
    expect(context.grantedScopes).toEqual(
      expect.arrayContaining(['profile:read'])
    );

    verifier.revoke('different-token');
    jest.advanceTimersByTime(121_000);
    await expect(verifier.verify(token)).rejects.toThrow('Token has expired');
  });
});
