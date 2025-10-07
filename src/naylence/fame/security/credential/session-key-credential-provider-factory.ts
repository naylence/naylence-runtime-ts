import {
  CREDENTIAL_PROVIDER_FACTORY_BASE_TYPE,
  CredentialProviderFactory,
  type CredentialProviderConfig,
} from './credential-provider-factory.js';
import type { CredentialProvider } from './credential-provider.js';
import { SessionKeyCredentialProvider } from './session-key-credential-provider.js';

export interface SessionKeyCredentialProviderConfig
  extends CredentialProviderConfig {
  type: 'SessionKeyCredentialProvider';
  length?: number;
}

export function normalizeSessionKeyConfig(
  config?: SessionKeyCredentialProviderConfig | Record<string, unknown> | null
): SessionKeyCredentialProviderConfig {
  if (!config) {
    return {
      type: 'SessionKeyCredentialProvider',
    };
  }

  const lengthValue =
    (config as SessionKeyCredentialProviderConfig).length ??
    (config as Record<string, unknown>).length;

  if (lengthValue === undefined || lengthValue === null) {
    return {
      type: 'SessionKeyCredentialProvider',
    };
  }

  if (
    typeof lengthValue !== 'number' ||
    !Number.isInteger(lengthValue) ||
    lengthValue <= 0
  ) {
    throw new Error(
      'SessionKeyCredentialProvider length must be a positive integer'
    );
  }

  return {
    type: 'SessionKeyCredentialProvider',
    length: lengthValue,
  };
}

export class SessionKeyCredentialProviderFactory extends CredentialProviderFactory<SessionKeyCredentialProviderConfig> {
  public readonly type = 'SessionKeyCredentialProvider';

  public async create(
    config?: SessionKeyCredentialProviderConfig | Record<string, unknown> | null
  ): Promise<CredentialProvider> {
    const resolved = normalizeSessionKeyConfig(config);
    return new SessionKeyCredentialProvider(resolved.length);
  }
}

export const FACTORY_META = {
  base: CREDENTIAL_PROVIDER_FACTORY_BASE_TYPE,
  key: 'SessionKeyCredentialProvider',
} as const;

export default SessionKeyCredentialProviderFactory;
