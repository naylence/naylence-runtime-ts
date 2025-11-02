import { safeImport } from '../../util/lazy-import.js';
import type { Authorizer } from './authorizer.js';
import {
  AUTHORIZER_FACTORY_BASE_TYPE,
  AuthorizerFactory,
  type AuthorizerConfig,
} from './authorizer-factory.js';
import {
  CredentialProviderFactory,
  type CredentialProviderConfig,
} from '../credential/credential-provider-factory.js';
import {
  normalizeSecretSource,
  type SecretSourceType,
} from '../credential/secret-source.js';

export interface SharedSecretAuthorizerConfig extends AuthorizerConfig {
  type: 'SharedSecretAuthorizer';
  secret?: SecretSourceType;
}

interface NormalizedSharedSecretAuthorizerConfig {
  secretConfig: CredentialProviderConfig | Record<string, unknown>;
}

type SharedSecretAuthorizerModule =
  typeof import('./shared-secret-authorizer.js');

let sharedSecretAuthorizerModulePromise: Promise<SharedSecretAuthorizerModule> | null =
  null;

async function getSharedSecretAuthorizerModule(): Promise<SharedSecretAuthorizerModule> {
  if (!sharedSecretAuthorizerModulePromise) {
    sharedSecretAuthorizerModulePromise = safeImport(
      () => import('./shared-secret-authorizer.js'),
      'shared-secret-authorizer'
    );
  }

  return sharedSecretAuthorizerModulePromise;
}

function normalizeConfig(
  config?: SharedSecretAuthorizerConfig | Record<string, unknown> | null
): NormalizedSharedSecretAuthorizerConfig {
  if (!config) {
    throw new Error('SharedSecretAuthorizer requires configuration');
  }

  const source = config as SharedSecretAuthorizerConfig &
    Record<string, unknown>;
  const record = source as Record<string, unknown>;

  let secretSource = source.secret as SecretSourceType | undefined;
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
  base: AUTHORIZER_FACTORY_BASE_TYPE,
  key: 'SharedSecretAuthorizer',
} as const;

export class SharedSecretAuthorizerFactory extends AuthorizerFactory<SharedSecretAuthorizerConfig> {
  public readonly type = 'SharedSecretAuthorizer';

  public async create(
    config?: SharedSecretAuthorizerConfig | Record<string, unknown> | null
  ): Promise<Authorizer> {
    const normalized = normalizeConfig(config);

    const credentialProvider =
      await CredentialProviderFactory.createCredentialProvider(
        normalized.secretConfig
      );

    const { SharedSecretAuthorizer } = await getSharedSecretAuthorizerModule();

    return new SharedSecretAuthorizer(credentialProvider);
  }
}

export default SharedSecretAuthorizerFactory;
