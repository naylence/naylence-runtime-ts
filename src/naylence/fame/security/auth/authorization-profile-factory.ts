import { Expressions, configValidator } from '@naylence/factory';
import type { ValidationContext } from '@naylence/factory';

import { getLogger } from '../../util/logging.js';
import type { Authorizer } from './authorizer.js';
import {
  AUTHORIZER_FACTORY_BASE_TYPE,
  AuthorizerFactory,
  type AuthorizerConfig,
} from './authorizer-factory.js';
import type { OAuth2AuthorizerConfig } from './oauth2-authorizer-factory.js';
import type { NoopAuthorizerConfig } from './noop-authorizer-factory.js';

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
export const PROFILE_NAME_NOOP = 'noop';

export const ENV_VAR_JWT_TRUSTED_ISSUER = 'FAME_JWT_TRUSTED_ISSUER';
export const ENV_VAR_JWT_ALGORITHM = 'FAME_JWT_ALGORITHM';
export const ENV_VAR_JWT_AUDIENCE = 'FAME_JWT_AUDIENCE';
export const ENV_VAR_JWKS_URL = 'FAME_JWKS_URL';
export const ENV_VAR_ENFORCE_TOKEN_SUBJECT_NODE_IDENTITY =
  'FAME_ENFORCE_TOKEN_SUBJECT_NODE_IDENTITY';
export const ENV_VAR_TRUSTED_CLIENT_SCOPE = 'FAME_TRUSTED_CLIENT_SCOPE';
export const ENV_VAR_JWT_REVERSE_AUTH_TRUSTED_ISSUER =
  'FAME_JWT_REVERSE_AUTH_TRUSTED_ISSUER';
export const ENV_VAR_JWT_REVERSE_AUTH_AUDIENCE =
  'FAME_JWT_REVERSE_AUTH_AUDIENCE';
export const ENV_VAR_HMAC_SECRET = 'FAME_HMAC_SECRET';

const DEFAULT_REVERSE_AUTH_ISSUER = 'reverse-auth.naylence.ai';
const DEFAULT_REVERSE_AUTH_AUDIENCE = 'dev.naylence.ai';

const DEFAULT_PROFILE: AuthorizerConfig = {
  type: 'DefaultAuthorizer',
  verifier: {
    type: 'JWKSJWTTokenVerifier',
    jwks_url: Expressions.env(ENV_VAR_JWKS_URL),
    issuer: Expressions.env(ENV_VAR_JWT_TRUSTED_ISSUER),
  },
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

const PROFILE_MAP: Record<string, AuthorizerConfig> = {
  [PROFILE_NAME_DEFAULT]: DEFAULT_PROFILE,
  [PROFILE_NAME_OAUTH2]: OAUTH2_PROFILE,
  [PROFILE_NAME_OAUTH2_GATED]: OAUTH2_GATED_PROFILE,
  [PROFILE_NAME_OAUTH2_CALLBACK]: OAUTH2_CALLBACK_PROFILE,
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

    // Extract CreateResourceOptions from factoryArgs - it's typically the last object with env/config/variables
    const createOptions = extractCreateResourceOptions(factoryArgs);

    // Build validation context from createOptions to evaluate expressions
    const validationContext: ValidationContext = {
      env: createOptions.env as Record<string, string> | undefined,
      config: createOptions.config as Record<string, unknown> | undefined,
      variables: createOptions.variables as Record<string, unknown> | undefined,
      allowUnknownProperties: true,
    };

    // Evaluate expressions in the profile config
    const validationResult = configValidator.validate(profileConfig, validationContext);
    if (!validationResult.valid) {
      const errorMessages = validationResult.errors
        .map((error) => `${error.path || 'root'}: ${error.message}`)
        .join('; ');
      throw new Error(
        `Failed to evaluate authorization profile configuration: ${errorMessages}`
      );
    }

    const evaluatedConfig = validationResult.config ?? profileConfig;

    const authorizer = await AuthorizerFactory.createAuthorizer(
      evaluatedConfig as AuthorizerConfig,
      { validate: false } // Already validated
    );

    if (!authorizer) {
      throw new Error(
        `Failed to create authorizer for profile: ${normalized.profile}`
      );
    }

    return authorizer;
  }
}

/**
 * Extracts CreateResourceOptions from factoryArgs.
 * The factory system passes CreateResourceOptions as an object in factoryArgs.
 */
function extractCreateResourceOptions(
  factoryArgs: unknown[]
): Record<string, unknown> {
  // Find the last object argument that looks like CreateResourceOptions
  for (let i = factoryArgs.length - 1; i >= 0; i--) {
    const arg = factoryArgs[i];
    if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
      const candidate = arg as Record<string, unknown>;
      // Check if it has typical CreateResourceOptions properties
      if ('env' in candidate || 'config' in candidate || 'variables' in candidate || 'factoryArgs' in candidate) {
        return candidate;
      }
    }
  }
  return {};
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
  const direct = coerceProfileString(candidate.profile);
  if (direct) {
    return direct;
  }

  const legacyKeys = ['profile_name', 'profileName'] as const;
  for (const legacyKey of legacyKeys) {
    const legacyValue = coerceProfileString(candidate[legacyKey]);
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
