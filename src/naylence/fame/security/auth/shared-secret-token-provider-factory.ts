import { safeImport } from '../../util/lazy-import.js';
import type { CredentialProvider } from '../credential/credential-provider.js';
import {
  CredentialProviderFactory,
  type CredentialProviderConfig,
} from '../credential/credential-provider-factory.js';
import {
  normalizeSecretSource,
  type SecretSourceType,
} from '../credential/secret-source.js';
import type { TokenProvider } from './token-provider.js';
import {
  TOKEN_PROVIDER_FACTORY_BASE_TYPE,
  TokenProviderFactory,
  type TokenProviderConfig,
} from './token-provider-factory.js';

export interface SharedSecretTokenProviderConfig extends TokenProviderConfig {
  type: 'SharedSecretTokenProvider';
  secret: SecretSourceType;
}

interface NormalizedSharedSecretConfig {
  secretConfig: CredentialProviderConfig | Record<string, unknown>;
}

type SharedSecretTokenProviderModule =
  typeof import('./shared-secret-token-provider.js');

let sharedSecretTokenProviderModulePromise: Promise<SharedSecretTokenProviderModule> | null =
  null;

async function getSharedSecretTokenProviderModule(): Promise<SharedSecretTokenProviderModule> {
  if (!sharedSecretTokenProviderModulePromise) {
    sharedSecretTokenProviderModulePromise = safeImport(
      () => import('./shared-secret-token-provider.js'),
      'shared-secret-token-provider'
    );
  }

  return sharedSecretTokenProviderModulePromise;
}

function normalizeConfig(
  config?: SharedSecretTokenProviderConfig | Record<string, unknown> | null
): NormalizedSharedSecretConfig {
  if (!config) {
    throw new Error('SharedSecretTokenProvider requires configuration');
  }

  const candidate = config as SharedSecretTokenProviderConfig &
    Record<string, unknown>;
  const record = candidate as Record<string, unknown>;

  let secretSource = candidate.secret as SecretSourceType | undefined;
  if (secretSource === undefined && record.secret_provider !== undefined) {
    secretSource = record.secret_provider as SecretSourceType;
  }
  if (secretSource === undefined && record.secret_source !== undefined) {
    secretSource = record.secret_source as SecretSourceType;
  }
  if (
    secretSource === undefined &&
    record.secret_provider_config !== undefined
  ) {
    secretSource = record.secret_provider_config as SecretSourceType;
  }

  if (secretSource === undefined) {
    secretSource = 'env://SHARED_SECRET';
  }

  return {
    secretConfig: normalizeSecretSource(secretSource),
  };
}

export const FACTORY_META = {
  base: TOKEN_PROVIDER_FACTORY_BASE_TYPE,
  key: 'SharedSecretTokenProvider',
} as const;

export class SharedSecretTokenProviderFactory extends TokenProviderFactory<SharedSecretTokenProviderConfig> {
  public readonly type = 'SharedSecretTokenProvider';

  public async create(
    config?: SharedSecretTokenProviderConfig | Record<string, unknown> | null
  ): Promise<TokenProvider> {
    const normalized = normalizeConfig(config);
    const credentialProvider =
      await CredentialProviderFactory.createCredentialProvider(
        normalized.secretConfig
      );

    const { SharedSecretTokenProvider } =
      await getSharedSecretTokenProviderModule();

    return new SharedSecretTokenProvider(
      credentialProvider as CredentialProvider
    );
  }
}

export default SharedSecretTokenProviderFactory;
