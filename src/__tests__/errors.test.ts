/**
 * Tests for Fame error classes and utilities
 */

import {
  FameError,
  FameTransportClose,
  FameConnectError,
  FameMessageTooLarge,
  FameProtocolError,
  BackPressureFull,
  NotAuthorized,
  WebSocketCloseCode,
  isFameError,
  isFameErrorType,
  createTransportCloseError,
} from '../naylence/fame/errors';

describe('Fame Errors', () => {
  describe('FameError base class', () => {
    class TestFameError extends FameError {}

    it('should create error with message', () => {
      const error = new TestFameError('test message');
      expect(error.message).toBe('test message');
      expect(error.name).toBe('TestFameError');
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(FameError);
    });

    it('should create error with message and code', () => {
      const error = new TestFameError('test message', 1001);
      expect(error.message).toBe('test message');
      expect(error.code).toBe(1001);
    });

    it('should maintain proper prototype chain', () => {
      const error = new TestFameError('test');
      expect(error instanceof TestFameError).toBe(true);
      expect(error instanceof FameError).toBe(true);
      expect(error instanceof Error).toBe(true);
    });
  });

  describe('Specific error types', () => {
    it('should create FameTransportClose with default message', () => {
      const error = new FameTransportClose();
      expect(error.message).toBe('Fame transport closed');
      expect(error.name).toBe('FameTransportClose');
      expect(error).toBeInstanceOf(FameTransportClose);
    });

    it('should create FameConnectError with custom message', () => {
      const error = new FameConnectError('Connection failed', 1006);
      expect(error.message).toBe('Connection failed');
      expect(error.code).toBe(1006);
    });

    it('should create FameMessageTooLarge', () => {
      const error = new FameMessageTooLarge();
      expect(error.message).toBe('Fame message too large');
      expect(error).toBeInstanceOf(FameMessageTooLarge);
    });

    it('should create FameProtocolError', () => {
      const error = new FameProtocolError('Invalid frame');
      expect(error.message).toBe('Invalid frame');
      expect(error).toBeInstanceOf(FameProtocolError);
    });

    it('should create BackPressureFull', () => {
      const error = new BackPressureFull();
      expect(error.message).toBe('Back pressure buffer full');
      expect(error).toBeInstanceOf(BackPressureFull);
    });

    it('should create NotAuthorized', () => {
      const error = new NotAuthorized('Access denied');
      expect(error.message).toBe('Access denied');
      expect(error).toBeInstanceOf(NotAuthorized);
    });
  });

  describe('WebSocket close codes', () => {
    it('should have correct close code values', () => {
      expect(WebSocketCloseCode.NORMAL_CLOSURE).toBe(1000);
      expect(WebSocketCloseCode.GOING_AWAY).toBe(1001);
      expect(WebSocketCloseCode.PROTOCOL_ERROR).toBe(1002);
      expect(WebSocketCloseCode.MESSAGE_TOO_BIG).toBe(1009);
      expect(WebSocketCloseCode.INTERNAL_ERROR).toBe(1011);
    });
  });

  describe('Error utilities', () => {
    it('should identify Fame errors correctly', () => {
      const fameError = new FameTransportClose();
      const regularError = new Error('regular error');

      expect(isFameError(fameError)).toBe(true);
      expect(isFameError(regularError)).toBe(false);
      expect(isFameError('not an error')).toBe(false);
      expect(isFameError(null)).toBe(false);
    });

    it('should identify specific Fame error types', () => {
      const transportError = new FameTransportClose();
      const connectError = new FameConnectError();

      expect(isFameErrorType(transportError, FameTransportClose)).toBe(true);
      expect(isFameErrorType(transportError, FameConnectError)).toBe(false);
      expect(isFameErrorType(connectError, FameConnectError)).toBe(true);
      expect(isFameErrorType('not an error', FameTransportClose)).toBe(false);
    });

    it('should create transport close error from WebSocket close', () => {
      const error = createTransportCloseError(1001, 'Server going away');
      expect(error).toBeInstanceOf(FameTransportClose);
      expect(error.message).toBe('Server going away');
      expect(error.code).toBe(1001);
    });

    it('should create transport close error without reason', () => {
      const error = createTransportCloseError(1002);
      expect(error.message).toBe('Transport closed with code 1002');
      expect(error.code).toBe(1002);
    });
  });
});
