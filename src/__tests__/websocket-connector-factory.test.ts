/**
 * Tests for WebSocket Connector Factory
 */

import {
  WebSocketConnectorFactory,
  WebSocketConnectorFactoryConfig,
  WebSocketConnectionGrant,
} from '../naylence/fame/connector/websocket-connector-factory';
import {
  WebSocketConnector,
  WebSocketLike,
  WebSocketState,
} from '../naylence/fame/connector/websocket-connector';

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
      expect(supportedTypes).toEqual(['WebSocketConnectionGrant', 'WebSocketConnector']);
    });

    it('should convert grant to config', () => {
      const grant: WebSocketConnectionGrant = {
        type: 'WebSocketConnectionGrant',
        purpose: 'connection',
        url: 'ws://test.example.com',
        auth: {
          type: 'WebSocketSubprotocolStrategy',
          token: 'test-token',
        },
      };

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

      expect(grant.type).toBe('WebSocketConnectionGrant');
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
      }).toThrow('WebSocketConnectorFactory only supports WebSocketConnectionGrant');
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
        'Config must have a type field'
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

      expect(connector.authorizationContext).toBeDefined();
      expect(connector.authorizationContext?.principal).toBe('test-user');
      expect(connector.authorizationContext?.grantedScopes).toEqual(['read', 'write']);
      expect(connector.authorizationContext?.authMethod).toBe('header');
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
