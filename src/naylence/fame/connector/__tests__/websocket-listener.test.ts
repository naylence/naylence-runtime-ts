import { DefaultHttpServer } from '../default-http-server.js';
import {
  WebSocketListener,
  getWebsocketConnector,
  getWebsocketListenerInstance,
} from '../websocket-listener.js';
import { WebSocketConnector, WebSocketState } from '../websocket-connector.js';
import type { AuthorizationContext } from '@naylence/core';
import type { Authorizer } from '../../security/auth/authorizer.js';
import type { HttpServer } from '../http-server.js';

function createHttpServerStub(
  overrides: Partial<HttpServer> & Record<string, unknown> = {}
): HttpServer {
  const includeRouter = overrides.includeRouter ?? jest.fn(async () => {});
  const start = overrides.start ?? (async () => {});
  const stop = overrides.stop ?? (async () => {});

  const base: HttpServer = {
    host: 'localhost',
    port: 8080,
    isRunning: false,
    actualHost: 'localhost',
    actualPort: 8080,
    actualBaseUrl: 'http://localhost:8080',
    start,
    stop,
    includeRouter: includeRouter as HttpServer['includeRouter'],
  };

  return {
    ...base,
    ...overrides,
    includeRouter: includeRouter as HttpServer['includeRouter'],
    start: start as HttpServer['start'],
    stop: stop as HttpServer['stop'],
  };
}

function createSocketStub(): {
  socket: any;
  close: jest.Mock;
  send: jest.Mock;
} {
  const close = jest.fn();
  const send = jest.fn();
  const socket = {
    readyState: WebSocketState.OPEN,
    send,
    close,
  };
  return { socket, close, send };
}

describe('WebSocketListener token extraction', () => {
  function createListener(): WebSocketListener {
    return new WebSocketListener({ httpServer: createHttpServerStub() });
  }

  function extractToken(
    listener: WebSocketListener,
    header: string | string[] | undefined
  ): string {
    return (
      listener as unknown as {
        _extractBearerToken: (value: string | string[] | undefined) => string;
      }
    )._extractBearerToken(header);
  }

  test('extracts token when provided as comma-separated subprotocol', () => {
    const listener = createListener();
    const token = extractToken(listener, 'bearer, my-token');

    expect(token).toBe('my-token');
  });

  test('accepts uppercase bearer prefix', () => {
    const listener = createListener();
    const token = extractToken(listener, 'Bearer, another-token');

    expect(token).toBe('another-token');
  });

  test('extracts token when provided in same segment', () => {
    const listener = createListener();
    const token = extractToken(listener, 'Bearer yet-another-token');

    expect(token).toBe('yet-another-token');
  });

  test('returns empty string when token is missing', () => {
    const listener = createListener();
    const token = extractToken(listener, 'bearer');

    expect(token).toBe('');
  });

  test('scans across multiple header values', () => {
    const listener = createListener();
    const token = extractToken(listener, ['apples', 'bearer, final-token']);

    expect(token).toBe('final-token');
  });
});

describe('WebSocketListener grants and lifecycle', () => {
  test('getCallbackGrant returns listener metadata', () => {
    const httpServer = createHttpServerStub();
    const listener = new WebSocketListener({ httpServer });

    expect(listener.getCallbackGrant()).toEqual({
      type: 'WebSocketListener',
      baseUrl: 'http://localhost:8080',
      base_url: 'http://localhost:8080',
      host: 'localhost',
      port: 8080,
    });
  });

  test('asCallbackGrant returns null when base url unavailable', () => {
    const httpServer = createHttpServerStub({
      actualBaseUrl: null,
      actualHost: null,
      actualPort: null,
    });
    const listener = new WebSocketListener({ httpServer });

    expect(listener.asCallbackGrant()).toBeNull();
  });

  test('asCallbackGrant converts http urls to websocket scheme', () => {
    const httpServer = createHttpServerStub();
    const listener = new WebSocketListener({ httpServer });

    expect(listener.asCallbackGrant()).toEqual({
      type: 'WebSocketStatelessConnector',
      url: 'ws://localhost:8080/fame/v1/attach/ws/upstream',
    });
  });

  test('onNodeInitialized registers router for routing nodes', async () => {
    const includeRouter = jest.fn(async () => {});
    const httpServer = createHttpServerStub({ includeRouter });
    const listener = new WebSocketListener({ httpServer });
    const node = {
      createOriginConnector: jest.fn(),
      publicUrl: 'https://public.example',
      id: 'node-1',
    };

    await listener.onNodeInitialized(node as any);

    expect(includeRouter).toHaveBeenCalledWith(expect.any(Function), {
      prefix: '/fame/v1/attach',
    });
    expect(listener.baseUrl).toBe('https://public.example');

    includeRouter.mockClear();
    await listener.onNodeInitialized(node as any);
    expect(includeRouter).not.toHaveBeenCalled();
  });

  test('onNodeInitialized stores null public url when node lacks value', async () => {
    const includeRouter = jest.fn(async () => {});
    const httpServer = createHttpServerStub({ includeRouter });
    const listener = new WebSocketListener({ httpServer });
    const node = { createOriginConnector: jest.fn(), id: 'node-1' };

    await listener.onNodeInitialized(node as any);

    expect(listener.baseUrl).toBe('http://localhost:8080');
    expect(includeRouter).toHaveBeenCalledTimes(1);
  });

  test('onNodeStarted starts the shared HTTP server when not already running', async () => {
    const start = jest.fn(async () => {});
    const httpServer = createHttpServerStub({ start, isRunning: false });
    const listener = new WebSocketListener({ httpServer });
    const node = {
      createOriginConnector: jest.fn(),
      publicUrl: 'https://public.example',
    };

    await listener.onNodeInitialized(node as any);

    await listener.onNodeStarted(node as any);

    expect(start).toHaveBeenCalledTimes(1);
  });

  test('onNodeStarted does not restart an already running HTTP server', async () => {
    const start = jest.fn(async () => {});
    const httpServer = createHttpServerStub({ start, isRunning: true });
    const listener = new WebSocketListener({ httpServer });
    const node = {
      createOriginConnector: jest.fn(),
      publicUrl: 'https://public.example',
    };

    await listener.onNodeInitialized(node as any);
    start.mockClear();

    await listener.onNodeStarted(node as any);

    expect(start).not.toHaveBeenCalled();
  });

  test('onNodeInitialized requires routing node implementation', async () => {
    const listener = new WebSocketListener({
      httpServer: createHttpServerStub(),
    });

    await expect(listener.onNodeInitialized({} as any)).rejects.toThrow(
      'WebSocketListener requires a RoutingNodeLike node instance'
    );
  });

  test('onNodeStopped resets state and releases default server', async () => {
    const releaseSpy = jest
      .spyOn(DefaultHttpServer, 'release')
      .mockResolvedValue();
    const listener = new WebSocketListener({
      httpServer: createHttpServerStub(),
    });
    const internals = listener as any;
    internals._routerRegistered = true;
    internals._node = { id: 'node-1' };
    internals._publicUrl = 'https://public.example';
    const fakeServer = Object.create(DefaultHttpServer.prototype);
    fakeServer._host = 'stub-host';
    fakeServer._port = 1234;
    fakeServer._started = false;
    fakeServer._actualHost = null;
    fakeServer._actualPort = null;
    fakeServer.start = jest.fn();
    fakeServer.stop = jest.fn();
    fakeServer.includeRouter = jest.fn();
    internals._httpServer = fakeServer;

    await listener.onNodeStopped({} as any);

    expect(internals._routerRegistered).toBe(false);
    expect(internals._node).toBeNull();
    expect(internals._publicUrl).toBeNull();
    expect(releaseSpy).toHaveBeenCalledWith({ host: 'stub-host', port: 1234 });

    releaseSpy.mockRestore();
  });

  test('onNodeStopped skips release for non-default servers', async () => {
    const releaseSpy = jest
      .spyOn(DefaultHttpServer, 'release')
      .mockResolvedValue();
    const httpServer = createHttpServerStub();
    const listener = new WebSocketListener({ httpServer });
    const internals = listener as any;
    internals._routerRegistered = true;
    internals._node = { id: 'node-1' };
    internals._publicUrl = 'https://public.example';

    await listener.onNodeStopped({} as any);

    expect(releaseSpy).not.toHaveBeenCalled();
    releaseSpy.mockRestore();
  });

  test('createRouter handler prefers connection socket when present', async () => {
    const listener = new WebSocketListener({
      httpServer: createHttpServerStub(),
    });
    const internals = listener as any;
    const attachSpy = jest
      .spyOn(internals, '_handleWebSocketAttach')
      .mockResolvedValue(undefined);
    const plugin = await listener.createRouter();
    const getMock = jest.fn();

    await plugin({ get: getMock } as any, {} as any);
    const wsRegistration = getMock.mock.calls.find(
      (call) => call[0] === '/ws/:downstreamOrPeer/:systemId'
    );
    const handler = wsRegistration?.[2];

    expect(handler).toBeDefined();
    expect(typeof handler).toBe('function');
    const connection = { socket: { id: 'socket-1' } };
    const request = {
      url: '/fame/v1/attach/ws/downstream/system-1',
      headers: {},
    } as any;

    await handler(connection, request);

    expect(attachSpy).toHaveBeenCalledWith(connection.socket, request);
  });

  test('createRouter handler falls back to connection object when socket missing', async () => {
    const listener = new WebSocketListener({
      httpServer: createHttpServerStub(),
    });
    const internals = listener as any;
    const attachSpy = jest
      .spyOn(internals, '_handleWebSocketAttach')
      .mockResolvedValue(undefined);
    const plugin = await listener.createRouter();
    const getMock = jest.fn();

    await plugin({ get: getMock } as any, {} as any);
    const wsRegistration = getMock.mock.calls.find(
      (call) => call[0] === '/ws/:downstreamOrPeer/:systemId'
    );
    const handler = wsRegistration?.[2];

    expect(handler).toBeDefined();
    expect(typeof handler).toBe('function');
    const connection = { id: 'connection-1' };
    const request = {
      url: '/fame/v1/attach/ws/downstream/system-1',
      headers: {},
    } as any;

    await handler(connection, request);

    expect(attachSpy).toHaveBeenCalledWith(connection, request);
  });
});

describe('WebSocketListener attachment handling', () => {
  function createListener(
    overrides: { authorizer?: Authorizer } = {}
  ): WebSocketListener {
    return new WebSocketListener({
      httpServer: createHttpServerStub(),
      ...overrides,
    });
  }

  function createRequestStub(
    url: string,
    params?: Record<string, unknown>
  ): any {
    return {
      url,
      headers: {},
      raw: { url },
      params,
    };
  }

  test('rejects attachment when params cannot be resolved', async () => {
    const listener = createListener();
    const listenerInternal = listener as any;
    const { socket } = createSocketStub();
    const closeSpy = jest.spyOn(listenerInternal, '_closeSocket');

    await listenerInternal._handleWebSocketAttach(
      socket,
      createRequestStub('/invalid')
    );

    expect(closeSpy).toHaveBeenCalledWith(socket, 1008, 'Invalid attach route');
  });

  test('rejects when node is not initialized', async () => {
    const listener = createListener();
    const listenerInternal = listener as any;
    const { socket } = createSocketStub();
    jest
      .spyOn(listenerInternal, '_resolveAttachParams')
      .mockReturnValue({ downstreamOrPeer: 'downstream', systemId: 'sys-1' });
    const closeSpy = jest.spyOn(listenerInternal, '_closeSocket');

    await listenerInternal._handleWebSocketAttach(
      socket,
      createRequestStub('/ws/downstream/sys-1')
    );

    expect(closeSpy).toHaveBeenCalledWith(
      socket,
      1011,
      'Listener not initialized'
    );
  });

  test('rejects when origin type is invalid', async () => {
    const listener = createListener();
    const listenerInternal = listener as any;
    const { socket } = createSocketStub();
    listenerInternal._node = { id: 'node-1' };
    jest
      .spyOn(listenerInternal, '_resolveAttachParams')
      .mockReturnValue({ downstreamOrPeer: 'invalid', systemId: 'sys-1' });
    const closeSpy = jest.spyOn(listenerInternal, '_closeSocket');

    await listenerInternal._handleWebSocketAttach(
      socket,
      createRequestStub('/ws/invalid/sys-1')
    );

    expect(closeSpy).toHaveBeenCalledWith(socket, 1008, 'Invalid origin type');
  });

  test('rejects invalid origin when raw url missing falls back to request url', async () => {
    const listener = createListener();
    const listenerInternal = listener as any;
    const { socket } = createSocketStub();
    listenerInternal._node = { id: 'node-1' };
    jest
      .spyOn(listenerInternal, '_resolveAttachParams')
      .mockReturnValue({ downstreamOrPeer: 'invalid', systemId: 'sys-1' });
    const closeSpy = jest.spyOn(listenerInternal, '_closeSocket');
    const request = { url: '/ws/invalid/sys-1', headers: {}, raw: {} } as any;

    await listenerInternal._handleWebSocketAttach(socket, request);

    expect(closeSpy).toHaveBeenCalledWith(socket, 1008, 'Invalid origin type');
  });

  test('rejects when system id is missing', async () => {
    const listener = createListener();
    const listenerInternal = listener as any;
    const { socket } = createSocketStub();
    listenerInternal._node = { id: 'node-1' };
    jest
      .spyOn(listenerInternal, '_resolveAttachParams')
      .mockReturnValue({ downstreamOrPeer: 'downstream', systemId: '' });
    const closeSpy = jest.spyOn(listenerInternal, '_closeSocket');

    await listenerInternal._handleWebSocketAttach(
      socket,
      createRequestStub('/ws/downstream/')
    );

    expect(closeSpy).toHaveBeenCalledWith(socket, 1008, 'Missing system id');
  });

  test('rejects when system id matches node id', async () => {
    const listener = createListener();
    const listenerInternal = listener as any;
    const { socket } = createSocketStub();
    listenerInternal._node = { id: 'sys-1' };
    jest
      .spyOn(listenerInternal, '_resolveAttachParams')
      .mockReturnValue({ downstreamOrPeer: 'downstream', systemId: 'sys-1' });
    const closeSpy = jest.spyOn(listenerInternal, '_closeSocket');

    await listenerInternal._handleWebSocketAttach(
      socket,
      createRequestStub('/ws/downstream/sys-1')
    );

    expect(closeSpy).toHaveBeenCalledWith(
      socket,
      1008,
      'Self attachment not allowed'
    );
  });

  test('delegates to connector when authentication succeeds', async () => {
    const listener = createListener();
    const listenerInternal = listener as any;
    const { socket } = createSocketStub();
    listenerInternal._node = { id: 'node-1' };
    jest
      .spyOn(listenerInternal, '_resolveAttachParams')
      .mockReturnValue({ downstreamOrPeer: 'downstream', systemId: 'peer-1' });
    const authSpy = jest
      .spyOn(listenerInternal, '_authenticateConnection')
      .mockResolvedValue({} as AuthorizationContext);
    const connectorMock = {
      waitUntilClosed: jest.fn().mockResolvedValue(undefined),
    };
    const createConnectorSpy = jest
      .spyOn(listenerInternal, '_createWebSocketConnector')
      .mockResolvedValue(connectorMock as any);
    jest.spyOn(listenerInternal, '_closeSocket');

    const request = createRequestStub('/ws/downstream/peer-1');
    request.headers['sec-websocket-protocol'] = 'Bearer valid-token';

    await listenerInternal._handleWebSocketAttach(socket, request);

    expect(authSpy).toHaveBeenCalledWith('valid-token', 'peer-1');
    expect(createConnectorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ systemId: 'peer-1' })
    );
    expect(connectorMock.waitUntilClosed).toHaveBeenCalledTimes(1);
  });

  test('handles authentication errors via attachment error handler', async () => {
    const listener = createListener();
    const listenerInternal = listener as any;
    listenerInternal._node = { id: 'node-1' };
    const { socket } = createSocketStub();
    jest
      .spyOn(listenerInternal, '_resolveAttachParams')
      .mockReturnValue({ downstreamOrPeer: 'downstream', systemId: 'peer-1' });
    const error = new Error('fail');
    jest
      .spyOn(listenerInternal, '_authenticateConnection')
      .mockRejectedValue(error);
    const handleErrorSpy = jest
      .spyOn(listenerInternal, '_handleAttachmentError')
      .mockResolvedValue(undefined);

    await listenerInternal._handleWebSocketAttach(
      socket,
      createRequestStub('/ws/downstream/peer-1')
    );

    expect(handleErrorSpy).toHaveBeenCalledWith(socket, error, 'peer-1');
  });

  test('delegates to connector without authorization when authentication returns undefined', async () => {
    const listener = createListener();
    const listenerInternal = listener as any;
    listenerInternal._node = { id: 'node-1' };
    const { socket } = createSocketStub();
    jest
      .spyOn(listenerInternal, '_resolveAttachParams')
      .mockReturnValue({ downstreamOrPeer: 'downstream', systemId: 'peer-2' });
    jest
      .spyOn(listenerInternal, '_authenticateConnection')
      .mockResolvedValue(undefined);
    const createConnectorSpy = jest
      .spyOn(listenerInternal, '_createWebSocketConnector')
      .mockResolvedValue({
        waitUntilClosed: jest.fn().mockResolvedValue(undefined),
      } as any);

    await listenerInternal._handleWebSocketAttach(
      socket,
      createRequestStub('/ws/downstream/peer-2')
    );

    expect(createConnectorSpy).toHaveBeenCalledWith({
      systemId: 'peer-2',
      websocket: socket,
      originType: expect.anything(),
    });
  });
});

describe('WebSocketListener helpers', () => {
  function access(listener: WebSocketListener): any {
    return listener as any;
  }

  test('maps origin type candidates', () => {
    const listener = new WebSocketListener({
      httpServer: createHttpServerStub(),
    });
    const internals = access(listener);

    expect(internals._mapOriginType('downstream')).toBeDefined();
    expect(internals._mapOriginType('peer')).toBeDefined();
    expect(internals._mapOriginType('unknown')).toBeNull();
  });

  test('resolves params from url when request params missing', () => {
    const listener = new WebSocketListener({
      httpServer: createHttpServerStub(),
    });
    const internals = access(listener);
    const request = {
      url: '/fame/v1/attach/ws/downstream/peer-1',
      headers: {},
      raw: { url: '/fame/v1/attach/ws/downstream/peer-1' },
    } as any;

    expect(internals._resolveAttachParams(request)).toEqual({
      downstreamOrPeer: 'downstream',
      systemId: 'peer-1',
    });
  });

  test('resolves attach params directly from request object', () => {
    const listener = new WebSocketListener({
      httpServer: createHttpServerStub(),
    });
    const internals = access(listener);
    const request = {
      params: { downstreamOrPeer: 'peer', systemId: 'peer-42' },
      url: '/ignored',
      headers: {},
      raw: { url: '/ignored' },
    } as any;

    expect(internals._resolveAttachParams(request)).toEqual({
      downstreamOrPeer: 'peer',
      systemId: 'peer-42',
    });
  });

  test('normalizeRequest unwraps Fastify replies', () => {
    const listener = new WebSocketListener({
      httpServer: createHttpServerStub(),
    });
    const internals = access(listener);
    const request = { url: '/foo', headers: {} };
    const reply = { request };

    expect(internals._normalizeRequest(reply)).toBe(request);
    expect(internals._normalizeRequest(request as any)).toBe(request);
  });

  test('resolveAttachParams returns null when raw url missing', () => {
    const listener = new WebSocketListener({
      httpServer: createHttpServerStub(),
    });
    const internals = access(listener);
    const request = { url: '', headers: {}, raw: {} } as any;

    expect(internals._resolveAttachParams(request)).toBeNull();
  });

  test('resolveAttachParams returns null when ws segments missing', () => {
    const listener = new WebSocketListener({
      httpServer: createHttpServerStub(),
    });
    const internals = access(listener);
    const request = {
      url: '/fame/v1/attach/downstream',
      headers: {},
      raw: { url: '/fame/v1/attach/downstream' },
    } as any;

    expect(internals._resolveAttachParams(request)).toBeNull();
  });

  test('resolveAttachParams returns null when system id missing in ws path', () => {
    const listener = new WebSocketListener({
      httpServer: createHttpServerStub(),
    });
    const internals = access(listener);
    const request = {
      url: '/fame/v1/attach/ws/downstream-only',
      headers: {},
      raw: { url: '/fame/v1/attach/ws/downstream-only' },
    } as any;

    expect(internals._resolveAttachParams(request)).toBeNull();
  });

  test('authenticate connection bypasses authorization when not configured', async () => {
    const listener = new WebSocketListener({
      httpServer: createHttpServerStub(),
    });
    const internals = access(listener);

    await expect(
      internals._authenticateConnection('', 'peer-1')
    ).resolves.toBeUndefined();
  });

  test('authenticate connection succeeds when authorizer returns context', async () => {
    const authorizer: Authorizer = {
      authenticate: jest.fn().mockResolvedValue({ subject: 'abc' }),
      authorize: jest.fn(),
    };
    const listener = new WebSocketListener({
      httpServer: createHttpServerStub(),
      authorizer,
    });
    const internals = access(listener);

    await expect(
      internals._authenticateConnection('token', 'peer-1')
    ).resolves.toEqual({
      subject: 'abc',
    });
    expect(authorizer.authenticate).toHaveBeenCalledWith('Bearer token');
  });

  test('authenticate connection throws when authorizer denies', async () => {
    const authorizer: Authorizer = {
      authenticate: jest.fn().mockResolvedValue(undefined),
      authorize: jest.fn(),
    };
    const listener = new WebSocketListener({
      httpServer: createHttpServerStub(),
      authorizer,
    });
    const internals = access(listener);

    await expect(
      internals._authenticateConnection('token', 'peer-1')
    ).rejects.toThrow('Authentication failed');
  });

  test('authenticate connection wraps unexpected errors', async () => {
    const authorizer: Authorizer = {
      authenticate: jest.fn().mockRejectedValue(new Error('boom')),
      authorize: jest.fn(),
    };
    const listener = new WebSocketListener({
      httpServer: createHttpServerStub(),
      authorizer,
    });
    const internals = access(listener);

    await expect(
      internals._authenticateConnection('token', 'peer-1')
    ).rejects.toThrow('Authorization error');
  });

  test('resolve authorizer prefers constructor override', async () => {
    const override: Authorizer = {
      authenticate: jest.fn(),
      authorize: jest.fn(),
    };
    const listener = new WebSocketListener({
      httpServer: createHttpServerStub(),
      authorizer: override,
    });
    const internals = access(listener);
    internals._node = {
      securityManager: {
        authorizer: { authenticate: jest.fn(), authorize: jest.fn() },
      },
    };

    await expect(internals._resolveAuthorizer()).resolves.toBe(override);
  });

  test('resolve authorizer uses node security manager when available', async () => {
    const nodeAuthorizer: Authorizer = {
      authenticate: jest.fn(),
      authorize: jest.fn(),
    };
    const listener = new WebSocketListener({
      httpServer: createHttpServerStub(),
    });
    const internals = access(listener);
    internals._node = { securityManager: { authorizer: nodeAuthorizer } };

    await expect(internals._resolveAuthorizer()).resolves.toBe(nodeAuthorizer);
  });

  test('resolve authorizer returns undefined when no sources available', async () => {
    const listener = new WebSocketListener({
      httpServer: createHttpServerStub(),
    });
    const internals = access(listener);

    await expect(internals._resolveAuthorizer()).resolves.toBeUndefined();
  });

  test('createWebSocketConnector wraps node connectors', async () => {
    const listener = new WebSocketListener({
      httpServer: createHttpServerStub(),
    });
    const internals = access(listener);
    const socket = createSocketStub().socket;
    const node = {
      createOriginConnector: jest.fn(
        async () => new WebSocketConnector(socket, { type: 'websocket' })
      ),
    };
    internals._node = node;

    const connector = await internals._createWebSocketConnector({
      systemId: 'peer-1',
      websocket: socket,
      originType: 0 as any,
    });

    expect(connector).toBeInstanceOf(WebSocketConnector);
    expect(node.createOriginConnector).toHaveBeenCalledWith(
      expect.objectContaining({ systemId: 'peer-1' })
    );
  });

  test('createWebSocketConnector throws when node not initialized', async () => {
    const listener = new WebSocketListener({
      httpServer: createHttpServerStub(),
    });
    const internals = access(listener);

    await expect(
      internals._createWebSocketConnector({
        systemId: 'peer-1',
        websocket: createSocketStub().socket,
        originType: 0 as any,
      })
    ).rejects.toThrow('Node not initialized');
  });

  test('createWebSocketConnector validates connector type', async () => {
    const listener = new WebSocketListener({
      httpServer: createHttpServerStub(),
    });
    const internals = access(listener);
    internals._node = {
      async createOriginConnector() {
        return {};
      },
    };

    await expect(
      internals._createWebSocketConnector({
        systemId: 'peer-1',
        websocket: createSocketStub().socket,
        originType: 0 as any,
      })
    ).rejects.toThrow('Invalid connector type returned');
  });

  test('createWebSocketConnector forwards authorization context', async () => {
    const listener = new WebSocketListener({
      httpServer: createHttpServerStub(),
    });
    const internals = access(listener);
    const socket = createSocketStub().socket;
    const authorization: AuthorizationContext = {
      authenticated: true,
      authorized: true,
      claims: {},
      grantedScopes: [],
      restrictions: {},
      principal: 'user-1',
    };
    const node = {
      createOriginConnector: jest.fn(async (options: any) => {
        expect(options.authorization).toBe(authorization);
        expect(options.connectorConfig.authorizationContext).toBe(
          authorization
        );
        return new WebSocketConnector(socket, { type: 'websocket' });
      }),
    };
    internals._node = node;

    const connector = await internals._createWebSocketConnector({
      systemId: 'peer-1',
      websocket: socket,
      originType: 0 as any,
      authorization,
    });

    expect(connector).toBeInstanceOf(WebSocketConnector);
  });

  test('handleAttachmentError sends ack frame for authentication issues', async () => {
    const listener = new WebSocketListener({
      httpServer: createHttpServerStub(),
    });
    const internals = access(listener);
    const { socket } = createSocketStub();
    const closeSpy = jest.spyOn(internals, '_closeSocket');
    const authorizer: Authorizer = {
      authenticate: jest.fn().mockResolvedValue(undefined),
      authorize: jest.fn(),
    };
    const authListener = new WebSocketListener({
      httpServer: createHttpServerStub(),
      authorizer,
    });
    const authInternals = access(authListener);
    let authError: Error | undefined;
    try {
      await authInternals._authenticateConnection('token', 'peer-1');
    } catch (error) {
      authError = error as Error;
    }

    expect(authError).toBeInstanceOf(Error);

    await internals._handleAttachmentError(socket, authError, 'peer-1');

    expect(closeSpy).toHaveBeenCalledWith(
      socket,
      1008,
      'Authentication failed'
    );
  });

  test('handleAttachmentError wraps unexpected errors', async () => {
    const listener = new WebSocketListener({
      httpServer: createHttpServerStub(),
    });
    const internals = access(listener);
    const { socket } = createSocketStub();
    const closeSpy = jest.spyOn(internals, '_closeSocket');

    await internals._handleAttachmentError(socket, new Error('boom'), 'peer-1');

    expect(closeSpy).toHaveBeenCalledWith(socket, 1011, 'Internal error');
  });

  test('handleAttachmentError string errors are stringified before closing', async () => {
    const listener = new WebSocketListener({
      httpServer: createHttpServerStub(),
    });
    const internals = access(listener);
    const { socket } = createSocketStub();
    const sendAckSpy = jest
      .spyOn(internals, '_sendAckAndClose')
      .mockResolvedValue(undefined);

    await internals._handleAttachmentError(socket, 'boom', 'peer-1');

    expect(sendAckSpy).toHaveBeenCalledWith(
      socket,
      { ok: false, reason: 'Unhandled error: boom' },
      1011,
      'Internal error'
    );
  });

  test('sendAckAndClose transmits ack payload when socket open', async () => {
    const listener = new WebSocketListener({
      httpServer: createHttpServerStub(),
    });
    const internals = access(listener);
    const { socket, send, close } = createSocketStub();

    await internals._sendAckAndClose(
      socket,
      { ok: true, reason: 'fine' },
      1000,
      'done'
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(1000, 'done');
  });

  test('sendAckAndClose skips payload when socket not open', async () => {
    const listener = new WebSocketListener({
      httpServer: createHttpServerStub(),
    });
    const internals = access(listener);
    const { socket, send, close } = createSocketStub();
    socket.readyState = WebSocketState.CLOSED;

    await internals._sendAckAndClose(socket, { ok: false }, 1000, 'done');

    expect(send).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith(1000, 'done');
  });

  test('sendAckAndClose tolerates send errors', async () => {
    const listener = new WebSocketListener({
      httpServer: createHttpServerStub(),
    });
    const internals = access(listener);
    const close = jest.fn();
    const send = jest.fn(() => {
      throw new Error('send failed');
    });
    const socket = { readyState: WebSocketState.OPEN, send, close };

    await internals._sendAckAndClose(socket, { ok: false }, 1000, 'done');

    expect(close).toHaveBeenCalledWith(1000, 'done');
  });

  test('closeSocket logs but suppresses close errors', () => {
    const listener = new WebSocketListener({
      httpServer: createHttpServerStub(),
    });
    const internals = access(listener);
    const close = jest.fn(() => {
      throw new Error('failure');
    });

    expect(() =>
      internals._closeSocket(
        { readyState: WebSocketState.OPEN, send: jest.fn(), close },
        1000,
        'reason'
      )
    ).not.toThrow();
  });
});

describe('WebSocketListener exports', () => {
  test('getWebsocketListenerInstance returns the most recent listener', () => {
    const first = new WebSocketListener({ httpServer: createHttpServerStub() });

    expect(getWebsocketListenerInstance()).toBe(first);

    const second = new WebSocketListener({
      httpServer: createHttpServerStub({ host: 'remote-host' }),
    });

    expect(getWebsocketListenerInstance()).toBe(second);
  });

  test('getWebsocketConnector returns null by default', () => {
    expect(getWebsocketConnector('peer')).toBeNull();
  });
});
