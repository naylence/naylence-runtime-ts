/**
 * Tests for WebSocket Connector
 */

import {
  WebSocketConnector,
  WebSocketLike,
  WebSocketState,
} from '../naylence/fame/connector/websocket-connector';
import { createFameEnvelope, type DataFrame } from 'naylence-core';
import { FameTransportClose } from '../naylence/fame/errors/errors';

const FAST_SHUTDOWN_CONFIG = {
  type: 'websocket',
  shutdownTimeouts: {
    gracePeriod: 0.01,
    joinTimeout: 50,
  },
} as const;

// Mock WebSocket implementation for testing
class MockWebSocket implements WebSocketLike {
  readyState: number = WebSocketState.CONNECTING;
  url: string | undefined;
  protocol?: string;

  onopen?: ((event: any) => void) | null = null;
  onclose?: ((event: any) => void) | null = null;
  onmessage?: ((event: any) => void) | null = null;
  onerror?: ((event: any) => void) | null = null;

  private _sendCallback?: (data: string | ArrayBuffer | Uint8Array) => void;

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

  send(data: string | ArrayBuffer | Uint8Array): void {
    if (this.readyState !== WebSocketState.OPEN) {
      throw new Error('WebSocket is not open');
    }
    if (this._sendCallback) {
      this._sendCallback(data);
    }
  }

  close(code?: number, reason?: string): void {
    this.readyState = WebSocketState.CLOSED;
    // Immediately trigger close event to properly clean up any pending operations
    if (this.onclose) {
      this.onclose({ type: 'close', code: code || 1000, reason: reason || '' });
    }
  }

  // Test helpers
  setSendCallback(callback: (data: string | ArrayBuffer | Uint8Array) => void): void {
    this._sendCallback = callback;
  }

  simulateMessage(data: string | ArrayBuffer | Uint8Array): void {
    if (this.onmessage) {
      this.onmessage({ type: 'message', data });
    }
  }

  simulateError(error: any): void {
    if (this.onerror) {
      this.onerror({ type: 'error', error });
    }
  }

  simulateClose(code: number = 1000, reason: string = ''): void {
    this.readyState = WebSocketState.CLOSED;
    if (this.onclose) {
      this.onclose({ type: 'close', code, reason });
    }
  }
}

describe('WebSocketConnector', () => {
  let mockWebSocket: MockWebSocket;
  let connector: WebSocketConnector;

  beforeEach(() => {
    mockWebSocket = new MockWebSocket('ws://test.example.com');
    connector = new WebSocketConnector(mockWebSocket, FAST_SHUTDOWN_CONFIG);
  });

  afterEach(async () => {
    // Force close the connector and wait for cleanup
    if (connector && connector.state !== 'closed') {
      try {
        await connector.close();
        // Give time for cleanup to complete
        await new Promise((resolve) => setTimeout(resolve, 10));
      } catch (_error) {
        // Ignore cleanup errors
      }
    }

    // Force close the mock WebSocket to trigger any pending close handlers
    if (mockWebSocket && mockWebSocket.readyState !== WebSocketState.CLOSED) {
      mockWebSocket.close(1000, 'test cleanup');
    }
  });

  describe('constructor', () => {
    it('should create a connector with a WebSocket', () => {
      expect(connector).toBeDefined();
      expect(connector.state).toBe('initialized');
    });

    it('should accept authorization context', () => {
      const authContext = {
        authenticated: true,
        authorized: true,
        claims: {},
        grantedScopes: [],
        restrictions: {},
      };

      const connectorWithAuth = new WebSocketConnector(mockWebSocket, {
        ...FAST_SHUTDOWN_CONFIG,
        authorizationContext: authContext,
      });

      expect(connectorWithAuth.authorizationContext).toEqual(authContext);
    });
  });

  describe('authorization context', () => {
    it('should get and set authorization context', () => {
      const authContext = {
        authenticated: true,
        authorized: true,
        principal: 'test-user',
        claims: { sub: 'test-user' },
        grantedScopes: ['read', 'write'],
        restrictions: {},
      };

      connector.authorizationContext = authContext;
      expect(connector.authorizationContext).toEqual(authContext);
    });

    it('should handle undefined authorization context', () => {
      connector.authorizationContext = undefined;
      expect(connector.authorizationContext).toBeUndefined();
    });
  });

  describe('lifecycle', () => {
    it('should start with a handler', async () => {
      const handler = jest.fn();
      await connector.start(handler);
      expect(connector.state).toBe('started');
    });

    it('should stop gracefully', async () => {
      const handler = jest.fn();
      await connector.start(handler);
      await connector.stop();
      expect(connector.state).toBe('stopped');
    });

    it('should close with code and reason', async () => {
      const handler = jest.fn();
      await connector.start(handler);
      await connector.close(1000, 'test close');
      expect(connector.state).toBe('closed');
      expect(connector.closeCode).toBe(1000);
      expect(connector.closeReason).toBe('test close');
    });
  });

  describe('send operation', () => {
    beforeEach(async () => {
      const handler = jest.fn();
      await connector.start(handler);
      // Wait for WebSocket to be ready
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    it('should send envelope through WebSocket', async () => {
      const sentData: any[] = [];
      mockWebSocket.setSendCallback((data) => {
        sentData.push(data);
      });

      const envelope = createFameEnvelope({
        frame: { type: 'Data', payload: 'test message' } as DataFrame,
        traceId: 'test-trace',
        flowId: 'test-flow',
      });

      await connector.send(envelope);

      expect(sentData).toHaveLength(1);
      const decodedData = JSON.parse(new TextDecoder().decode(sentData[0] as Uint8Array));
      expect(decodedData.frame.payload).toBe('test message');
      expect(decodedData.traceId).toBe('test-trace');
    });

    it('should throw error when closed', async () => {
      await connector.close();

      const envelope = createFameEnvelope({
        frame: { type: 'Data', payload: 'test' } as DataFrame,
      });

      await expect(connector.send(envelope)).rejects.toThrow(FameTransportClose);
    });
  });

  describe('receive operation', () => {
    beforeEach(async () => {
      const handler = jest.fn();
      await connector.start(handler);
      // Wait for WebSocket to be ready
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    it('should handle incoming JSON messages', async () => {
      const handler = jest.fn();
      await connector.replaceHandler(handler);

      const envelope = {
        frame: { type: 'Data', payload: 'incoming message' },
        traceId: 'incoming-trace',
      };

      mockWebSocket.simulateMessage(JSON.stringify(envelope));

      // Give time for message processing
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          frame: { type: 'Data', payload: 'incoming message' },
          traceId: 'incoming-trace',
        }),
        expect.any(Object)
      );
    });

    it('should handle incoming binary messages', async () => {
      const handler = jest.fn();
      await connector.replaceHandler(handler);

      const envelope = {
        frame: { type: 'Data', payload: 'binary message' },
        traceId: 'binary-trace',
      };

      const jsonData = JSON.stringify(envelope);
      const binaryData = new TextEncoder().encode(jsonData);

      mockWebSocket.simulateMessage(binaryData);

      // Give time for message processing
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          frame: { type: 'Data', payload: 'binary message' },
          traceId: 'binary-trace',
        }),
        expect.any(Object)
      );
    });
  });

  describe('error handling', () => {
    it('should handle WebSocket close events', async () => {
      const handler = jest.fn();
      await connector.start(handler);

      // Simulate WebSocket close
      mockWebSocket.simulateClose(1001, 'going away');

      // Give time for close processing
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(connector.state).toBe('closed');
      expect(connector.closeCode).toBe(1001);
      expect(connector.closeReason).toBe('going away');
    });

    it('should handle WebSocket errors', async () => {
      const handler = jest.fn();
      await connector.start(handler);

      // Simulate WebSocket error
      mockWebSocket.simulateError(new Error('connection failed'));

      // Give time for error processing
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(connector.state).toBe('closed');
    });
  });

  describe('FastAPI-like WebSocket support', () => {
    let fastApiMockWebSocket: any;
    let fastApiConnector: WebSocketConnector | undefined;

    beforeEach(() => {
      fastApiMockWebSocket = {
        readyState: WebSocketState.OPEN,
        client_state: 'CONNECTED',
        send_bytes: jest.fn().mockResolvedValue(undefined),
        receive_bytes: jest.fn().mockImplementation(() => {
          // Return a promise that resolves to a transport close after a short delay
          // This simulates a clean disconnect and prevents hanging
          return new Promise((_, reject) => {
            setTimeout(() => {
              reject(new FameTransportClose('Test WebSocket closed', 1000));
            }, 100);
          });
        }),
        close: jest.fn().mockImplementation(async () => {
          fastApiMockWebSocket.readyState = WebSocketState.CLOSED;
          fastApiMockWebSocket.client_state = 'DISCONNECTED';
        }),
      };
    });

    afterEach(async () => {
      // Ensure proper cleanup of FastAPI connectors
      if (fastApiConnector && fastApiConnector.state !== 'closed') {
        try {
          await fastApiConnector.close();
        } catch (_error) {
          // Ignore errors during cleanup
        }
      }
      fastApiConnector = undefined;
    });

    it('should detect FastAPI-like WebSocket', () => {
      fastApiConnector = new WebSocketConnector(fastApiMockWebSocket, FAST_SHUTDOWN_CONFIG);
      expect(fastApiConnector).toBeDefined();
    }, 1000); // Explicit timeout

    it('should send bytes through FastAPI WebSocket', async () => {
      fastApiConnector = new WebSocketConnector(fastApiMockWebSocket, FAST_SHUTDOWN_CONFIG);
      const handler = jest.fn();
      await fastApiConnector.start(handler);

      // Wait for connector to fully start before sending
      await new Promise((resolve) => setTimeout(resolve, 10));

      const envelope = {
        frame: { type: 'Data', payload: 'fastapi message' } as DataFrame,
      };

      await fastApiConnector.send(createFameEnvelope(envelope));

      expect(fastApiMockWebSocket.send_bytes).toHaveBeenCalledWith(expect.any(Uint8Array));

      // Close immediately after successful send
      await fastApiConnector.close();
      fastApiConnector = undefined;
    }, 3000);
  });
});
