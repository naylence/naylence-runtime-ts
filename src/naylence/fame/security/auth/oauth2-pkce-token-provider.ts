import { getLogger } from '../../util/logging.js';
import {
  credentialToString,
  type CredentialProvider,
} from '../credential/credential-provider.js';
import type { Token } from './token.js';
import type { TokenProvider } from './token-provider.js';

const logger = getLogger(
  'naylence.fame.security.auth.oauth2_pkce_token_provider'
);

interface FetchLike {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

type PkceMethod = 'S256' | 'PLAIN';

export interface OAuth2PkceTokenProviderOptions {
  authorizeUrl: string;
  tokenUrl: string;
  redirectUri: string;
  clientId: string;
  usernameProvider?: CredentialProvider;
  clientSecretProvider?: CredentialProvider;
  scopes?: string[];
  audience?: string;
  fetchImpl?: FetchLike;
  clockSkewSeconds?: number;
  codeVerifierLength?: number;
  codeChallengeMethod?: PkceMethod;
  loginHintParam?: string;
}

type SnakeCaseOAuth2PkceOptions = Partial<
  Record<
    | 'authorize_url'
    | 'token_url'
    | 'redirect_uri'
    | 'client_id'
    | 'username_provider'
    | 'client_secret_provider'
    | 'scopes'
    | 'scope'
    | 'audience'
    | 'aud'
    | 'fetch_impl'
    | 'clock_skew_seconds'
    | 'code_verifier_length'
    | 'code_challenge_method'
    | 'login_hint_param',
    unknown
  >
>;

type BufferCtor = {
  from(
    input: Uint8Array | string,
    encoding?: string
  ): { toString(encoding: string): string };
};

const DEFAULT_SCOPES: string[] = [];
const DEFAULT_CLOCK_SKEW_SECONDS = 30;
const DEFAULT_CODE_VERIFIER_LENGTH = 48; // bytes before base64url encoding
const DEFAULT_CODE_CHALLENGE_METHOD: PkceMethod = 'S256';

function normalizeScopes(candidate: unknown): string[] | undefined {
  if (Array.isArray(candidate)) {
    const scopes = candidate
      .map((scope) => (typeof scope === 'string' ? scope.trim() : ''))
      .filter((scope) => scope.length > 0);
    return scopes.length > 0 ? scopes : undefined;
  }
  if (typeof candidate === 'string') {
    const scopes = candidate
      .split(/[,\s]+/u)
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0);
    return scopes.length > 0 ? scopes : undefined;
  }
  return undefined;
}

function coerceString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeOptions(
  raw: OAuth2PkceTokenProviderOptions | Record<string, unknown>
): Required<
  Pick<
    OAuth2PkceTokenProviderOptions,
    'authorizeUrl' | 'tokenUrl' | 'redirectUri' | 'clientId'
  >
> &
  Omit<
    OAuth2PkceTokenProviderOptions,
    'authorizeUrl' | 'tokenUrl' | 'redirectUri' | 'clientId'
  > {
  const camel = raw as OAuth2PkceTokenProviderOptions;
  const snake = raw as SnakeCaseOAuth2PkceOptions;

  const authorizeUrl =
    coerceString(camel.authorizeUrl) ?? coerceString(snake.authorize_url);
  if (!authorizeUrl) {
    throw new Error('OAuth2PkceTokenProvider authorizeUrl must be provided');
  }

  const tokenUrl =
    coerceString(camel.tokenUrl) ?? coerceString(snake.token_url);
  if (!tokenUrl) {
    throw new Error('OAuth2PkceTokenProvider tokenUrl must be provided');
  }

  const redirectUri =
    coerceString(camel.redirectUri) ?? coerceString(snake.redirect_uri);
  if (!redirectUri) {
    throw new Error('OAuth2PkceTokenProvider redirectUri must be provided');
  }

  const clientId =
    coerceString(camel.clientId) ?? coerceString(snake.client_id);
  if (!clientId) {
    throw new Error('OAuth2PkceTokenProvider clientId must be provided');
  }

  const usernameProvider =
    camel.usernameProvider ??
    (snake.username_provider as CredentialProvider | undefined);

  const clientSecretProvider =
    camel.clientSecretProvider ??
    (snake.client_secret_provider as CredentialProvider | undefined);

  const scopes =
    normalizeScopes(camel.scopes) ??
    normalizeScopes(snake.scopes ?? snake.scope) ??
    DEFAULT_SCOPES.slice();

  const audience =
    coerceString(camel.audience) ?? coerceString(snake.audience ?? snake.aud);

  const fetchImpl = (camel.fetchImpl ?? snake.fetch_impl) as
    | FetchLike
    | undefined;

  const clockSkewSeconds =
    coerceNumber(camel.clockSkewSeconds) ??
    coerceNumber(snake.clock_skew_seconds) ??
    DEFAULT_CLOCK_SKEW_SECONDS;

  const codeVerifierLength =
    coerceNumber(camel.codeVerifierLength) ??
    coerceNumber(snake.code_verifier_length) ??
    DEFAULT_CODE_VERIFIER_LENGTH;

  const methodCandidate =
    coerceString(camel.codeChallengeMethod) ??
    coerceString(snake.code_challenge_method);
  const codeChallengeMethod: PkceMethod =
    methodCandidate && methodCandidate.toUpperCase() === 'PLAIN'
      ? 'PLAIN'
      : DEFAULT_CODE_CHALLENGE_METHOD;

  const loginHintParam =
    coerceString(camel.loginHintParam) ??
    coerceString(snake.login_hint_param) ??
    'login_hint';

  return {
    authorizeUrl,
    tokenUrl,
    redirectUri,
    clientId,
    usernameProvider,
    clientSecretProvider,
    scopes,
    audience,
    fetchImpl,
    clockSkewSeconds,
    codeVerifierLength,
    codeChallengeMethod,
    loginHintParam,
  };
}

function generateRandomBytes(length: number): Uint8Array {
  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw new Error(
      'crypto.getRandomValues is unavailable. Provide a secure random source.'
    );
  }

  const buffer = new Uint8Array(length);
  globalThis.crypto.getRandomValues(buffer);
  return buffer;
}

function base64UrlEncode(buffer: Uint8Array): string {
  const bufferCtor = (globalThis as Record<string, unknown>).Buffer as
    | BufferCtor
    | undefined;

  if (bufferCtor) {
    return bufferCtor
      .from(buffer)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/u, '');
  }

  let binary = '';
  for (const byte of buffer) {
    binary += String.fromCharCode(byte);
  }

  if (typeof globalThis.btoa === 'function') {
    return globalThis
      .btoa(binary)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/u, '');
  }

  throw new Error('Base64 encoding is unavailable in this environment');
}

async function computeS256(verifier: string): Promise<string> {
  if (typeof globalThis.crypto?.subtle !== 'object') {
    throw new Error(
      'crypto.subtle.digest is unavailable. Provide an environment with Web Crypto support.'
    );
  }

  const encoder = new TextEncoder();
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    encoder.encode(verifier)
  );
  return base64UrlEncode(new Uint8Array(digest));
}

function ensureFinitePositive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number`);
  }
  return Math.max(1, Math.floor(value));
}

/**
 * In-memory token cache for PKCE tokens.
 *
 * Tokens are intentionally NOT persisted to localStorage or sessionStorage to avoid
 * stale-token issues when the OAuth2 server restarts and generates new signing keys.
 * Each fresh page load triggers a new PKCE flow when a token is needed.
 */
let inMemoryTokenCache: Map<string, PersistedTokenRecord> = new Map();

const STORAGE_NAMESPACE = 'naylence.oauth2_pkce.';

type PendingAuthorization = {
  state: string;
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: PkceMethod;
  authorizeUrl: string;
  createdAt: number;
};

type StoredAuthorization = PendingAuthorization & {
  scopes?: string[];
  audience?: string;
};

type PersistedTokenRecord = {
  value: string;
  expiresAt?: number;
  scopes?: string[];
  audience?: string;
};

type RedirectOutcome = {
  code: string;
  state: string;
  error?: string;
  errorDescription?: string;
};

function getStorageKey(clientId: string): string {
  return `${STORAGE_NAMESPACE}${clientId}`;
}

function isBrowserEnvironment(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.location !== 'undefined' &&
    typeof window.sessionStorage !== 'undefined'
  );
}

function readPendingAuthorization(
  clientId: string
): StoredAuthorization | null {
  if (!isBrowserEnvironment()) {
    return null;
  }

  try {
    const raw = window.sessionStorage.getItem(getStorageKey(clientId));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as StoredAuthorization;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return parsed;
  } catch (error) {
    logger.debug('pkce_storage_read_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function writePendingAuthorization(
  clientId: string,
  pending: StoredAuthorization | null
): void {
  if (!isBrowserEnvironment()) {
    return;
  }

  try {
    const key = getStorageKey(clientId);
    if (!pending) {
      window.sessionStorage.removeItem(key);
      return;
    }
    window.sessionStorage.setItem(key, JSON.stringify(pending));
  } catch (error) {
    logger.debug('pkce_storage_write_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function stableScopeKey(scopes?: string[]): string {
  if (!scopes || scopes.length === 0) {
    return '';
  }

  return [...scopes].sort().join(' ');
}

/**
 * Read token from in-memory cache.
 * Returns null if no cached token exists for the given clientId.
 */
function readPersistedToken(clientId: string): PersistedTokenRecord | null {
  return inMemoryTokenCache.get(clientId) ?? null;
}

/**
 * Write token to in-memory cache.
 * If token is null, removes the cached token for the given clientId.
 */
function writePersistedToken(
  clientId: string,
  token: PersistedTokenRecord | null
): void {
  if (!token) {
    inMemoryTokenCache.delete(clientId);
    return;
  }

  inMemoryTokenCache.set(clientId, token);
}

function clearOAuthParamsFromUrl(url: URL): void {
  if (!isBrowserEnvironment()) {
    return;
  }

  try {
    const cleaned = new URL(url.toString());
    cleaned.searchParams.delete('code');
    cleaned.searchParams.delete('state');
    cleaned.searchParams.delete('error');
    cleaned.searchParams.delete('error_description');
    cleaned.searchParams.delete('error_description'.toUpperCase());
    cleaned.searchParams.delete('scope');
    cleaned.searchParams.delete('scope'.toUpperCase());

    const finalUrl = `${cleaned.pathname}${cleaned.search}${cleaned.hash}`;
    window.history.replaceState(window.history.state, '', finalUrl);
  } catch (error) {
    logger.debug('pkce_replace_state_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function collectRedirectOutcome(
  currentLocation: Location
): RedirectOutcome | null {
  const url = new URL(currentLocation.href);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  const errorDescription =
    url.searchParams.get('error_description') ??
    url.searchParams.get('error_description'.toUpperCase());

  if (!code && !error) {
    return null;
  }

  return {
    code: code ?? '',
    state: state ?? '',
    error: error ?? undefined,
    errorDescription: errorDescription ?? undefined,
  };
}

export class OAuth2PkceRedirectInitiatedError extends Error {
  constructor(message = 'OAuth2PkceTokenProvider initiated browser redirect') {
    super(message);
    this.name = 'OAuth2PkceRedirectInitiatedError';
  }
}

export class OAuth2PkceTokenProvider implements TokenProvider {
  private cachedToken: Token | undefined;
  private readonly options: ReturnType<typeof normalizeOptions>;

  constructor(
    rawOptions: OAuth2PkceTokenProviderOptions | Record<string, unknown>
  ) {
    this.options = normalizeOptions(rawOptions);
  }

  public async getToken(): Promise<Token> {
    if (!isBrowserEnvironment()) {
      throw new Error(
        'OAuth2PkceTokenProvider requires a browser environment with sessionStorage support'
      );
    }

    if (!this.cachedToken) {
      const persisted = readPersistedToken(this.options.clientId);
      if (persisted) {
        if (this.isTokenCompatible(persisted.scopes, persisted.audience)) {
          if (!persisted.expiresAt || this.isTokenFresh(persisted)) {
            logger.debug('using_persisted_oauth2_pkce_token', {
              authorize_url: this.options.authorizeUrl,
            });
            const cached: Token = {
              value: persisted.value,
            };
            if (typeof persisted.expiresAt === 'number') {
              cached.expiresAt = persisted.expiresAt;
            }
            this.cachedToken = cached;
          } else {
            writePersistedToken(this.options.clientId, null);
          }
        } else {
          writePersistedToken(this.options.clientId, null);
        }
      }
    }

    if (this.cachedToken && this.isTokenFresh(this.cachedToken)) {
      logger.debug('using_cached_oauth2_pkce_token', {
        authorize_url: this.options.authorizeUrl,
      });
      return { ...this.cachedToken };
    }

    const tokenFromRedirect = await this.tryCompletePendingAuthorization();
    if (tokenFromRedirect) {
      this.cachedToken = tokenFromRedirect;
      return { ...this.cachedToken };
    }

    await this.beginBrowserAuthorization();
    throw new OAuth2PkceRedirectInitiatedError();
  }

  private isTokenFresh(token: Token): boolean {
    if (typeof token.expiresAt !== 'number') {
      return true;
    }

    const skew = this.options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
    return token.expiresAt - skew * 1000 > Date.now();
  }

  private async beginBrowserAuthorization(): Promise<void> {
    const existing = readPendingAuthorization(this.options.clientId);
    if (existing) {
      logger.debug('pkce_redirect_in_progress', {
        authorize_url: this.options.authorizeUrl,
      });
      this.navigate(existing.authorizeUrl);
      return;
    }

    const verifierLength = ensureFinitePositive(
      this.options.codeVerifierLength ?? DEFAULT_CODE_VERIFIER_LENGTH,
      'codeVerifierLength'
    );
    const codeVerifier = base64UrlEncode(generateRandomBytes(verifierLength));
    const state = base64UrlEncode(generateRandomBytes(24));

    const codeChallengeMethod = this.options.codeChallengeMethod ?? 'S256';
    const codeChallenge =
      codeChallengeMethod === 'S256'
        ? await computeS256(codeVerifier)
        : codeVerifier;

    const authorizeUrl = await this.buildAuthorizeUrl({
      state,
      codeChallenge,
      codeChallengeMethod,
    });

    const pending: StoredAuthorization = {
      state,
      codeVerifier,
      codeChallenge,
      codeChallengeMethod,
      authorizeUrl,
      createdAt: Date.now(),
      scopes: this.options.scopes,
      audience: this.options.audience,
    };

    writePersistedToken(this.options.clientId, null);
    writePendingAuthorization(this.options.clientId, pending);

    logger.debug('pkce_redirect_start', {
      authorize_url: this.options.authorizeUrl,
      redirect_uri: this.options.redirectUri,
    });

    this.navigate(authorizeUrl);
  }

  private navigate(url: string): void {
    if (!isBrowserEnvironment()) {
      return;
    }

    try {
      window.location.assign(url);
    } catch (error) {
      logger.error('pkce_navigation_failed', {
        authorize_url: url,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async tryCompletePendingAuthorization(): Promise<Token | null> {
    const pending = readPendingAuthorization(this.options.clientId);
    if (!pending) {
      return null;
    }

    const outcome = collectRedirectOutcome(window.location);
    if (!outcome) {
      return null;
    }

    clearOAuthParamsFromUrl(new URL(window.location.href));

    writePendingAuthorization(this.options.clientId, null);

    if (outcome.error) {
      const suffix = outcome.errorDescription
        ? ` - ${outcome.errorDescription}`
        : '';
      throw new Error(`OAuth2 authorization failed: ${outcome.error}${suffix}`);
    }

    if (!outcome.code) {
      throw new Error('Authorization redirect missing code parameter');
    }

    if (!outcome.state || outcome.state !== pending.state) {
      throw new Error('Authorization state mismatch');
    }

    const fetchImpl = this.resolveFetch();
    const clientSecret = await this.resolveOptionalSecret(
      this.options.clientSecretProvider
    );

    const token = await this.exchangeToken({
      fetchImpl,
      codeVerifier: pending.codeVerifier,
      authorizationCode: outcome.code,
      clientSecret,
      scopes: pending.scopes,
      audience: pending.audience,
    });

    this.persistToken(token, {
      scopes: pending.scopes,
      audience: pending.audience,
    });

    return token;
  }

  private isTokenCompatible(scopes?: string[], audience?: string): boolean {
    const expectedScopeKey = stableScopeKey(this.options.scopes);
    const tokenScopeKey = stableScopeKey(scopes);
    if (expectedScopeKey !== tokenScopeKey) {
      return false;
    }

    const expectedAudience = this.options.audience ?? '';
    const tokenAudience = audience ?? '';
    return expectedAudience === tokenAudience;
  }

  private persistToken(
    token: Token,
    metadata: { scopes?: string[]; audience?: string }
  ): void {
    writePersistedToken(this.options.clientId, {
      value: token.value,
      expiresAt: token.expiresAt,
      scopes: metadata.scopes ? [...metadata.scopes] : undefined,
      audience: metadata.audience,
    });
  }

  private async buildAuthorizeUrl(params: {
    state: string;
    codeChallenge: string;
    codeChallengeMethod: PkceMethod;
  }): Promise<string> {
    const authorizeUrl = new URL(this.options.authorizeUrl);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', this.options.clientId);
    authorizeUrl.searchParams.set('redirect_uri', this.options.redirectUri);
    authorizeUrl.searchParams.set('state', params.state);
    authorizeUrl.searchParams.set(
      'code_challenge_method',
      params.codeChallengeMethod
    );
    authorizeUrl.searchParams.set('code_challenge', params.codeChallenge);

    if (this.options.scopes && this.options.scopes.length > 0) {
      authorizeUrl.searchParams.set('scope', this.options.scopes.join(' '));
    }

    if (this.options.audience) {
      authorizeUrl.searchParams.set('audience', this.options.audience);
    }

    const loginHint = await this.resolveOptionalSecret(
      this.options.usernameProvider
    );
    if (loginHint) {
      authorizeUrl.searchParams.set(
        this.options.loginHintParam ?? 'login_hint',
        loginHint
      );
    }

    return authorizeUrl.toString();
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

  private async resolveOptionalSecret(
    provider?: CredentialProvider
  ): Promise<string | undefined> {
    if (!provider) {
      return undefined;
    }

    const value = credentialToString(await provider.get());
    return value ?? undefined;
  }

  private async exchangeToken(params: {
    fetchImpl: FetchLike;
    codeVerifier: string;
    authorizationCode: string;
    clientSecret?: string;
    scopes?: string[];
    audience?: string;
  }): Promise<Token> {
    const {
      fetchImpl,
      codeVerifier,
      authorizationCode,
      clientSecret,
      scopes,
      audience,
    } = params;

    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.options.clientId,
      code: authorizationCode,
      redirect_uri: this.options.redirectUri,
      code_verifier: codeVerifier,
    });

    if (scopes && scopes.length > 0) {
      form.set('scope', scopes.join(' '));
    }

    if (audience) {
      form.set('audience', audience);
    }

    if (clientSecret) {
      form.set('client_secret', clientSecret);
    }

    const response = await fetchImpl(this.options.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '<unavailable>');
      throw new Error(
        `OAuth2 PKCE token request failed: ${response.status} ${response.statusText} - ${errorBody}`
      );
    }

    const payload = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
      expires?: number;
    };

    const accessToken = payload.access_token;
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new Error('OAuth2 PKCE token response missing access_token');
    }

    const expiresInCandidate =
      typeof payload.expires_in === 'number'
        ? payload.expires_in
        : typeof payload.expires === 'number'
          ? payload.expires
          : undefined;

    const expiresInSeconds =
      expiresInCandidate && Number.isFinite(expiresInCandidate)
        ? Math.max(1, Math.floor(expiresInCandidate))
        : 3600;

    const token: Token = {
      value: accessToken,
      expiresAt: Date.now() + expiresInSeconds * 1000,
    };

    logger.debug('oauth2_pkce_token_fetched', {
      authorize_url: this.options.authorizeUrl,
      token_url: this.options.tokenUrl,
      expires_in: expiresInSeconds,
      scopes,
      audience,
    });

    return token;
  }

  /**
   * Clear the cached token for this provider instance.
   * This clears both the instance cache and the in-memory module cache.
   */
  public clearToken(): void {
    this.cachedToken = undefined;
    writePersistedToken(this.options.clientId, null);
    logger.debug('oauth2_pkce_token_cleared', {
      authorize_url: this.options.authorizeUrl,
    });
  }
}
