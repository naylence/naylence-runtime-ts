import type {
  AuthorizationContext,
  FameDeliveryContext,
  FameEnvelope,
  NodeAttachFrame,
} from 'naylence-core';
import { DeliveryOriginType, FameResponseType } from 'naylence-core';
import { OAuth2Authorizer } from '../auth/oauth2-authorizer.js';
import { JWTTokenIssuer } from '../auth/jwt-token-issuer.js';
import { JWTTokenVerifier } from '../auth/jwt-token-verifier.js';
import type { NodeLike } from '../../node/node-like.js';
import type { TokenVerifier } from '../auth/token-verifier.js';
import type { TokenIssuer } from '../auth/token-issuer.js';

const HMAC_SECRET = 'oauth2-secret';
const NODE_PHYSICAL_PATH = '/nodes/node-1';

function createNodeStub(overrides: Partial<NodeLike> = {}): NodeLike {
  const base: NodeLike = {
    id: 'node-1',
    sid: null,
  physicalPath: NODE_PHYSICAL_PATH,
    acceptedLogicals: new Set(),
    envelopeFactory: {} as any,
    deliveryPolicy: null,
    defaultBindingPath: '',
    hasParent: false,
    securityManager: null,
    admissionClient: null,
    eventListeners: [],
    upstreamConnector: null,
    publicUrl: null,
  storageProvider: {} as any,
  cryptoProvider: {} as any,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
    bind: jest.fn(),
    unbind: jest.fn(),
    send: jest.fn(),
    listen: jest.fn(),
    listenRpc: jest.fn(),
    invoke: jest.fn(),
    invokeByCapability: jest.fn(),
    invokeStream: jest.fn(),
    invokeByCapabilityStream: jest.fn(),
    deliver: jest.fn(),
    deliverLocal: jest.fn(),
    forwardUpstream: jest.fn(),
    hasLocal: jest.fn(),
    gatherSupportedCallbackGrants: jest.fn(() => []),
    dispatchEvent: jest.fn(),
    dispatchEnvelopeEvent: jest.fn(async () => null),
  };

  return { ...base, ...overrides };
}

describe('OAuth2Authorizer', () => {
  let issuer: JWTTokenIssuer;
  let verifier: JWTTokenVerifier;

  beforeEach(() => {
    jest.useRealTimers();
    issuer = new JWTTokenIssuer({
      signingKeyPem: HMAC_SECRET,
      kid: 'oauth2-kid',
      issuer: 'https://issuer.example',
      algorithm: 'HS256',
      ttlSec: 600,
    });

    verifier = new JWTTokenVerifier({
      verificationKey: HMAC_SECRET,
      issuer: 'https://issuer.example',
      ttlSec: 600,
    });
  });

  it('authenticates tokens and enforces required scopes', async () => {
    const token = await issuer.issue({
      sub: 'user-1',
      scope: 'fame:connect fame:read',
      aud: NODE_PHYSICAL_PATH,
    });

    const authorizer = new OAuth2Authorizer({
      tokenVerifier: verifier,
      requiredScopes: ['fame:connect'],
    });

    const node = createNodeStub();
    await authorizer.onNodeStarted(node);

    const context = await authorizer.authenticate(`Bearer ${token}`);

    expect(context).toBeDefined();
    expect(context?.authenticated).toBe(true);
    expect(context?.principal).toBe('user-1');
    expect(context?.grantedScopes).toEqual(expect.arrayContaining(['fame:connect', 'fame:read']));
    expect(context?.claims.iss).toBe('https://issuer.example');
  });

  it('rejects authentication when required scopes are missing', async () => {
    const token = await issuer.issue({
      sub: 'user-2',
      scope: 'profile:read',
      aud: NODE_PHYSICAL_PATH,
    });

    const authorizer = new OAuth2Authorizer({
      tokenVerifier: verifier,
      requiredScopes: ['fame:connect'],
    });

    const node = createNodeStub();
    await authorizer.onNodeStarted(node);

    const context = await authorizer.authenticate(`Bearer ${token}`);
    expect(context).toBeUndefined();
  });

  it('authorizes delivery contexts when scopes are satisfied', async () => {
    const token = await issuer.issue({
      sub: 'user-3',
      scope: 'fame:connect',
      aud: NODE_PHYSICAL_PATH,
    });

    const authorizer = new OAuth2Authorizer({
      tokenVerifier: verifier,
      requiredScopes: ['fame:connect'],
    });

    const node = createNodeStub();
    await authorizer.onNodeStarted(node);
    const authContext = await authorizer.authenticate(`Bearer ${token}`);
    expect(authContext).toBeDefined();

    const deliveryContext: FameDeliveryContext = {
      security: {
        authorization: { ...authContext!, authorized: false },
      },
      expectedResponseType: FameResponseType.NONE,
    };

    const envelope = {} as FameEnvelope;
    const result = await authorizer.authorize(node, envelope, deliveryContext);

    expect(result).toBeDefined();
    expect(result?.authorized).toBe(true);
  });

  it('creates reverse authorization configuration when issuer is available', async () => {
    const authorizer = new OAuth2Authorizer({
      tokenVerifier: verifier,
      tokenIssuer: issuer,
      requiredScopes: ['fame:connect'],
    });

    const node = createNodeStub();
    await authorizer.onNodeStarted(node);

    const config = await authorizer.createReverseAuthorizationConfig(node);
    expect(config).toBeDefined();
    expect(config).toHaveProperty('tokenProvider');

    const tokenProvider = config!.tokenProvider as { token: string; expiresAt: Date };
    expect(typeof tokenProvider.token).toBe('string');

    const reverseContext = await verifier.verify(tokenProvider.token);
    expect(reverseContext.claims.sub).toBe(`reverse-auth-${node.id}`);
  });

  it('creates node authorization context during attach validation', async () => {
    const token = await issuer.issue({
      sub: 'user-4',
      scope: 'fame:connect fame:write',
      aud: NODE_PHYSICAL_PATH,
    });

    const authorizer = new OAuth2Authorizer({
      tokenVerifier: verifier,
      requiredScopes: ['fame:connect'],
    });

    const node = createNodeStub();
    await authorizer.onNodeStarted(node);
    const authContext = await authorizer.authenticate(`Bearer ${token}`);
    expect(authContext).toBeDefined();

    const frame: NodeAttachFrame = {
      type: 'NodeAttach',
      originType: DeliveryOriginType.DOWNSTREAM,
      systemId: 'system-1',
      instanceId: 'instance-1',
      assignedPath: '/assigned/path',
      capabilities: ['fame:connect'],
      acceptedLogicals: ['logical-a'],
    };

    const nodeContext = await authorizer.validateNodeAttachRequest(node, frame, authContext!);
    expect(nodeContext).toBeDefined();
    expect(nodeContext?.authorized).toBe(true);
    expect(nodeContext?.claims.instance_id).toBe('instance-1');
    expect(nodeContext?.claims.assigned_path).toBe('/assigned/path');
    expect(nodeContext?.grantedScopes).toEqual(expect.arrayContaining(['fame:connect', 'fame:write']));
  });
});

describe('OAuth2Authorizer edge cases', () => {
  const createVerifierMock = () => {
    const verify = jest.fn();
    return {
      mock: verify,
      verifier: { verify } as unknown as TokenVerifier,
    };
  };

  const baseAuthContext: AuthorizationContext = {
    authenticated: true,
    authorized: false,
    principal: 'stub-user',
    claims: {},
    grantedScopes: [],
    restrictions: {},
  };

  it('returns undefined when credentials are empty', async () => {
    const { mock, verifier } = createVerifierMock();
    const authorizer = new OAuth2Authorizer({ tokenVerifier: verifier });

    const result = await authorizer.authenticate('   ');

    expect(result).toBeUndefined();
    expect(mock).not.toHaveBeenCalled();
  });

  it('accepts raw tokens without Bearer prefix', async () => {
    const { mock, verifier } = createVerifierMock();
    mock.mockResolvedValue({
      ...baseAuthContext,
      authenticated: true,
      authorized: true,
      grantedScopes: [],
    });

    const authorizer = new OAuth2Authorizer({ tokenVerifier: verifier });
    await authorizer.authenticate('raw-token');

    expect(mock).toHaveBeenCalledWith('raw-token');
  });

  it('decodes bearer tokens from Uint8Array and merges scopes uniquely', async () => {
    const { mock, verifier } = createVerifierMock();
    mock.mockResolvedValue({
      ...baseAuthContext,
      claims: {
        scopes: ['alpha', 'beta '],
        capabilities: ['gamma', ''],
      },
      grantedScopes: ['delta'],
    });

    const authorizer = new OAuth2Authorizer({ tokenVerifier: verifier });
    const tokenBytes = new TextEncoder().encode('Bearer stub-token');

    const context = await authorizer.authenticate(tokenBytes);

    expect(mock).toHaveBeenCalledWith('stub-token');
    expect(context?.grantedScopes).toEqual(
      expect.arrayContaining(['delta', 'alpha', 'beta', 'gamma'])
    );
  });

  it('returns undefined when token verification fails', async () => {
    const { mock, verifier } = createVerifierMock();
    mock.mockRejectedValue(new Error('boom'));

    const authorizer = new OAuth2Authorizer({ tokenVerifier: verifier });

    const context = await authorizer.authenticate('Bearer broken');

    expect(context).toBeUndefined();
  });

  it('rejects authentication when required scope is absent', async () => {
    const { mock, verifier } = createVerifierMock();
    mock.mockResolvedValue({
      ...baseAuthContext,
      grantedScopes: ['scope:other'],
      claims: {},
    });

    const authorizer = new OAuth2Authorizer({
      tokenVerifier: verifier,
      requiredScopes: ['scope:required'],
    });

    const context = await authorizer.authenticate('Bearer missing-scope');
    expect(context).toBeUndefined();
  });

  it('skips scope enforcement when disabled during authentication', async () => {
    const { mock, verifier } = createVerifierMock();
    mock.mockResolvedValue({
      ...baseAuthContext,
      grantedScopes: ['scope:other'],
      claims: {},
    });

    const authorizer = new OAuth2Authorizer({
      tokenVerifier: verifier,
      requiredScopes: ['scope:required'],
      requireScope: false,
    });

    const context = await authorizer.authenticate('Bearer relaxed-scope');
    expect(context).toBeDefined();
    expect(mock).toHaveBeenCalledWith('relaxed-scope');
  });

  it('derives audience from node path when none configured', async () => {
    const { mock, verifier } = createVerifierMock();
    mock.mockResolvedValue({
      ...baseAuthContext,
      authorized: true,
      grantedScopes: ['scope:a'],
    });

    const authorizer = new OAuth2Authorizer({ tokenVerifier: verifier, requiredScopes: ['scope:a'] });
    const node = createNodeStub();
    await authorizer.onNodeStarted(node);

    await authorizer.authenticate('Bearer node-token');

    expect(mock).toHaveBeenCalledWith('node-token', { expectedAudience: NODE_PHYSICAL_PATH });
  });

  it('returns undefined from authorize when no security context is present', async () => {
    const authorizer = new OAuth2Authorizer({
      tokenVerifier: createVerifierMock().verifier,
    });

    const result = await authorizer.authorize(createNodeStub(), {} as FameEnvelope);
    expect(result).toBeUndefined();
  });

  it('denies authorization when required scope is missing', async () => {
    const authorization: AuthorizationContext = {
      ...baseAuthContext,
      grantedScopes: ['scope:incomplete'],
      authorized: false,
    };
    const deliveryContext: FameDeliveryContext = {
      expectedResponseType: FameResponseType.ACK,
      security: { authorization },
    };

    const authorizer = new OAuth2Authorizer({
      tokenVerifier: createVerifierMock().verifier,
      requiredScopes: ['scope:required'],
    });

    const result = await authorizer.authorize(createNodeStub(), {} as FameEnvelope, deliveryContext);
    expect(result).toBeUndefined();
  });

  it('returns existing authorization context when already authorized', async () => {
    const authorization: AuthorizationContext = {
      ...baseAuthContext,
      authorized: true,
      grantedScopes: ['scope:required'],
    };
    const deliveryContext: FameDeliveryContext = {
      expectedResponseType: FameResponseType.ACK,
      security: { authorization },
    };

    const authorizer = new OAuth2Authorizer({
      tokenVerifier: createVerifierMock().verifier,
      requiredScopes: ['scope:required'],
    });

    const result = await authorizer.authorize(createNodeStub(), {} as FameEnvelope, deliveryContext);
    expect(result).toBe(authorization);
  });

  it('returns undefined when no token issuer is configured for reverse auth', async () => {
    const authorizer = new OAuth2Authorizer({ tokenVerifier: createVerifierMock().verifier });
    const config = await authorizer.createReverseAuthorizationConfig(createNodeStub());
    expect(config).toBeUndefined();
  });

  it('returns undefined when token issuing fails for reverse auth', async () => {
    const issue = jest.fn().mockRejectedValue(new Error('issue failed'));
    const tokenIssuer: TokenIssuer = {
      issuer: 'stub-issuer',
      issue,
    };

    const authorizer = new OAuth2Authorizer({
      tokenVerifier: createVerifierMock().verifier,
      tokenIssuer,
      requiredScopes: ['scope:required'],
    });

    const config = await authorizer.createReverseAuthorizationConfig(createNodeStub());
    expect(issue).toHaveBeenCalled();
    expect(config).toBeUndefined();
  });

  it('validateNodeAttachRequest returns undefined without auth context', async () => {
    const authorizer = new OAuth2Authorizer({
      tokenVerifier: createVerifierMock().verifier,
      requiredScopes: ['scope:required'],
    });

    const frame: NodeAttachFrame = {
      type: 'NodeAttach',
      originType: DeliveryOriginType.DOWNSTREAM,
      systemId: 'system',
      instanceId: 'instance',
      assignedPath: '/assigned',
    } as NodeAttachFrame;

    const result = await authorizer.validateNodeAttachRequest(createNodeStub(), frame, undefined);
    expect(result).toBeUndefined();
  });

  it('validateNodeAttachRequest returns undefined when not authenticated', async () => {
    const authorizer = new OAuth2Authorizer({
      tokenVerifier: createVerifierMock().verifier,
      requiredScopes: ['scope:required'],
    });

    const frame: NodeAttachFrame = {
      type: 'NodeAttach',
      originType: DeliveryOriginType.DOWNSTREAM,
      systemId: 'system',
      instanceId: 'instance',
      assignedPath: '/assigned',
    } as NodeAttachFrame;

    const authContext: AuthorizationContext = {
      ...baseAuthContext,
      authenticated: false,
    };

    const result = await authorizer.validateNodeAttachRequest(createNodeStub(), frame, authContext);
    expect(result).toBeUndefined();
  });

  it('authorize skips scope check when disabled', async () => {
    const authorization: AuthorizationContext = {
      ...baseAuthContext,
      authorized: false,
      grantedScopes: ['scope:other'],
    };
    const deliveryContext: FameDeliveryContext = {
      expectedResponseType: FameResponseType.ACK,
      security: { authorization },
    };

    const authorizer = new OAuth2Authorizer({
      tokenVerifier: createVerifierMock().verifier,
      requiredScopes: ['scope:required'],
      requireScope: false,
    });

    const result = await authorizer.authorize(createNodeStub(), {} as FameEnvelope, deliveryContext);
    expect(result).toEqual(
      expect.objectContaining({
        authorized: true,
        grantedScopes: authorization.grantedScopes,
      })
    );
  });

  it('validateNodeAttachRequest enforces required scopes', async () => {
    const authorizer = new OAuth2Authorizer({
      tokenVerifier: createVerifierMock().verifier,
      requiredScopes: ['scope:required'],
    });

    const frame: NodeAttachFrame = {
      type: 'NodeAttach',
      originType: DeliveryOriginType.DOWNSTREAM,
      systemId: 'system',
      instanceId: 'instance',
      assignedPath: '/assigned',
    } as NodeAttachFrame;

    const authContext: AuthorizationContext = {
      ...baseAuthContext,
      authenticated: true,
      grantedScopes: ['scope:other'],
    };

    const result = await authorizer.validateNodeAttachRequest(createNodeStub(), frame, authContext);
    expect(result).toBeUndefined();
  });

  it('validateNodeAttachRequest skips scope enforcement when disabled', async () => {
    const authorizer = new OAuth2Authorizer({
      tokenVerifier: createVerifierMock().verifier,
      requiredScopes: ['scope:required'],
      requireScope: false,
    });

    const frame: NodeAttachFrame = {
      type: 'NodeAttach',
      originType: DeliveryOriginType.DOWNSTREAM,
      systemId: 'system',
      instanceId: 'instance',
      assignedPath: '/assigned',
    } as NodeAttachFrame;

    const authContext: AuthorizationContext = {
      ...baseAuthContext,
      authenticated: true,
      grantedScopes: ['scope:other'],
    };

    const result = await authorizer.validateNodeAttachRequest(createNodeStub(), frame, authContext);
    expect(result).toBeDefined();
    expect(result?.authorized).toBe(true);
  });
});
