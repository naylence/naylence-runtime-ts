/**
 * WebSocket Connector Implementation
 *
 * A transport adapter that works with both Node.js and browser WebSocket APIs.
 * Supports both native WebSocket clients and server-side WebSocket connections.
 */

import {
  BaseAsyncConnector,
  BaseAsyncConnectorConfig,
} from './base-async-connector.js';
import type { ConnectorConfig } from './connector-config.js';
import { FameTransportClose } from '../errors/errors.js';
import { getLogger } from '../util/logging.js';
import type {
  AuthorizationContext as CoreAuthorizationContext,
  FameEnvelope,
  FameChannelMessage,
} from '@naylence/core';

const logger = getLogger('naylence.fame.connector.websocket_connector');

interface ReceiveWaiter {
  resolve: (value: Uint8Array) => void;
  reject: (reason: unknown) => void;
  timeoutId?: ReturnType<typeof setTimeout>;
}

/**
 * Authorization context for connectors
 */
export type AuthorizationContext = CoreAuthorizationContext;

/**
 * WebSocket-like interface that covers both browser WebSocket and Node.js ws library
 */
export interface WebSocketLike {
  // Properties
  readyState: number;
  url?: string | undefined;
  protocol?: string | undefined;

  // Methods
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;

  // Event handlers (can be null/undefined)
  onopen?: ((event: any) => void) | null | undefined;
  onclose?: ((event: any) => void) | null | undefined;
  onmessage?: ((event: any) => void) | null | undefined;
  onerror?: ((event: any) => void) | null | undefined;

  // Optional - for Node.js ws library
  ping?(): void;
  pong?(): void;

  // Optional - for server-side WebSocket (like FastAPI)
  accept?(): Promise<void>;
  receive_bytes?(): Promise<Uint8Array>;
  send_bytes?(data: Uint8Array): Promise<void>;
}

/**
 * Configuration for WebSocket connector
 */
export interface WebSocketConnectorConfig
  extends BaseAsyncConnectorConfig,
    ConnectorConfig {
  /** Authorization context for the connection */
  authorizationContext?: AuthorizationContext | undefined;
}

/**
 * WebSocket state constants (mirrors standard WebSocket states)
 */
export const WebSocketState = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const;

/**
 * A transport adapter that can work with either:
 * • Browser WebSocket API
 * • Node.js ws library WebSocket
 * • Server-side WebSocket connections (with FastAPI-like interface)
 */
export class WebSocketConnector extends BaseAsyncConnector {
  private readonly _websocket: WebSocketLike;
  private readonly _isFastApiLike: boolean;
  private _authHeader: string | null = null;
  private readonly _receiveQueue: Uint8Array[] = [];
  private readonly _receiveWaiters: ReceiveWaiter[] = [];
  private _receiveHandlersAttached = false;
  private _removeReceiveHandlers: (() => void) | null = null;
  private _terminateFallbackTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    websocket: WebSocketLike,
    config: WebSocketConnectorConfig = { type: 'websocket' }
  ) {
    const normalizedConfig: WebSocketConnectorConfig = { ...config };

    // Ensure the connector type is always set for factory compatibility
    if (!normalizedConfig.type) {
      normalizedConfig.type = 'websocket';
    }

    const legacyAuthContext = (
      config as { authorization_context?: AuthorizationContext }
    ).authorization_context;
    if (
      legacyAuthContext !== undefined &&
      normalizedConfig.authorizationContext === undefined
    ) {
      normalizedConfig.authorizationContext = legacyAuthContext;
    }

    super(normalizedConfig);

    this._websocket = websocket;

    // Detect if this is a FastAPI-like server WebSocket
    this._isFastApiLike = !!(
      websocket.receive_bytes &&
      websocket.send_bytes &&
      typeof websocket.receive_bytes === 'function' &&
      typeof websocket.send_bytes === 'function'
    );

    logger.debug('websocket_connector_created', {
      is_fastapi_like: this._isFastApiLike,
      ready_state: websocket.readyState,
      url: websocket.url,
    });

    // For non-FastAPI WebSockets (browser/Node.js ws), attach receive handlers immediately
    // to avoid race conditions where messages arrive before the first _transportReceive() call
    if (!this._isFastApiLike) {
      this._ensureReceiveHandlers();
    }
  }

  /**
   * Update the Authorization header associated with this connector, if provided.
   * For WebSocket transports the header is primarily used during the initial
   * handshake; the stored value is retained for observability or refresh logic.
   */
  public setAuthHeader(value: string): void {
    if (typeof value === 'string') {
      this._authHeader = value.trim();
    }
  }

  /**
   * Retrieve the most recently applied Authorization header value, if any.
   */
  public get authHeader(): string | null {
    return this._authHeader;
  }

  /**
   * Push data to the receive queue for processing (override from base class).
   * This is used to replay buffered messages after authentication.
   */
  async pushToReceive(
    rawOrEnvelope: Uint8Array | FameEnvelope | FameChannelMessage
  ): Promise<void> {
    // Convert to Uint8Array if needed
    let data: Uint8Array;

    if (rawOrEnvelope instanceof Uint8Array) {
      data = rawOrEnvelope;
    } else {
      // FameEnvelope or FameChannelMessage - serialize to JSON bytes
      const jsonStr = JSON.stringify(rawOrEnvelope);
      data = new TextEncoder().encode(jsonStr);
    }

    // Push to receive queue - if there's a waiter, resolve it immediately
    if (this._receiveWaiters.length > 0) {
      const waiter = this._receiveWaiters.shift() as ReceiveWaiter;
      if (waiter.timeoutId) {
        clearTimeout(waiter.timeoutId);
        delete waiter.timeoutId;
      }
      waiter.resolve(data);
    } else {
      this._receiveQueue.push(data);
    }

    logger.debug('websocket_message_pushed_to_queue', {
      queueLength: this._receiveQueue.length,
      waitersLength: this._receiveWaiters.length,
    });
  }

  // ---------------------------------------------------------------------
  // Transport Implementation
  // ---------------------------------------------------------------------

  /**
   * Send raw bytes through the WebSocket transport
   */
  protected async _transportSendBytes(data: Uint8Array): Promise<void> {
    try {
      if (this._isFastApiLike && this._websocket.send_bytes) {
        // FastAPI-style server WebSocket
        this._websocket.send_bytes(data);
      } else {
        // Browser WebSocket or Node.js ws client
        this._websocket.send(data);
      }
    } catch (error) {
      // Handle WebSocket disconnection errors
      if (this._isWebSocketDisconnectError(error)) {
        const closeCode = this._extractCloseCode(error);
        const reason = this._extractCloseReason(error) || 'peer closed';
        throw new FameTransportClose(reason, closeCode);
      }
      throw error;
    }
  }

  /**
   * Receive bytes from the WebSocket with enhanced error handling and cancellation safety
   */
  protected async _transportReceive(): Promise<Uint8Array> {
    try {
      // Validate WebSocket object before attempting to receive
      if (!this._websocket) {
        throw new FameTransportClose('WebSocket object is null', 1006);
      }

      // Use a timeout to prevent hanging during shutdown scenarios
      const receiveTimeout = 30000; // 30 seconds

      if (this._isFastApiLike && this._websocket.receive_bytes) {
        // FastAPI-style server WebSocket
        const receiveMethod = this._websocket.receive_bytes;

        if (typeof receiveMethod !== 'function') {
          throw new FameTransportClose(
            'FastAPI WebSocket receive_bytes method not available',
            1006
          );
        }

        const result = receiveMethod.call(this._websocket);

        // Ensure we have a Promise
        if (!result || typeof result.then !== 'function') {
          logger.error('fastapi_receive_not_awaitable', {
            result_type: typeof result,
            result_str: String(result).substring(0, 100),
          });
          throw new FameTransportClose(
            `FastAPI receive_bytes returned non-awaitable: ${typeof result}`,
            1006
          );
        }

        // Add timeout protection
        try {
          return await this._withTimeout(result, receiveTimeout);
        } catch (error) {
          if (error instanceof Error && error.name === 'TimeoutError') {
            throw new FameTransportClose(
              'FastAPI receive_bytes timed out',
              1006
            );
          }

          // Handle known WebSocket shutdown race condition
          if (this._isAwaitFutureError(error)) {
            logger.debug('websocket_shutdown_race_condition_handled', {
              note: 'Normal WebSocket close timing - converting to cancellation',
              websocket_state:
                (this._websocket as any).client_state || 'unknown',
            });
            throw new FameTransportClose(
              'WebSocket cancelled during receive operation',
              1006
            );
          }
          throw error;
        }
      } else {
        // Browser WebSocket or Node.js ws client - buffered approach to avoid message loss
        this._ensureReceiveHandlers();

        if (this._receiveQueue.length > 0) {
          return this._receiveQueue.shift() as Uint8Array;
        }

        return await new Promise<Uint8Array>((resolve, reject) => {
          const waiter: ReceiveWaiter = {
            resolve: (value: Uint8Array) => {
              if (waiter.timeoutId) {
                clearTimeout(waiter.timeoutId);
              }
              resolve(value);
            },
            reject: (reason: unknown) => {
              if (waiter.timeoutId) {
                clearTimeout(waiter.timeoutId);
              }
              reject(reason);
            },
          };

          waiter.timeoutId = setTimeout(() => {
            const index = this._receiveWaiters.indexOf(waiter);
            if (index !== -1) {
              this._receiveWaiters.splice(index, 1);
            }
            waiter.reject(
              new FameTransportClose('WebSocket receive timed out', 1006)
            );
          }, receiveTimeout);

          this._receiveWaiters.push(waiter);
        });
      }
    } catch (error) {
      if (this._isAwaitFutureError(error)) {
        logger.debug('websocket_shutdown_race_condition_detected', {
          websocket_type: this._websocket.constructor.name,
          is_fastapi: this._isFastApiLike,
          note: 'Normal WebSocket close timing during shutdown',
        });

        throw new FameTransportClose(
          'WebSocket cancelled during receive operation',
          1006
        );
      }

      if (this._isWebSocketDisconnectError(error)) {
        const closeCode = this._extractCloseCode(error);
        const reason = this._extractCloseReason(error) || 'peer closed';
        throw new FameTransportClose(reason, closeCode);
      }

      throw error;
    }
  }

  /**
   * Close the underlying WebSocket transport
   */
  protected async _transportClose(code: number, reason: string): Promise<void> {
    try {
      if (this._isFastApiLike) {
        // FastAPI-style WebSocket has explicit state tracking
        const websocketState = (this._websocket as any).client_state;
        if (websocketState === 'CONNECTED' || websocketState === 1) {
          await this._websocket.close?.(code, reason);
        }
      } else {
        // Browser/Node.js WebSocket
        if (this._websocket.readyState === WebSocketState.OPEN) {
          this._websocket.close(code, reason);
        }

        // In Node.js environments (ws library) close() performs a graceful shutdown that
        // may defer socket termination until the peer responds. When shutting down tests we
        // need connections to close promptly to avoid hanging receive loops. If terminate()
        // is available, schedule a fallback to forcefully tear down the socket after a short
        // delay in case the graceful close does not complete in time.
        if (typeof (this._websocket as any).terminate === 'function') {
          const socketAny = this._websocket as any;
          if (
            socketAny.readyState !== WebSocketState.CLOSED &&
            this._terminateFallbackTimer === null
          ) {
            this._terminateFallbackTimer = setTimeout(() => {
              this._terminateFallbackTimer = null;
              if (socketAny.readyState !== WebSocketState.CLOSED) {
                try {
                  socketAny.terminate();
                  logger.debug('websocket_force_terminated', {
                    ready_state: socketAny.readyState,
                  });
                } catch (error) {
                  logger.debug('websocket_force_terminate_failed', {
                    error:
                      error instanceof Error ? error.message : String(error),
                  });
                }
              }
            }, 250);
          }
        }
      }
    } catch (error) {
      logger.error('websocket_close_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't re-throw - close errors are not critical during shutdown
    } finally {
      // If we're shutting down proactively, ensure any pending receivers are released
      this._rejectPendingWaiters(new FameTransportClose(reason, code));
      this._detachReceiveHandlers({ cancelTerminateFallback: false });
    }
  }

  // ---------------------------------------------------------------------
  // Utility Methods
  // ---------------------------------------------------------------------

  /**
   * Check if an error is a WebSocket disconnection error
   */
  private _isWebSocketDisconnectError(error: unknown): boolean {
    if (error instanceof Error) {
      // Common WebSocket error patterns
      const message = error.message.toLowerCase();
      return (
        message.includes('websocket') &&
        (message.includes('disconnect') ||
          message.includes('closed') ||
          message.includes('connection') ||
          error.name === 'WebSocketDisconnect')
      );
    }
    return false;
  }

  /**
   * Check if an error is the "await wasn't used with future" error
   */
  private _isAwaitFutureError(error: unknown): boolean {
    return (
      error instanceof Error &&
      error.message.includes("await wasn't used with future")
    );
  }

  /**
   * Extract close code from WebSocket error
   */
  private _extractCloseCode(error: unknown): number {
    if (error && typeof error === 'object') {
      const code = (error as any).code;
      if (typeof code === 'number') {
        return code;
      }
    }
    return 1006; // Default to abnormal closure
  }

  /**
   * Extract close reason from WebSocket error
   */
  private _extractCloseReason(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    if (error && typeof error === 'object') {
      const reason = (error as any).reason;
      if (typeof reason === 'string') {
        return reason;
      }
    }
    return '';
  }

  /**
   * Add timeout protection to a Promise
   */
  private async _withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const error = new Error('Operation timed out');
        error.name = 'TimeoutError';
        reject(error);
      }, timeoutMs);

      promise
        .then((result) => {
          clearTimeout(timeoutId);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
  }

  private _ensureReceiveHandlers(): void {
    if (this._receiveHandlersAttached) {
      return;
    }

    const handleMessage = (data: unknown, isBinary?: boolean) => {
      try {
        const payload = this._normalizeIncomingMessage(data, isBinary);

        if (this._receiveWaiters.length > 0) {
          const waiter = this._receiveWaiters.shift() as ReceiveWaiter;
          if (waiter.timeoutId) {
            clearTimeout(waiter.timeoutId);
            delete waiter.timeoutId;
          }
          waiter.resolve(payload);
        } else {
          this._receiveQueue.push(payload);
        }
      } catch (error) {
        this._rejectPendingWaiters(
          error instanceof Error ? error : new Error(String(error))
        );
      }
    };

    const handleClose = (event: any, rawReason?: any) => {
      let code: number;
      let reason: string;

      if (typeof event === 'number') {
        code = event;
        if (typeof rawReason === 'string') {
          reason = rawReason;
        } else if (
          typeof Buffer !== 'undefined' &&
          Buffer.isBuffer?.(rawReason)
        ) {
          reason = rawReason.toString();
        } else {
          reason = 'peer closed';
        }
      } else {
        code = typeof event?.code === 'number' ? event.code : 1006;
        if (typeof event?.reason === 'string') {
          reason = event.reason;
        } else if (
          typeof Buffer !== 'undefined' &&
          Buffer.isBuffer?.(event?.reason)
        ) {
          reason = event.reason.toString();
        } else {
          reason = 'peer closed';
        }
      }

      // Immediately initiate shutdown to prevent sending on closed socket
      // This ensures _closed flag is set before any send attempts
      const error = new FameTransportClose(reason, code);
      this._rejectPendingWaiters(error);
      this._detachReceiveHandlers();

      // Trigger shutdown asynchronously to set _closed flag immediately
      // Use void to explicitly ignore the promise (shutdown is fire-and-forget here)
      void this['_shutdown'](code, reason, undefined, error);
    };

    const handleError = (event: any) => {
      const candidate = event?.error ?? event;
      const message =
        candidate instanceof Error
          ? candidate.message
          : (candidate?.message ?? 'WebSocket error');
      this._rejectPendingWaiters(new FameTransportClose(String(message), 1006));
      this._detachReceiveHandlers();
    };

    const socketAny = this._websocket as any;

    if (typeof socketAny.addEventListener === 'function') {
      const messageListener = (event: any) => {
        handleMessage(event?.data ?? event, event?.isBinary);
      };
      const closeListener = (event: any) => handleClose(event);
      const errorListener = (event: any) => handleError(event);

      socketAny.addEventListener('message', messageListener);
      socketAny.addEventListener('close', closeListener);
      socketAny.addEventListener('error', errorListener);
      this._removeReceiveHandlers = () => {
        socketAny.removeEventListener('message', messageListener);
        socketAny.removeEventListener('close', closeListener);
        socketAny.removeEventListener('error', errorListener);
      };
    } else if (typeof socketAny.on === 'function') {
      const onMessageHandler = (data: any, isBinary?: boolean) => {
        handleMessage(data, isBinary);
      };
      socketAny.on('message', onMessageHandler);
      socketAny.on('close', handleClose);
      socketAny.on('error', handleError);
      this._removeReceiveHandlers = () => {
        if (typeof socketAny.off === 'function') {
          socketAny.off('message', onMessageHandler);
          socketAny.off('close', handleClose);
          socketAny.off('error', handleError);
        } else if (typeof socketAny.removeListener === 'function') {
          socketAny.removeListener('message', onMessageHandler);
          socketAny.removeListener('close', handleClose);
          socketAny.removeListener('error', handleError);
        }
      };
    } else {
      const messageHandler = (event: any) =>
        handleMessage(event?.data ?? event, event?.isBinary);
      const closeHandler = (event: any) => handleClose(event);
      const errorHandler = (event: any) => handleError(event);
      this._websocket.onmessage = messageHandler;
      this._websocket.onclose = closeHandler;
      this._websocket.onerror = errorHandler;
      this._removeReceiveHandlers = () => {
        if (this._websocket.onmessage === messageHandler) {
          this._websocket.onmessage = null;
        }
        if (this._websocket.onclose === closeHandler) {
          this._websocket.onclose = null;
        }
        if (this._websocket.onerror === errorHandler) {
          this._websocket.onerror = null;
        }
      };
    }

    this._receiveHandlersAttached = true;
  }

  private _detachReceiveHandlers(
    options: { cancelTerminateFallback?: boolean } = {}
  ): void {
    const { cancelTerminateFallback = true } = options;

    if (cancelTerminateFallback && this._terminateFallbackTimer !== null) {
      clearTimeout(this._terminateFallbackTimer);
      this._terminateFallbackTimer = null;
    }

    if (this._removeReceiveHandlers) {
      try {
        this._removeReceiveHandlers();
      } catch (error) {
        logger.debug('websocket_remove_handlers_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this._removeReceiveHandlers = null;
    }
    this._receiveHandlersAttached = false;
  }

  private _normalizeIncomingMessage(
    data: unknown,
    isBinary?: boolean
  ): Uint8Array {
    if (data instanceof Uint8Array) {
      return data;
    }

    if (typeof Buffer !== 'undefined' && Buffer.isBuffer?.(data)) {
      return new Uint8Array(data);
    }

    if (data instanceof ArrayBuffer) {
      return new Uint8Array(data);
    }

    if (typeof data === 'string' && !isBinary) {
      return new TextEncoder().encode(data);
    }

    if (typeof data === 'string') {
      return new TextEncoder().encode(data);
    }

    if (
      data &&
      typeof data === 'object' &&
      'data' in (data as Record<string, unknown>)
    ) {
      return this._normalizeIncomingMessage(
        (data as { data: unknown }).data,
        (data as { isBinary?: boolean }).isBinary ?? isBinary
      );
    }

    throw new FameTransportClose(`Unsupported data type: ${typeof data}`, 1003);
  }

  private _rejectPendingWaiters(error: unknown): void {
    while (this._receiveWaiters.length > 0) {
      const waiter = this._receiveWaiters.shift() as ReceiveWaiter;
      if (waiter.timeoutId) {
        clearTimeout(waiter.timeoutId);
        delete waiter.timeoutId;
      }
      waiter.reject(error);
    }
    this._receiveQueue.length = 0;
  }
}
