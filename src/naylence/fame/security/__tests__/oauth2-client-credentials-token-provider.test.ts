import { OAuth2ClientCredentialsTokenProvider } from '../auth/oauth2-client-credentials-token-provider.js';
import type { CredentialProvider } from '../credential/credential-provider.js';

describe('OAuth2ClientCredentialsTokenProvider', () => {
  class StaticCredentialProvider implements CredentialProvider {
    constructor(private readonly value: string) {}

    async get(): Promise<string> {
      return this.value;
    }
  }

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('accepts snake_case options and caches tokens respecting clock skew', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-01-01T00:00:00Z'));

    const fetchCalls: Array<{ url: RequestInfo | URL; init?: RequestInit }> =
      [];
    const fetchImpl = jest.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls.push({ url: input, init });
        return new Response(
          JSON.stringify({ access_token: 'token-value', expires_in: 60 }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
    );

    const provider = new OAuth2ClientCredentialsTokenProvider({
      token_url: 'https://issuer.example/oauth/token',
      client_id_provider: new StaticCredentialProvider('client-id'),
      client_secret_provider: new StaticCredentialProvider('client-secret'),
      scopes: [' scope:a ', ''],
      aud: '/nodes/node-1',
      fetch_impl: fetchImpl,
      clock_skew_seconds: 10,
    } as Record<string, unknown>);

    const firstToken = await provider.getToken();
    expect(firstToken.value).toBe('token-value');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const firstCall = fetchCalls[0];
    expect(firstCall.url).toBe('https://issuer.example/oauth/token');
    const bodyParams = new URLSearchParams(firstCall.init?.body as string);
    expect(bodyParams.get('grant_type')).toBe('client_credentials');
    expect(bodyParams.get('client_id')).toBe('client-id');
    expect(bodyParams.get('client_secret')).toBe('client-secret');
    expect(bodyParams.get('scope')).toBe('scope:a');
    expect(bodyParams.get('audience')).toBe('/nodes/node-1');

    const secondToken = await provider.getToken();
    expect(secondToken.value).toBe('token-value');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(20_000);
    await provider.getToken();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(31_000);
    const refreshedToken = await provider.getToken();
    expect(refreshedToken.value).toBe('token-value');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
