import { GRANT_PURPOSE_NODE_ATTACH } from '../grant.js';
import {
  HTTP_CONNECTION_GRANT_TYPE,
  normalizeHttpConnectionGrant,
} from '../http-connection-grant.js';

describe('normalizeHttpConnectionGrant', () => {
  it('fills missing purpose with node.attach', () => {
    const result = normalizeHttpConnectionGrant({
      type: HTTP_CONNECTION_GRANT_TYPE,
      url: 'https://example.invalid/callback',
    });

    expect(result.purpose).toBe(GRANT_PURPOSE_NODE_ATTACH);
  });

  it('preserves provided purpose', () => {
    const result = normalizeHttpConnectionGrant({
      type: HTTP_CONNECTION_GRANT_TYPE,
      url: 'https://example.invalid/callback',
      purpose: 'custom-purpose',
    });

    expect(result.purpose).toBe('custom-purpose');
  });

  it('defaults type when omitted', () => {
    const result = normalizeHttpConnectionGrant({
      url: 'https://example.invalid/callback',
      purpose: GRANT_PURPOSE_NODE_ATTACH,
    });

    expect(result.type).toBe(HTTP_CONNECTION_GRANT_TYPE);
  });

  it('normalizes auth injection strategy aliases', () => {
    const result = normalizeHttpConnectionGrant({
      type: HTTP_CONNECTION_GRANT_TYPE,
      url: 'https://example.invalid/callback',
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
