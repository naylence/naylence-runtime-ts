import {
  CREDENTIAL_PROVIDER_FACTORY_BASE_TYPE,
  CredentialProviderFactory,
  type CredentialProviderConfig,
} from './credential-provider-factory.js';
import type { CredentialProvider } from './credential-provider.js';
import { SecretStoreCredentialProvider } from './secret-store-credential-provider.js';

export interface SecretStoreCredentialProviderConfig
  extends CredentialProviderConfig {
  type: 'SecretStoreCredentialProvider';
  secretName: string;
}

export function normalizeSecretStoreConfig(
  config?: SecretStoreCredentialProviderConfig | Record<string, unknown> | null
): SecretStoreCredentialProviderConfig {
  if (!config) {
    return {
      type: 'SecretStoreCredentialProvider',
      secretName: 'default',
    };
  }

  if (
    'secretName' in config &&
    typeof config.secretName === 'string' &&
    config.secretName.length > 0
  ) {
    return {
      type: 'SecretStoreCredentialProvider',
      secretName: config.secretName,
    };
  }

  const rawName =
    (config as Record<string, unknown>).secretName ??
    (config as Record<string, unknown>).secret_name;

  if (typeof rawName !== 'string' || rawName.length === 0) {
    throw new Error(
      'SecretStoreCredentialProvider requires a non-empty "secretName"'
    );
  }

  return {
    type: 'SecretStoreCredentialProvider',
    secretName: rawName,
  };
}

export class SecretStoreCredentialProviderFactory extends CredentialProviderFactory<SecretStoreCredentialProviderConfig> {
  public readonly type = 'SecretStoreCredentialProvider';

  public async create(
    config?:
      | SecretStoreCredentialProviderConfig
      | Record<string, unknown>
      | null
  ): Promise<CredentialProvider> {
    const resolved = normalizeSecretStoreConfig(config);
    return new SecretStoreCredentialProvider(resolved.secretName);
  }
}

export const FACTORY_META = {
  base: CREDENTIAL_PROVIDER_FACTORY_BASE_TYPE,
  key: 'SecretStoreCredentialProvider',
} as const;

export default SecretStoreCredentialProviderFactory;
