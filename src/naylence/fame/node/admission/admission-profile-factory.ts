import { Expressions } from 'naylence-factory';
import { GRANT_PURPOSE_NODE_ATTACH } from '../../grants/grant.js';
import { getLogger } from '../../util/logging.js';
import {
  ADMISSION_CLIENT_FACTORY_BASE_TYPE,
  AdmissionClientFactory,
  type AdmissionConfig,
} from './admission-client-factory.js';
import type { AdmissionClient } from './admission-client.js';

const logger = getLogger('admission-profile-factory');

export interface AdmissionProfileConfig extends AdmissionConfig {
  type: 'AdmissionProfile';
  profile?: string | null;
}

const ENV_VAR_IS_ROOT = 'FAME_ROOT';
const ENV_VAR_JWT_AUDIENCE = 'FAME_JWT_AUDIENCE';
const ENV_VAR_ADMISSION_TOKEN_URL = 'FAME_ADMISSION_TOKEN_URL';
const ENV_VAR_ADMISSION_CLIENT_ID = 'FAME_ADMISSION_CLIENT_ID';
const ENV_VAR_ADMISSION_CLIENT_SECRET = 'FAME_ADMISSION_CLIENT_SECRET';
const ENV_VAR_DIRECT_ADMISSION_URL = 'FAME_DIRECT_ADMISSION_URL';
const ENV_VAR_ADMISSION_SERVICE_URL = 'FAME_ADMISSION_SERVICE_URL';

const PROFILE_NAME_WELCOME = 'welcome';
const PROFILE_NAME_DIRECT = 'direct';
const PROFILE_NAME_DIRECT_HTTP = 'direct-http';
const PROFILE_NAME_OPEN = 'open';
const PROFILE_NAME_NOOP = 'noop';
const PROFILE_NAME_NONE = 'none';

const WELCOME_SERVICE_PROFILE: AdmissionConfig = {
  type: 'WelcomeServiceClient',
  is_root: Expressions.env(ENV_VAR_IS_ROOT, 'false'),
  url: Expressions.env(ENV_VAR_ADMISSION_SERVICE_URL),
  supported_transports: ['websocket'],
  auth: {
    type: 'BearerTokenHeaderAuth',
    token_provider: {
      type: 'OAuth2ClientCredentialsTokenProvider',
      token_url: Expressions.env(ENV_VAR_ADMISSION_TOKEN_URL),
      client_id: Expressions.env(ENV_VAR_ADMISSION_CLIENT_ID),
      client_secret: Expressions.env(ENV_VAR_ADMISSION_CLIENT_SECRET),
      scopes: ['node.connect'],
      audience: Expressions.env(ENV_VAR_JWT_AUDIENCE),
    },
  },
};

const DIRECT_PROFILE: AdmissionConfig = {
  type: 'DirectAdmissionClient',
  connection_grants: [
    {
      type: 'WebSocketConnectionGrant',
      purpose: GRANT_PURPOSE_NODE_ATTACH,
      url: Expressions.env(ENV_VAR_DIRECT_ADMISSION_URL),
      auth: {
        type: 'WebSocketSubprotocolAuth',
        token_provider: {
          type: 'OAuth2ClientCredentialsTokenProvider',
          token_url: Expressions.env(ENV_VAR_ADMISSION_TOKEN_URL),
          client_id: Expressions.env(ENV_VAR_ADMISSION_CLIENT_ID),
          client_secret: Expressions.env(ENV_VAR_ADMISSION_CLIENT_SECRET),
          scopes: ['node.connect'],
          audience: Expressions.env(ENV_VAR_JWT_AUDIENCE),
        },
      },
      ttl: 0,
      durable: false,
    },
  ],
};

const DIRECT_HTTP_PROFILE: AdmissionConfig = {
  type: 'DirectAdmissionClient',
  connection_grants: [
    {
      type: 'HttpConnectionGrant',
      purpose: GRANT_PURPOSE_NODE_ATTACH,
      url: Expressions.env(ENV_VAR_DIRECT_ADMISSION_URL),
      auth: {
        type: 'BearerTokenHeaderAuth',
        token_provider: {
          type: 'OAuth2ClientCredentialsTokenProvider',
          token_url: Expressions.env(ENV_VAR_ADMISSION_TOKEN_URL),
          client_id: Expressions.env(ENV_VAR_ADMISSION_CLIENT_ID),
          client_secret: Expressions.env(ENV_VAR_ADMISSION_CLIENT_SECRET),
          scopes: ['node.connect'],
          audience: Expressions.env(ENV_VAR_JWT_AUDIENCE),
        },
      },
      ttl: 0,
      durable: false,
    },
  ],
};

const OPEN_PROFILE: AdmissionConfig = {
  type: 'DirectAdmissionClient',
  connection_grants: [
    {
      type: 'WebSocketConnectionGrant',
      purpose: GRANT_PURPOSE_NODE_ATTACH,
      url: Expressions.env(ENV_VAR_DIRECT_ADMISSION_URL),
      auth: {
        type: 'NoAuth',
      },
      ttl: 0,
      durable: false,
    },
  ],
};

const NOOP_PROFILE: AdmissionConfig = {
  type: 'NoopAdmissionClient',
  auto_accept_logicals: true,
};

const PROFILE_MAP: Record<string, AdmissionConfig> = {
  [PROFILE_NAME_WELCOME]: WELCOME_SERVICE_PROFILE,
  [PROFILE_NAME_DIRECT]: DIRECT_PROFILE,
  [PROFILE_NAME_DIRECT_HTTP]: DIRECT_HTTP_PROFILE,
  [PROFILE_NAME_OPEN]: OPEN_PROFILE,
  [PROFILE_NAME_NOOP]: NOOP_PROFILE,
  [PROFILE_NAME_NONE]: NOOP_PROFILE,
};

export const FACTORY_META = {
  base: ADMISSION_CLIENT_FACTORY_BASE_TYPE,
  key: 'AdmissionProfile',
} as const;

export class AdmissionProfileFactory extends AdmissionClientFactory<AdmissionProfileConfig> {
  public readonly type = 'AdmissionProfile';

  public async create(
    config?: AdmissionProfileConfig | Record<string, unknown> | null
  ): Promise<AdmissionClient> {
    const normalized = normalizeConfig(config);
    const profileConfig = resolveProfileConfig(normalized.profile);

    logger.debug('enabling_admission_profile', { profile: normalized.profile });

    return AdmissionClientFactory.createAdmissionClient(profileConfig);
  }
}

interface NormalizedAdmissionProfileConfig {
  profile: string;
}

function normalizeConfig(
  config: AdmissionProfileConfig | Record<string, unknown> | null | undefined
): NormalizedAdmissionProfileConfig {
  if (!config) {
    return { profile: PROFILE_NAME_DIRECT };
  }

  const candidate = config as AdmissionProfileConfig & Record<string, unknown>;
  const profileValue =
    typeof candidate.profile === 'string' && candidate.profile.trim().length > 0
      ? candidate.profile
      : typeof candidate.profile_name === 'string' &&
          candidate.profile_name.trim().length > 0
        ? candidate.profile_name
        : typeof candidate.profileName === 'string' &&
            candidate.profileName.trim().length > 0
          ? candidate.profileName
          : PROFILE_NAME_DIRECT;

  return { profile: profileValue.toLowerCase() };
}

function resolveProfileConfig(profileName: string): AdmissionConfig {
  const profile = PROFILE_MAP[profileName];
  if (!profile) {
    throw new Error(`Unknown admission profile: ${profileName}`);
  }

  return deepClone(profile);
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export default AdmissionProfileFactory;
