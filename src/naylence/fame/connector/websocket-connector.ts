/**
 * WebSocket Connector Implementation
 * 
 * A transport adapter that works with both Node.js and browser WebSocket APIs.
 * Supports both native WebSocket clients and server-side WebSocket connections.
 */

import { BaseAsyncConnector, BaseAsyncConnectorConfig } from './base-async-connector.js';
import { FameTransportClose } from '../errors/errors.js';
import { getLogger } from '../util/logging.js';
import type { AuthorizationContext as CoreAuthorizationContext } from 'naylence-core';

const logger = getLogger('websocket-connector');

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
export interface WebSocketConnectorConfig extends BaseAsyncConnectorConfig {
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

  constructor(
    websocket: WebSocketLike,
    config: WebSocketConnectorConfig = {}
  ) {
    super(config);
    
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
        await this._websocket.send_bytes(data);
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
          throw new FameTransportClose('FastAPI WebSocket receive_bytes method not available', 1006);
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
            throw new FameTransportClose('FastAPI receive_bytes timed out', 1006);
          }
          
          // Handle known WebSocket shutdown race condition
          if (this._isAwaitFutureError(error)) {
            logger.debug('websocket_shutdown_race_condition_handled', {
              note: 'Normal WebSocket close timing - converting to cancellation',
              websocket_state: (this._websocket as any).client_state || 'unknown',
            });
            throw new FameTransportClose('WebSocket cancelled during receive operation', 1006);
          }
          throw error;
        }
      } else {
        // Browser WebSocket or Node.js ws client - use Promise-based approach
        return await new Promise<Uint8Array>((resolve, reject) => {
          const timeoutId = setTimeout(() => {
            reject(new FameTransportClose('WebSocket receive timed out', 1006));
          }, receiveTimeout);

          const cleanup = () => {
            clearTimeout(timeoutId);
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

          const messageHandler = (event: any) => {
            cleanup();
            
            let data: Uint8Array;
            if (event.data instanceof ArrayBuffer) {
              data = new Uint8Array(event.data);
            } else if (event.data instanceof Uint8Array) {
              data = event.data;
            } else if (typeof event.data === 'string') {
              data = new TextEncoder().encode(event.data);
            } else {
              reject(new FameTransportClose(`Unsupported data type: ${typeof event.data}`, 1003));
              return;
            }
            
            resolve(data);
          };

          const closeHandler = (event: any) => {
            cleanup();
            const code = event.code || 1006;
            const reason = event.reason || 'peer closed';
            reject(new FameTransportClose(reason, code));
          };

          const errorHandler = (event: any) => {
            cleanup();
            const message = event.message || 'WebSocket error';
            reject(new FameTransportClose(message, 1006));
          };

          // Set up event handlers
          this._websocket.onmessage = messageHandler;
          this._websocket.onclose = closeHandler;
          this._websocket.onerror = errorHandler;

          // Check if WebSocket is already closed
          if (this._websocket.readyState === WebSocketState.CLOSED) {
            cleanup();
            reject(new FameTransportClose('WebSocket is already closed', 1006));
          }
        });
      }
    } catch (error) {
      if (this._isAwaitFutureError(error)) {
        logger.debug('websocket_shutdown_race_condition_detected', {
          websocket_type: this._websocket.constructor.name,
          is_fastapi: this._isFastApiLike,
          note: 'Normal WebSocket close timing during shutdown',
        });
        
        throw new FameTransportClose('WebSocket cancelled during receive operation', 1006);
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
      }
    } catch (error) {
      logger.error('websocket_close_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't re-throw - close errors are not critical during shutdown
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
    return error instanceof Error && 
           error.message.includes("await wasn't used with future");
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
  private async _withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
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
}