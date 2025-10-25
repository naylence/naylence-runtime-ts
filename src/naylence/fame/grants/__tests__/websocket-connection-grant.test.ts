import { GRANT_PURPOSE_NODE_ATTACH } from '../grant.js';
import {
  WEBSOCKET_CONNECTION_GRANT_TYPE,
  normalizeWebSocketConnectionGrant,
} from '../websocket-connection-grant.js';

describe('normalizeWebSocketConnectionGrant', () => {
  it('fills missing purpose with node.attach', () => {
    const result = normalizeWebSocketConnectionGrant({
      type: WEBSOCKET_CONNECTION_GRANT_TYPE,
    });

    expect(result.purpose).toBe(GRANT_PURPOSE_NODE_ATTACH);
  });

  it('preserves provided purpose', () => {
    const result = normalizeWebSocketConnectionGrant({
      type: WEBSOCKET_CONNECTION_GRANT_TYPE,
      purpose: 'custom-purpose',
    });

    expect(result.purpose).toBe('custom-purpose');
  });

  it('defaults type when omitted', () => {
    const result = normalizeWebSocketConnectionGrant({
      purpose: GRANT_PURPOSE_NODE_ATTACH,
    });

    expect(result.type).toBe(WEBSOCKET_CONNECTION_GRANT_TYPE);
  });

  it('normalizes auth injection strategy aliases', () => {
    const result = normalizeWebSocketConnectionGrant({
      type: WEBSOCKET_CONNECTION_GRANT_TYPE,
      auth: {
        type: 'BearerTokenHeaderAuthInjectionStrategy',
        tokenProvider: {
          type: 'StaticTokenProvider',
          token: 'token',
          expiresAt: new Date(),
        },
      },
    });

    expect(result.auth).toEqual(
      expect.objectContaining({ type: 'BearerTokenHeaderAuth' })
    );
  });
});
