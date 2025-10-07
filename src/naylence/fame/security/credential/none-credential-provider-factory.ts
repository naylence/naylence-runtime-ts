import {
  CREDENTIAL_PROVIDER_FACTORY_BASE_TYPE,
  CredentialProviderFactory,
  type CredentialProviderConfig,
} from './credential-provider-factory.js';
import type { CredentialProvider } from './credential-provider.js';
import { NoneCredentialProvider } from './none-credential-provider.js';

export interface NoneCredentialProviderConfig extends CredentialProviderConfig {
  type: 'NoneCredentialProvider';
}

export class NoneCredentialProviderFactory extends CredentialProviderFactory<NoneCredentialProviderConfig> {
  public readonly type = 'NoneCredentialProvider';
  public readonly isDefault = true;
  public readonly priority = 100;

  public async create(): Promise<CredentialProvider> {
    return new NoneCredentialProvider();
  }
}

export const FACTORY_META = {
  base: CREDENTIAL_PROVIDER_FACTORY_BASE_TYPE,
  key: 'NoneCredentialProvider',
} as const;

export default NoneCredentialProviderFactory;
