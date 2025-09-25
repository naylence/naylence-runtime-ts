import { registerFactory } from 'naylence-factory';

import type { CredentialProvider } from '../credential/credential-provider.js';
import { CredentialProviderFactory, type CredentialProviderConfig } from '../credential/credential-provider-factory.js';
import { normalizeSecretSource, type SecretSourceType } from '../credential/secret-source.js';
import type { TokenProvider } from './token-provider.js';
import {
  TOKEN_PROVIDER_FACTORY_BASE_TYPE,
  TokenProviderFactory,
  type TokenProviderConfig,
} from './token-provider-factory.js';
import { SharedSecretTokenProvider } from './shared-secret-token-provider.js';

export interface SharedSecretTokenProviderConfig extends TokenProviderConfig {
  type: 'SharedSecretTokenProvider';
  secret: SecretSourceType;
}

interface NormalizedSharedSecretConfig {
  secretConfig: CredentialProviderConfig | Record<string, unknown>;
}

function normalizeConfig(
  config?: SharedSecretTokenProviderConfig | Record<string, unknown> | null
): NormalizedSharedSecretConfig {
  if (!config) {
    throw new Error('SharedSecretTokenProvider requires configuration');
  }

  const candidate = config as SharedSecretTokenProviderConfig & Record<string, unknown>;
  const secretSource: SecretSourceType = candidate.secret ?? 'env://SHARED_SECRET';

  return {
    secretConfig: normalizeSecretSource(secretSource),
  };
}

export class SharedSecretTokenProviderFactory extends TokenProviderFactory<SharedSecretTokenProviderConfig> {
  public readonly type = 'SharedSecretTokenProvider';

  public async create(
    config?: SharedSecretTokenProviderConfig | Record<string, unknown> | null
  ): Promise<TokenProvider> {
    const normalized = normalizeConfig(config);
    const credentialProvider = await CredentialProviderFactory.createCredentialProvider(
      normalized.secretConfig
    );

    return new SharedSecretTokenProvider(credentialProvider as CredentialProvider);
  }
}

registerFactory<TokenProvider, SharedSecretTokenProviderConfig>(
  TOKEN_PROVIDER_FACTORY_BASE_TYPE,
  'SharedSecretTokenProvider',
  SharedSecretTokenProviderFactory
);
