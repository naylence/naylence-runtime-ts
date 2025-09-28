/**
 * Tests for WebSocket Connector Factory
 */

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

type StubAuthConfig = Record<string, unknown> & { type: string };

const authStrategySpy = jest.spyOn(AuthInjectionStrategyFactory, 'createAuthInjectionStrategy');

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
    const principal = typeof config.principal === 'string' ? config.principal : undefined;
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
      expect(supportedTypes).toEqual([WEBSOCKET_CONNECTION_GRANT_TYPE, 'WebSocketConnector']);
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
      }).toThrow('WebSocketConnectionGrant requires a valid base grant');
    });

    it('should throw error for unsupported config type', () => {
      const invalidConfig = {
        type: 'UnsupportedConnector',
        url: 'ws://test.example.com',
      };

      expect(() => {
        factory.grantFromConfig(invalidConfig as any);
      }).toThrow('WebSocketConnectorFactory only supports WebSocketConnector config');
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
      const mockWebSocket = new MockWebSocket('ws://test.example.com/system123');
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
      const mockWebSocket = new MockWebSocket('ws://test.example.com?access_token=test-token-123');
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

      expect(customClientFactory).toHaveBeenCalledWith('ws://test.example.com', undefined, {
        Authorization: 'Bearer test-token-123',
      });
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
      ).rejects.toThrow('Token required for WebSocket subprotocol auth strategy');
    });
  });
});
