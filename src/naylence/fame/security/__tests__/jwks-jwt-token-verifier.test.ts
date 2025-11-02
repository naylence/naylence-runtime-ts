import { JWKSJWTTokenVerifier } from '../auth/jwks-jwt-token-verifier.js';
import { requireJose } from '../auth/jose-loader.js';

const createRemoteJWKSetMock = jest.fn();
const jwtVerifyMock = jest.fn();

jest.mock('../auth/jose-loader.js', () => ({
  __esModule: true,
  requireJose: jest.fn(async () => ({
    createRemoteJWKSet: createRemoteJWKSetMock,
    jwtVerify: jwtVerifyMock,
  })),
}));

describe('JWKSJWTTokenVerifier', () => {
  beforeEach(() => {
    createRemoteJWKSetMock.mockReset();
    jwtVerifyMock.mockReset();
    (requireJose as unknown as jest.Mock).mockClear();
  });

  it('requires an issuer', () => {
    expect(
      () =>
        new JWKSJWTTokenVerifier({
          issuer: undefined,
          jwksUrl: 'https://example.com/keys',
        })
    ).toThrow('JWKSJWTTokenVerifier requires an issuer');
  });

  it('requires a JWKS URL', () => {
    expect(
      () =>
        new JWKSJWTTokenVerifier({
          issuer: 'issuer-1',
          jwksUrl: undefined,
        })
    ).toThrow('JWKSJWTTokenVerifier requires a JWKS URL');
  });

  it('validates JWKS URL format', () => {
    expect(
      () =>
        new JWKSJWTTokenVerifier({
          issuer: 'issuer-2',
          jwksUrl: 'not-a-url',
        })
    ).toThrow('Invalid JWKS URL: not-a-url');
  });

  it('verifies tokens, builds authorization context, and caches JWKS set', async () => {
    const remoteSet = jest.fn();
    createRemoteJWKSetMock.mockReturnValue(remoteSet);
    jwtVerifyMock.mockResolvedValueOnce({
      payload: { sub: 'user-123', scope: 'read write', jti: 'token-1' },
      protectedHeader: { kid: 'kid-123' },
    });
    jwtVerifyMock.mockResolvedValueOnce({
      payload: { sub: 'user-456', scope: ['admin'] },
      protectedHeader: {},
    });

    const verifier = new JWKSJWTTokenVerifier({
      issuer: 'issuer-3',
      jwksUrl: 'https://example.com/keys',
      cacheTtlSec: 0.1,
    });

    const context = await verifier.verify('token-value');

    expect(context.principal).toBe('user-123');
    expect(context.grantedScopes).toEqual(
      expect.arrayContaining(['read', 'write'])
    );
    expect(context.claims.kid).toBe('kid-123');

    expect(createRemoteJWKSetMock).toHaveBeenCalledTimes(1);
    expect(createRemoteJWKSetMock).toHaveBeenCalledWith(
      new URL('https://example.com/keys'),
      {
        cacheMaxAge: 1_000,
        cooldownDuration: 500,
      }
    );
    expect(jwtVerifyMock).toHaveBeenCalledWith(
      'token-value',
      remoteSet,
      expect.objectContaining({
        issuer: 'issuer-3',
        algorithms: ['RS256', 'ES256', 'EdDSA'],
      })
    );

    await verifier.verify('another-token');
    expect(createRemoteJWKSetMock).toHaveBeenCalledTimes(1);
  });

  it('passes expected audience and trimmed algorithms', async () => {
    const remoteSet = jest.fn();
    createRemoteJWKSetMock.mockReturnValue(remoteSet);
    jwtVerifyMock.mockResolvedValue({
      payload: { sub: 'aud-user' },
      protectedHeader: {},
    });

    const verifier = new JWKSJWTTokenVerifier({
      issuer: 'issuer-4',
      jwksUrl: 'https://example.org/jwks',
      algorithms: [' RS512 ', 'ES384'],
    });

    await verifier.verify('aud-token', { expectedAudience: 'expected-aud' });

    expect(jwtVerifyMock).toHaveBeenCalledWith(
      'aud-token',
      remoteSet,
      expect.objectContaining({
        algorithms: ['RS512', 'ES384'],
        audience: 'expected-aud',
      })
    );
  });

  it('maps JWT expiration errors', async () => {
    const remoteSet = jest.fn();
    createRemoteJWKSetMock.mockReturnValue(remoteSet);
    const expiredError = new Error('expired');
    expiredError.name = 'JWTExpired';
    jwtVerifyMock.mockRejectedValue(expiredError);

    const verifier = new JWKSJWTTokenVerifier({
      issuer: 'issuer-5',
      jwksUrl: 'https://example.com/jwks',
    });

    await expect(verifier.verify('expired-token')).rejects.toMatchObject({
      message: 'Token has expired',
      cause: expiredError,
    });
  });

  it('maps JWT audience claim errors', async () => {
    const remoteSet = jest.fn();
    createRemoteJWKSetMock.mockReturnValue(remoteSet);
    const error = new Error('audience mismatch');
    error.name = 'JWTClaimValidationFailed';
    (error as { claim?: string }).claim = 'aud';
    jwtVerifyMock.mockRejectedValue(error);

    const verifier = new JWKSJWTTokenVerifier({
      issuer: 'issuer-6',
      jwksUrl: 'https://example.com/jwks',
    });

    await expect(verifier.verify('aud-token')).rejects.toMatchObject({
      message: 'Invalid audience',
      cause: error,
    });
  });

  it('maps JWT issuer claim errors', async () => {
    const remoteSet = jest.fn();
    createRemoteJWKSetMock.mockReturnValue(remoteSet);
    const error = new Error('issuer mismatch');
    error.name = 'JWTClaimValidationFailed';
    (error as { claim?: string }).claim = 'iss';
    jwtVerifyMock.mockRejectedValue(error);

    const verifier = new JWKSJWTTokenVerifier({
      issuer: 'issuer-7',
      jwksUrl: 'https://example.com/jwks',
    });

    await expect(verifier.verify('iss-token')).rejects.toMatchObject({
      message: 'Invalid issuer',
      cause: error,
    });
  });

  it('maps JWT subject claim errors', async () => {
    const remoteSet = jest.fn();
    createRemoteJWKSetMock.mockReturnValue(remoteSet);
    const error = new Error('subject mismatch');
    error.name = 'JWTClaimValidationFailed';
    (error as { claim?: string }).claim = 'sub';
    jwtVerifyMock.mockRejectedValue(error);

    const verifier = new JWKSJWTTokenVerifier({
      issuer: 'issuer-8',
      jwksUrl: 'https://example.com/jwks',
    });

    await expect(verifier.verify('sub-token')).rejects.toMatchObject({
      message: 'Invalid subject',
      cause: error,
    });
  });

  it('supports snake_case constructor options', async () => {
    const remoteSet = jest.fn();
    createRemoteJWKSetMock.mockReturnValue(remoteSet);
    jwtVerifyMock.mockResolvedValue({
      payload: { sub: 'snake-user' },
      protectedHeader: {},
    });

    const verifier = new JWKSJWTTokenVerifier({
      issuer: 'issuer-12',
      jwks_url: 'https://example.com/jwks-snake',
      cache_ttl_sec: 2,
      algorithms: [' RS512 '],
    });

    await verifier.verify('snake-token');

    expect(createRemoteJWKSetMock).toHaveBeenCalledWith(
      new URL('https://example.com/jwks-snake'),
      expect.objectContaining({
        cacheMaxAge: 2_000,
        cooldownDuration: 1_000,
      })
    );
    expect(jwtVerifyMock).toHaveBeenCalledWith(
      'snake-token',
      remoteSet,
      expect.objectContaining({ algorithms: ['RS512'] })
    );
  });

  it('maps invalid token errors', async () => {
    const remoteSet = jest.fn();
    createRemoteJWKSetMock.mockReturnValue(remoteSet);
    const error = new Error('invalid token');
    (error as { code?: string }).code = 'ERR_JWT_INVALID';
    jwtVerifyMock.mockRejectedValue(error);

    const verifier = new JWKSJWTTokenVerifier({
      issuer: 'issuer-9',
      jwksUrl: 'https://example.com/jwks',
    });

    await expect(verifier.verify('invalid-token')).rejects.toMatchObject({
      message: 'Invalid token',
      cause: error,
    });
  });

  it('returns the original error when unrecognized error type is thrown', async () => {
    const remoteSet = jest.fn();
    createRemoteJWKSetMock.mockReturnValue(remoteSet);
    const error = new Error('network glitch');
    jwtVerifyMock.mockRejectedValue(error);

    const verifier = new JWKSJWTTokenVerifier({
      issuer: 'issuer-10',
      jwksUrl: 'https://example.com/jwks',
    });

    await expect(verifier.verify('original-error-token')).rejects.toBe(error);
  });

  it('wraps unknown non-error rejections', async () => {
    const remoteSet = jest.fn();
    createRemoteJWKSetMock.mockReturnValue(remoteSet);
    jwtVerifyMock.mockRejectedValue('unhandled');

    const verifier = new JWKSJWTTokenVerifier({
      issuer: 'issuer-11',
      jwksUrl: 'https://example.com/jwks',
    });

    await expect(verifier.verify('non-error-token')).rejects.toThrow(
      'Token verification failed'
    );
  });
});
