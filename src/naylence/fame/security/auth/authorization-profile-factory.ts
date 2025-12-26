import { Expressions, ExpressionEvaluator } from '@naylence/factory';

import { getLogger } from '../../util/logging.js';
import type { Authorizer } from './authorizer.js';
import {
  AUTHORIZER_FACTORY_BASE_TYPE,
  AuthorizerFactory,
  type AuthorizerConfig,
} from './authorizer-factory.js';
import type { DefaultPolicyAuthorizerConfig } from './default-policy-authorizer-factory.js';
import type { OAuth2AuthorizerConfig } from './oauth2-authorizer-factory.js';
import type { NoopAuthorizerConfig } from './noop-authorizer-factory.js';
import type { LocalFileAuthorizationPolicySourceConfig } from './policy/local-file-authorization-policy-source-factory.js';
import type { TokenVerifierConfig } from './token-verifier-factory.js';

const logger = getLogger(
  'naylence.fame.security.auth.authorization_profile_factory'
);

export interface AuthorizationProfileConfig extends AuthorizerConfig {
  type: 'AuthorizationProfile';
  profile?: string | null;
}

export const PROFILE_NAME_DEFAULT = 'jwt';
export const PROFILE_NAME_OAUTH2 = 'oauth2';
export const PROFILE_NAME_OAUTH2_GATED = 'oauth2-gated';
export const PROFILE_NAME_OAUTH2_CALLBACK = 'oauth2-callback';
export const PROFILE_NAME_POLICY_LOCALFILE = 'policy-localfile';
export const PROFILE_NAME_NOOP = 'noop';

export const ENV_VAR_JWT_TRUSTED_ISSUER = 'FAME_JWT_TRUSTED_ISSUER';
export const ENV_VAR_JWT_ALGORITHM = 'FAME_JWT_ALGORITHM';
export const ENV_VAR_JWT_AUDIENCE = 'FAME_JWT_AUDIENCE';
export const ENV_VAR_JWKS_URL = 'FAME_JWKS_URL';
export const ENV_VAR_ENFORCE_TOKEN_SUBJECT_NODE_IDENTITY =
  'FAME_ENFORCE_TOKEN_SUBJECT_NODE_IDENTITY';
export const ENV_VAR_TRUSTED_CLIENT_SCOPE = 'FAME_TRUSTED_CLIENT_SCOPE';
export const ENV_VAR_AUTH_POLICY_PATH = 'FAME_AUTH_POLICY_PATH';
export const ENV_VAR_AUTH_POLICY_FORMAT = 'FAME_AUTH_POLICY_FORMAT';
export const ENV_VAR_JWT_REVERSE_AUTH_TRUSTED_ISSUER =
  'FAME_JWT_REVERSE_AUTH_TRUSTED_ISSUER';
export const ENV_VAR_JWT_REVERSE_AUTH_AUDIENCE =
  'FAME_JWT_REVERSE_AUTH_AUDIENCE';
export const ENV_VAR_HMAC_SECRET = 'FAME_HMAC_SECRET';

const DEFAULT_REVERSE_AUTH_ISSUER = 'reverse-auth.naylence.ai';
const DEFAULT_REVERSE_AUTH_AUDIENCE = 'dev.naylence.ai';

const DEFAULT_VERIFIER_CONFIG: TokenVerifierConfig = {
  type: 'JWKSJWTTokenVerifier',
  jwks_url: Expressions.env(ENV_VAR_JWKS_URL),
  issuer: Expressions.env(ENV_VAR_JWT_TRUSTED_ISSUER),
};

const DEFAULT_PROFILE: AuthorizerConfig = {
  type: 'DefaultAuthorizer',
  verifier: DEFAULT_VERIFIER_CONFIG,
};

const OAUTH2_PROFILE: OAuth2AuthorizerConfig = {
  type: 'OAuth2Authorizer',
  issuer: Expressions.env(ENV_VAR_JWT_TRUSTED_ISSUER),
  required_scopes: ['node.connect'],
  require_scope: true,
  default_ttl_sec: 3600,
  max_ttl_sec: 86400,
  algorithm: Expressions.env(ENV_VAR_JWT_ALGORITHM, 'RS256'),
  audience: Expressions.env(ENV_VAR_JWT_AUDIENCE),
};

const OAUTH2_GATED_PROFILE: OAuth2AuthorizerConfig = {
  ...OAUTH2_PROFILE,
  enforce_token_subject_node_identity: Expressions.env(
    ENV_VAR_ENFORCE_TOKEN_SUBJECT_NODE_IDENTITY,
    'false'
  ) as unknown as boolean,
  trusted_client_scope: Expressions.env(
    ENV_VAR_TRUSTED_CLIENT_SCOPE,
    'node.trusted'
  ),
};

const OAUTH2_CALLBACK_PROFILE: OAuth2AuthorizerConfig = {
  type: 'OAuth2Authorizer',
  issuer: Expressions.env(
    ENV_VAR_JWT_REVERSE_AUTH_TRUSTED_ISSUER,
    DEFAULT_REVERSE_AUTH_ISSUER
  ),
  audience: Expressions.env(ENV_VAR_JWT_REVERSE_AUTH_AUDIENCE),
  require_scope: true,
  default_ttl_sec: 3600,
  max_ttl_sec: 86400,
  reverse_auth_ttl_sec: 86400,
  token_verifier_config: {
    type: 'JWTTokenVerifier',
    algorithm: 'HS256',
    hmac_secret: Expressions.env(ENV_VAR_HMAC_SECRET),
    issuer: Expressions.env(
      ENV_VAR_JWT_REVERSE_AUTH_TRUSTED_ISSUER,
      DEFAULT_REVERSE_AUTH_ISSUER
    ),
    ttl_sec: 86400,
  },
  token_issuer_config: {
    type: 'JWTTokenIssuer',
    algorithm: 'HS256',
    hmac_secret: Expressions.env(ENV_VAR_HMAC_SECRET),
    kid: 'hmac-reverse-auth-key',
    issuer: Expressions.env(
      ENV_VAR_JWT_REVERSE_AUTH_TRUSTED_ISSUER,
      DEFAULT_REVERSE_AUTH_ISSUER
    ),
    ttl_sec: 86400,
    audience: Expressions.env(
      ENV_VAR_JWT_REVERSE_AUTH_AUDIENCE,
      DEFAULT_REVERSE_AUTH_AUDIENCE
    ),
  },
};

const NOOP_PROFILE: NoopAuthorizerConfig = {
  type: 'NoopAuthorizer',
};

const DEFAULT_POLICY_SOURCE: LocalFileAuthorizationPolicySourceConfig = {
  type: 'LocalFileAuthorizationPolicySource',
  path: Expressions.env(ENV_VAR_AUTH_POLICY_PATH, './auth-policy.yaml'),
  format: Expressions.env(ENV_VAR_AUTH_POLICY_FORMAT, 'auto') as
    | 'auto'
    | 'yaml'
    | 'json',
};

const POLICY_LOCALFILE_PROFILE: DefaultPolicyAuthorizerConfig = {
  type: 'PolicyAuthorizer',
  verifier: DEFAULT_VERIFIER_CONFIG,
  policySource: DEFAULT_POLICY_SOURCE,
};

const PROFILE_MAP: Record<string, AuthorizerConfig> = {
  [PROFILE_NAME_DEFAULT]: DEFAULT_PROFILE,
  [PROFILE_NAME_OAUTH2]: OAUTH2_PROFILE,
  [PROFILE_NAME_OAUTH2_GATED]: OAUTH2_GATED_PROFILE,
  [PROFILE_NAME_OAUTH2_CALLBACK]: OAUTH2_CALLBACK_PROFILE,
  [PROFILE_NAME_POLICY_LOCALFILE]: POLICY_LOCALFILE_PROFILE,
  [PROFILE_NAME_NOOP]: NOOP_PROFILE,
};

const PROFILE_ALIASES: Record<string, string> = {
  jwt: PROFILE_NAME_DEFAULT,
  jwks: PROFILE_NAME_DEFAULT,
  default: PROFILE_NAME_DEFAULT,
  oauth2: PROFILE_NAME_OAUTH2,
  oidc: PROFILE_NAME_OAUTH2,
  'oauth2-gated': PROFILE_NAME_OAUTH2_GATED,
  oauth2_gated: PROFILE_NAME_OAUTH2_GATED,
  'oauth2-callback': PROFILE_NAME_OAUTH2_CALLBACK,
  oauth2_callback: PROFILE_NAME_OAUTH2_CALLBACK,
  'reverse-auth': PROFILE_NAME_OAUTH2_CALLBACK,
  policy: PROFILE_NAME_POLICY_LOCALFILE,
  'policy-localfile': PROFILE_NAME_POLICY_LOCALFILE,
  policy_localfile: PROFILE_NAME_POLICY_LOCALFILE,
  noop: PROFILE_NAME_NOOP,
  'no-op': PROFILE_NAME_NOOP,
  no_op: PROFILE_NAME_NOOP,
};

export const FACTORY_META = {
  base: AUTHORIZER_FACTORY_BASE_TYPE,
  key: 'AuthorizationProfile',
} as const;

export class AuthorizationProfileFactory extends AuthorizerFactory<AuthorizationProfileConfig> {
  public readonly type = 'AuthorizationProfile';

  public async create(
    config?: AuthorizationProfileConfig | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<Authorizer> {
    const normalized = normalizeConfig(config);
    const profileConfig = resolveProfileConfig(normalized.profile);

    logger.debug('enabling_authorization_profile', {
      profile: normalized.profile,
    });

    const authorizer = await AuthorizerFactory.createAuthorizer(
      profileConfig,
      { factoryArgs }
    );

    if (!authorizer) {
      throw new Error(
        `Failed to create authorizer for profile: ${normalized.profile}`
      );
    }

    return authorizer;
  }
}

interface NormalizedAuthorizationProfileConfig {
  profile: string;
}

function normalizeConfig(
  config:
    | AuthorizationProfileConfig
    | Record<string, unknown>
    | null
    | undefined
): NormalizedAuthorizationProfileConfig {
  if (!config) {
    return { profile: PROFILE_NAME_OAUTH2 };
  }

  const candidate = config as AuthorizationProfileConfig &
    Record<string, unknown>;
  const profileValue = resolveProfileName(candidate);
  const canonicalProfile = canonicalizeProfileName(profileValue);
  candidate.profile = canonicalProfile;

  return { profile: canonicalProfile };
}

function resolveProfileName(candidate: Record<string, unknown>): string {
  let direct = coerceProfileString(candidate.profile);

  if (direct && ExpressionEvaluator.isExpression(direct)) {
    const evaluated = ExpressionEvaluator.evaluate(direct);
    direct = coerceProfileString(evaluated);
  }

  if (direct) {
    return direct;
  }

  const legacyKeys = ['profile_name', 'profileName'] as const;
  for (const legacyKey of legacyKeys) {
    let legacyValue = coerceProfileString(candidate[legacyKey]);

    if (legacyValue && ExpressionEvaluator.isExpression(legacyValue)) {
      const evaluated = ExpressionEvaluator.evaluate(legacyValue);
      legacyValue = coerceProfileString(evaluated);
    }

    if (legacyValue) {
      return legacyValue;
    }
  }

  return PROFILE_NAME_OAUTH2;
}

function coerceProfileString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function canonicalizeProfileName(value: string): string {
  const normalized = value.replace(/[\s_]+/g, '-').toLowerCase();
  return PROFILE_ALIASES[normalized] ?? normalized;
}

function resolveProfileConfig(profileName: string): AuthorizerConfig {
  const profile = PROFILE_MAP[profileName];
  if (!profile) {
    throw new Error(`Unknown authorization profile: ${profileName}`);
  }

  return deepClone(profile);
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export default AuthorizationProfileFactory;
