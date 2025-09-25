import type {
  AuthorizationContext,
  FameDeliveryContext,
  FameEnvelope,
  NodeAttachFrame,
} from 'naylence-core';
import { createAuthorizationContext, DeliveryOriginType, FameResponseType } from 'naylence-core';

import type { CredentialProvider } from '../credential/credential-provider.js';
import { SharedSecretAuthorizer } from '../auth/shared-secret-authorizer.js';
import { SharedSecretAuthorizerFactory } from '../auth/shared-secret-authorizer-factory.js';
import type { NodeLike } from '../../node/node-like.js';

class StubCredentialProvider implements CredentialProvider {
  constructor(private readonly token: string | null) {}

  async get(): Promise<string | null> {
    return this.token;
  }
}

const nodeStub = { id: 'node-123', physicalPath: '/physical/path' } as unknown as NodeLike;
const envelopeStub = {} as FameEnvelope;

function makeAuthContext(overrides?: Partial<AuthorizationContext>): AuthorizationContext {
  return createAuthorizationContext({
    authenticated: true,
    ...(overrides ?? {}),
  });
}

describe('SharedSecretAuthorizer', () => {
  it('authenticates bearer token credentials', async () => {
    const provider = new StubCredentialProvider('super-secret');
    const authorizer = new SharedSecretAuthorizer(provider);

    const result = await authorizer.authenticate('Bearer super-secret');

    expect(result).toBeDefined();
    expect(result?.authenticated).toBe(true);
    expect(result?.authMethod).toBe('shared_secret');
    expect(result?.principal).toBe('shared_secret_user');
  });

  it('decodes Uint8Array credentials', async () => {
    const provider = new StubCredentialProvider('binary-secret');
    const authorizer = new SharedSecretAuthorizer(provider);

    const tokenBytes = new TextEncoder().encode('binary-secret');
    const result = await authorizer.authenticate(tokenBytes);

    expect(result).toBeDefined();
    expect(result?.authenticated).toBe(true);
  });

  it('falls back to Buffer decoding when TextDecoder is unavailable', async () => {
    const provider = new StubCredentialProvider('binary-secret');
    const authorizer = new SharedSecretAuthorizer(provider);

    const globalObject = globalThis as Record<string, unknown>;
    const originalTextDecoder = globalObject.TextDecoder as typeof TextDecoder | undefined;
    try {
      delete globalObject.TextDecoder;
      const bytes = Buffer.from('binary-secret', 'utf-8');
      const result = await authorizer.authenticate(new Uint8Array(bytes));
      expect(result).toBeDefined();
      expect(result?.authenticated).toBe(true);
    } finally {
      if (originalTextDecoder) {
        globalObject.TextDecoder = originalTextDecoder;
      }
    }
  });

  it('throws when secret is not configured', async () => {
    const provider = new StubCredentialProvider(null);
    const authorizer = new SharedSecretAuthorizer(provider);

    await expect(authorizer.authenticate('any-token')).rejects.toThrow('Shared secret not configured');
  });

  it('returns undefined for mismatched token', async () => {
    const provider = new StubCredentialProvider('expected-secret');
    const authorizer = new SharedSecretAuthorizer(provider);

    const result = await authorizer.authenticate('wrong-secret');

    expect(result).toBeUndefined();
  });

  it('ignores blank credential inputs', async () => {
    const provider = new StubCredentialProvider('expected-secret');
    const authorizer = new SharedSecretAuthorizer(provider);

    const result = await authorizer.authenticate('   ');

    expect(result).toBeUndefined();
  });

  it('authorizes when provided legacy authorization context', async () => {
    const provider = new StubCredentialProvider('expected-secret');
    const authorizer = new SharedSecretAuthorizer(provider);

    const authContext = makeAuthContext();
    const result = await authorizer.authorize(
      nodeStub,
      envelopeStub,
      authContext as unknown as FameDeliveryContext
    );

    expect(result).toBeDefined();
    expect(result?.authorized).toBe(true);
    expect(result?.authMethod).toBe('shared_secret');
  });

  it('authorizes via FameDeliveryContext security payload', async () => {
    const provider = new StubCredentialProvider('expected-secret');
    const authorizer = new SharedSecretAuthorizer(provider);

    const deliveryContext: FameDeliveryContext = {
      expectedResponseType: FameResponseType.NONE,
      security: {
        authorization: makeAuthContext(),
      },
    };

    const result = await authorizer.authorize(nodeStub, envelopeStub, deliveryContext);

    expect(result).toBeDefined();
    expect(result?.authorized).toBe(true);
  });

  it('returns existing authorization context when already authorized', async () => {
    const provider = new StubCredentialProvider('expected-secret');
    const authorizer = new SharedSecretAuthorizer(provider);

    const authContext = makeAuthContext({
      authorized: true,
      authMethod: 'shared_secret',
    });

    const result = await authorizer.authorize(
      nodeStub,
      envelopeStub,
      authContext as unknown as FameDeliveryContext
    );

    expect(result).toBe(authContext);
  });

  it('returns undefined when authorization context is missing', async () => {
    const provider = new StubCredentialProvider('expected-secret');
    const authorizer = new SharedSecretAuthorizer(provider);

    const deliveryContext: FameDeliveryContext = {
      expectedResponseType: FameResponseType.NONE,
    };

    const result = await authorizer.authorize(nodeStub, envelopeStub, deliveryContext);

    expect(result).toBeUndefined();
  });

  it('populates claims during node attach validation', async () => {
    const provider = new StubCredentialProvider('expected-secret');
    const authorizer = new SharedSecretAuthorizer(provider);

    const frame: NodeAttachFrame = {
      type: 'NodeAttach',
  originType: DeliveryOriginType.DOWNSTREAM,
      systemId: 'child-1',
      instanceId: 'instance-55',
      assignedPath: '/child/path',
      capabilities: ['cap-a', 'cap-b'],
      acceptedLogicals: ['logical-a'],
      keys: [],
      callbackGrants: [],
    };

    const result = await authorizer.validateNodeAttachRequest(
      nodeStub,
      frame,
      makeAuthContext({ authMethod: 'shared_secret' })
    );

    expect(result).toBeDefined();
    expect(result?.authorized).toBe(true);
    expect(result?.principal).toBe('child-1');
    expect(result?.claims.sub).toBe('child-1');
    expect(result?.claims.aud).toBe(nodeStub.id);
    expect(result?.claims.instance_id).toBe('instance-55');
    expect(result?.claims.assigned_path).toBe('/child/path');
    expect(result?.claims.accepted_capabilities).toEqual(['cap-a', 'cap-b']);
    expect(result?.claims.accepted_logicals).toEqual(['logical-a']);
  });

  it('rejects node attach validation when not authenticated', async () => {
    const provider = new StubCredentialProvider('expected-secret');
    const authorizer = new SharedSecretAuthorizer(provider);

    const frame: NodeAttachFrame = {
      type: 'NodeAttach',
  originType: DeliveryOriginType.DOWNSTREAM,
      systemId: 'child-1',
      instanceId: 'instance-55',
      keys: [],
      callbackGrants: [],
    };

    const result = await authorizer.validateNodeAttachRequest(nodeStub, frame, undefined);

    expect(result).toBeUndefined();
  });
});

describe('SharedSecretAuthorizerFactory', () => {
  const originalEnv = process.env.SHARED_SECRET;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SHARED_SECRET;
    } else {
      process.env.SHARED_SECRET = originalEnv;
    }
  });

  it('creates authorizer using default env secret', async () => {
    process.env.SHARED_SECRET = 'env-secret';
    const factory = new SharedSecretAuthorizerFactory();

    const authorizer = await factory.create({ type: 'SharedSecretAuthorizer' });

    const result = await authorizer.authenticate('Bearer env-secret');
    expect(result).toBeDefined();
  });

  it('creates authorizer from static secret configuration', async () => {
    const factory = new SharedSecretAuthorizerFactory();

    const authorizer = await factory.create({
      type: 'SharedSecretAuthorizer',
      secret: {
        type: 'StaticCredentialProvider',
        credentialValue: 'static-secret',
      },
    });

    const result = await authorizer.authenticate('static-secret');
    expect(result).toBeDefined();
  });

  it('requires a configuration object', async () => {
    const factory = new SharedSecretAuthorizerFactory();

    await expect(factory.create()).rejects.toThrow('SharedSecretAuthorizer requires configuration');
  });
});
