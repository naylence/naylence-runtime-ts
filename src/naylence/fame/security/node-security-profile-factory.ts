import {
  Expressions,
  configValidator,
  createResource,
  type CreateResourceOptions,
  type ValidationContext,
} from '@naylence/factory';
import type { SecurityManager } from './security-manager.js';
import type { SecurityProfileConfig } from './security-manager-config.js';
import {
  SECURITY_MANAGER_FACTORY_BASE_TYPE,
  SecurityManagerFactory,
  type SecurityManagerComponentOverrides,
} from './security-manager-factory.js';
import { type DefaultSecurityManagerConfig } from './default-security-manager-factory.js';
import { getLogger } from '../util/logging.js';
import {
  getProfile,
  registerProfile,
} from '../profile/profile-registry.js';

const logger = getLogger(
  'naylence.fame.security.node_security_profile_factory'
);

export const ENV_VAR_JWT_TRUSTED_ISSUER = 'FAME_JWT_TRUSTED_ISSUER';
export const ENV_VAR_JWT_ALGORITHM = 'FAME_JWT_ALGORITHM';
export const ENV_VAR_JWT_AUDIENCE = 'FAME_JWT_AUDIENCE';
export const ENV_VAR_JWKS_URL = 'FAME_JWKS_URL';
export const ENV_VAR_DEFAULT_ENCRYPTION_LEVEL = 'FAME_DEFAULT_ENCRYPTION_LEVEL';
export const ENV_VAR_HMAC_SECRET = 'FAME_HMAC_SECRET';
export const ENV_VAR_JWT_REVERSE_AUTH_TRUSTED_ISSUER =
  'FAME_JWT_REVERSE_AUTH_TRUSTED_ISSUER';
export const ENV_VAR_JWT_REVERSE_AUTH_AUDIENCE =
  'FAME_JWT_REVERSE_AUTH_AUDIENCE';
export const ENV_VAR_ENFORCE_TOKEN_SUBJECT_NODE_IDENTITY =
  'FAME_ENFORCE_TOKEN_SUBJECT_NODE_IDENTITY';
export const ENV_VAR_TRUSTED_CLIENT_SCOPE = 'FAME_TRUSTED_CLIENT_SCOPE';
export const ENV_VAR_AUTHORIZATION_PROFILE = 'FAME_AUTHORIZATION_PROFILE';

export const PROFILE_NAME_STRICT_OVERLAY = 'strict-overlay';
export const PROFILE_NAME_OVERLAY = 'overlay';
export const PROFILE_NAME_OVERLAY_CALLBACK = 'overlay-callback';
export const PROFILE_NAME_GATED = 'gated';
export const PROFILE_NAME_GATED_CALLBACK = 'gated-callback';
export const PROFILE_NAME_OPEN = 'open';

const STRICT_OVERLAY_PROFILE: DefaultSecurityManagerConfig = {
  type: 'DefaultSecurityManager',
  security_policy: {
    type: 'DefaultSecurityPolicy',
    signing: {
      signing_material: 'x509-chain',
      require_cert_sid_match: true,
      inbound: {
        signature_policy: 'required',
        unsigned_violation_action: 'nack',
        invalid_signature_action: 'nack',
      },
      response: {
        mirror_request_signing: true,
        always_sign_responses: false,
        sign_error_responses: true,
      },
      outbound: {
        default_signing: true,
        sign_sensitive_operations: true,
        sign_if_recipient_expects: true,
      },
    },
    encryption: {
      inbound: {
        allow_plaintext: true,
        allow_channel: true,
        allow_sealed: true,
        plaintext_violation_action: 'nack',
        channel_violation_action: 'nack',
        sealed_violation_action: 'nack',
      },
      response: {
        mirror_request_level: true,
        minimum_response_level: 'plaintext',
        escalate_sealed_responses: false,
      },
      outbound: {
        default_level: Expressions.env(
          ENV_VAR_DEFAULT_ENCRYPTION_LEVEL,
          'channel'
        ),
        escalate_if_peer_supports: false,
        prefer_sealed_for_sensitive: false,
      },
    },
  },
  authorizer: {
    type: 'AuthorizationProfile',
    profile: Expressions.env(ENV_VAR_AUTHORIZATION_PROFILE, 'jwt'),
  },
};

const OVERLAY_PROFILE: DefaultSecurityManagerConfig = {
  type: 'DefaultSecurityManager',
  security_policy: {
    type: 'DefaultSecurityPolicy',
    signing: {
      signing_material: 'raw-key',
      inbound: {
        signature_policy: 'required',
        unsigned_violation_action: 'nack',
        invalid_signature_action: 'nack',
      },
      response: {
        mirror_request_signing: true,
        always_sign_responses: false,
        sign_error_responses: true,
      },
      outbound: {
        default_signing: true,
        sign_sensitive_operations: true,
        sign_if_recipient_expects: true,
      },
    },
    encryption: {
      inbound: {
        allow_plaintext: true,
        allow_channel: false,
        allow_sealed: false,
        plaintext_violation_action: 'nack',
        channel_violation_action: 'nack',
        sealed_violation_action: 'nack',
      },
      response: {
        mirror_request_level: false,
        minimum_response_level: 'plaintext',
        escalate_sealed_responses: false,
      },
      outbound: {
        default_level: 'plaintext',
        escalate_if_peer_supports: false,
        prefer_sealed_for_sensitive: false,
      },
    },
  },
  authorizer: {
    type: 'AuthorizationProfile',
    profile: Expressions.env(ENV_VAR_AUTHORIZATION_PROFILE, 'oauth2'),
  },
};

const OVERLAY_CALLBACK_PROFILE: DefaultSecurityManagerConfig = {
  type: 'DefaultSecurityManager',
  security_policy: {
    type: 'DefaultSecurityPolicy',
    signing: {
      signing_material: 'raw-key',
      inbound: {
        signature_policy: 'required',
        unsigned_violation_action: 'nack',
        invalid_signature_action: 'nack',
      },
      response: {
        mirror_request_signing: true,
        always_sign_responses: false,
        sign_error_responses: true,
      },
      outbound: {
        default_signing: true,
        sign_sensitive_operations: true,
        sign_if_recipient_expects: true,
      },
    },
    encryption: {
      inbound: {
        allow_plaintext: true,
        allow_channel: false,
        allow_sealed: false,
        plaintext_violation_action: 'nack',
        channel_violation_action: 'nack',
        sealed_violation_action: 'nack',
      },
      response: {
        mirror_request_level: false,
        minimum_response_level: 'plaintext',
        escalate_sealed_responses: false,
      },
      outbound: {
        default_level: 'plaintext',
        escalate_if_peer_supports: false,
        prefer_sealed_for_sensitive: false,
      },
    },
  },
  authorizer: {
    type: 'AuthorizationProfile',
    profile: Expressions.env(ENV_VAR_AUTHORIZATION_PROFILE, 'oauth2-callback'),
  },
};

const GATED_PROFILE: DefaultSecurityManagerConfig = {
  type: 'DefaultSecurityManager',
  security_policy: {
    type: 'DefaultSecurityPolicy',
    signing: {
      inbound: {
        signature_policy: 'disabled',
        unsigned_violation_action: 'allow',
        invalid_signature_action: 'allow',
      },
      response: {
        mirror_request_signing: false,
        always_sign_responses: false,
        sign_error_responses: false,
      },
      outbound: {
        default_signing: false,
        sign_sensitive_operations: false,
        sign_if_recipient_expects: false,
      },
    },
    encryption: {
      inbound: {
        allow_plaintext: true,
        allow_channel: false,
        allow_sealed: false,
        plaintext_violation_action: 'allow',
        channel_violation_action: 'nack',
        sealed_violation_action: 'nack',
      },
      response: {
        mirror_request_level: true,
        minimum_response_level: 'plaintext',
        escalate_sealed_responses: false,
      },
      outbound: {
        default_level: 'plaintext',
        escalate_if_peer_supports: false,
        prefer_sealed_for_sensitive: false,
      },
    },
  },
  authorizer: {
    type: 'AuthorizationProfile',
    profile: Expressions.env(ENV_VAR_AUTHORIZATION_PROFILE, 'oauth2-gated'),
  },
};

const GATED_CALLBACK_PROFILE: DefaultSecurityManagerConfig = {
  type: 'DefaultSecurityManager',
  security_policy: {
    type: 'DefaultSecurityPolicy',
    signing: {
      inbound: {
        signature_policy: 'disabled',
        unsigned_violation_action: 'allow',
        invalid_signature_action: 'allow',
      },
      response: {
        mirror_request_signing: false,
        always_sign_responses: false,
        sign_error_responses: false,
      },
      outbound: {
        default_signing: false,
        sign_sensitive_operations: false,
        sign_if_recipient_expects: false,
      },
    },
    encryption: {
      inbound: {
        allow_plaintext: true,
        allow_channel: false,
        allow_sealed: false,
        plaintext_violation_action: 'allow',
        channel_violation_action: 'nack',
        sealed_violation_action: 'nack',
      },
      response: {
        mirror_request_level: true,
        minimum_response_level: 'plaintext',
        escalate_sealed_responses: false,
      },
      outbound: {
        default_level: 'plaintext',
        escalate_if_peer_supports: false,
        prefer_sealed_for_sensitive: false,
      },
    },
  },
  authorizer: {
    type: 'AuthorizationProfile',
    profile: Expressions.env(ENV_VAR_AUTHORIZATION_PROFILE, 'oauth2-callback'),
  },
};

const OPEN_PROFILE: DefaultSecurityManagerConfig = {
  type: 'DefaultSecurityManager',
  security_policy: {
    type: 'NoSecurityPolicy',
  },
  authorizer: {
    type: 'AuthorizationProfile',
    profile: Expressions.env(ENV_VAR_AUTHORIZATION_PROFILE, 'noop'),
  },
};

registerProfile(
  SECURITY_MANAGER_FACTORY_BASE_TYPE,
  PROFILE_NAME_OVERLAY,
  OVERLAY_PROFILE,
  { source: 'node-security-profile-factory' }
);
registerProfile(
  SECURITY_MANAGER_FACTORY_BASE_TYPE,
  PROFILE_NAME_OVERLAY_CALLBACK,
  OVERLAY_CALLBACK_PROFILE,
  { source: 'node-security-profile-factory' }
);
registerProfile(
  SECURITY_MANAGER_FACTORY_BASE_TYPE,
  PROFILE_NAME_STRICT_OVERLAY,
  STRICT_OVERLAY_PROFILE,
  { source: 'node-security-profile-factory' }
);
registerProfile(
  SECURITY_MANAGER_FACTORY_BASE_TYPE,
  PROFILE_NAME_GATED,
  GATED_PROFILE,
  { source: 'node-security-profile-factory' }
);
registerProfile(
  SECURITY_MANAGER_FACTORY_BASE_TYPE,
  PROFILE_NAME_GATED_CALLBACK,
  GATED_CALLBACK_PROFILE,
  { source: 'node-security-profile-factory' }
);
registerProfile(
  SECURITY_MANAGER_FACTORY_BASE_TYPE,
  PROFILE_NAME_OPEN,
  OPEN_PROFILE,
  { source: 'node-security-profile-factory' }
);

export const FACTORY_META = {
  base: SECURITY_MANAGER_FACTORY_BASE_TYPE,
  key: 'SecurityProfile',
} as const;

export class NodeSecurityProfileFactory extends SecurityManagerFactory<SecurityProfileConfig> {
  public readonly type = 'SecurityProfile';

  public async create(
    config?: SecurityProfileConfig | Record<string, unknown> | null,
    overrides?: SecurityManagerComponentOverrides | null,
    createOptions?: CreateResourceOptions | null
  ): Promise<SecurityManager> {
    const profile = normalizeProfile(config);
    const profileConfig = resolveProfileConfig(profile);

    logger.debug('enabling_security_profile', { profile });

    const validationContext = buildValidationContext(createOptions);
    const evaluatedConfig = evaluateProfileConfig(
      profileConfig,
      validationContext
    );
    const sanitizedConfig = JSON.parse(
      JSON.stringify(evaluatedConfig)
    ) as DefaultSecurityManagerConfig;
    if (!('security_policy' in sanitizedConfig)) {
      throw new Error('sanitized config missing security_policy');
    }

    const creationOptions: CreateResourceOptions = {
      validate: false,
    };

    if (overrides) {
      creationOptions.factoryArgs = [overrides];
    }

    if (validationContext.env) {
      creationOptions.env = { ...validationContext.env };
    }

    if (validationContext.config) {
      creationOptions.config = { ...validationContext.config };
    }

    if (validationContext.variables) {
      creationOptions.variables = { ...validationContext.variables };
    }

    const instance = await createResource<SecurityManager>(
      SECURITY_MANAGER_FACTORY_BASE_TYPE,
      sanitizedConfig,
      creationOptions
    );

    if (!instance) {
      throw new Error(
        `Failed to create security manager for profile: ${profile}`
      );
    }

    return instance;
  }
}

function buildValidationContext(
  options?: CreateResourceOptions | null
): ValidationContext {
  const context: ValidationContext = {};

  const mergedEnv: Record<string, string> = collectProcessEnv();
  if (options?.env) {
    for (const [key, value] of Object.entries(options.env)) {
      if (value === null || value === undefined) {
        continue;
      }
      mergedEnv[key] = String(value);
    }
  }

  if (Object.keys(mergedEnv).length > 0) {
    context.env = mergedEnv;
  }

  if (options?.config) {
    context.config = { ...options.config };
  }

  if (options?.variables) {
    context.variables = { ...options.variables };
  }

  return context;
}

function evaluateProfileConfig(
  profileConfig: DefaultSecurityManagerConfig,
  context: ValidationContext
): DefaultSecurityManagerConfig {
  const validationResult = configValidator.validate(profileConfig, {
    ...context,
    allowUnknownProperties: true,
  });

  if (!validationResult.valid) {
    const errorMessages = validationResult.errors
      .map((error) => `${error.path || 'root'}: ${error.message}`)
      .join('; ');
    throw new Error(
      `Failed to evaluate security profile configuration: ${errorMessages}`
    );
  }

  return (
    (validationResult.config as DefaultSecurityManagerConfig | undefined) ??
    profileConfig
  );
}

function collectProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  if (typeof process === 'undefined' || !process.env) {
    return env;
  }

  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      env[key] = value;
    }
  }

  return env;
}

function normalizeProfile(
  config: SecurityProfileConfig | Record<string, unknown> | null | undefined
): string {
  if (!config) {
    return PROFILE_NAME_OVERLAY;
  }

  const candidate = config as SecurityProfileConfig & Record<string, unknown>;
  const value =
    typeof candidate.profile === 'string' && candidate.profile.trim().length > 0
      ? candidate.profile
      : typeof candidate.profile_name === 'string' &&
          candidate.profile_name.trim().length > 0
        ? candidate.profile_name
        : typeof candidate.profileName === 'string' &&
            candidate.profileName.trim().length > 0
          ? candidate.profileName
          : PROFILE_NAME_OVERLAY;

  return value.toLowerCase();
}

function resolveProfileConfig(
  profileName: string
): DefaultSecurityManagerConfig {
  const template = getProfile(
    SECURITY_MANAGER_FACTORY_BASE_TYPE,
    profileName
  ) as DefaultSecurityManagerConfig | null;
  if (!template) {
    throw new Error(`Unknown security profile: ${profileName}`);
  }

  return template;
}

export default NodeSecurityProfileFactory;
