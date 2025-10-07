import {
  CREDENTIAL_PROVIDER_FACTORY_BASE_TYPE,
  CredentialProviderFactory,
  type CredentialProviderConfig,
} from './credential-provider-factory.js';
import type { CredentialProvider } from './credential-provider.js';
import { EnvCredentialProvider } from './env-credential-provider.js';

export interface EnvCredentialProviderConfig extends CredentialProviderConfig {
  type: 'EnvCredentialProvider';
  varName: string;
}

export function normalizeEnvConfig(
  config?: EnvCredentialProviderConfig | Record<string, unknown> | null
): EnvCredentialProviderConfig {
  if (!config) {
    return {
      type: 'EnvCredentialProvider',
      varName: 'DEFAULT_VAR',
    };
  }

  if (
    'varName' in config &&
    typeof config.varName === 'string' &&
    config.varName.length > 0
  ) {
    return {
      type: 'EnvCredentialProvider',
      varName: config.varName,
    };
  }

  const rawName =
    (config as Record<string, unknown>).varName ??
    (config as Record<string, unknown>).var_name;

  if (typeof rawName !== 'string' || rawName.length === 0) {
    throw new Error('EnvCredentialProvider requires a non-empty "varName"');
  }

  return {
    type: 'EnvCredentialProvider',
    varName: rawName,
  };
}

export class EnvCredentialProviderFactory extends CredentialProviderFactory<EnvCredentialProviderConfig> {
  public readonly type = 'EnvCredentialProvider';

  public async create(
    config?: EnvCredentialProviderConfig | Record<string, unknown> | null
  ): Promise<CredentialProvider> {
    const resolved = normalizeEnvConfig(config);
    return new EnvCredentialProvider(resolved.varName);
  }
}

export const FACTORY_META = {
  base: CREDENTIAL_PROVIDER_FACTORY_BASE_TYPE,
  key: 'EnvCredentialProvider',
} as const;

export default EnvCredentialProviderFactory;
