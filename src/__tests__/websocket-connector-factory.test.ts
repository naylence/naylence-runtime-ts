/**
 * Tests for WebSocket Connector Factory
 */

jest.mock('../naylence/fame/util/logging.js', () => {
  const logger = {
    debug: jest.fn(),
    warning: jest.fn(),
  };

  return {
    getLogger: jest.fn(() => logger),
    __loggerMock: logger,
  };
});

jest.mock('ws', () => {
  const wsConstructorMock = jest.fn();
  return {
    __esModule: true,
    default: wsConstructorMock,
    __wsConstructorMock: wsConstructorMock,
  };
});

jest.mock('fs', () => {
  const readFileSyncMock = jest.fn();
  return {
    __esModule: true,
    readFileSync: readFileSyncMock,
    __readFileSyncMock: readFileSyncMock,
  };
});

import {
  WebSocketConnectorFactory,
  WebSocketConnectorFactoryConfig,
} from '../naylence/fame/connector/websocket-connector-factory';
import {
  WebSocketConnector,
  WebSocketLike,
  WebSocketState,
} from '../naylence/fame/connector/websocket-connector';
import {
  normalizeWebSocketConnectionGrant,
  WEBSOCKET_CONNECTION_GRANT_TYPE,
} from '../naylence/fame/grants/websocket-connection-grant';
import { AuthInjectionStrategyFactory } from '../naylence/fame/security/auth/auth-injection-strategy-factory';
import { FameConnectError } from '../naylence/fame/errors/errors';

type StubAuthConfig = Record<string, unknown> & { type: string };

const { __loggerMock: loggerMock } = jest.requireMock(
  '../naylence/fame/util/logging.js'
) as {
  __loggerMock: { debug: jest.Mock; warning: jest.Mock };
};

const { __wsConstructorMock: wsConstructorMock } = jest.requireMock('ws') as {
  __wsConstructorMock: jest.Mock;
};

const { __readFileSyncMock: readFileSyncMock } = jest.requireMock('fs') as {
  __readFileSyncMock: jest.Mock;
};

const authStrategySpy = jest.spyOn(
  AuthInjectionStrategyFactory,
  'createAuthInjectionStrategy'
);

function createStubAuthStrategy(config: StubAuthConfig) {
  if (!config || typeof config.type !== 'string') {
    throw new Error('Invalid authentication configuration');
  }

  if (config.type === 'WebSocketSubprotocolStrategy') {
    const token = typeof config.token === 'string' ? config.token : undefined;
    if (!token) {
      throw new Error('Token required for WebSocket subprotocol auth strategy');
    }

    return {
      async apply() {
        // No-op, handled during connection setup
      },
      async cleanup() {
        // No-op
      },
      async getSubprotocols() {
        return [`access_token.${token}`];
      },
    };
  }

  if (config.type === 'QueryParamStrategy') {
    const token = typeof config.token === 'string' ? config.token : undefined;
    if (!token) {
      throw new Error('Token required for query param auth strategy');
    }

    return {
      async apply() {
        // Query parameter applied during URL modification
      },
      async cleanup() {
        // No-op
      },
      async modifyUrl(url: string) {
        const separator = url.includes('?') ? '&' : '?';
        return `${url}${separator}access_token=${encodeURIComponent(token)}`;
      },
    };
  }

  if (config.type === 'HeaderStrategy') {
    const token = typeof config.token === 'string' ? config.token : undefined;
    const principal =
      typeof config.principal === 'string' ? config.principal : undefined;
    const grantedScopes = Array.isArray(config.scopes) ? config.scopes : [];
    const headerName =
      typeof config.headerName === 'string' && config.headerName.length > 0
        ? config.headerName
        : 'Authorization';

    return {
      async apply(target: any) {
        if (!target || typeof target !== 'object') {
          return;
        }

        if ('authorizationContext' in target) {
          target.authorizationContext = {
            ...(target.authorizationContext ?? {}),
            authenticated: true,
            authorized: true,
            principal,
            grantedScopes,
            authMethod: 'header',
          };
          if (token && typeof target.setAuthHeader === 'function') {
            target.setAuthHeader(`Bearer ${token}`);
          }
          return;
        }

        if (token) {
          (target as Record<string, string>)[headerName] = `Bearer ${token}`;
        }
      },
      async cleanup() {
        // No-op
      },
    };
  }

  return {
    async apply() {
      // No-op
    },
    async cleanup() {
      // No-op
    },
  };
}

const flushAsync = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

// Mock WebSocket implementation for testing
class MockWebSocket implements WebSocketLike {
  readyState: number = WebSocketState.CONNECTING;
  url: string | undefined;
  protocol?: string;

  onopen?: ((event: any) => void) | null = null;
  onclose?: ((event: any) => void) | null = null;
  onmessage?: ((event: any) => void) | null = null;
  onerror?: ((event: any) => void) | null = null;

  constructor(url?: string) {
    this.url = url;
    // Simulate connection opening
    setTimeout(() => {
      this.readyState = WebSocketState.OPEN;
      if (this.onopen) {
        this.onopen({ type: 'open' });
      }
    }, 10);
  }

  send(_data: string | ArrayBuffer | Uint8Array): void {
    if (this.readyState !== WebSocketState.OPEN) {
      throw new Error('WebSocket is not open');
    }
  }

  close(code?: number, reason?: string): void {
    this.readyState = WebSocketState.CLOSED;
    if (this.onclose) {
      this.onclose({ type: 'close', code: code || 1000, reason: reason || '' });
    }
  }
}

describe('WebSocketConnectorFactory', () => {
  let factory: WebSocketConnectorFactory;

  beforeEach(() => {
    factory = new WebSocketConnectorFactory();
    authStrategySpy.mockImplementation(async (config) => {
      if (!config || typeof (config as { type?: unknown }).type !== 'string') {
        throw new Error('Invalid authentication configuration');
      }

      return createStubAuthStrategy(config as StubAuthConfig);
    });
  });

  afterEach(() => {
    authStrategySpy.mockReset();
  });

  afterAll(() => {
    authStrategySpy.mockRestore();
  });

  describe('constructor', () => {
    it('should create factory with default client factory', () => {
      expect(factory).toBeDefined();
      expect(factory.type).toBe('WebSocketConnector');
    });

    it('should create factory with custom client factory', () => {
      const customClientFactory = jest.fn();
      const customFactory = new WebSocketConnectorFactory(customClientFactory);
      expect(customFactory).toBeDefined();
      expect(customFactory.type).toBe('WebSocketConnector');
    });
  });

  describe('instance methods', () => {
    it('should return supported grant types', () => {
      const supportedTypes = factory.supportedGrantTypes();
      expect(supportedTypes).toEqual([
        WEBSOCKET_CONNECTION_GRANT_TYPE,
        'WebSocketConnector',
      ]);
    });

    it('should convert grant to config', () => {
      const grant = normalizeWebSocketConnectionGrant({
        type: WEBSOCKET_CONNECTION_GRANT_TYPE,
        purpose: 'connection',
        url: 'ws://test.example.com',
        auth: {
          type: 'WebSocketSubprotocolStrategy',
          token: 'test-token',
        },
      });

      const config = factory.configFromGrant(grant);

      expect(config.type).toBe('WebSocketConnector');
      expect(config.url).toBe('ws://test.example.com');
      expect(config.auth?.type).toBe('WebSocketSubprotocolStrategy');
    });

    it('should convert config to grant', () => {
      const config: WebSocketConnectorFactoryConfig = {
        type: 'WebSocketConnector',
        url: 'ws://test.example.com',
        auth: {
          type: 'QueryParamStrategy',
          token: 'test-token',
        },
      };

      const grant = factory.grantFromConfig(config);

      expect(grant.type).toBe(WEBSOCKET_CONNECTION_GRANT_TYPE);
      expect(grant.purpose).toBe('connection');
      expect(grant.url).toBe('ws://test.example.com');
      expect(grant.auth?.type).toBe('QueryParamStrategy');
    });

    it('should throw error for unsupported grant type', () => {
      const invalidGrant = {
        type: 'UnsupportedGrant',
        url: 'ws://test.example.com',
      };

      expect(() => {
        factory.configFromGrant(invalidGrant as any);
      }).toThrow(
        'WebSocketConnectionGrant expected type "WebSocketConnectionGrant", received "UnsupportedGrant"'
      );
    });

    it('should throw error for unsupported config type', () => {
      const invalidConfig = {
        type: 'UnsupportedConnector',
        url: 'ws://test.example.com',
      };

      expect(() => {
        factory.grantFromConfig(invalidConfig as any);
      }).toThrow(
        'WebSocketConnectorFactory only supports WebSocketConnector config'
      );
    });
  });

  describe('create connector', () => {
    it('should create connector with existing WebSocket', async () => {
      const mockWebSocket = new MockWebSocket('ws://test.example.com');
      const config: WebSocketConnectorFactoryConfig = {
        type: 'WebSocketConnector',
        url: 'ws://test.example.com',
      };

      const connector = await factory.create(config, {
        websocket: mockWebSocket,
      });

      expect(connector).toBeInstanceOf(WebSocketConnector);
      expect(connector.state).toBe('initialized');
    });

    it('should create connector with custom client factory', async () => {
      const mockWebSocket = new MockWebSocket('ws://test.example.com');
      const customClientFactory = jest.fn().mockResolvedValue(mockWebSocket);

      const config: WebSocketConnectorFactoryConfig = {
        type: 'WebSocketConnector',
        url: 'ws://test.example.com',
      };

      const connector = await factory.create(config, {
        clientFactory: customClientFactory,
      });

      expect(connector).toBeInstanceOf(WebSocketConnector);
      expect(customClientFactory).toHaveBeenCalledWith(
        'ws://test.example.com',
        undefined,
        undefined
      );
    });

    it('should append system ID to URL', async () => {
      const mockWebSocket = new MockWebSocket(
        'ws://test.example.com/system123'
      );
      const customClientFactory = jest.fn().mockResolvedValue(mockWebSocket);

      const config: WebSocketConnectorFactoryConfig = {
        type: 'WebSocketConnector',
        url: 'ws://test.example.com',
      };

      await factory.create(config, {
        clientFactory: customClientFactory,
        systemId: 'system123',
      });

      expect(customClientFactory).toHaveBeenCalledWith(
        'ws://test.example.com/system123',
        undefined,
        undefined
      );
    });

    it('should throw error when no URL provided', async () => {
      const config: WebSocketConnectorFactoryConfig = {
        type: 'WebSocketConnector',
      };

      await expect(factory.create(config)).rejects.toThrow(
        'WebSocket URL must be provided in config'
      );
    });

    it('should throw error when config has no type', async () => {
      const invalidConfig = {
        url: 'ws://test.example.com',
      };

      await expect(factory.create(invalidConfig as any)).rejects.toThrow(
        'WebSocketConnectorFactory only supports WebSocketConnector config, got type undefined'
      );
    });
  });

  describe('authentication strategies', () => {
    it('should apply WebSocket subprotocol auth strategy', async () => {
      const mockWebSocket = new MockWebSocket('ws://test.example.com');
      const customClientFactory = jest.fn().mockResolvedValue(mockWebSocket);

      const config: WebSocketConnectorFactoryConfig = {
        type: 'WebSocketConnector',
        url: 'ws://test.example.com',
        auth: {
          type: 'WebSocketSubprotocolStrategy',
          token: 'test-token-123',
        },
      };

      const connector = await factory.create(config, {
        clientFactory: customClientFactory,
      });

      expect(customClientFactory).toHaveBeenCalledWith(
        'ws://test.example.com',
        ['access_token.test-token-123'],
        undefined
      );
      expect(connector.authorizationContext).toBeDefined();
      expect(connector.authorizationContext?.authenticated).toBe(true);
    });

    it('should apply query param auth strategy', async () => {
      const mockWebSocket = new MockWebSocket(
        'ws://test.example.com?access_token=test-token-123'
      );
      const customClientFactory = jest.fn().mockResolvedValue(mockWebSocket);

      const config: WebSocketConnectorFactoryConfig = {
        type: 'WebSocketConnector',
        url: 'ws://test.example.com',
        auth: {
          type: 'QueryParamStrategy',
          token: 'test-token-123',
        },
      };

      const connector = await factory.create(config, {
        clientFactory: customClientFactory,
      });

      expect(customClientFactory).toHaveBeenCalledWith(
        'ws://test.example.com?access_token=test-token-123',
        undefined,
        undefined
      );
      expect(connector.authorizationContext).toBeDefined();
    });

    it('should apply header auth strategy', async () => {
      const mockWebSocket = new MockWebSocket('ws://test.example.com');
      const customClientFactory = jest.fn().mockResolvedValue(mockWebSocket);

      const config: WebSocketConnectorFactoryConfig = {
        type: 'WebSocketConnector',
        url: 'ws://test.example.com',
        auth: {
          type: 'HeaderStrategy',
          token: 'test-token-123',
          principal: 'test-user',
          scopes: ['read', 'write'],
        },
      };

      const connector = await factory.create(config, {
        clientFactory: customClientFactory,
      });

      expect(customClientFactory).toHaveBeenCalledWith(
        'ws://test.example.com',
        undefined,
        {
          Authorization: 'Bearer test-token-123',
        }
      );
      expect(connector.authorizationContext).toBeDefined();
      expect(connector.authorizationContext?.authenticated).toBe(true);
    });

    it('should handle unknown auth strategy gracefully', async () => {
      const mockWebSocket = new MockWebSocket('ws://test.example.com');
      const customClientFactory = jest.fn().mockResolvedValue(mockWebSocket);

      const config: WebSocketConnectorFactoryConfig = {
        type: 'WebSocketConnector',
        url: 'ws://test.example.com',
        auth: {
          type: 'UnknownStrategy',
          token: 'test-token-123',
        },
      };

      const connector = await factory.create(config, {
        clientFactory: customClientFactory,
      });

      expect(connector).toBeInstanceOf(WebSocketConnector);
      // Should still create connector but without specific auth handling
    });

    it('should throw error when token missing for subprotocol strategy', async () => {
      const mockWebSocket = new MockWebSocket('ws://test.example.com');
      const customClientFactory = jest.fn().mockResolvedValue(mockWebSocket);

      const config: WebSocketConnectorFactoryConfig = {
        type: 'WebSocketConnector',
        url: 'ws://test.example.com',
        auth: {
          type: 'WebSocketSubprotocolStrategy',
          // Missing token
        },
      };

      await expect(
        factory.create(config, {
          clientFactory: customClientFactory,
        })
      ).rejects.toThrow(
        'Token required for WebSocket subprotocol auth strategy'
      );
    });
  });

  describe('internal helpers', () => {
    beforeEach(() => {
      wsConstructorMock.mockReset();
      readFileSyncMock.mockReset();
      loggerMock.debug.mockReset?.();
      loggerMock.warning.mockReset?.();
      loggerMock.debug.mockClear();
      loggerMock.warning.mockClear();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('normalizes legacy websocket config values', () => {
      const factoryAny = factory as any;
      const input = {
        type: 'websocket',
        url: 'ws://legacy',
        auth: { type: 'UnknownStrategy' },
      };

      const result = factoryAny._normalizeConfig(input);

      expect(result).toEqual({
        type: 'WebSocketConnector',
        url: 'ws://legacy',
        auth: { type: 'UnknownStrategy' },
      });
      expect(input.type).toBe('WebSocketConnector');
    });

    it('validates authentication configuration', () => {
      const factoryAny = factory as any;
      expect(() => factoryAny._normalizeAuthConfig(null as any)).toThrow(
        'Authentication configuration must be an object with a type property'
      );
      expect(() => factoryAny._normalizeAuthConfig({} as any)).toThrow(
        'Authentication configuration requires a non-empty "type" property'
      );

      const normalized = factoryAny._normalizeAuthConfig({
        type: 'HeaderStrategy',
        token: 'abc',
      });

      expect(normalized).toEqual({ type: 'HeaderStrategy', token: 'abc' });
    });

    it('derives subprotocols from auth strategies', async () => {
      const factoryAny = factory as any;

      await expect(
        factoryAny._maybeGetSubprotocols(undefined)
      ).resolves.toBeUndefined();
      await expect(
        factoryAny._maybeGetSubprotocols({})
      ).resolves.toBeUndefined();

      const stringStrategy = {
        getSubprotocols: jest.fn().mockResolvedValue('proto'),
      };
      await expect(
        factoryAny._maybeGetSubprotocols(stringStrategy)
      ).resolves.toEqual(['proto']);

      const arrayStrategy = {
        getSubprotocols: jest.fn().mockResolvedValue(['proto1', 'proto2']),
      };
      await expect(
        factoryAny._maybeGetSubprotocols(arrayStrategy)
      ).resolves.toEqual(['proto1', 'proto2']);

      const emptyStrategy = {
        getSubprotocols: jest.fn().mockResolvedValue(''),
      };
      await expect(
        factoryAny._maybeGetSubprotocols(emptyStrategy)
      ).resolves.toBeUndefined();
    });

    it('applies url modifications when provided', async () => {
      const factoryAny = factory as any;
      const url = 'ws://base';

      await expect(factoryAny._maybeModifyUrl(undefined, url)).resolves.toBe(
        url
      );

      const mutator = {
        modifyUrl: jest.fn().mockResolvedValue('ws://modified'),
      };
      await expect(factoryAny._maybeModifyUrl(mutator, url)).resolves.toBe(
        'ws://modified'
      );

      const emptyMutator = {
        modifyUrl: jest.fn().mockResolvedValue(''),
      };
      await expect(factoryAny._maybeModifyUrl(emptyMutator, url)).resolves.toBe(
        url
      );
    });

    it('appends system identifiers correctly', () => {
      const factoryAny = factory as any;
      expect(factoryAny._appendSystemId('ws://root', 'child')).toBe(
        'ws://root/child'
      );
      expect(factoryAny._appendSystemId('ws://root/', 'child')).toBe(
        'ws://root/child'
      );
      expect(factoryAny._appendSystemId('ws://root', '')).toBe('ws://root');
    });

    it('builds authorization context with defaults', () => {
      const factoryAny = factory as any;
      const context = factoryAny._buildAuthorizationContext();
      expect(context).toMatchObject({
        authenticated: true,
        authorized: true,
        claims: {},
        grantedScopes: [],
        restrictions: {},
      });
    });

    it('validates connector config candidates', () => {
      const factoryAny = factory as any;
      expect(factoryAny._isWebSocketConnectorConfig(null)).toBe(false);
      expect(factoryAny._isWebSocketConnectorConfig({ type: 123 })).toBe(false);
      expect(factoryAny._isWebSocketConnectorConfig({ type: 'Other' })).toBe(
        false
      );

      const candidate = { type: 'websocket', url: 'ws://ok' } as Record<
        string,
        unknown
      >;
      expect(factoryAny._isWebSocketConnectorConfig(candidate)).toBe(true);
      expect(candidate.type).toBe('WebSocketConnector');

      expect(
        factoryAny._isWebSocketConnectorConfig({
          type: 'WebSocketConnector',
          url: 42,
        } as any)
      ).toBe(false);
    });

    it('prefers browser websocket creation when available', async () => {
      const factoryAny = factory as any;
      const browserSpy = jest
        .spyOn(factoryAny, '_createBrowserWebSocket')
        .mockResolvedValue({} as WebSocketLike);
      const nodeSpy = jest
        .spyOn(factoryAny, '_createNodeWebSocket')
        .mockResolvedValue({} as WebSocketLike);

      const originalWindow = (globalThis as any).window;
      (globalThis as any).window = { WebSocket: function WebSocket() {} };

      try {
        await factoryAny._defaultWebSocketClient('ws://browser');
        expect(browserSpy).toHaveBeenCalledWith('ws://browser', undefined);
        expect(nodeSpy).not.toHaveBeenCalled();
      } finally {
        browserSpy.mockRestore();
        nodeSpy.mockRestore();
        if (originalWindow === undefined) {
          delete (globalThis as any).window;
        } else {
          (globalThis as any).window = originalWindow;
        }
      }
    });

    it('falls back to node websocket when browser api missing', async () => {
      const factoryAny = factory as any;
      const browserSpy = jest
        .spyOn(factoryAny, '_createBrowserWebSocket')
        .mockResolvedValue({} as WebSocketLike);
      const nodeSocket = {} as WebSocketLike;
      const nodeSpy = jest
        .spyOn(factoryAny, '_createNodeWebSocket')
        .mockResolvedValue(nodeSocket);

      const originalWindow = (globalThis as any).window;
      delete (globalThis as any).window;

      try {
        const result = await factoryAny._defaultWebSocketClient('ws://node');
        expect(nodeSpy).toHaveBeenCalledWith('ws://node', undefined, undefined);
        expect(result).toBe(nodeSocket);
        expect(browserSpy).not.toHaveBeenCalled();
      } finally {
        browserSpy.mockRestore();
        nodeSpy.mockRestore();
        if (originalWindow === undefined) {
          delete (globalThis as any).window;
        } else {
          (globalThis as any).window = originalWindow;
        }
      }
    });

    it('wraps node connection failures in FameConnectError', async () => {
      const factoryAny = factory as any;
      const nodeSpy = jest
        .spyOn(factoryAny, '_createNodeWebSocket')
        .mockRejectedValue(new Error('boom'));

      const originalWindow = (globalThis as any).window;
      delete (globalThis as any).window;

      await expect(
        factoryAny._defaultWebSocketClient('ws://node')
      ).rejects.toThrow('Cannot connect to ws://node: boom');

      nodeSpy.mockRestore();
      if (originalWindow === undefined) {
        delete (globalThis as any).window;
      } else {
        (globalThis as any).window = originalWindow;
      }
    });

    it('propagates FameConnectError from node creation', async () => {
      const factoryAny = factory as any;
      const fameError = new FameConnectError('already wrapped');
      const nodeSpy = jest
        .spyOn(factoryAny, '_createNodeWebSocket')
        .mockRejectedValue(fameError);

      const originalWindow = (globalThis as any).window;
      delete (globalThis as any).window;

      await expect(
        factoryAny._defaultWebSocketClient('ws://node')
      ).rejects.toBe(fameError);

      nodeSpy.mockRestore();
      if (originalWindow === undefined) {
        delete (globalThis as any).window;
      } else {
        (globalThis as any).window = originalWindow;
      }
    });

    it('creates browser websocket and resolves on open', async () => {
      const factoryAny = factory as any;
      const originalWebSocket = (globalThis as any).WebSocket;

      class SuccessfulWebSocket {
        public onopen: ((event: any) => void) | null = null;
        public onerror: ((event: any) => void) | null = null;
        public close = jest.fn();

        constructor(
          public url: string,
          public protocols?: string[]
        ) {
          setTimeout(() => {
            this.onopen?.({ type: 'open' });
          }, 10);
        }
      }

      (globalThis as any).WebSocket = SuccessfulWebSocket as any;
      jest.useFakeTimers();

      try {
        const promise = factoryAny._createBrowserWebSocket('ws://browser', [
          'proto',
        ]);
        jest.advanceTimersByTime(10);
        const socket = await promise;
        expect(socket).toBeInstanceOf(SuccessfulWebSocket);
      } finally {
        (globalThis as any).WebSocket = originalWebSocket;
        jest.useRealTimers();
      }
    });

    it('rejects when browser websocket emits error', async () => {
      const factoryAny = factory as any;
      const originalWebSocket = (globalThis as any).WebSocket;

      class ErrorWebSocket {
        public onopen: ((event: any) => void) | null = null;
        public onerror: ((event: any) => void) | null = null;
        public close = jest.fn();

        constructor() {
          setTimeout(() => {
            this.onerror?.('boom');
          }, 10);
        }
      }

      (globalThis as any).WebSocket = ErrorWebSocket as any;
      jest.useFakeTimers();

      try {
        const promise = factoryAny._createBrowserWebSocket('ws://browser');
        jest.advanceTimersByTime(10);
        await expect(promise).rejects.toThrow(
          'Failed to connect to ws://browser: boom'
        );
      } finally {
        (globalThis as any).WebSocket = originalWebSocket;
        jest.useRealTimers();
      }
    });

    it('rejects when browser websocket construction fails', async () => {
      const factoryAny = factory as any;
      const originalWebSocket = (globalThis as any).WebSocket;

      (globalThis as any).WebSocket = function ThrowingWebSocket() {
        throw new Error('ctor failure');
      } as any;

      await expect(
        factoryAny._createBrowserWebSocket('ws://browser')
      ).rejects.toThrow('Failed to create WebSocket: ctor failure');

      (globalThis as any).WebSocket = originalWebSocket;
    });

    it('creates node websocket without ssl certificate', async () => {
      const factoryAny = factory as any;
      const sockets: any[] = [];

      class NodeWebSocketStub {
        private readonly handlers = new Map<
          string,
          Set<(...args: any[]) => void>
        >();

        constructor(
          public url: string,
          public protocols?: string[],
          public options?: any
        ) {}

        on(event: string, handler: (...args: any[]) => void): void {
          const set = this.handlers.get(event) ?? new Set();
          set.add(handler);
          this.handlers.set(event, set);
        }

        emit(event: string, ...args: any[]): void {
          this.handlers.get(event)?.forEach((handler) => handler(...args));
        }
      }

      wsConstructorMock.mockImplementation(
        (url: string, protocols?: string[], options?: any) => {
          const instance = new NodeWebSocketStub(url, protocols, options);
          sockets.push(instance);
          return instance;
        }
      );

      const loadSslSpy = jest
        .spyOn(factoryAny, '_loadSslCertificate')
        .mockResolvedValue(undefined);

      jest.useFakeTimers();
      const promise = factoryAny._createNodeWebSocket('ws://node');
      await flushAsync();

      expect(wsConstructorMock).toHaveBeenCalledTimes(1);

      expect(wsConstructorMock).toHaveBeenCalledWith('ws://node', undefined, {
        headers: undefined,
        handshakeTimeout: 5000,
      });

      expect(sockets).not.toHaveLength(0);
      sockets[0].emit('open');
      jest.runAllTimers();
      const websocket = await promise;
      expect(websocket).toBe(sockets[0]);
      expect(loadSslSpy).not.toHaveBeenCalled();

      loadSslSpy.mockRestore();
      jest.useRealTimers();
    });

    it('creates node websocket with ssl certificate when wss', async () => {
      const factoryAny = factory as any;
      const sockets: any[] = [];
      const certificate = Buffer.from('cert');

      class NodeWebSocketStub {
        private readonly handlers = new Map<
          string,
          Set<(...args: any[]) => void>
        >();

        constructor(
          public url: string,
          public protocols?: string[],
          public options?: any
        ) {}

        on(event: string, handler: (...args: any[]) => void): void {
          const set = this.handlers.get(event) ?? new Set();
          set.add(handler);
          this.handlers.set(event, set);
        }

        emit(event: string, ...args: any[]): void {
          this.handlers.get(event)?.forEach((handler) => handler(...args));
        }
      }

      wsConstructorMock.mockImplementation(
        (url: string, protocols?: string[], options?: any) => {
          const instance = new NodeWebSocketStub(url, protocols, options);
          sockets.push(instance);
          return instance;
        }
      );

      const loadSslSpy = jest
        .spyOn(factoryAny, '_loadSslCertificate')
        .mockResolvedValue(certificate);

      jest.useFakeTimers();
      const promise = factoryAny._createNodeWebSocket('wss://secure');
      await flushAsync();

      expect(wsConstructorMock).toHaveBeenCalledTimes(1);

      expect(wsConstructorMock).toHaveBeenCalledWith(
        'wss://secure',
        undefined,
        {
          headers: undefined,
          handshakeTimeout: 5000,
          ca: certificate,
        }
      );

      expect(sockets).not.toHaveLength(0);
      sockets[0].emit('open');
      jest.runAllTimers();
      await expect(promise).resolves.toBe(sockets[0]);

      loadSslSpy.mockRestore();
      jest.useRealTimers();
    });

    it('rejects when node websocket emits error', async () => {
      const factoryAny = factory as any;

      class NodeWebSocketStub {
        private readonly handlers = new Map<
          string,
          Set<(...args: any[]) => void>
        >();

        constructor(
          public url: string,
          public protocols?: string[],
          public options?: any
        ) {}

        on(event: string, handler: (...args: any[]) => void): void {
          const set = this.handlers.get(event) ?? new Set();
          set.add(handler);
          this.handlers.set(event, set);
        }

        emit(event: string, ...args: any[]): void {
          this.handlers.get(event)?.forEach((handler) => handler(...args));
        }
      }

      let instance: any;
      wsConstructorMock.mockImplementation(() => {
        instance = new NodeWebSocketStub('ws://node');
        return instance;
      });

      jest.useFakeTimers();
      const promise = factoryAny._createNodeWebSocket('ws://node');
      await flushAsync();
      expect(instance).toBeDefined();
      instance.emit('error', new Error('fail'));
      jest.runAllTimers();
      await expect(promise).rejects.toThrow(
        'Failed to connect to ws://node: fail'
      );
      jest.useRealTimers();
    });

    it('propagates constructor failures during node websocket creation', async () => {
      const factoryAny = factory as any;
      wsConstructorMock.mockImplementation(() => {
        throw new Error('constructor failure');
      });

      await expect(
        factoryAny._createNodeWebSocket('ws://node')
      ).rejects.toThrow('constructor failure');
    });

    it('returns undefined when ssl cert file missing', async () => {
      const factoryAny = factory as any;
      const originalEnv = process.env.SSL_CERT_FILE;
      delete process.env.SSL_CERT_FILE;

      const result = await factoryAny._loadSslCertificate();
      expect(result).toBeUndefined();
      expect(readFileSyncMock).not.toHaveBeenCalled();

      if (originalEnv === undefined) {
        delete process.env.SSL_CERT_FILE;
      } else {
        process.env.SSL_CERT_FILE = originalEnv;
      }
    });

    it('loads ssl certificate when path provided', async () => {
      const factoryAny = factory as any;
      const originalEnv = process.env.SSL_CERT_FILE;
      process.env.SSL_CERT_FILE = '/tmp/cert.pem';
      const buffer = Buffer.from('cert');
      readFileSyncMock.mockReturnValue(buffer);

      const result = await factoryAny._loadSslCertificate();
      expect(result).toBe(buffer);
      expect(readFileSyncMock).toHaveBeenCalledWith('/tmp/cert.pem');

      if (originalEnv === undefined) {
        delete process.env.SSL_CERT_FILE;
      } else {
        process.env.SSL_CERT_FILE = originalEnv;
      }
    });

    it('logs warning when ssl certificate load fails', async () => {
      const factoryAny = factory as any;
      const originalEnv = process.env.SSL_CERT_FILE;
      process.env.SSL_CERT_FILE = '/tmp/missing.pem';

      readFileSyncMock.mockImplementation(() => {
        throw new Error('failed to read');
      });

      const result = await factoryAny._loadSslCertificate();
      expect(result).toBeUndefined();
      expect(loggerMock.warning).toHaveBeenCalledWith(
        'ssl_certificate_load_failed',
        expect.objectContaining({
          cert_file: '/tmp/missing.pem',
          error: 'failed to read',
        })
      );

      if (originalEnv === undefined) {
        delete process.env.SSL_CERT_FILE;
      } else {
        process.env.SSL_CERT_FILE = originalEnv;
      }
    });
  });
});
