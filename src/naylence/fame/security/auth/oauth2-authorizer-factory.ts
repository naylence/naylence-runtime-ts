import {
  DEFAULT_JWKS_CACHE_TTL_SEC,
  DEFAULT_OAUTH2_TTL_SEC,
  MAX_OAUTH2_TTL_SEC,
  DEFAULT_REVERSE_AUTH_TTL_SEC,
} from '../../constants/ttl-constants.js';
import { getLogger } from '../../util/logging.js';
import { safeImport } from '../../util/lazy-import.js';
import { validateOAuth2TtlSec } from '../../util/ttl-validation.js';
import type { Authorizer } from './authorizer.js';
import {
  AUTHORIZER_FACTORY_BASE_TYPE,
  AuthorizerFactory,
  type AuthorizerConfig,
} from './authorizer-factory.js';
import type { TokenIssuer } from './token-issuer.js';
import {
  TokenIssuerFactory,
  type TokenIssuerConfig,
} from './token-issuer-factory.js';
import {
  TokenVerifierFactory,
  type TokenVerifierConfig,
} from './token-verifier-factory.js';
import type { JWKSJWTTokenVerifierConfig } from './jwks-jwt-token-verifier-factory.js';
import type { OAuth2AuthorizerOptions } from './oauth2-authorizer.js';

const logger = getLogger(
  'naylence.fame.security.auth.oauth2_authorizer_factory'
);

type OAuth2AuthorizerModule = typeof import('./oauth2-authorizer.js');

let oauth2AuthorizerModulePromise: Promise<OAuth2AuthorizerModule> | null =
  null;
function getOAuth2AuthorizerModule(): Promise<OAuth2AuthorizerModule> {
  if (!oauth2AuthorizerModulePromise) {
    oauth2AuthorizerModulePromise = safeImport(
      () => import('./oauth2-authorizer.js'),
      'oauth2-authorizer'
    );
  }

  return oauth2AuthorizerModulePromise;
}

export interface OAuth2AuthorizerConfig extends AuthorizerConfig {
  type: 'OAuth2Authorizer';
  issuer: string;
  audience?: string | null;
  jwksUrl?: string | null;
  jwks_url?: string | null;
  algorithm?: string;
  requiredScopes?: string[] | null;
  required_scopes?: string[] | null;
  requireScope?: boolean;
  require_scope?: boolean;
  defaultTtlSec?: number;
  default_ttl_sec?: number;
  maxTtlSec?: number;
  max_ttl_sec?: number;
  tokenVerifierConfig?: TokenVerifierConfig;
  token_verifier_config?: TokenVerifierConfig;
  tokenIssuerConfig?: TokenIssuerConfig;
  token_issuer_config?: TokenIssuerConfig;
  reverseAuthTtlSec?: number;
  reverse_auth_ttl_sec?: number;
}

interface NormalizedOAuth2AuthorizerConfig {
  issuer: string;
  audience?: string;
  jwksUrl: string;
  algorithm: string;
  requiredScopes: string[];
  requireScope: boolean;
  defaultTtlSec: number;
  maxTtlSec: number;
  tokenVerifierConfig: TokenVerifierConfig;
  tokenIssuerConfig?: TokenIssuerConfig;
  reverseAuthTtlSec: number;
}

export const FACTORY_META = {
  base: AUTHORIZER_FACTORY_BASE_TYPE,
  key: 'OAuth2Authorizer',
} as const;

export class OAuth2AuthorizerFactory extends AuthorizerFactory<OAuth2AuthorizerConfig> {
  public readonly type = 'OAuth2Authorizer';

  public async create(
    config?: OAuth2AuthorizerConfig | Record<string, unknown> | null
  ): Promise<Authorizer> {
    if (!config) {
      throw new Error('OAuth2Authorizer requires configuration');
    }

    const normalized = normalizeConfig(config);

    const tokenVerifier = await TokenVerifierFactory.createTokenVerifier(
      normalized.tokenVerifierConfig
    );

    let tokenIssuer: TokenIssuer | undefined;
    if (normalized.tokenIssuerConfig) {
      try {
        tokenIssuer = await TokenIssuerFactory.createTokenIssuer(
          normalized.tokenIssuerConfig
        );
        logger.debug('token_issuer_created_for_reverse_auth', {
          issuer_type: normalized.tokenIssuerConfig.type,
        });
      } catch (error) {
        logger.warning('failed_to_create_token_issuer_for_reverse_auth', {
          error: error instanceof Error ? error.message : String(error),
          issuer_config: normalized.tokenIssuerConfig,
        });
      }
    }

    const authorizerOptions: OAuth2AuthorizerOptions = {
      tokenVerifier,
      requiredScopes: normalized.requiredScopes,
      requireScope: normalized.requireScope,
      defaultTtlSec: normalized.defaultTtlSec,
      maxTtlSec: normalized.maxTtlSec,
      reverseAuthTtlSec: normalized.reverseAuthTtlSec,
    };

    if (tokenIssuer) {
      authorizerOptions.tokenIssuer = tokenIssuer;
    }

    if (normalized.audience) {
      authorizerOptions.audience = normalized.audience;
    }

    const { OAuth2Authorizer } = await getOAuth2AuthorizerModule();

    return new OAuth2Authorizer(authorizerOptions);
  }
}

function normalizeConfig(
  config: OAuth2AuthorizerConfig | Record<string, unknown>
): NormalizedOAuth2AuthorizerConfig {
  const source = config as OAuth2AuthorizerConfig & Record<string, unknown>;

  const issuer =
    typeof source.issuer === 'string' && source.issuer.trim().length > 0
      ? source.issuer.trim()
      : undefined;
  if (!issuer) {
    throw new Error('OAuth2Authorizer configuration requires "issuer"');
  }

  const audienceRaw =
    typeof source.audience === 'string' ? source.audience : null;
  const audience =
    audienceRaw && audienceRaw.trim().length > 0
      ? audienceRaw.trim()
      : undefined;

  const jwksUrlRaw = source.jwksUrl ?? source.jwks_url;
  let jwksUrl =
    typeof jwksUrlRaw === 'string' && jwksUrlRaw.trim().length > 0
      ? jwksUrlRaw.trim()
      : undefined;
  if (!jwksUrl) {
    const trimmedIssuer = issuer.replace(/\/+$/, '');
    jwksUrl = `${trimmedIssuer}/.well-known/jwks.json`;
  }

  const algorithm =
    typeof source.algorithm === 'string' && source.algorithm.trim().length > 0
      ? source.algorithm.trim()
      : 'RS256';

  const requiredScopesSource =
    source.requiredScopes ?? source.required_scopes ?? [];
  const requiredScopes = Array.isArray(requiredScopesSource)
    ? requiredScopesSource
        .map((scope) => (typeof scope === 'string' ? scope.trim() : ''))
        .filter((scope) => scope.length > 0)
    : [];

  const requireScope =
    typeof source.requireScope === 'boolean'
      ? source.requireScope
      : typeof source.require_scope === 'boolean'
        ? source.require_scope
        : true;

  const defaultTtlCandidate =
    typeof source.defaultTtlSec === 'number'
      ? source.defaultTtlSec
      : typeof source.default_ttl_sec === 'number'
        ? source.default_ttl_sec
        : DEFAULT_OAUTH2_TTL_SEC;

  const validatedDefaultTtl = validateOAuth2TtlSec(defaultTtlCandidate);
  const defaultTtlSec =
    typeof validatedDefaultTtl === 'number'
      ? validatedDefaultTtl
      : defaultTtlCandidate;

  const maxTtlCandidate =
    typeof source.maxTtlSec === 'number'
      ? source.maxTtlSec
      : typeof source.max_ttl_sec === 'number'
        ? source.max_ttl_sec
        : MAX_OAUTH2_TTL_SEC;

  const validatedMaxTtl = validateOAuth2TtlSec(maxTtlCandidate);
  const maxTtlSec =
    typeof validatedMaxTtl === 'number' ? validatedMaxTtl : maxTtlCandidate;

  const reverseAuthCandidate =
    typeof source.reverseAuthTtlSec === 'number'
      ? source.reverseAuthTtlSec
      : typeof source.reverse_auth_ttl_sec === 'number'
        ? source.reverse_auth_ttl_sec
        : DEFAULT_REVERSE_AUTH_TTL_SEC;

  const tokenVerifierConfigInput =
    source.tokenVerifierConfig ?? source.token_verifier_config ?? null;

  const tokenVerifierConfig = normalizeTokenVerifierConfig({
    config: tokenVerifierConfigInput,
    issuer,
    jwksUrl,
    algorithm,
  });

  const tokenIssuerConfig =
    source.tokenIssuerConfig ?? source.token_issuer_config ?? undefined;

  const normalized: NormalizedOAuth2AuthorizerConfig = {
    issuer,
    jwksUrl,
    algorithm,
    requiredScopes,
    requireScope,
    defaultTtlSec,
    maxTtlSec,
    tokenVerifierConfig,
    reverseAuthTtlSec: reverseAuthCandidate,
    ...(audience ? { audience } : {}),
    ...(tokenIssuerConfig ? { tokenIssuerConfig } : {}),
  };

  return normalized;
}

function normalizeTokenVerifierConfig({
  config,
  issuer,
  jwksUrl,
  algorithm,
}: {
  config?: TokenVerifierConfig | null;
  issuer: string;
  jwksUrl: string;
  algorithm: string;
}): TokenVerifierConfig {
  if (config) {
    return config;
  }

  const defaultConfig: JWKSJWTTokenVerifierConfig = {
    type: 'JWKSJWTTokenVerifier',
    issuer,
    jwksUrl,
    cacheTtlSec: DEFAULT_JWKS_CACHE_TTL_SEC,
    algorithms: [algorithm],
  };

  return defaultConfig;
}

export default OAuth2AuthorizerFactory;
