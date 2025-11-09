import { Expressions } from '@naylence/factory';
import { GRANT_PURPOSE_NODE_ATTACH } from '../../grants/grant.js';
import { getLogger } from '../../util/logging.js';
import {
  ADMISSION_CLIENT_FACTORY_BASE_TYPE,
  AdmissionClientFactory,
  type AdmissionConfig,
} from './admission-client-factory.js';
import type { AdmissionClient } from './admission-client.js';

const logger = getLogger(
  'naylence.fame.node.admission.admission_profile_factory'
);

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
const ENV_VAR_DIRECT_INPAGE_CHANNEL = 'FAME_DIRECT_INPAGE_CHANNEL';
const ENV_VAR_ADMISSION_SERVICE_URL = 'FAME_ADMISSION_SERVICE_URL';

const DEFAULT_INPAGE_CHANNEL = 'naylence-fabric';

const PROFILE_NAME_WELCOME = 'welcome';
const PROFILE_NAME_DIRECT = 'direct';
const PROFILE_NAME_DIRECT_HTTP = 'direct-http';
const PROFILE_NAME_DIRECT_INPAGE = 'direct-inpage';
const PROFILE_NAME_OPEN = 'open';
const PROFILE_NAME_NOOP = 'noop';
const PROFILE_NAME_NONE = 'none';
const PROFILE_NAME_DIRECT_INPAGE_ALIAS = 'direct_inpage';

function createOAuthTokenProviderConfig() {
  const tokenUrl = Expressions.env(ENV_VAR_ADMISSION_TOKEN_URL);
  const clientId = Expressions.env(ENV_VAR_ADMISSION_CLIENT_ID);
  const clientSecret = Expressions.env(ENV_VAR_ADMISSION_CLIENT_SECRET);
  const audience = Expressions.env(ENV_VAR_JWT_AUDIENCE);

  return {
    type: 'OAuth2ClientCredentialsTokenProvider',
    token_url: tokenUrl,
    tokenUrl,
    client_id: clientId,
    clientId,
    client_secret: clientSecret,
    clientSecret,
    scopes: ['node.connect'],
    audience,
  };
}

const welcomeIsRoot = Expressions.env(ENV_VAR_IS_ROOT, 'false');
const welcomeTokenProvider = createOAuthTokenProviderConfig();

const WELCOME_SERVICE_PROFILE: AdmissionConfig = {
  type: 'WelcomeServiceClient',
  is_root: welcomeIsRoot,
  isRoot: welcomeIsRoot,
  url: Expressions.env(ENV_VAR_ADMISSION_SERVICE_URL),
  supported_transports: ['websocket'],
  supportedTransports: ['websocket'],
  auth: {
    type: 'BearerTokenHeaderAuth',
    token_provider: welcomeTokenProvider,
    tokenProvider: welcomeTokenProvider,
  },
};

const directGrantTokenProvider = createOAuthTokenProviderConfig();
const directGrant = {
  type: 'WebSocketConnectionGrant',
  purpose: GRANT_PURPOSE_NODE_ATTACH,
  url: Expressions.env(ENV_VAR_DIRECT_ADMISSION_URL),
  auth: {
    type: 'WebSocketSubprotocolAuth',
    token_provider: directGrantTokenProvider,
    tokenProvider: directGrantTokenProvider,
  },
  ttl: 0,
  durable: false,
};
const directGrants = [directGrant];

const DIRECT_PROFILE: AdmissionConfig = {
  type: 'DirectAdmissionClient',
  connection_grants: directGrants,
  connectionGrants: directGrants,
};

const directHttpTokenProvider = createOAuthTokenProviderConfig();
const directHttpGrant = {
  type: 'HttpConnectionGrant',
  purpose: GRANT_PURPOSE_NODE_ATTACH,
  url: Expressions.env(ENV_VAR_DIRECT_ADMISSION_URL),
  auth: {
    type: 'BearerTokenHeaderAuth',
    token_provider: directHttpTokenProvider,
    tokenProvider: directHttpTokenProvider,
  },
  ttl: 0,
  durable: false,
};
const directHttpGrants = [directHttpGrant];

const DIRECT_HTTP_PROFILE: AdmissionConfig = {
  type: 'DirectAdmissionClient',
  connection_grants: directHttpGrants,
  connectionGrants: directHttpGrants,
};

const directInPageGrant = {
  type: 'InPageConnectionGrant',
  purpose: GRANT_PURPOSE_NODE_ATTACH,
  channelName: Expressions.env(
    ENV_VAR_DIRECT_INPAGE_CHANNEL,
    DEFAULT_INPAGE_CHANNEL
  ),
  channel_name: Expressions.env(
    ENV_VAR_DIRECT_INPAGE_CHANNEL,
    DEFAULT_INPAGE_CHANNEL
  ),
  ttl: 0,
  durable: false,
};
const directInPageGrants = [directInPageGrant];

const DIRECT_INPAGE_PROFILE: AdmissionConfig = {
  type: 'DirectAdmissionClient',
  connection_grants: directInPageGrants,
  connectionGrants: directInPageGrants,
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
  connectionGrants: [
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
  autoAcceptLogicals: true,
};

const PROFILE_MAP: Record<string, AdmissionConfig> = {
  [PROFILE_NAME_WELCOME]: WELCOME_SERVICE_PROFILE,
  [PROFILE_NAME_DIRECT]: DIRECT_PROFILE,
  [PROFILE_NAME_DIRECT_HTTP]: DIRECT_HTTP_PROFILE,
  [PROFILE_NAME_DIRECT_INPAGE]: DIRECT_INPAGE_PROFILE,
  [PROFILE_NAME_DIRECT_INPAGE_ALIAS]: DIRECT_INPAGE_PROFILE,
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
