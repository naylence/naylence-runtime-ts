import { Buffer } from 'node:buffer';
import type { FastifyReply } from 'fastify';

import { HttpListener, getHttpListenerInstance } from '../http-listener.js';
import { QueueFullError } from '../http-stateless-connector.js';
import type { Authorizer } from '../../security/auth/authorizer.js';
import type { HttpServer } from '../http-server.js';
import type { RoutingNodeLike } from '../../node/routing-node-like.js';
import type { NodeLike } from '../../node/node-like.js';
import type { FameConnector } from '@naylence/core';
import { DeliveryOriginType, FameChannelMessage } from '@naylence/core';
import { DefaultHttpServer } from '../default-http-server.js';
import * as HttpGrantModule from '../../grants/http-connection-grant.js';
import * as WebSocketGrantModule from '../../grants/websocket-connection-grant.js';
import { GRANT_PURPOSE_NODE_ATTACH } from '../../grants/grant.js';

jest.mock('@naylence/core', () => {
  const actual =
    jest.requireActual<typeof import('@naylence/core')>('@naylence/core');

  class FakeFameChannelMessage {
    public envelope: unknown;
    public context: unknown;

    constructor(envelope: unknown, context: unknown) {
      this.envelope = envelope;
      this.context = context;
    }
  }

  return {
    ...actual,
    deserializeEnvelope: jest.fn((value: unknown) => value as any),
    FameChannelMessage: FakeFameChannelMessage,
  };
});

jest.mock('../../util/logging.js', () => {
  const logger = {
    debug: jest.fn(),
    error: jest.fn(),
    warning: jest.fn(),
    info: jest.fn(),
  };

  return {
    getLogger: jest.fn(() => logger),
    __mockLogger: logger,
  };
});

describe('HttpListener', () => {
  const loggingModule = require('../../util/logging.js');
  const mockLogger = loggingModule.__mockLogger as Record<string, jest.Mock>;
  const grantPolicyModule = require('../grant-selection-policy.js');
  let selectCallbackGrant: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    Object.values(mockLogger).forEach((fn) => fn.mockReset());
    selectCallbackGrant = jest
      .spyOn(
        grantPolicyModule.defaultGrantSelectionPolicy,
        'selectCallbackGrant'
      )
      .mockImplementation(() => ({
        grant: {
          type: HttpGrantModule.HTTP_CONNECTION_GRANT_TYPE,
          purpose: GRANT_PURPOSE_NODE_ATTACH,
          url: 'http://downstream',
          toConnectorConfig: () =>
            HttpGrantModule.httpGrantToConnectorConfig({
              type: HttpGrantModule.HTTP_CONNECTION_GRANT_TYPE,
              purpose: GRANT_PURPOSE_NODE_ATTACH,
              url: 'http://downstream',
            }),
        },
        selectionReason: 'default',
        fallbackUsed: false,
      }));
  });

  describe('onNodeStarted', () => {
    it('starts the HTTP server when not already running', async () => {
      const server = createStubServer('http://listener', {
        isRunning: false,
      });
      const listener = new HttpListener({ httpServer: server });
      const node: RoutingNodeLike & { createOriginConnector: jest.Mock } = {
        publicUrl: 'http://listener',
        createOriginConnector: jest.fn().mockResolvedValue({
          connector: { pushToReceive: jest.fn() },
          pushToReceive: jest.fn(),
        }),
        securityManager: null,
      } as unknown as RoutingNodeLike & { createOriginConnector: jest.Mock };

      await listener.onNodeInitialized(node);

      await listener.onNodeStarted(node);

      expect(server.start).toHaveBeenCalledTimes(1);
    });

    it('does not restart an already running HTTP server', async () => {
      const server = createStubServer('http://listener', {
        isRunning: true,
      });
      const listener = new HttpListener({ httpServer: server });
      const node: RoutingNodeLike & { createOriginConnector: jest.Mock } = {
        publicUrl: 'http://listener',
        createOriginConnector: jest.fn().mockResolvedValue({
          connector: { pushToReceive: jest.fn() },
          pushToReceive: jest.fn(),
        }),
        securityManager: null,
      } as unknown as RoutingNodeLike & { createOriginConnector: jest.Mock };

      await listener.onNodeInitialized(node);
      server.start.mockClear();

      await listener.onNodeStarted(node);

      expect(server.start).not.toHaveBeenCalled();
    });
  });

  afterEach(() => {
    selectCallbackGrant.mockRestore();
  });

  const createStubServer = (
    baseUrl: string | null,
    options: { isRunning?: boolean } = {}
  ): HttpServer & {
    includeRouter: jest.Mock;
    start: jest.Mock;
    stop: jest.Mock;
  } => ({
    host: '127.0.0.1',
    port: 8080,
    isRunning: options.isRunning ?? true,
    actualHost: '127.0.0.1',
    actualPort: 8080,
    actualBaseUrl: baseUrl,
    includeRouter: jest.fn(async () => undefined),
    start: jest.fn(async () => undefined),
    stop: jest.fn(async () => undefined),
  });

  const createReply = () => {
    const send = jest.fn();
    const code = jest.fn(() => ({ send }));
    const reply = {
      code,
      send,
    } as unknown as FastifyReply & { send: jest.Mock } & {
      code: jest.Mock;
    };
    return { reply, send, code };
  };

  const createConnector = () => {
    const pushToReceive = jest.fn(async (_message: any) => undefined);
    return {
      connector: { pushToReceive } as unknown as FameConnector,
      pushToReceive,
    };
  };

  it('exposes the most recently created listener instance', () => {
    const server = createStubServer('http://localhost:8080');
    const listener = new HttpListener({ httpServer: server });

    expect(getHttpListenerInstance()).toBe(listener);
  });

  describe('asCallbackGrant', () => {
    it('returns null when no base URL is available', () => {
      const listener = new HttpListener({ httpServer: createStubServer(null) });
      expect(listener.asCallbackGrant()).toBeNull();
    });

    it('returns grant with default auth when reverse auth config is null', () => {
      const listener = new HttpListener({
        httpServer: createStubServer('http://localhost:3000'),
      });
      (listener as any)._reverseAuthConfig = null;

      const grant = listener.asCallbackGrant();
      expect(grant).toEqual({
        type: HttpGrantModule.HTTP_CONNECTION_GRANT_TYPE,
        url: 'http://localhost:3000/fame/v1/ingress/upstream',
        auth: { type: 'NoAuth' },
      });
    });

    it('uses reverse auth config when present', () => {
      const listener = new HttpListener({
        httpServer: createStubServer('http://public'),
      });
      (listener as any)._reverseAuthConfig = {
        type: 'CustomAuth',
        token: 'abc',
      };

      const grant = listener.asCallbackGrant();
      expect(grant).toEqual({
        type: HttpGrantModule.HTTP_CONNECTION_GRANT_TYPE,
        url: 'http://public/fame/v1/ingress/upstream',
        auth: { type: 'CustomAuth', token: 'abc' },
      });
    });
  });

  describe('onNodeInitialized', () => {
    it('allows initialization with non-routing nodes', async () => {
      const server = createStubServer('http://local');
      const listener = new HttpListener({
        httpServer: server,
      });

      const nonRoutingNode = {
        publicUrl: 'http://local',
        securityManager: null,
      } as unknown as NodeLike;

      await expect(
        listener.onNodeInitialized(nonRoutingNode as any)
      ).resolves.toBeUndefined();

      expect(listener.baseUrl).toBe('http://local');
      expect(listener.httpServer.includeRouter).toHaveBeenCalledTimes(1);
      expect((listener as any)._routingNode).toBeNull();
    });

    it('registers router only once and refreshes reverse auth config', async () => {
      const authorizer: Authorizer = {
        authenticate: jest.fn(),
        createReverseAuthorizationConfig: jest
          .fn()
          .mockResolvedValue({ type: 'Reverse', enabled: true }),
      } as unknown as Authorizer;

      const listener = new HttpListener({
        httpServer: createStubServer('http://host'),
        authorizer,
      });

      const { connector } = createConnector();
      const node: RoutingNodeLike & {
        publicUrl: string | null;
        createOriginConnector: jest.Mock;
        securityManager: { authorizer?: Authorizer } | null;
      } = {
        publicUrl: 'http://host',
        createOriginConnector: jest.fn().mockResolvedValue(connector),
        securityManager: { authorizer },
      } as unknown as RoutingNodeLike & {
        publicUrl: string | null;
        createOriginConnector: jest.Mock;
        securityManager: { authorizer?: Authorizer } | null;
      };

      await listener.onNodeInitialized(node);
      await listener.onNodeInitialized(node);

      expect(listener.baseUrl).toBe('http://host');
      expect((listener as any)._reverseAuthConfig).toEqual({
        type: 'Reverse',
        enabled: true,
      });
      expect(authorizer.createReverseAuthorizationConfig).toHaveBeenCalledTimes(
        1
      );
      expect(listener.httpServer.includeRouter).toHaveBeenCalledTimes(1);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'http_routes_registered',
        expect.any(Object)
      );
    });

    it('falls back to HTTP server base URL when node lacks public URL', async () => {
      const server = createStubServer('http://actual-base');
      const listener = new HttpListener({ httpServer: server });
      const node: RoutingNodeLike & {
        publicUrl?: string | null;
        createOriginConnector: jest.Mock;
        securityManager: { authorizer?: Authorizer } | null;
      } = {
        publicUrl: undefined,
        createOriginConnector: jest.fn(),
        securityManager: { authorizer: undefined },
      } as unknown as RoutingNodeLike & {
        publicUrl?: string | null;
        createOriginConnector: jest.Mock;
        securityManager: { authorizer?: Authorizer } | null;
      };

      await listener.onNodeInitialized(node);

      expect((listener as any)._publicUrl).toBeNull();
      expect(listener.baseUrl).toBe('http://actual-base');
    });
  });

  describe('onNodeStopped', () => {
    it('releases DefaultHttpServer instances', async () => {
      const fakeDefault = Object.create(
        DefaultHttpServer.prototype
      ) as HttpServer;
      Object.defineProperties(fakeDefault, {
        host: { get: () => '127.0.0.1' },
        port: { get: () => 8080 },
        isRunning: { get: () => true },
        actualHost: { get: () => '127.0.0.1' },
        actualPort: { get: () => 8080 },
        actualBaseUrl: { get: () => 'http://listener' },
      });
      const releaseSpy = jest
        .spyOn(DefaultHttpServer, 'release')
        .mockResolvedValue(undefined);

      const listener = new HttpListener({
        httpServer: fakeDefault as HttpServer,
      });
      await listener.onNodeStopped({} as RoutingNodeLike);

      expect(releaseSpy).toHaveBeenCalledWith({
        host: '127.0.0.1',
        port: 8080,
      });
      releaseSpy.mockRestore();
    });

    it('does not release non-default HTTP servers', async () => {
      const listener = new HttpListener({
        httpServer: createStubServer('http://listener'),
      });
      const releaseSpy = jest
        .spyOn(DefaultHttpServer, 'release')
        .mockResolvedValue(undefined);

      await listener.onNodeStopped({} as RoutingNodeLike);

      expect(releaseSpy).not.toHaveBeenCalled();
      releaseSpy.mockRestore();
    });
  });

  describe('grant conversion', () => {
    it('converts HTTP grants', () => {
      const listener = new HttpListener({
        httpServer: createStubServer('http://host'),
      });
      const httpSpy = jest.spyOn(HttpGrantModule, 'httpGrantToConnectorConfig');
      const grant = {
        type: HttpGrantModule.HTTP_CONNECTION_GRANT_TYPE,
        purpose: GRANT_PURPOSE_NODE_ATTACH,
        url: 'http://downstream',
      };

      const result = (listener as any)._grantToConnectorConfig(grant);

      expect(result).toEqual({
        type: HttpGrantModule.HTTP_STATELESS_CONNECTOR_TYPE,
        url: 'http://downstream',
        auth: undefined,
      });
      expect(httpSpy).toHaveBeenCalledWith(grant);
      httpSpy.mockRestore();
    });

    it('converts WebSocket grants', () => {
      const listener = new HttpListener({
        httpServer: createStubServer('http://host'),
      });
      const wsSpy = jest.spyOn(
        WebSocketGrantModule,
        'websocketGrantToConnectorConfig'
      );
      const grant = {
        type: WebSocketGrantModule.WEBSOCKET_CONNECTION_GRANT_TYPE,
        purpose: GRANT_PURPOSE_NODE_ATTACH,
        url: 'ws://child',
      };

      const result = (listener as any)._grantToConnectorConfig(grant);

      expect(result).toEqual({
        type: 'WebSocketConnector',
        url: 'ws://child',
        auth: undefined,
      });
      expect(wsSpy).toHaveBeenCalledWith(grant);
      wsSpy.mockRestore();
    });

    it('delegates to custom connector config converter when available', () => {
      const listener = new HttpListener({
        httpServer: createStubServer('http://host'),
      });
      const grant = {
        type: 'CUSTOM',
        toConnectorConfig: jest.fn(() => ({ type: 'custom' })),
      };
      const result = (listener as any)._grantToConnectorConfig(grant);
      expect(result).toEqual({ type: 'custom' });
      expect(grant.toConnectorConfig).toHaveBeenCalled();
    });

    it('throws for unsupported grant types', () => {
      const listener = new HttpListener({
        httpServer: createStubServer('http://host'),
      });
      expect(() =>
        (listener as any)._grantToConnectorConfig({ type: 'UNKNOWN' })
      ).toThrow('Unsupported grant type: UNKNOWN');
    });
  });

  describe('_getExistingConnector', () => {
    it('returns null when node or route manager unavailable', () => {
      const listener = new HttpListener({
        httpServer: createStubServer('http://host'),
      });
      expect((listener as any)._getExistingConnector('child')).toBeNull();

      const node = { routeManager: undefined } as unknown as RoutingNodeLike;
      (listener as any)._node = node;
      (listener as any)._routingNode = node;
      expect((listener as any)._getExistingConnector('child')).toBeNull();
    });

    it('returns existing connector from downstream routes', () => {
      const listener = new HttpListener({
        httpServer: createStubServer('http://host'),
      });
      const { connector } = createConnector();
      const routeManager = {
        downstreamRoutes: new Map([['child', connector]]),
        _pending_routes: new Map(),
      };
      const routingNode = { routeManager } as unknown as RoutingNodeLike;
      (listener as any)._node = routingNode;
      (listener as any)._routingNode = routingNode;

      expect((listener as any)._getExistingConnector('child')).toBe(connector);
    });

    it('returns connector from pending routes', () => {
      const listener = new HttpListener({
        httpServer: createStubServer('http://host'),
      });
      const { connector } = createConnector();
      const routeManager = {
        downstreamRoutes: new Map(),
        _pending_routes: new Map([['child', { connector }]]),
      };
      const routingNode = { routeManager } as unknown as RoutingNodeLike;
      (listener as any)._node = routingNode;
      (listener as any)._routingNode = routingNode;

      expect((listener as any)._getExistingConnector('child')).toBe(connector);
    });
  });

  describe('_parseEnvelope', () => {
    it('handles buffers, strings, and objects', () => {
      const listener = new HttpListener({
        httpServer: createStubServer('http://host'),
      });

      const buffer = Buffer.from(
        JSON.stringify({ frame: { type: 'NodeAttach' }, test: true })
      );
      expect((listener as any)._parseEnvelope(buffer)).toEqual({
        frame: { type: 'NodeAttach' },
        test: true,
      });

      const jsonString = JSON.stringify({ frame: { type: 'Message' } });
      expect((listener as any)._parseEnvelope(jsonString)).toEqual({
        frame: { type: 'Message' },
      });

      expect(
        (listener as any)._parseEnvelope({ frame: { type: 'Other' } })
      ).toEqual({
        frame: { type: 'Other' },
      });
    });

    it('returns null and logs when JSON parsing fails', () => {
      const listener = new HttpListener({
        httpServer: createStubServer('http://host'),
      });
      expect((listener as any)._parseEnvelope('{')).toBeNull();
      expect(mockLogger.warning).toHaveBeenCalledWith(
        'http_listener_envelope_parse_failed',
        expect.any(Object)
      );
    });

    it('returns null for nullish bodies', () => {
      const listener = new HttpListener({
        httpServer: createStubServer('http://host'),
      });
      expect((listener as any)._parseEnvelope(null)).toBeNull();
      expect((listener as any)._parseEnvelope(undefined)).toBeNull();
    });

    it('returns null for unsupported primitive bodies', () => {
      const listener = new HttpListener({
        httpServer: createStubServer('http://host'),
      });
      expect((listener as any)._parseEnvelope(42)).toBeNull();
    });
  });

  describe('_handleNodeAttachFrame', () => {
    it('throws when node is not initialized', async () => {
      const listener = new HttpListener({
        httpServer: createStubServer('http://host'),
      });

      await expect(
        (listener as any)._handleNodeAttachFrame({
          childId: 'child',
          attachFrame: { type: 'NodeAttach', systemId: 'child' },
          envelope: { frame: { type: 'NodeAttach', systemId: 'child' } },
        })
      ).rejects.toThrow('Node not initialized');
    });

    it('passes authorization context when creating connectors', async () => {
      const listener = new HttpListener({
        httpServer: createStubServer('http://host'),
      });
      const { connector } = createConnector();
      const node: RoutingNodeLike & { createOriginConnector: jest.Mock } = {
        createOriginConnector: jest.fn().mockResolvedValue(connector),
        publicUrl: null,
        securityManager: { authorizer: undefined },
      } as unknown as RoutingNodeLike & { createOriginConnector: jest.Mock };
      (listener as any)._node = node;
      (listener as any)._routingNode = node;

      const attachFrame = {
        type: 'NodeAttach',
        systemId: 'child',
        callbackGrants: [
          {
            type: HttpGrantModule.HTTP_CONNECTION_GRANT_TYPE,
            purpose: GRANT_PURPOSE_NODE_ATTACH,
            url: 'http://child/downstream',
          },
        ],
      } as const;

      const result = await (listener as any)._handleNodeAttachFrame({
        childId: 'child',
        attachFrame,
        envelope: { frame: attachFrame },
        authorization: { principal: 'node' },
      });

      expect(node.createOriginConnector).toHaveBeenCalledWith(
        expect.objectContaining({ authorization: { principal: 'node' } })
      );
      expect(result).toBe(connector);
    });

    it('rejects downstream attachments for non-routing nodes', async () => {
      const listener = new HttpListener({
        httpServer: createStubServer('http://host'),
      });
      const nonRouting = {
        publicUrl: null,
        securityManager: { authorizer: undefined },
      } as unknown as NodeLike;
      (listener as any)._node = nonRouting;

      await expect(
        (listener as any)._handleNodeAttachFrame({
          childId: 'child',
          attachFrame: {
            type: 'NodeAttach',
            systemId: 'child',
            callbackGrants: [],
          },
          envelope: { frame: { type: 'NodeAttach', systemId: 'child' } },
        })
      ).rejects.toThrow('Node does not support downstream attachments');
    });
  });

  describe('_authenticateRequest', () => {
    it('returns undefined when no authorizer is configured', async () => {
      const listener = new HttpListener({
        httpServer: createStubServer('http://host'),
      });
      (listener as any)._node = { securityManager: null };
      await expect(
        (listener as any)._authenticateRequest(undefined)
      ).resolves.toBeUndefined();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'http_ingress_no_authorization'
      );
    });

    it('throws when authentication fails or throws non-Error', async () => {
      const authorizer: Authorizer = {
        authenticate: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockRejectedValueOnce('boom'),
      } as unknown as Authorizer;
      const listener = new HttpListener({
        httpServer: createStubServer('http://host'),
        authorizer,
      });

      await expect(
        (listener as any)._authenticateRequest('token')
      ).rejects.toThrow('Authentication failed');
      await expect(
        (listener as any)._authenticateRequest('token')
      ).rejects.toThrow('boom');
    });
  });

  describe('_handleIngressError', () => {
    it('returns 429 when receive queue is full', () => {
      const listener = new HttpListener({
        httpServer: createStubServer('http://host'),
      });
      const { reply, send, code } = createReply();

      (listener as any)._handleIngressError(
        new QueueFullError(),
        reply,
        'downstream',
        'child-queue'
      );

      expect(code).toHaveBeenCalledWith(429);
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'receiver busy' })
      );
      expect(mockLogger.warning).toHaveBeenCalledWith(
        'http_downstream_receiver_busy',
        {
          childId: 'child-queue',
        }
      );
    });

    it('distinguishes authentication errors', () => {
      const listener = new HttpListener({
        httpServer: createStubServer('http://host'),
      });
      const { reply } = createReply();

      (listener as any)._handleIngressError(
        new Error('Authentication failed'),
        reply,
        'upstream'
      );
      expect(reply.code).toHaveBeenCalledWith(401);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'http_upstream_ingress_error',
        {
          childId: undefined,
          error: 'Authentication failed',
        }
      );
    });

    it('handles unknown error values', () => {
      const listener = new HttpListener({
        httpServer: createStubServer('http://host'),
      });
      const { reply } = createReply();

      (listener as any)._handleIngressError(
        'boom',
        reply,
        'downstream',
        'child-1'
      );
      expect(reply.code).toHaveBeenCalledWith(500);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'http_downstream_ingress_error',
        {
          childId: 'child-1',
          error: 'boom',
        }
      );
    });
  });

  describe('_refreshReverseAuthConfig', () => {
    it('uses default config when authorizer missing or throws', async () => {
      const listener = new HttpListener({
        httpServer: createStubServer('http://host'),
      });
      const nodeWithoutAuthorizer = {
        securityManager: null,
      } as unknown as RoutingNodeLike;
      await (listener as any)._refreshReverseAuthConfig(nodeWithoutAuthorizer);
      expect((listener as any)._reverseAuthConfig).toEqual({ type: 'NoAuth' });

      const failingAuthorizer: Authorizer = {
        authenticate: jest.fn(),
        createReverseAuthorizationConfig: jest
          .fn()
          .mockRejectedValue(new Error('nope')),
      } as unknown as Authorizer;
      const listenerWithAuth = new HttpListener({
        httpServer: createStubServer('http://host'),
        authorizer: failingAuthorizer,
      });
      const nodeWithManager = {
        securityManager: { authorizer: failingAuthorizer },
      } as unknown as RoutingNodeLike;

      await (listenerWithAuth as any)._refreshReverseAuthConfig(
        nodeWithManager
      );
      expect((listenerWithAuth as any)._reverseAuthConfig).toEqual({
        type: 'NoAuth',
      });
      expect(mockLogger.warning).toHaveBeenCalledWith(
        'reverse_auth_config_failure',
        expect.any(Object)
      );
    });

    it('stores reverse config when available', async () => {
      const authorizer: Authorizer = {
        authenticate: jest.fn(),
        createReverseAuthorizationConfig: jest
          .fn()
          .mockResolvedValue({ type: 'Issued' }),
      } as unknown as Authorizer;
      const listener = new HttpListener({
        httpServer: createStubServer('http://host'),
        authorizer,
      });
      const node = {
        securityManager: { authorizer },
      } as unknown as RoutingNodeLike;

      await (listener as any)._refreshReverseAuthConfig(node);
      expect((listener as any)._reverseAuthConfig).toEqual({ type: 'Issued' });
    });
  });

  describe('ingress handlers', () => {
    const createNodeWithConnector = () => {
      const { connector, pushToReceive } = createConnector();
      return {
        connector,
        pushMock: pushToReceive,
        node: {
          upstreamConnector: connector,
          publicUrl: 'http://public',
          createOriginConnector: jest.fn().mockResolvedValue(connector),
          routeManager: {
            downstreamRoutes: new Map(),
            _pending_routes: new Map(),
          },
          securityManager: { authorizer: undefined },
        } as unknown as RoutingNodeLike,
      };
    };

    it('returns 503 when node not initialized for upstream ingress', async () => {
      const listener = new HttpListener({
        httpServer: createStubServer('http://host'),
      });
      const { reply } = createReply();

      await (listener as any)._handleUpstreamIngress({ body: {} }, reply);
      expect(reply.code).toHaveBeenCalledWith(503);
    });

    it('validates upstream envelope parsing and connector availability', async () => {
      const listener = new HttpListener({
        httpServer: createStubServer('http://host'),
      });
      const { node } = createNodeWithConnector();
      (listener as any)._node = node;
      (listener as any)._routingNode = node;

      const { reply: invalidReply } = createReply();
      await (listener as any)._handleUpstreamIngress(
        {
          body: 'not json',
          headers: {},
        },
        invalidReply
      );
      expect(invalidReply.code).toHaveBeenCalledWith(400);

      const { reply: missingConnectorReply } = createReply();
      const nodeWithoutUpstream = {
        ...node,
        upstreamConnector: null,
      } as RoutingNodeLike;
      (listener as any)._node = nodeWithoutUpstream;
      (listener as any)._routingNode = nodeWithoutUpstream;
      await (listener as any)._handleUpstreamIngress(
        { body: {}, headers: {} },
        missingConnectorReply
      );
      expect(missingConnectorReply.code).toHaveBeenCalledWith(503);
    });

    it('delivers upstream messages and includes security context', async () => {
      const authorizer: Authorizer = {
        authenticate: jest.fn().mockResolvedValue({ principal: 'node' }),
      } as unknown as Authorizer;
      const listener = new HttpListener({
        httpServer: createStubServer('http://host'),
        authorizer,
      });
      const { node, pushMock } = createNodeWithConnector();
      (listener as any)._node = node;
      (listener as any)._routingNode = node;

      const { reply } = createReply();
      const envelope = { frame: { type: 'Message' } };
      await (listener as any)._handleUpstreamIngress(
        {
          body: envelope,
          headers: { authorization: 'token' },
        },
        reply
      );

      expect(pushMock).toHaveBeenCalledTimes(1);
      const message = pushMock.mock.calls[0][0] as any;
      expect(message).toBeInstanceOf(FameChannelMessage);
      expect(message.context).toBeDefined();
      expect(message.context.originType).toBe(DeliveryOriginType.UPSTREAM);
      expect(message.context.security?.authorization).toEqual({
        principal: 'node',
      });
      expect(reply.code).toHaveBeenCalledWith(202);
    });

    it('handles downstream ingress including attach frames and missing connectors', async () => {
      const authorizer: Authorizer = {
        authenticate: jest.fn().mockResolvedValue({ principal: 'node' }),
      } as unknown as Authorizer;
      const listener = new HttpListener({
        httpServer: createStubServer('http://host'),
        authorizer,
      });
      const { connector, pushToReceive: downstreamPush } = createConnector();
      const node: RoutingNodeLike & {
        routeManager: any;
        publicUrl: string | null;
      } = {
        publicUrl: 'http://public',
        upstreamConnector: connector,
        createOriginConnector: jest.fn().mockResolvedValue(connector),
        routeManager: {
          downstreamRoutes: new Map(),
          _pending_routes: new Map(),
        },
        securityManager: { authorizer },
      } as unknown as RoutingNodeLike & {
        routeManager: any;
        publicUrl: string | null;
      };
      (listener as any)._node = node;
      (listener as any)._routingNode = node;

      const { reply: notInitialized } = createReply();
      (listener as any)._node = null;
      (listener as any)._routingNode = null;
      await (listener as any)._handleDownstreamIngress(
        { params: { childId: 'child' }, body: {} },
        notInitialized
      );
      expect(notInitialized.code).toHaveBeenCalledWith(503);

      (listener as any)._node = node;
      (listener as any)._routingNode = node;
      const { reply: mismatchReply } = createReply();
      const attachEnvelope = {
        frame: { type: 'NodeAttach', systemId: 'other' },
      };
      await (listener as any)._handleDownstreamIngress(
        {
          params: { childId: 'child' },
          body: attachEnvelope,
          headers: {},
        },
        mismatchReply
      );
      expect(mismatchReply.code).toHaveBeenCalledWith(400);
      expect(mockLogger.warning).toHaveBeenCalledWith(
        'child_id_mismatch',
        expect.any(Object)
      );

      const { reply: attachReply } = createReply();
      const validEnvelope = {
        frame: {
          type: 'NodeAttach',
          systemId: 'child',
          callbackGrants: [
            {
              type: HttpGrantModule.HTTP_CONNECTION_GRANT_TYPE,
              purpose: GRANT_PURPOSE_NODE_ATTACH,
              url: 'http://child/downstream',
            },
          ],
        },
      };
      await (listener as any)._handleDownstreamIngress(
        {
          params: { childId: 'child' },
          body: validEnvelope,
          headers: { authorization: 'token' },
        },
        attachReply
      );
      expect(mockLogger.error).not.toHaveBeenCalled();
      expect(node.createOriginConnector).toHaveBeenCalledWith(
        expect.objectContaining({ systemId: 'child' })
      );
      expect(downstreamPush).toHaveBeenCalledWith(
        expect.any(FameChannelMessage)
      );
      expect(selectCallbackGrant).toHaveBeenCalledWith(
        expect.any(grantPolicyModule.GrantSelectionContext)
      );
      const attachMessage = downstreamPush.mock.calls[
        downstreamPush.mock.calls.length - 1
      ]?.[0] as any;
      expect(attachMessage.context.security?.authorization).toEqual({
        principal: 'node',
      });
      expect(attachReply.code).toHaveBeenCalledWith(202);

      const { reply: missingConnectorReply } = createReply();
      await (listener as any)._handleDownstreamIngress(
        {
          params: { childId: 'no-connector' },
          body: { frame: { type: 'Message' } },
          headers: {},
        },
        missingConnectorReply
      );
      expect(missingConnectorReply.code).toHaveBeenCalledWith(400);
      expect(mockLogger.warning).toHaveBeenCalledWith(
        'no_connector_for_child',
        {
          childId: 'no-connector',
        }
      );

      node.routeManager.downstreamRoutes.set('child', connector);
      const { reply: messageReply } = createReply();
      await (listener as any)._handleDownstreamIngress(
        {
          params: { childId: 'child' },
          body: { frame: { type: 'Message' } },
          headers: {},
        },
        messageReply
      );
      expect(messageReply.code).toHaveBeenCalledWith(202);
      const { reply: invalidBody } = createReply();
      await (listener as any)._handleDownstreamIngress(
        {
          params: { childId: 'child' },
          body: 'not json',
          headers: {},
        },
        invalidBody
      );
      expect(invalidBody.code).toHaveBeenCalledWith(400);

      const { reply: messageWithAuth } = createReply();
      await (listener as any)._handleDownstreamIngress(
        {
          params: { childId: 'child' },
          body: { frame: { type: 'Message' } },
          headers: { authorization: 'token' },
        },
        messageWithAuth
      );
      const downstreamMessage = downstreamPush.mock.calls[
        downstreamPush.mock.calls.length - 1
      ]?.[0] as any;
      expect(downstreamMessage.context.security?.authorization).toEqual({
        principal: 'node',
      });
      expect(messageWithAuth.code).toHaveBeenCalledWith(202);
    });
  });
});
