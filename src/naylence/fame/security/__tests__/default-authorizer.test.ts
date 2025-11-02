import { ResourceFactoryRegistry } from '@naylence/factory';
import type {
  AuthorizationContext,
  FameDeliveryContext,
  FameEnvelope,
  NodeAttachFrame,
} from '@naylence/core';
import {
  createAuthorizationContext,
  DeliveryOriginType,
  FameResponseType,
} from '@naylence/core';

import type { NodeLike } from '../../node/node-like.js';
import type { TokenVerifier } from '../auth/token-verifier.js';
import { DefaultAuthorizer } from '../auth/default-authorizer.js';
import { DefaultAuthorizerFactory } from '../auth/default-authorizer-factory.js';
import '../auth/shared-secret-token-verifier-factory.js';

interface VerifyOptions {
  expectedAudience?: string;
}

class StubTokenVerifier implements TokenVerifier {
  constructor(
    private readonly handler: (
      token: string,
      options?: VerifyOptions
    ) => Promise<AuthorizationContext>
  ) {}

  public async verify(
    token: string,
    options?: VerifyOptions
  ): Promise<AuthorizationContext> {
    return this.handler(token, options);
  }
}

function createNodeStub(overrides: Partial<NodeLike> = {}): NodeLike {
  const base: Record<string, unknown> = {
    id: 'node-123',
    sid: null,
    physicalPath: '/region/node-123',
    acceptedLogicals: new Set<string>(),
    envelopeFactory: {} as unknown,
    deliveryPolicy: null,
    defaultBindingPath: '/',
    hasParent: false,
    securityManager: null,
    admissionClient: null,
    eventListeners: [],
    upstreamConnector: null,
    publicUrl: null,
    storageProvider: {} as unknown,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    start: jest.fn(async () => undefined),
    stop: jest.fn(async () => undefined),
    bind: jest.fn(async () => ({}) as any),
    unbind: jest.fn(async () => undefined),
    send: jest.fn(async () => null),
    listen: jest.fn(async () => ({}) as any),
    listenRpc: jest.fn(async () => ({}) as any),
    invoke: jest.fn(async () => ({})),
    invokeByCapability: jest.fn(async () => ({})),
    invokeStream: jest.fn(async function* () {}),
    invokeByCapabilityStream: jest.fn(async function* () {}),
    deliver: jest.fn(async () => undefined),
    deliverLocal: jest.fn(async () => undefined),
    forwardUpstream: jest.fn(async () => undefined),
    hasLocal: jest.fn(() => true),
    gatherSupportedCallbackGrants: jest.fn(() => []),
    dispatchEvent: jest.fn(async () => undefined),
    dispatchEnvelopeEvent: jest.fn(async () => null),
  };

  return { ...base, ...overrides } as NodeLike;
}

function createAttachFrame(
  overrides: Partial<NodeAttachFrame> = {}
): NodeAttachFrame {
  return {
    type: 'NodeAttach',
    originType: DeliveryOriginType.DOWNSTREAM,
    systemId: 'system-1',
    instanceId: 'instance-1',
    assignedPath: '/region/node-123',
    capabilities: [],
    acceptedLogicals: [],
    ...overrides,
  };
}

function createDeliveryContext(
  overrides: Partial<FameDeliveryContext> = {}
): FameDeliveryContext {
  return {
    expectedResponseType: FameResponseType.ACK,
    ...overrides,
  } as FameDeliveryContext;
}

describe('DefaultAuthorizer', () => {
  afterEach(() => {
    ResourceFactoryRegistry.clearCache('TokenVerifierFactory');
    ResourceFactoryRegistry.clearCache('CredentialProviderFactory');
  });

  it('authenticates credentials using token verifier and sets defaults', async () => {
    const node = createNodeStub();

    const verifier = new StubTokenVerifier(async (token, options) => {
      expect(token).toBe('valid-token');
      expect(options?.expectedAudience).toBe(node.physicalPath);
      return createAuthorizationContext({
        authenticated: true,
        authorized: true,
        principal: 'principal-1',
        claims: {
          sub: 'principal-1',
          instance_id: 'instance-1',
          aud: options?.expectedAudience,
        },
      });
    });

    const authorizer = new DefaultAuthorizer({ tokenVerifier: verifier });
    await authorizer.onNodeStarted(node);

    const context = await authorizer.authenticate('Bearer valid-token');

    expect(context).toBeDefined();
    expect(context?.authenticated).toBe(true);
    expect(context?.authorized).toBe(true);
    expect(context?.principal).toBe('principal-1');
    expect(context?.claims?.aud).toBe(node.physicalPath);
    expect(context?.authMethod).toBe('jwt_fame_claims');
  });

  it('supports snake_case constructor options', async () => {
    const node = createNodeStub();
    const verifier = new StubTokenVerifier(async () =>
      createAuthorizationContext({ authenticated: true, authorized: true })
    );

    const authorizer = new DefaultAuthorizer({
      token_verifier: verifier,
    });

    await authorizer.onNodeStarted(node);
    const context = await authorizer.authenticate('Bearer token');

    expect(context?.authenticated).toBe(true);
  });

  it('returns undefined when token verification fails', async () => {
    const node = createNodeStub();
    const verifier = new StubTokenVerifier(async () => {
      throw new Error('invalid token');
    });

    const authorizer = new DefaultAuthorizer({ tokenVerifier: verifier });
    await authorizer.onNodeStarted(node);

    const context = await authorizer.authenticate('Bearer invalid');
    expect(context).toBeUndefined();
  });

  it("rejects remote node attach when claims don't match frame", async () => {
    const authorizer = new DefaultAuthorizer();
    const node = createNodeStub();

    const attachFrame: NodeAttachFrame = {
      type: 'NodeAttach',
      originType: DeliveryOriginType.DOWNSTREAM,
      systemId: 'system-2',
      instanceId: 'instance-1',
      assignedPath: '/region/node-123',
      capabilities: [],
      acceptedLogicals: [],
    };

    const envelope = { frame: attachFrame } as unknown as FameEnvelope;
    const context = createAuthorizationContext({
      authenticated: true,
      authorized: false,
      principal: 'system-1',
      claims: {
        sub: 'system-1',
        instance_id: 'instance-1',
        aud: node.id,
      },
    });

    await expect(
      authorizer.authorize(node, envelope, {
        originType: DeliveryOriginType.DOWNSTREAM,
        security: { authorization: context },
      } as unknown as FameDeliveryContext)
    ).rejects.toThrow("Token sub doesn't match system id");
  });

  it('authorizes node attach when claims match frame', async () => {
    const authorizer = new DefaultAuthorizer();
    const node = createNodeStub();

    const attachFrame: NodeAttachFrame = {
      type: 'NodeAttach',
      originType: DeliveryOriginType.DOWNSTREAM,
      systemId: 'system-1',
      instanceId: 'instance-1',
      assignedPath: '/region/node-123',
      capabilities: ['cap-a'],
      acceptedLogicals: ['logical-a'],
    };

    const envelope = { frame: attachFrame } as unknown as FameEnvelope;

    const context = createAuthorizationContext({
      authenticated: true,
      authorized: false,
      principal: 'system-1',
      authMethod: 'jwt_fame_claims',
      claims: {
        sub: 'system-1',
        instance_id: 'instance-1',
        aud: node.id,
        assigned_path: '/region/node-123',
        accepted_capabilities: ['cap-a'],
        accepted_logicals: ['logical-a'],
      },
    });

    const result = await authorizer.authorize(node, envelope, {
      originType: DeliveryOriginType.DOWNSTREAM,
      security: { authorization: context },
    } as unknown as FameDeliveryContext);

    expect(result).toBeDefined();
    expect(result?.authorized).toBe(true);
    expect(result?.authMethod).toBe('jwt_fame_claims');
  });

  it('augments claims during node attach request validation', async () => {
    const authorizer = new DefaultAuthorizer();
    const node = createNodeStub();

    const frame: NodeAttachFrame = {
      type: 'NodeAttach',
      originType: DeliveryOriginType.DOWNSTREAM,
      systemId: 'system-1',
      instanceId: 'instance-1',
      assignedPath: '/region/child',
      capabilities: ['cap-a', 'cap-b'],
      acceptedLogicals: ['logical-a'],
    };

    const auth = createAuthorizationContext({
      authenticated: true,
      authorized: false,
    });

    const result = await authorizer.validateNodeAttachRequest(
      node,
      frame,
      auth
    );

    expect(result).toBeDefined();
    expect(result?.authorized).toBe(true);
    expect(result?.claims).toMatchObject({
      sub: 'system-1',
      instance_id: 'instance-1',
      aud: node.id,
      assigned_path: '/region/child',
      accepted_capabilities: ['cap-a', 'cap-b'],
      accepted_logicals: ['logical-a'],
    });
    expect(result?.principal).toBe('system-1');
  });

  it('creates authorizer via factory using shared secret verifier', async () => {
    const node = createNodeStub();
    const factory = new DefaultAuthorizerFactory();

    const authorizer = (await factory.create({
      type: 'DefaultAuthorizer',
      verifier: {
        type: 'SharedSecretTokenVerifier',
        secret: 'shared-secret',
      },
    })) as DefaultAuthorizer;

    await authorizer.onNodeStarted(node);
    const context = await authorizer.authenticate('Bearer shared-secret');

    expect(context).toBeDefined();
    expect(context?.authenticated).toBe(true);
    expect(context?.authorized).toBe(true);
    expect(context?.authMethod).toBe('shared_secret');
  });

  it('returns undefined when credentials are blank', async () => {
    const handler = jest.fn<
      Promise<AuthorizationContext>,
      [string, VerifyOptions | undefined]
    >();
    const authorizer = new DefaultAuthorizer({
      tokenVerifier: new StubTokenVerifier(handler),
    });

    const context = await authorizer.authenticate('   ');

    expect(context).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
  });

  it('trims raw tokens and verifies without expected audience', async () => {
    const handler = jest.fn(
      async (
        token: string,
        options?: VerifyOptions
      ): Promise<AuthorizationContext> => {
        expect(token).toBe('raw-token');
        expect(options).toBeUndefined();
        return createAuthorizationContext({
          authenticated: true,
          authorized: true,
          principal: 'principal-raw',
        });
      }
    );

    const authorizer = new DefaultAuthorizer({
      tokenVerifier: new StubTokenVerifier(handler),
    });

    const context = await authorizer.authenticate('  raw-token  ');

    expect(context?.authorized).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('decodes byte credentials with Buffer when TextDecoder is unavailable', async () => {
    const globalAny = globalThis as { [key: string]: unknown };
    const originalTextDecoder = globalAny.TextDecoder;

    const handler = jest.fn(
      async (
        token: string,
        options?: VerifyOptions
      ): Promise<AuthorizationContext> => {
        expect(token).toBe('buffer-token');
        expect(options).toBeUndefined();
        return createAuthorizationContext({
          authenticated: true,
          authorized: true,
        });
      }
    );

    const authorizer = new DefaultAuthorizer({
      tokenVerifier: new StubTokenVerifier(handler),
    });

    try {
      globalAny.TextDecoder = undefined;
      const bytes = Uint8Array.from(
        Buffer.from('Bearer buffer-token', 'utf-8')
      );
      const context = await authorizer.authenticate(bytes);

      expect(context?.authenticated).toBe(true);
      expect(handler).toHaveBeenCalledWith('buffer-token', undefined);
    } finally {
      globalAny.TextDecoder = originalTextDecoder;
    }
  });

  it('throws when byte credentials cannot be decoded', async () => {
    const globalAny = globalThis as { [key: string]: unknown };
    const originalTextDecoder = globalAny.TextDecoder;
    const originalBuffer = globalAny.Buffer;

    const handler = jest.fn(
      async (): Promise<AuthorizationContext> =>
        createAuthorizationContext({ authenticated: true, authorized: true })
    );

    const authorizer = new DefaultAuthorizer({
      tokenVerifier: new StubTokenVerifier(handler),
    });

    try {
      globalAny.TextDecoder = undefined;
      globalAny.Buffer = undefined;
      const bytes = new Uint8Array([66, 121]);

      await expect(authorizer.authenticate(bytes)).rejects.toThrow(
        'Unable to decode credential bytes without TextDecoder support'
      );
      expect(handler).not.toHaveBeenCalled();
    } finally {
      globalAny.TextDecoder = originalTextDecoder;
      globalAny.Buffer = originalBuffer;
    }
  });

  it('returns undefined when authorization context is missing or unauthenticated', async () => {
    const authorizer = new DefaultAuthorizer();
    const node = createNodeStub();
    const envelope = { frame: {} } as FameEnvelope;

    const resultWithoutContext = await authorizer.authorize(node, envelope);
    expect(resultWithoutContext).toBeUndefined();

    const resultNotAuthenticated = await authorizer.authorize(
      node,
      envelope,
      createDeliveryContext({
        security: {
          authorization: createAuthorizationContext({
            authenticated: false,
            authorized: false,
          }),
        },
      })
    );
    expect(resultNotAuthenticated).toBeUndefined();
  });

  it('returns existing authorization when already authorized', async () => {
    const authorizer = new DefaultAuthorizer();
    const node = createNodeStub();
    const envelope = { frame: {} } as FameEnvelope;

    const authorization = createAuthorizationContext({
      authenticated: true,
      authorized: true,
      authMethod: 'custom-method',
    });

    const result = await authorizer.authorize(
      node,
      envelope,
      createDeliveryContext({ security: { authorization } })
    );

    expect(result).toBe(authorization);
  });

  it('authorizes remote node attach even when claims are incomplete', async () => {
    const authorizer = new DefaultAuthorizer();
    const node = createNodeStub();
    const frame = createAttachFrame();
    const envelope = { frame } as unknown as FameEnvelope;

    const authorization = createAuthorizationContext({
      authenticated: true,
      authorized: false,
    });

    const result = await authorizer.authorize(
      node,
      envelope,
      createDeliveryContext({
        originType: DeliveryOriginType.DOWNSTREAM,
        security: { authorization },
      })
    );

    expect(result?.authorized).toBe(true);
  });

  it('validateNodeAttachRequest returns undefined when auth context is missing or unauthenticated', async () => {
    const authorizer = new DefaultAuthorizer();
    const node = createNodeStub();
    const frame = createAttachFrame();

    const resultWithoutAuth = await authorizer.validateNodeAttachRequest(
      node,
      frame
    );
    expect(resultWithoutAuth).toBeUndefined();

    const resultNotAuthenticated = await authorizer.validateNodeAttachRequest(
      node,
      frame,
      createAuthorizationContext({ authenticated: false, authorized: false })
    );
    expect(resultNotAuthenticated).toBeUndefined();
  });

  it('rejects node attach when instance id does not match claims', async () => {
    const authorizer = new DefaultAuthorizer();
    const node = createNodeStub();
    const frame = createAttachFrame();
    const envelope = { frame } as unknown as FameEnvelope;

    const authorization = createAuthorizationContext({
      authenticated: true,
      authorized: false,
      principal: 'system-1',
      claims: {
        sub: 'system-1',
        instance_id: 'instance-2',
        aud: node.id,
      },
    });

    await expect(
      authorizer.authorize(
        node,
        envelope,
        createDeliveryContext({
          originType: DeliveryOriginType.DOWNSTREAM,
          security: { authorization },
        })
      )
    ).rejects.toThrow('Token instance ID mismatch');
  });

  it('rejects node attach when audience does not match claims', async () => {
    const authorizer = new DefaultAuthorizer();
    const node = createNodeStub();
    const frame = createAttachFrame();
    const envelope = { frame } as unknown as FameEnvelope;

    const authorization = createAuthorizationContext({
      authenticated: true,
      authorized: false,
      principal: 'system-1',
      claims: {
        sub: 'system-1',
        instance_id: frame.instanceId,
        aud: 'different-node',
      },
    });

    await expect(
      authorizer.authorize(
        node,
        envelope,
        createDeliveryContext({
          originType: DeliveryOriginType.DOWNSTREAM,
          security: { authorization },
        })
      )
    ).rejects.toThrow("Token audience doesn't match target node");
  });

  it('rejects node attach when assigned path differs from token claims', async () => {
    const authorizer = new DefaultAuthorizer();
    const node = createNodeStub();
    const frame = createAttachFrame({ assignedPath: '/region/child' });
    const envelope = { frame } as unknown as FameEnvelope;

    const authorization = createAuthorizationContext({
      authenticated: true,
      authorized: false,
      principal: 'system-1',
      claims: {
        sub: 'system-1',
        instance_id: frame.instanceId,
        aud: node.id,
        assigned_path: '/region/other',
      },
    });

    await expect(
      authorizer.authorize(
        node,
        envelope,
        createDeliveryContext({
          originType: DeliveryOriginType.DOWNSTREAM,
          security: { authorization },
        })
      )
    ).rejects.toThrow('Assigned path is not authorized by token');
  });

  it('rejects node attach when requested logicals are not authorized', async () => {
    const authorizer = new DefaultAuthorizer();
    const node = createNodeStub();
    const frame = createAttachFrame({
      acceptedLogicals: ['logical-a', 'logical-b'],
    });
    const envelope = { frame } as unknown as FameEnvelope;

    const authorization = createAuthorizationContext({
      authenticated: true,
      authorized: false,
      principal: 'system-1',
      claims: {
        sub: 'system-1',
        instance_id: frame.instanceId,
        aud: node.id,
        accepted_logicals: ['logical-a'],
      },
    });

    await expect(
      authorizer.authorize(
        node,
        envelope,
        createDeliveryContext({
          originType: DeliveryOriginType.DOWNSTREAM,
          security: { authorization },
        })
      )
    ).rejects.toThrow('Logicals not authorized by token');
  });

  it('rejects node attach when requested capabilities are not authorized', async () => {
    const authorizer = new DefaultAuthorizer();
    const node = createNodeStub();
    const frame = createAttachFrame({ capabilities: ['cap-a', 'cap-b'] });
    const envelope = { frame } as unknown as FameEnvelope;

    const authorization = createAuthorizationContext({
      authenticated: true,
      authorized: false,
      principal: 'system-1',
      claims: {
        sub: 'system-1',
        instance_id: frame.instanceId,
        aud: node.id,
        accepted_capabilities: ['cap-a'],
      },
    });

    await expect(
      authorizer.authorize(
        node,
        envelope,
        createDeliveryContext({
          originType: DeliveryOriginType.DOWNSTREAM,
          security: { authorization },
        })
      )
    ).rejects.toThrow('Capabilities not authorized by token');
  });

  it('rejects node attach when capabilities are requested but token supplies none', async () => {
    const authorizer = new DefaultAuthorizer();
    const node = createNodeStub();
    const frame = createAttachFrame({ capabilities: ['cap-a'] });
    const envelope = { frame } as unknown as FameEnvelope;

    const authorization = createAuthorizationContext({
      authenticated: true,
      authorized: false,
      principal: 'system-1',
      claims: {
        sub: 'system-1',
        instance_id: frame.instanceId,
        aud: node.id,
      },
    });

    await expect(
      authorizer.authorize(
        node,
        envelope,
        createDeliveryContext({
          originType: DeliveryOriginType.DOWNSTREAM,
          security: { authorization },
        })
      )
    ).rejects.toThrow('Capabilities not authorized by token');
  });
});
