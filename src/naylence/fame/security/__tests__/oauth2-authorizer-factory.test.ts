import { OAuth2AuthorizerFactory, type OAuth2AuthorizerConfig } from '../auth/oauth2-authorizer-factory.js';
import { OAuth2Authorizer } from '../auth/oauth2-authorizer.js';
import { TokenVerifierFactory } from '../auth/token-verifier-factory.js';
import type { TokenVerifier } from '../auth/token-verifier.js';
import { TokenIssuerFactory } from '../auth/token-issuer-factory.js';

import '../auth/jwt-token-verifier-factory.js';
import '../auth/jwt-token-issuer-factory.js';
import '../auth/jwks-jwt-token-verifier-factory.js';

const HMAC_SECRET = 'oauth2-secret';

describe('OAuth2AuthorizerFactory', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('creates an authorizer using provided verifier and issuer configurations', async () => {
    const factory = new OAuth2AuthorizerFactory();

    const config: OAuth2AuthorizerConfig = {
      type: 'OAuth2Authorizer',
      issuer: 'https://issuer.example',
      audience: '/nodes/node-1',
      requiredScopes: ['fame:connect'],
      tokenVerifierConfig: {
        type: 'JWTTokenVerifier',
        issuer: 'https://issuer.example',
        hmacSecret: HMAC_SECRET,
        algorithms: ['HS256'],
      },
      tokenIssuerConfig: {
        type: 'JWTTokenIssuer',
        issuer: 'https://issuer.example',
        algorithm: 'HS256',
        hmacSecret: HMAC_SECRET,
        kid: 'oauth2-kid',
      },
    };

    const authorizer = await factory.create(config);
    expect(authorizer).toBeInstanceOf(OAuth2Authorizer);
    expect((authorizer as OAuth2Authorizer).tokenVerifier).toBeDefined();
  });

  it('derives JWKS verifier configuration when not provided', async () => {
    const factory = new OAuth2AuthorizerFactory();

    const mockVerifier: TokenVerifier = {
      verify: jest.fn(),
    };

    const verifierSpy = jest
      .spyOn(TokenVerifierFactory, 'createTokenVerifier')
      .mockResolvedValue(mockVerifier);

    const issuerSpy = jest.spyOn(TokenIssuerFactory, 'createTokenIssuer').mockResolvedValue(undefined as any);

    const config: OAuth2AuthorizerConfig = {
      type: 'OAuth2Authorizer',
      issuer: 'https://issuer.example',
    };

    const authorizer = await factory.create(config);
    expect(authorizer).toBeInstanceOf(OAuth2Authorizer);

    expect(verifierSpy).toHaveBeenCalledTimes(1);
    const passedConfig = verifierSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(passedConfig).toMatchObject({
      type: 'JWKSJWTTokenVerifier',
      issuer: 'https://issuer.example',
      jwksUrl: 'https://issuer.example/.well-known/jwks.json',
    });

    expect(issuerSpy).not.toHaveBeenCalled();
  });
});
