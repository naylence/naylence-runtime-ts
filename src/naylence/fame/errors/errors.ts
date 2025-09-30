/**
 * Fame protocol specific error classes with WebSocket close codes and proper inheritance.
 */

/**
 * Base class for all Fame-related errors.
 */
export abstract class FameError extends Error {
  constructor(
    message: string,
    public readonly code?: number
  ) {
    super(message);
    this.name = this.constructor.name;
    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Raised when the Fame transport is closed.
 * Maps to WebSocket close event codes.
 */
export class FameTransportClose extends FameError {
  constructor(message: string = "Fame transport closed", code?: number) {
    super(message, code);
  }
}

/**
 * Raised when a Fame connection cannot be established.
 */
export class FameConnectError extends FameError {
  constructor(message: string = "Failed to connect to Fame service", code?: number) {
    super(message, code);
  }
}

/**
 * Raised when a Fame message exceeds the maximum allowed size.
 */
export class FameMessageTooLarge extends FameError {
  constructor(message: string = "Fame message too large", code?: number) {
    super(message, code);
  }
}

/**
 * Raised when a Fame protocol violation occurs.
 */
export class FameProtocolError extends FameError {
  constructor(message: string = "Fame protocol error", code?: number) {
    super(message, code);
  }
}

/**
 * Raised when the Fame back pressure buffer is full.
 */
export class BackPressureFull extends FameError {
  constructor(message: string = "Back pressure buffer full", code?: number) {
    super(message, code);
  }
}

/**
 * Raised when a Fame operation is not authorized.
 */
export class NotAuthorized extends FameError {
  constructor(message: string = "Not authorized", code?: number) {
    super(message, code);
  }
}

/**
 * WebSocket close codes used by Fame protocol.
 * @see https://tools.ietf.org/html/rfc6455#section-7.4.1
 */
export const WebSocketCloseCode = {
  /** Normal closure; the connection successfully completed whatever purpose for which it was created. */
  NORMAL_CLOSURE: 1000,
  /** The endpoint is going away, either because of a server failure or because the browser is navigating away. */
  GOING_AWAY: 1001,
  /** The endpoint is terminating the connection due to a protocol error. */
  PROTOCOL_ERROR: 1002,
  /** The connection is being terminated because the endpoint received data of a type it cannot accept. */
  UNSUPPORTED_DATA: 1003,
  /** The endpoint is terminating the connection because a message was received that is too big to process. */
  MESSAGE_TOO_BIG: 1009,
  /** The client is terminating the connection because it expected the server to negotiate one or more extension. */
  MANDATORY_EXTENSION: 1010,
  /** The server is terminating the connection because it encountered an unexpected condition. */
  INTERNAL_ERROR: 1011,
  /** The service is restarting. A client may reconnect, and if it chooses to do so, should reconnect using a randomized delay. */
  SERVICE_RESTART: 1012,
  /** The service is experiencing overload. A client should only connect to a different IP (when there are multiple for the target) or reconnect to the same IP upon user action. */
  TRY_AGAIN_LATER: 1013,
  /** The server was acting as a gateway or proxy and received an invalid response from the upstream server. */
  BAD_GATEWAY: 1014,
} as const;

export type WebSocketCloseCode = (typeof WebSocketCloseCode)[keyof typeof WebSocketCloseCode];

/**
 * Check if an error is a Fame-related error.
 */
export function isFameError(error: unknown): error is FameError {
  return error instanceof FameError;
}

/**
 * Check if an error is a specific Fame error type.
 */
export function isFameErrorType<T extends FameError>(
  error: unknown,
  errorClass: new (...args: any[]) => T
): error is T {
  return error instanceof errorClass;
}

/**
 * Create a FameTransportClose error from a WebSocket close event.
 */
export function createTransportCloseError(code: number, reason?: string): FameTransportClose {
  const message = reason || `Transport closed with code ${code}`;
  return new FameTransportClose(message, code);
}
