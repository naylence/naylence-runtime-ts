import {
  CredentialProviderFactory,
  type CredentialProviderConfig,
} from '../credential/credential-provider-factory.js';
import {
  normalizeSecretSource,
  type SecretSourceType,
} from '../credential/secret-source.js';
import { safeImport } from '../../util/lazy-import.js';
import type { TokenProvider } from './token-provider.js';
import {
  TOKEN_PROVIDER_FACTORY_BASE_TYPE,
  TokenProviderFactory,
  type TokenProviderConfig,
} from './token-provider-factory.js';
import type { OAuth2PkceTokenProviderOptions } from './oauth2-pkce-token-provider.js';

type OAuth2PkceTokenProviderModule = typeof import('./oauth2-pkce-token-provider.js');

let oauth2PkceTokenProviderModulePromise: Promise<OAuth2PkceTokenProviderModule> | null =
  null;
async function getOAuth2PkceTokenProviderModule(): Promise<OAuth2PkceTokenProviderModule> {
  if (!oauth2PkceTokenProviderModulePromise) {
    oauth2PkceTokenProviderModulePromise = safeImport(
      () => import('./oauth2-pkce-token-provider.js'),
      'oauth2-pkce-token-provider'
    );
  }

  return oauth2PkceTokenProviderModulePromise;
}

export interface OAuth2PkceTokenProviderConfig extends TokenProviderConfig {
  type: 'OAuth2PkceTokenProvider';
  authorizeUrl: string;
  tokenUrl: string;
  redirectUri: string;
  clientId: string;
  username?: SecretSourceType;
  clientSecret?: SecretSourceType;
  scopes?: string[];
  audience?: string;
  codeChallengeMethod?: string;
  codeVerifierLength?: number;
  clockSkewSeconds?: number;
  loginHintParam?: string;
}

interface NormalizedPkceConfig {
  authorizeUrl: string;
  tokenUrl: string;
  redirectUri: string;
  clientId: string;
  usernameConfig?: CredentialProviderConfig | Record<string, unknown>;
  clientSecretConfig?: CredentialProviderConfig | Record<string, unknown>;
  scopes: string[];
  audience?: string;
  codeChallengeMethod?: string;
  codeVerifierLength?: number;
  clockSkewSeconds?: number;
  loginHintParam?: string;
}

function ensureNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`OAuth2PkceTokenProvider ${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeScopes(value: unknown): string[] {
  if (Array.isArray(value)) {
    const scopes = value
      .map((scope) => (typeof scope === 'string' ? scope.trim() : ''))
      .filter((scope) => scope.length > 0);
    return scopes;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    return value
      .split(/[\s,]+/u)
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0);
  }

  return [];
}

function normalizeConfig(
  config?: OAuth2PkceTokenProviderConfig | Record<string, unknown> | null
): NormalizedPkceConfig {
  if (!config) {
    throw new Error('OAuth2PkceTokenProvider requires configuration');
  }

  const candidate = config as OAuth2PkceTokenProviderConfig &
    Record<string, unknown> &
    Partial<
      Record<
        | 'authorize_url'
        | 'token_url'
        | 'redirect_uri'
        | 'client_id'
        | 'login_hint_param',
        unknown
      >
    >;

  const authorizeUrl = ensureNonEmptyString(
    candidate.authorizeUrl ?? candidate.authorize_url,
    'authorizeUrl'
  );
  const tokenUrl = ensureNonEmptyString(
    candidate.tokenUrl ?? candidate.token_url,
    'tokenUrl'
  );
  const redirectUri = ensureNonEmptyString(
    candidate.redirectUri ?? candidate.redirect_uri,
    'redirectUri'
  );
  const clientId = ensureNonEmptyString(
    candidate.clientId ?? candidate.client_id,
    'clientId'
  );

  const usernameSource = (candidate.username ??
    (candidate as Record<string, unknown>).username_source) as
    | SecretSourceType
    | undefined;
  const clientSecretSource = (candidate.clientSecret ??
    (candidate as Record<string, unknown>).client_secret) as
    | SecretSourceType
    | undefined;

  const scopes = normalizeScopes(
    candidate.scopes ?? (candidate as Record<string, unknown>).scope
  );

  const normalized: NormalizedPkceConfig = {
    authorizeUrl,
    tokenUrl,
    redirectUri,
    clientId,
    scopes,
  };

  if (usernameSource) {
    normalized.usernameConfig = normalizeSecretSource(usernameSource);
  }

  if (clientSecretSource) {
    normalized.clientSecretConfig = normalizeSecretSource(clientSecretSource);
  }

  const audienceCandidate =
    candidate.audience ?? (candidate as Record<string, unknown>).aud;
  if (typeof audienceCandidate === 'string' && audienceCandidate.trim().length > 0) {
    normalized.audience = audienceCandidate.trim();
  }

  const codeChallengeMethod = candidate.codeChallengeMethod ?? candidate.code_challenge_method;
  if (typeof codeChallengeMethod === 'string' && codeChallengeMethod.trim().length > 0) {
    normalized.codeChallengeMethod = codeChallengeMethod.trim();
  }

  const codeVerifierLength = candidate.codeVerifierLength ?? candidate.code_verifier_length;
  if (typeof codeVerifierLength === 'number' && Number.isFinite(codeVerifierLength)) {
    normalized.codeVerifierLength = codeVerifierLength;
  }

  const clockSkewSeconds = candidate.clockSkewSeconds ?? candidate.clock_skew_seconds;
  if (typeof clockSkewSeconds === 'number' && Number.isFinite(clockSkewSeconds)) {
    normalized.clockSkewSeconds = clockSkewSeconds;
  }

  const loginHintParam = candidate.loginHintParam ?? candidate.login_hint_param;
  if (typeof loginHintParam === 'string' && loginHintParam.trim().length > 0) {
    normalized.loginHintParam = loginHintParam.trim();
  }

  return normalized;
}

export const FACTORY_META = {
  base: TOKEN_PROVIDER_FACTORY_BASE_TYPE,
  key: 'OAuth2PkceTokenProvider',
} as const;

export class OAuth2PkceTokenProviderFactory extends TokenProviderFactory<OAuth2PkceTokenProviderConfig> {
  public readonly type = 'OAuth2PkceTokenProvider';

  public async create(
    config?: OAuth2PkceTokenProviderConfig | Record<string, unknown> | null
  ): Promise<TokenProvider> {
    const normalized = normalizeConfig(config);

    const [usernameProvider, clientSecretProvider] = await Promise.all([
      normalized.usernameConfig
        ? CredentialProviderFactory.createCredentialProvider(normalized.usernameConfig)
        : Promise.resolve(undefined),
      normalized.clientSecretConfig
        ? CredentialProviderFactory.createCredentialProvider(normalized.clientSecretConfig)
        : Promise.resolve(undefined),
    ]);

    const options: OAuth2PkceTokenProviderOptions = {
      authorizeUrl: normalized.authorizeUrl,
      tokenUrl: normalized.tokenUrl,
      redirectUri: normalized.redirectUri,
      clientId: normalized.clientId,
      scopes: normalized.scopes,
    };

    if (usernameProvider) {
      options.usernameProvider = usernameProvider;
    }
    if (clientSecretProvider) {
      options.clientSecretProvider = clientSecretProvider;
    }
    if (normalized.audience) {
      options.audience = normalized.audience;
    }
    if (normalized.codeChallengeMethod) {
      options.codeChallengeMethod = normalized.codeChallengeMethod
        .toUpperCase() as 'S256' | 'PLAIN';
    }
    if (normalized.codeVerifierLength) {
      options.codeVerifierLength = normalized.codeVerifierLength;
    }
    if (normalized.clockSkewSeconds) {
      options.clockSkewSeconds = normalized.clockSkewSeconds;
    }
    if (normalized.loginHintParam) {
      options.loginHintParam = normalized.loginHintParam;
    }

    const { OAuth2PkceTokenProvider } = await getOAuth2PkceTokenProviderModule();

    return new OAuth2PkceTokenProvider(options);
  }
}

export default OAuth2PkceTokenProviderFactory;
