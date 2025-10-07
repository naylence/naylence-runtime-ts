import {
  CREDENTIAL_PROVIDER_FACTORY_BASE_TYPE,
  CredentialProviderFactory,
  type CredentialProviderConfig,
} from './credential-provider-factory.js';
import type { CredentialProvider } from './credential-provider.js';
import { PromptCredentialProvider } from './prompt-credential-provider.js';

export interface PromptCredentialProviderConfig
  extends CredentialProviderConfig {
  type: 'PromptCredentialProvider';
  credentialName?: string;
}

export function normalizePromptConfig(
  config?: PromptCredentialProviderConfig | Record<string, unknown> | null
): PromptCredentialProviderConfig {
  if (!config) {
    return {
      type: 'PromptCredentialProvider',
      credentialName: 'credential',
    };
  }

  const credentialName =
    (config as PromptCredentialProviderConfig).credentialName ??
    (config as Record<string, unknown>).credential_name ??
    'credential';

  if (typeof credentialName !== 'string' || credentialName.length === 0) {
    throw new Error(
      'PromptCredentialProvider requires a non-empty "credentialName"'
    );
  }

  return {
    type: 'PromptCredentialProvider',
    credentialName,
  };
}

export class PromptCredentialProviderFactory extends CredentialProviderFactory<PromptCredentialProviderConfig> {
  public readonly type = 'PromptCredentialProvider';

  public async create(
    config?: PromptCredentialProviderConfig | Record<string, unknown> | null
  ): Promise<CredentialProvider> {
    const resolved = normalizePromptConfig(config);
    return new PromptCredentialProvider(resolved.credentialName);
  }
}

export const FACTORY_META = {
  base: CREDENTIAL_PROVIDER_FACTORY_BASE_TYPE,
  key: 'PromptCredentialProvider',
} as const;

export default PromptCredentialProviderFactory;
