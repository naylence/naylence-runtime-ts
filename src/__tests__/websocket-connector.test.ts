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
  setSendCallback(
    callback: (data: string | ArrayBuffer | Uint8Array) => void
  ): void {
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

class EventTargetWebSocket implements WebSocketLike {
  readyState: number = WebSocketState.OPEN;
  url: string | undefined;
  protocol?: string;

  private readonly listeners = new Map<string, Set<(event: any) => void>>();

  send(_data: string | ArrayBuffer | Uint8Array): void {
    if (this.readyState !== WebSocketState.OPEN) {
      throw new Error('WebSocket not open');
    }
  }

  close(code?: number, reason?: string): void {
    this.readyState = WebSocketState.CLOSED;
    this.dispatch('close', { code: code ?? 1000, reason: reason ?? '' });
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    const set = this.listeners.get(type);
    set?.delete(listener);
  }

  emitMessage(data: unknown, isBinary?: boolean): void {
    this.dispatch('message', { data, isBinary });
  }

  emitError(error: unknown): void {
    this.dispatch('error', { error });
  }

  emitClose(code: number, reason?: string): void {
    this.dispatch('close', { code, reason: reason ?? '' });
  }

  emitCloseEvent(event: any): void {
    this.dispatch('close', event);
  }

  emitErrorEvent(event: any): void {
    this.dispatch('error', event);
  }

  dispatch(type: string, event: any): void {
    const listeners = this.listeners.get(type);
    listeners?.forEach((listener) => listener(event));
  }
}

class EmitterWebSocket implements WebSocketLike {
  readyState: number = WebSocketState.OPEN;
  url: string | undefined;
  protocol?: string;
  terminate = jest.fn();

  private readonly listeners = new Map<string, Set<(...args: any[]) => void>>();

  send(_data: string | ArrayBuffer | Uint8Array): void {
    if (this.readyState !== WebSocketState.OPEN) {
      throw new Error('send on closed socket');
    }
  }

  close(code?: number, reason?: string): void {
    this.readyState = WebSocketState.CLOSED;
    this.emit('close', code ?? 1000, Buffer.from(reason ?? ''));
  }

  on(type: string, listener: (...args: any[]) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  off(type: string, listener: (...args: any[]) => void): void {
    const set = this.listeners.get(type);
    set?.delete(listener);
  }

  removeListener(type: string, listener: (...args: any[]) => void): void {
    this.off(type, listener);
  }

  emit(type: string, ...args: any[]): void {
    const set = this.listeners.get(type);
    set?.forEach((listener) => listener(...args));
  }

  emitMessage(data: unknown, isBinary?: boolean): void {
    this.emit('message', data, isBinary);
  }

  emitClose(code: number, reason?: string | Buffer): void {
    this.emit('close', code, reason);
  }

  emitError(error: Error): void {
    this.emit('error', error);
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

  describe('auth header management', () => {
    it('should trim auth header values', () => {
      const trimmedConnector = new WebSocketConnector(
        new MockWebSocket(),
        FAST_SHUTDOWN_CONFIG
      );
      trimmedConnector.setAuthHeader('  Bearer token  ');
      expect(trimmedConnector.authHeader).toBe('Bearer token');
    });

    it('should ignore non-string auth header assignments', () => {
      const noopConnector = new WebSocketConnector(
        new MockWebSocket(),
        FAST_SHUTDOWN_CONFIG
      );
      noopConnector.setAuthHeader('Bearer A');
      noopConnector.setAuthHeader(123 as unknown as string);
      expect(noopConnector.authHeader).toBe('Bearer A');
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
      const decodedData = JSON.parse(
        new TextDecoder().decode(sentData[0] as Uint8Array)
      );
      expect(decodedData.frame.payload).toBe('test message');
      expect(decodedData.traceId).toBe('test-trace');
    });

    it('should throw error when closed', async () => {
      await connector.close();

      const envelope = createFameEnvelope({
        frame: { type: 'Data', payload: 'test' } as DataFrame,
      });

      await expect(connector.send(envelope)).rejects.toThrow(
        FameTransportClose
      );
    });

    it('should wrap disconnect errors from underlying socket', async () => {
      mockWebSocket.readyState = WebSocketState.OPEN;
      mockWebSocket.setSendCallback(() => {
        const error = new Error('WebSocket closed unexpectedly');
        (error as any).code = 1011;
        throw error;
      });

      await expect(
        (connector as any)._transportSendBytes(new Uint8Array([1, 2, 3]))
      ).rejects.toMatchObject({
        code: 1011,
        message: 'WebSocket closed unexpectedly',
      });
    });

    it('should rethrow non-websocket errors from send', async () => {
      mockWebSocket.readyState = WebSocketState.OPEN;
      const unexpected = new Error('boom');
      mockWebSocket.setSendCallback(() => {
        throw unexpected;
      });

      await expect(
        (connector as any)._transportSendBytes(new Uint8Array([4, 5, 6]))
      ).rejects.toBe(unexpected);
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

    it('should wrap handler setup disconnect errors', async () => {
      const disconnectError = new Error('WebSocket disconnected unexpectedly');
      const throwingSocket: WebSocketLike & {
        addEventListener: (
          type: string,
          listener: (event: any) => void
        ) => void;
        removeEventListener: (
          type: string,
          listener: (event: any) => void
        ) => void;
      } = {
        readyState: WebSocketState.OPEN,
        send: jest.fn(),
        close: jest.fn(),
        addEventListener: () => {
          throw disconnectError;
        },
        removeEventListener: jest.fn(),
      } as any;

      // Since _ensureReceiveHandlers() is called in constructor for non-FastAPI WebSockets,
      // the error will be thrown during construction
      expect(() => {
        new WebSocketConnector(throwingSocket, FAST_SHUTDOWN_CONFIG);
      }).toThrow('WebSocket disconnected unexpectedly');
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
      fastApiConnector = new WebSocketConnector(
        fastApiMockWebSocket,
        FAST_SHUTDOWN_CONFIG
      );
      expect(fastApiConnector).toBeDefined();
    }, 1000); // Explicit timeout

    it('should send bytes through FastAPI WebSocket', async () => {
      fastApiConnector = new WebSocketConnector(
        fastApiMockWebSocket,
        FAST_SHUTDOWN_CONFIG
      );
      const handler = jest.fn();
      await fastApiConnector.start(handler);

      // Wait for connector to fully start before sending
      await new Promise((resolve) => setTimeout(resolve, 10));

      const envelope = {
        frame: { type: 'Data', payload: 'fastapi message' } as DataFrame,
      };

      await fastApiConnector.send(createFameEnvelope(envelope));

      expect(fastApiMockWebSocket.send_bytes).toHaveBeenCalledWith(
        expect.any(Uint8Array)
      );

      // Close immediately after successful send
      await fastApiConnector.close();
      fastApiConnector = undefined;
    }, 3000);
  });

  describe('FastAPI receive edge cases', () => {
    let fastApiConnector: WebSocketConnector | undefined;
    let fastApiSocket: any;

    afterEach(async () => {
      if (fastApiConnector && fastApiConnector.state !== 'closed') {
        try {
          await fastApiConnector.close();
        } catch (_error) {
          // ignore cleanup issues
        }
      }
      fastApiConnector = undefined;
      jest.useRealTimers();
    });

    it('should fail when receive_bytes becomes unavailable', async () => {
      const receiveBytes = jest.fn().mockResolvedValue(new Uint8Array([1]));
      fastApiSocket = {
        readyState: WebSocketState.OPEN,
        client_state: 'CONNECTED',
        send_bytes: jest.fn().mockResolvedValue(undefined),
        receive_bytes: receiveBytes,
        close: jest.fn().mockResolvedValue(undefined),
      };

      fastApiConnector = new WebSocketConnector(
        fastApiSocket,
        FAST_SHUTDOWN_CONFIG
      );
      fastApiSocket.receive_bytes = 'not-a-function' as any;

      await expect(
        (fastApiConnector as any)._transportReceive()
      ).rejects.toMatchObject({
        code: 1006,
        message: 'FastAPI WebSocket receive_bytes method not available',
      });
    });

    it('should reject when receive_bytes returns non-thenable', async () => {
      fastApiSocket = {
        readyState: WebSocketState.OPEN,
        client_state: 'CONNECTED',
        send_bytes: jest.fn().mockResolvedValue(undefined),
        receive_bytes: jest.fn().mockReturnValue(42),
        close: jest.fn().mockResolvedValue(undefined),
      };

      fastApiConnector = new WebSocketConnector(
        fastApiSocket,
        FAST_SHUTDOWN_CONFIG
      );

      await expect(
        (fastApiConnector as any)._transportReceive()
      ).rejects.toMatchObject({
        code: 1006,
        message: expect.stringContaining('non-awaitable'),
      });
    });

    it('should convert FastAPI receive timeout into transport close', async () => {
      jest.useFakeTimers();

      fastApiSocket = {
        readyState: WebSocketState.OPEN,
        client_state: 'CONNECTED',
        send_bytes: jest.fn().mockResolvedValue(undefined),
        receive_bytes: jest.fn().mockReturnValue(new Promise(() => {})),
        close: jest.fn().mockResolvedValue(undefined),
      };

      fastApiConnector = new WebSocketConnector(
        fastApiSocket,
        FAST_SHUTDOWN_CONFIG
      );

      const receivePromise = (fastApiConnector as any)._transportReceive();

      jest.advanceTimersByTime(30000);
      await Promise.resolve();

      await expect(receivePromise).rejects.toMatchObject({
        code: 1006,
        message: 'FastAPI receive_bytes timed out',
      });
    });

    it("should treat await wasn't used with future as cancellation", async () => {
      const awaitError = new Error("await wasn't used with future in test");

      fastApiSocket = {
        readyState: WebSocketState.OPEN,
        client_state: 'CONNECTED',
        send_bytes: jest.fn().mockResolvedValue(undefined),
        receive_bytes: jest.fn().mockImplementation(async () => {
          throw awaitError;
        }),
        close: jest.fn().mockResolvedValue(undefined),
      };

      fastApiConnector = new WebSocketConnector(
        fastApiSocket,
        FAST_SHUTDOWN_CONFIG
      );

      await expect(
        (fastApiConnector as any)._transportReceive()
      ).rejects.toMatchObject({
        code: 1006,
        message: 'WebSocket cancelled during receive operation',
      });
    });

    it('should resolve when receive_bytes returns data', async () => {
      const payload = new Uint8Array([5, 6, 7]);
      fastApiSocket = {
        readyState: WebSocketState.OPEN,
        client_state: 'CONNECTED',
        send_bytes: jest.fn().mockResolvedValue(undefined),
        receive_bytes: jest.fn().mockResolvedValue(payload),
        close: jest.fn().mockResolvedValue(undefined),
      };

      fastApiConnector = new WebSocketConnector(
        fastApiSocket,
        FAST_SHUTDOWN_CONFIG
      );

      await expect(
        (fastApiConnector as any)._transportReceive()
      ).resolves.toEqual(payload);
    });

    it('should convert FastAPI disconnect errors', async () => {
      const disconnectError = new Error('WebSocket connection closed by peer');
      (disconnectError as any).code = 1013;

      fastApiSocket = {
        readyState: WebSocketState.OPEN,
        client_state: 'CONNECTED',
        send_bytes: jest.fn().mockResolvedValue(undefined),
        receive_bytes: jest.fn().mockRejectedValue(disconnectError),
        close: jest.fn().mockResolvedValue(undefined),
      };

      fastApiConnector = new WebSocketConnector(
        fastApiSocket,
        FAST_SHUTDOWN_CONFIG
      );

      await expect(
        (fastApiConnector as any)._transportReceive()
      ).rejects.toMatchObject({
        code: 1013,
        message: 'WebSocket connection closed by peer',
      });
    });

    it('should convert synchronous future errors to cancellation', async () => {
      const syncAwaitError = new Error(
        "await wasn't used with future immediate"
      );

      fastApiSocket = {
        readyState: WebSocketState.OPEN,
        client_state: 'CONNECTED',
        send_bytes: jest.fn().mockResolvedValue(undefined),
        receive_bytes: jest.fn(() => {
          throw syncAwaitError;
        }),
        close: jest.fn().mockResolvedValue(undefined),
      };

      fastApiConnector = new WebSocketConnector(
        fastApiSocket,
        FAST_SHUTDOWN_CONFIG
      );

      await expect(
        (fastApiConnector as any)._transportReceive()
      ).rejects.toMatchObject({
        code: 1006,
        message: 'WebSocket cancelled during receive operation',
      });
    });
  });

  describe('browser and node receive variants', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it('should consume queued message without awaiting new data', async () => {
      const connectorAny = connector as any;
      connectorAny._ensureReceiveHandlers();

      const payload = new Uint8Array([9, 8, 7]);
      mockWebSocket.simulateMessage(payload);

      await expect(connectorAny._transportReceive()).resolves.toEqual(payload);
    });

    it('should timeout when no messages arrive', async () => {
      jest.useFakeTimers();

      const receivePromise = (connector as any)._transportReceive();

      jest.advanceTimersByTime(30000);
      await Promise.resolve();

      await expect(receivePromise).rejects.toMatchObject({
        code: 1006,
        message: 'WebSocket receive timed out',
      });
    });

    it('should handle event-target style sockets', async () => {
      const eventSocket = new EventTargetWebSocket();
      const localConnector = new WebSocketConnector(
        eventSocket,
        FAST_SHUTDOWN_CONFIG
      );

      const receivePromise = (localConnector as any)._transportReceive();
      const payload = new Uint8Array([1, 1, 2]);
      eventSocket.emitMessage(payload);

      await expect(receivePromise).resolves.toEqual(payload);

      eventSocket.emitClose(1001, 'going away');

      await localConnector.close().catch(() => undefined);
    });

    it('should handle node emitter style sockets and force terminate', async () => {
      jest.useFakeTimers();
      const emitterSocket = new EmitterWebSocket();
      emitterSocket.close = jest.fn();
      const localConnector = new WebSocketConnector(
        emitterSocket,
        FAST_SHUTDOWN_CONFIG
      );

      const receivePromise = (localConnector as any)._transportReceive();

      emitterSocket.emitClose(1000, Buffer.from('bye'));

      await expect(receivePromise).rejects.toMatchObject({
        code: 1000,
        message: 'bye',
      });

      const terminatePromise = (localConnector as any)._transportClose(
        1011,
        'closing'
      );

      jest.advanceTimersByTime(250);
      await Promise.resolve();
      await terminatePromise;

      expect(emitterSocket.terminate).toHaveBeenCalled();

      await localConnector.close().catch(() => undefined);
    });

    it('should detach handlers even when removal throws', () => {
      const eventSocket = new EventTargetWebSocket();
      const localConnector = new WebSocketConnector(
        eventSocket,
        FAST_SHUTDOWN_CONFIG
      );
      const connectorAny = localConnector as any;

      connectorAny._ensureReceiveHandlers();
      connectorAny._terminateFallbackTimer = setTimeout(() => undefined, 1000);
      eventSocket.removeEventListener = jest.fn(() => {
        throw new Error('unable to remove');
      });

      expect(() => connectorAny._detachReceiveHandlers()).not.toThrow();
      expect(connectorAny._terminateFallbackTimer).toBeNull();
    });

    it('should fall back to removeListener when off is unavailable', async () => {
      const handlers = new Map<string, Set<(...args: any[]) => void>>();
      const removeSpy = jest.fn();
      const nodeSocket: WebSocketLike & {
        on: (event: string, listener: (...args: any[]) => void) => void;
        emit: (event: string, ...args: any[]) => void;
        removeListener: (
          event: string,
          listener: (...args: any[]) => void
        ) => void;
        terminate: () => void;
      } = {
        readyState: WebSocketState.OPEN,
        url: undefined,
        protocol: undefined,
        send: () => undefined,
        close: jest.fn(),
        terminate: jest.fn(),
        on(event, listener) {
          const set = handlers.get(event) ?? new Set();
          set.add(listener);
          handlers.set(event, set);
        },
        emit(event, ...args) {
          handlers.get(event)?.forEach((listener) => listener(...args));
        },
        removeListener(event, listener) {
          removeSpy(event);
          const set = handlers.get(event);
          set?.delete(listener);
        },
      };

      const localConnector = new WebSocketConnector(
        nodeSocket,
        FAST_SHUTDOWN_CONFIG
      );
      const connectorAny = localConnector as any;

      const receivePromise = connectorAny._transportReceive();
      nodeSocket.emit('close', 1000, Buffer.from('node-off'));

      await expect(receivePromise).rejects.toMatchObject({
        code: 1000,
        message: 'node-off',
      });

      expect(removeSpy).toHaveBeenCalledWith('message');
      await localConnector.close().catch(() => undefined);
    });

    it('should reject waiters when incoming message normalization fails', async () => {
      const connectorAny = connector as any;
      const receivePromise = connectorAny._transportReceive();

      mockWebSocket.simulateMessage(Symbol('invalid') as any);

      await expect(receivePromise).rejects.toBeInstanceOf(FameTransportClose);
    });

    it('should propagate numeric close reasons provided as strings', async () => {
      const emitterSocket = new EmitterWebSocket();
      emitterSocket.close = jest.fn();
      const localConnector = new WebSocketConnector(
        emitterSocket,
        FAST_SHUTDOWN_CONFIG
      );

      const receivePromise = (localConnector as any)._transportReceive();
      emitterSocket.emitClose(1010, 'numeric-string-reason');

      await expect(receivePromise).rejects.toMatchObject({
        code: 1010,
        message: 'numeric-string-reason',
      });

      await localConnector.close().catch(() => undefined);
    });

    it('should default numeric close reason to peer closed', async () => {
      const emitterSocket = new EmitterWebSocket();
      emitterSocket.close = jest.fn();
      const localConnector = new WebSocketConnector(
        emitterSocket,
        FAST_SHUTDOWN_CONFIG
      );

      const receivePromise = (localConnector as any)._transportReceive();
      emitterSocket.emitClose(1005, undefined as any);

      await expect(receivePromise).rejects.toMatchObject({
        code: 1005,
        message: 'peer closed',
      });

      await localConnector.close().catch(() => undefined);
    });

    it('should decode buffer reason from close events', async () => {
      const eventSocket = new EventTargetWebSocket();
      const localConnector = new WebSocketConnector(
        eventSocket,
        FAST_SHUTDOWN_CONFIG
      );

      const receivePromise = (localConnector as any)._transportReceive();
      eventSocket.emitClose(1002, Buffer.from('buffer-reason') as any);

      await expect(receivePromise).rejects.toMatchObject({
        code: 1002,
        message: 'buffer-reason',
      });

      await localConnector.close().catch(() => undefined);
    });

    it('should default object close reason when absent', async () => {
      const eventSocket = new EventTargetWebSocket();
      const localConnector = new WebSocketConnector(
        eventSocket,
        FAST_SHUTDOWN_CONFIG
      );

      const receivePromise = (localConnector as any)._transportReceive();
      eventSocket.emitCloseEvent({ code: 1008 });

      await expect(receivePromise).rejects.toMatchObject({
        code: 1008,
        message: 'peer closed',
      });

      await localConnector.close().catch(() => undefined);
    });

    it('should handle error events without embedded error objects', async () => {
      const eventSocket = new EventTargetWebSocket();
      const localConnector = new WebSocketConnector(
        eventSocket,
        FAST_SHUTDOWN_CONFIG
      );

      const receivePromise = (localConnector as any)._transportReceive();
      eventSocket.emitErrorEvent({ message: 'socket-failure' });

      await expect(receivePromise).rejects.toMatchObject({
        code: 1006,
        message: 'socket-failure',
      });

      await localConnector.close().catch(() => undefined);
    });
  });

  describe('message normalization', () => {
    it('should convert buffers and array buffers', () => {
      const connectorAny = connector as any;
      const fromBuffer = connectorAny._normalizeIncomingMessage(
        Buffer.from('abc')
      );
      expect(Array.from(fromBuffer)).toEqual(
        Array.from(new Uint8Array(Buffer.from('abc')))
      );

      const arrayBuffer = new TextEncoder().encode('xyz').buffer;
      const fromArrayBuffer =
        connectorAny._normalizeIncomingMessage(arrayBuffer);
      expect(Array.from(fromArrayBuffer)).toEqual(
        Array.from(new Uint8Array(arrayBuffer))
      );
    });

    it('should unwrap nested data objects', () => {
      const connectorAny = connector as any;
      const nested = connectorAny._normalizeIncomingMessage({
        data: new Uint8Array([4, 4, 1]),
      });

      expect(Array.from(nested)).toEqual([4, 4, 1]);
    });

    it('should reject unsupported types', () => {
      const connectorAny = connector as any;
      expect(() => connectorAny._normalizeIncomingMessage(123 as any)).toThrow(
        FameTransportClose
      );
    });

    it('should respect isBinary flag for strings', () => {
      const connectorAny = connector as any;
      const payload = connectorAny._normalizeIncomingMessage('bin-data', true);
      expect(Array.from(payload)).toEqual(
        Array.from(new TextEncoder().encode('bin-data'))
      );
    });
  });

  describe('close reason extraction', () => {
    it('should extract reason from Error instances', () => {
      const connectorAny = connector as any;
      expect(
        connectorAny._extractCloseReason(new Error('explicit reason'))
      ).toBe('explicit reason');
    });

    it('should extract reason from error-like objects', () => {
      const connectorAny = connector as any;
      expect(
        connectorAny._extractCloseReason({ reason: 'object reason' })
      ).toBe('object reason');
    });

    it('should default to empty string when reason missing', () => {
      const connectorAny = connector as any;
      expect(connectorAny._extractCloseReason({})).toBe('');
    });
  });
});
