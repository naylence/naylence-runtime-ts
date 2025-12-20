import { getLogger } from '../../util/logging.js';
import {
  credentialToString,
  type CredentialProvider,
} from '../credential/credential-provider.js';
import type { Token } from './token.js';
import type { IdentityExposingTokenProvider } from './token-provider.js';
import type { AuthIdentity } from './auth-identity.js';

const logger = getLogger(
  'naylence.fame.security.auth.oauth2_client_credentials_token_provider'
);

interface FetchLike {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface OAuth2ClientCredentialsTokenProviderOptions {
  tokenUrl: string;
  clientIdProvider: CredentialProvider;
  clientSecretProvider: CredentialProvider;
  scopes?: string[];
  audience?: string;
  fetchImpl?: FetchLike;
  clockSkewSeconds?: number;
}

type SnakeCaseOAuth2ClientCredentialsOptions = Partial<
  Record<
    | 'token_url'
    | 'client_id_provider'
    | 'client_secret_provider'
    | 'scope'
    | 'scopes'
    | 'audience'
    | 'aud'
    | 'fetch_impl'
    | 'clock_skew_seconds',
    unknown
  >
>;

function normalizeOptions(
  raw: OAuth2ClientCredentialsTokenProviderOptions | Record<string, unknown>
): OAuth2ClientCredentialsTokenProviderOptions {
  const camel = raw as OAuth2ClientCredentialsTokenProviderOptions;
  const snake = raw as SnakeCaseOAuth2ClientCredentialsOptions;

  const tokenUrlCandidate = camel.tokenUrl ?? snake.token_url;
  const tokenUrl =
    typeof tokenUrlCandidate === 'string' && tokenUrlCandidate.trim().length > 0
      ? tokenUrlCandidate.trim()
      : undefined;
  if (!tokenUrl) {
    throw new Error('OAuth2 token URL must be provided');
  }

  const clientIdProvider =
    camel.clientIdProvider ??
    (snake.client_id_provider as CredentialProvider | undefined);
  if (!clientIdProvider) {
    throw new Error('OAuth2 client ID provider must be supplied');
  }

  const clientSecretProvider =
    camel.clientSecretProvider ??
    (snake.client_secret_provider as CredentialProvider | undefined);
  if (!clientSecretProvider) {
    throw new Error('OAuth2 client secret provider must be supplied');
  }

  const scopesCandidate = camel.scopes ?? snake.scopes ?? snake.scope;
  let scopes: string[] | undefined;
  if (Array.isArray(scopesCandidate)) {
    scopes = scopesCandidate
      .map((scope) => (typeof scope === 'string' ? scope.trim() : ''))
      .filter((scope) => scope.length > 0);
  } else if (typeof scopesCandidate === 'string') {
    scopes = scopesCandidate
      .split(/[\s,]+/)
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0);
  }

  const audienceCandidate = camel.audience ?? snake.audience ?? snake.aud;
  const audience =
    typeof audienceCandidate === 'string' && audienceCandidate.trim().length > 0
      ? audienceCandidate.trim()
      : undefined;

  const fetchImplCandidate = camel.fetchImpl ?? snake.fetch_impl;
  const fetchImpl =
    typeof fetchImplCandidate === 'function'
      ? (fetchImplCandidate as FetchLike)
      : undefined;

  const clockSkewCandidate = camel.clockSkewSeconds ?? snake.clock_skew_seconds;
  const clockSkewSeconds =
    typeof clockSkewCandidate === 'number' &&
    Number.isFinite(clockSkewCandidate)
      ? clockSkewCandidate
      : undefined;

  return {
    tokenUrl,
    clientIdProvider,
    clientSecretProvider,
    ...(scopes ? { scopes } : {}),
    ...(audience ? { audience } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(clockSkewSeconds !== undefined ? { clockSkewSeconds } : {}),
  };
}

interface OAuth2TokenResponse {
  access_token?: string;
  expires_in?: number;
  expires?: number;
  token_type?: string;
  scope?: string;
  [key: string]: unknown;
}

const DEFAULT_EXPIRY_SECONDS = 3600;
const DEFAULT_CLOCK_SKEW_SECONDS = 30;

export class OAuth2ClientCredentialsTokenProvider
  implements IdentityExposingTokenProvider
{
  private cachedToken: Token | undefined;
  private readonly options: OAuth2ClientCredentialsTokenProviderOptions;

  constructor(
    rawOptions:
      | OAuth2ClientCredentialsTokenProviderOptions
      | Record<string, unknown>
  ) {
    const options = normalizeOptions(rawOptions);

    this.options = options;
  }

  public async getToken(): Promise<Token> {
    if (this.cachedToken && this.isTokenFresh(this.cachedToken)) {
      logger.debug('using_cached_oauth2_token', {
        token_url: this.options.tokenUrl,
      });
      return { ...this.cachedToken };
    }

    this.cachedToken = await this.fetchNewToken();
    return { ...this.cachedToken };
  }

  private isTokenFresh(token: Token): boolean {
    if (typeof token.expiresAt !== 'number') {
      return true;
    }

    const clockSkew =
      this.options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
    return token.expiresAt - clockSkew * 1000 > Date.now();
  }

  private async fetchNewToken(): Promise<Token> {
    const fetchImpl = this.resolveFetch();

    const clientId = credentialToString(
      await this.options.clientIdProvider.get()
    );
    if (!clientId) {
      throw new Error('OAuth2 client ID provider returned empty value');
    }

    const clientSecret = credentialToString(
      await this.options.clientSecretProvider.get()
    );
    if (!clientSecret) {
      throw new Error('OAuth2 client secret provider returned empty value');
    }

    const params = new URLSearchParams();
    params.set('grant_type', 'client_credentials');
    params.set('client_id', clientId);
    params.set('client_secret', clientSecret);

    if (this.options.scopes && this.options.scopes.length > 0) {
      params.set('scope', this.options.scopes.join(' '));
    }

    if (this.options.audience) {
      params.set('audience', this.options.audience);
    }

    const response = await fetchImpl(this.options.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '<unavailable>');
      throw new Error(
        `OAuth2 token request failed: ${response.status} ${response.statusText} - ${errorBody}`
      );
    }

    const payload = (await response.json()) as OAuth2TokenResponse;
    const accessToken =
      typeof payload.access_token === 'string'
        ? payload.access_token
        : undefined;
    if (!accessToken) {
      throw new Error('OAuth2 token response did not include access_token');
    }

    const expiresInSeconds = this.resolveExpiresIn(payload);
    const expiresAt = Date.now() + expiresInSeconds * 1000;

    logger.debug('oauth2_token_fetched', {
      token_url: this.options.tokenUrl,
      scopes: this.options.scopes,
      audience: this.options.audience,
      expires_in: expiresInSeconds,
    });

    return {
      value: accessToken,
      expiresAt,
    };
  }

  private resolveFetch(): FetchLike {
    if (this.options.fetchImpl) {
      return this.options.fetchImpl;
    }

    if (typeof fetch === 'function') {
      return fetch.bind(globalThis) as FetchLike;
    }

    throw new Error(
      'Global fetch implementation is not available. Provide fetchImpl in options.'
    );
  }

  private resolveExpiresIn(payload: OAuth2TokenResponse): number {
    const expiresInCandidate = payload.expires_in ?? payload.expires;
    if (
      typeof expiresInCandidate === 'number' &&
      Number.isFinite(expiresInCandidate)
    ) {
      return Math.max(1, Math.floor(expiresInCandidate));
    }

    return DEFAULT_EXPIRY_SECONDS;
  }

  public async getIdentity(): Promise<AuthIdentity | undefined> {
    const token = await this.getToken();
    const tokenValue = token.value;
    const parts = tokenValue.split('.');
    if (parts.length !== 3) {
      return undefined;
    }

    try {
      const payloadSegment = parts[1];
      // Fix padding for base64url
      const padding = '='.repeat((4 - (payloadSegment.length % 4)) % 4);
      const base64 = (payloadSegment + padding)
        .replace(/-/g, '+')
        .replace(/_/g, '/');

      let jsonString: string;
      if (typeof Buffer !== 'undefined') {
        jsonString = Buffer.from(base64, 'base64').toString('utf-8');
      } else if (typeof atob === 'function') {
        jsonString = atob(base64);
        try {
          jsonString = decodeURIComponent(
            jsonString
              .split('')
              .map(function (c) {
                return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
              })
              .join('')
          );
        } catch {
          // ignore
        }
      } else {
        return undefined;
      }

      const payload = JSON.parse(jsonString);
      if (payload && typeof payload.sub === 'string') {
        return { subject: payload.sub, claims: payload };
      }
    } catch {
      // ignore decoding errors
    }
    return undefined;
  }
}
