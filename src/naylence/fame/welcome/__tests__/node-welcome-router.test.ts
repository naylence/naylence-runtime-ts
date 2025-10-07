import fastify from 'fastify';
import { createFameEnvelope, type FameEnvelope } from 'naylence-core';

import type { NodeHelloFrame, NodeWelcomeFrame } from 'naylence-core';
import type { WelcomeService } from '../welcome-service.js';
import { nodeWelcomeRouter } from '../node-welcome-router.js';
import type { Authorizer } from '../../security/auth/authorizer.js';

function createHelloEnvelope(
  overrides: Partial<NodeHelloFrame> = {}
): FameEnvelope {
  const frame: NodeHelloFrame = {
    type: 'NodeHello',
    systemId: overrides.systemId ?? '',
    instanceId: overrides.instanceId ?? 'instance-123',
    logicals: overrides.logicals ?? ['api.service'],
    capabilities: overrides.capabilities ?? ['capability-a'],
    supportedTransports: overrides.supportedTransports ?? ['websocket'],
    securitySettings: overrides.securitySettings,
    regionHint: overrides.regionHint,
  };

  return createFameEnvelope({ frame });
}

describe('nodeWelcomeRouter', () => {
  afterEach(async () => {
    jest.restoreAllMocks();
  });

  it('responds with welcome envelope when hello accepted', async () => {
    const app = fastify();

    const welcomeFrame: NodeWelcomeFrame = {
      type: 'NodeWelcome',
      systemId: 'assigned-1',
      instanceId: 'instance-123',
      assignedPath: '/fabric/node-1',
    };

    const service: WelcomeService = {
      authorizer: null,
      handleHello: jest.fn(async () => welcomeFrame),
    };

    await app.register(nodeWelcomeRouter, { welcomeService: service });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/fame/v1/welcome/hello',
      payload: createHelloEnvelope(),
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.frame.type).toBe('NodeWelcome');
    expect(service.handleHello).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'NodeHello' })
    );

    await app.close();
  });

  it('returns 401 when authentication fails', async () => {
    const app = fastify();

    const authorizer: Authorizer = {
      authenticate: jest.fn(async () => undefined),
      authorize: jest.fn(async () => undefined),
    };

    const service: WelcomeService = {
      authorizer,
      handleHello: jest.fn(),
    };

    await app.register(nodeWelcomeRouter, { welcomeService: service });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/fame/v1/welcome/hello',
      payload: createHelloEnvelope(),
    });

    expect(response.statusCode).toBe(401);
    expect(authorizer.authenticate).toHaveBeenCalled();
    expect(service.handleHello).not.toHaveBeenCalled();

    await app.close();
  });

  it('returns 422 when payload invalid', async () => {
    const app = fastify();
    const service: WelcomeService = {
      authorizer: null,
      handleHello: jest.fn(),
    };

    await app.register(nodeWelcomeRouter, { welcomeService: service });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/fame/v1/welcome/hello',
      payload: { invalid: true },
    });

    expect(response.statusCode).toBe(422);
    expect(service.handleHello).not.toHaveBeenCalled();

    await app.close();
  });
});
