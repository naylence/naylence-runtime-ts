import {
  OAuth2AuthorizerFactory,
  type OAuth2AuthorizerConfig,
} from '../auth/oauth2-authorizer-factory.js';
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

    const issuerSpy = jest
      .spyOn(TokenIssuerFactory, 'createTokenIssuer')
      .mockResolvedValue(undefined as any);

    const config: OAuth2AuthorizerConfig = {
      type: 'OAuth2Authorizer',
      issuer: 'https://issuer.example',
    };

    const authorizer = await factory.create(config);
    expect(authorizer).toBeInstanceOf(OAuth2Authorizer);

    expect(verifierSpy).toHaveBeenCalledTimes(1);
    const passedConfig = verifierSpy.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(passedConfig).toMatchObject({
      type: 'JWKSJWTTokenVerifier',
      issuer: 'https://issuer.example',
      jwksUrl: 'https://issuer.example/.well-known/jwks.json',
    });

    expect(issuerSpy).not.toHaveBeenCalled();
  });

  it('accepts snake_case configuration fields', async () => {
    const factory = new OAuth2AuthorizerFactory();

    const verify = jest.fn().mockResolvedValue({
      authenticated: true,
      authorized: true,
      principal: 'user',
      claims: {},
      grantedScopes: [],
      restrictions: {},
    });
    const mockVerifier: TokenVerifier = { verify };
    const verifierSpy = jest
      .spyOn(TokenVerifierFactory, 'createTokenVerifier')
      .mockResolvedValue(mockVerifier);

    const issue = jest.fn().mockResolvedValue('reverse-token');
    const mockIssuer = {
      issue,
      issuer: 'https://issuer.example',
    } as any;
    const issuerSpy = jest
      .spyOn(TokenIssuerFactory, 'createTokenIssuer')
      .mockResolvedValue(mockIssuer);

    const now = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);

    const config = {
      type: 'OAuth2Authorizer',
      issuer: 'https://issuer.example',
      aud: '/nodes/node-2',
      required_scopes: [' scope:a '],
      require_scope: false,
      default_ttl_sec: 123,
      max_ttl_sec: 456,
      reverse_auth_ttl_sec: 42,
      token_verifier_config: {
        type: 'JWTTokenVerifier',
        issuer: 'https://issuer.example',
        hmac_secret: HMAC_SECRET,
        algorithms: ['HS256'],
      },
      token_issuer_config: {
        type: 'JWTTokenIssuer',
        issuer: 'https://issuer.example',
        algorithm: 'HS256',
        hmac_secret: HMAC_SECRET,
        kid: 'oauth2-kid',
      },
    } as const;

    const authorizer = (await factory.create(config)) as OAuth2Authorizer;

    expect(verifierSpy).toHaveBeenCalledWith(config.token_verifier_config);
    expect(issuerSpy).toHaveBeenCalledWith(config.token_issuer_config);
    expect(authorizer).toBeInstanceOf(OAuth2Authorizer);

    const node = {
      id: 'node-2',
      physicalPath: '/nodes/physical-path',
    } as any;

    await authorizer.onNodeStarted(node);
    await authorizer.authenticate('Bearer forward-token');

    expect(verify).toHaveBeenCalledWith('forward-token', {
      expectedAudience: '/nodes/node-2',
    });

    const reverseConfig =
      await authorizer.createReverseAuthorizationConfig(node);
    expect(reverseConfig).toBeDefined();
    expect(issue).toHaveBeenCalledWith(
      expect.objectContaining({
        exp: Math.floor((now + 42_000) / 1000),
        aud: '/nodes/node-2',
      })
    );

    nowSpy.mockRestore();
  });

  it('passes enforceTokenSubjectNodeIdentity via factory config', async () => {
    const factory = new OAuth2AuthorizerFactory();

    const config: OAuth2AuthorizerConfig = {
      type: 'OAuth2Authorizer',
      issuer: 'https://issuer.example',
      enforceTokenSubjectNodeIdentity: true,
      tokenVerifierConfig: {
        type: 'JWTTokenVerifier',
        issuer: 'https://issuer.example',
        hmacSecret: HMAC_SECRET,
        algorithms: ['HS256'],
      },
    };

    const authorizer = (await factory.create(config)) as OAuth2Authorizer;
    expect(authorizer).toBeInstanceOf(OAuth2Authorizer);

    // Verify enforcement is enabled by testing that it rejects attach without proper prefix
    const { DeliveryOriginType } = await import('@naylence/core');

    const frame = {
      type: 'NodeAttach',
      originType: DeliveryOriginType.DOWNSTREAM,
      systemId: 'wrong-prefix-node-id',
      instanceId: 'instance',
      assignedPath: '/assigned',
    } as any;

    const authContext = {
      authenticated: true,
      authorized: false,
      principal: 'user',
      claims: { sub: 'user@example.com' },
      grantedScopes: [],
      restrictions: {},
    };

    const node = { id: 'node-1', physicalPath: '/nodes/node-1' } as any;
    const result = await authorizer.validateNodeAttachRequest(
      node,
      frame,
      authContext
    );
    // Should be undefined because the node ID doesn't have the correct prefix
    expect(result).toBeUndefined();
  });

  it('passes enforce_token_subject_node_identity via snake_case config', async () => {
    const factory = new OAuth2AuthorizerFactory();

    const config = {
      type: 'OAuth2Authorizer',
      issuer: 'https://issuer.example',
      enforce_token_subject_node_identity: true,
      token_verifier_config: {
        type: 'JWTTokenVerifier',
        issuer: 'https://issuer.example',
        hmac_secret: HMAC_SECRET,
        algorithms: ['HS256'],
      },
    } as const;

    const authorizer = (await factory.create(config)) as OAuth2Authorizer;
    expect(authorizer).toBeInstanceOf(OAuth2Authorizer);

    // Verify enforcement is enabled by testing that it rejects attach without proper prefix
    const { DeliveryOriginType } = await import('@naylence/core');

    const frame = {
      type: 'NodeAttach',
      originType: DeliveryOriginType.DOWNSTREAM,
      systemId: 'wrong-prefix-node-id',
      instanceId: 'instance',
      assignedPath: '/assigned',
    } as any;

    const authContext = {
      authenticated: true,
      authorized: false,
      principal: 'user',
      claims: { sub: 'user@example.com' },
      grantedScopes: [],
      restrictions: {},
    };

    const node = { id: 'node-1', physicalPath: '/nodes/node-1' } as any;
    const result = await authorizer.validateNodeAttachRequest(
      node,
      frame,
      authContext
    );
    // Should be undefined because the node ID doesn't have the correct prefix
    expect(result).toBeUndefined();
  });
});
