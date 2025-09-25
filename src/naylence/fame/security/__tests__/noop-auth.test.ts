import {
  createAuthorizationContext,
  DeliveryOriginType,
  FameResponseType,
  type FameDeliveryContext,
  type NodeAttachFrame,
} from 'naylence-core';

import { NoopAuthorizer } from '../auth/noop-authorizer.js';
import { NoopAuthorizerFactory } from '../auth/noop-authorizer-factory.js';
import { NoopTokenIssuer } from '../auth/noop-token-issuer.js';
import { NoopTokenIssuerFactory } from '../auth/noop-token-issuer-factory.js';
import { NoopTokenVerifier } from '../auth/noop-token-verifier.js';
import { NoopTokenVerifierFactory } from '../auth/noop-token-verifier-factory.js';
import { AuthorizerFactory } from '../auth/authorizer-factory.js';
import { TokenIssuerFactory } from '../auth/token-issuer-factory.js';
import { TokenVerifierFactory } from '../auth/token-verifier-factory.js';
import type { NodeLike } from '../../node/node-like.js';

const nodeStub = { id: 'node-id' } as unknown as NodeLike;
const envelopeStub = {} as import('naylence-core').FameEnvelope;

describe('NoopAuthorizer', () => {
  const authorizer = new NoopAuthorizer();

  it('authenticates without inspecting credentials', async () => {
    const context = await authorizer.authenticate('ignored');

    expect(context.authenticated).toBe(true);
    expect(context.authorized).toBe(true);
    expect(context.authMethod).toBe('noop_authorizer');
  });

  it('authorizes when provided an authorization context directly', async () => {
    const provided = createAuthorizationContext({
      authenticated: false,
      authorized: false,
      principal: 'existing',
    });

    const context = await authorizer.authorize(nodeStub, envelopeStub, provided);
    expect(context.authenticated).toBe(true);
    expect(context.authorized).toBe(true);
    expect(context.principal).toBe('existing');
  });

  it('authorizes when context arrives via delivery metadata', async () => {
    const delivery: FameDeliveryContext = {
      expectedResponseType: FameResponseType.NONE,
      security: {
        authorization: createAuthorizationContext({ principal: 'delivery' }),
      },
    };

    const context = await authorizer.authorize(nodeStub, envelopeStub, delivery);
    expect(context.principal).toBe('delivery');
    expect(context.authMethod).toBe('noop_authorizer');
  });

  it('returns a permissive context for node attach validation', async () => {
    const frame: NodeAttachFrame = {
      type: 'NodeAttach',
      originType: DeliveryOriginType.DOWNSTREAM,
      systemId: 'attach-node',
      instanceId: 'instance-1',
    };

    const context = await authorizer.validateNodeAttachRequest(nodeStub, frame);
    expect(context.principal).toBe('attach-node');
    expect(context.authorized).toBe(true);
  });

  it('can be created through the factory registry', async () => {
    const factory = new NoopAuthorizerFactory();
    const instance = await factory.create();
    expect(instance).toBeInstanceOf(NoopAuthorizer);

    const registryInstance = await AuthorizerFactory.createAuthorizer({
      type: 'NoopAuthorizer',
    });
    expect(registryInstance).toBeInstanceOf(NoopAuthorizer);
  });
});

describe('NoopTokenIssuer', () => {
  const issuer = new NoopTokenIssuer();

  it('returns an empty issuer id and token', async () => {
    expect(issuer.issuer).toBe('');
    await expect(issuer.issue({ foo: 'bar' })).resolves.toBe('');
  });

  it('supports factory creation and registry lookup', async () => {
    const factory = new NoopTokenIssuerFactory();
    const instance = await factory.create();
    expect(instance).toBeInstanceOf(NoopTokenIssuer);

    const registryInstance = await TokenIssuerFactory.createTokenIssuer({
      type: 'NoopTokenIssuer',
    });
    expect(registryInstance).toBeInstanceOf(NoopTokenIssuer);
  });
});

describe('NoopTokenVerifier', () => {
  const verifier = new NoopTokenVerifier();

  it('returns an authenticated authorization context', async () => {
    const context = await verifier.verify('anything');
    expect(context.authenticated).toBe(true);
    expect(context.authorized).toBe(true);
    expect(context.authMethod).toBe('noop_token_verifier');
    expect(context.claims).toEqual({});
  });

  it('supports factory creation and registry lookup', async () => {
    const factory = new NoopTokenVerifierFactory();
    const instance = await factory.create();
    expect(instance).toBeInstanceOf(NoopTokenVerifier);

    const registryInstance = await TokenVerifierFactory.createTokenVerifier({
      type: 'NoopTokenVerifier',
    });
    expect(registryInstance).toBeInstanceOf(NoopTokenVerifier);
  });
});
