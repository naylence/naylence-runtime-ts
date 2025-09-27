import { WebSocketListener } from '../websocket-listener.js';
import type { HttpServer } from '../http-server.js';

function createHttpServerStub(): HttpServer {
  return {
    host: 'localhost',
    port: 8080,
    isRunning: false,
    actualHost: 'localhost',
    actualPort: 8080,
    actualBaseUrl: 'http://localhost:8080',
    async start() {},
    async stop() {},
    async includeRouter() {},
  };
}

describe('WebSocketListener token extraction', () => {
  function createListener(): WebSocketListener {
    return new WebSocketListener({ httpServer: createHttpServerStub() });
  }

  function extractToken(listener: WebSocketListener, header: string | string[] | undefined): string {
    return (listener as unknown as { _extractBearerToken: (value: string | string[] | undefined) => string })
      ._extractBearerToken(header);
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
