import { getLogger } from '../../util/logging.js';
import {
  credentialToString,
  type CredentialProvider,
} from '../credential/credential-provider.js';
import type { Token } from './token.js';
import type { TokenProvider } from './token-provider.js';

const logger = getLogger('oauth2-client-credentials-token-provider');

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

export class OAuth2ClientCredentialsTokenProvider implements TokenProvider {
  private cachedToken: Token | undefined;

  constructor(
    private readonly options: OAuth2ClientCredentialsTokenProviderOptions
  ) {
    if (!options.tokenUrl) {
      throw new Error('OAuth2 token URL must be provided');
    }
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
}
