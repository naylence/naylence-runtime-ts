import {
  CREDENTIAL_PROVIDER_FACTORY_BASE_TYPE,
  CredentialProviderFactory,
  type CredentialProviderConfig,
} from './credential-provider-factory.js';
import type { CredentialProvider } from './credential-provider.js';
import { DevFixedKeyCredentialProvider } from './dev-fixed-key-credential-provider.js';

export interface DevFixedKeyCredentialProviderConfig
  extends CredentialProviderConfig {
  type: 'DevFixedKeyCredentialProvider';
  keyHex?: string;
  keyBase64?: string;
}

export function normalizeDevFixedConfig(
  config?: DevFixedKeyCredentialProviderConfig | Record<string, unknown> | null
): DevFixedKeyCredentialProviderConfig {
  if (!config) {
    throw new Error(
      'DevFixedKeyCredentialProvider requires configuration with a key value'
    );
  }

  const keyHex =
    (config as DevFixedKeyCredentialProviderConfig).keyHex ??
    (config as Record<string, unknown>).key_hex ??
    (config as Record<string, unknown>).keyHex;
  const keyBase64 =
    (config as DevFixedKeyCredentialProviderConfig).keyBase64 ??
    (config as Record<string, unknown>).key_base64 ??
    (config as Record<string, unknown>).keyBase64;

  if (typeof keyHex === 'string' && keyHex.length > 0) {
    if (typeof keyBase64 === 'string' && keyBase64.length > 0) {
      throw new Error('Provide either keyHex or keyBase64, not both');
    }
    return {
      type: 'DevFixedKeyCredentialProvider',
      keyHex,
    };
  }

  if (typeof keyBase64 === 'string' && keyBase64.length > 0) {
    return {
      type: 'DevFixedKeyCredentialProvider',
      keyBase64,
    };
  }

  throw new Error('DevFixedKeyCredentialProvider requires keyHex or keyBase64');
}

export class DevFixedKeyCredentialProviderFactory extends CredentialProviderFactory<DevFixedKeyCredentialProviderConfig> {
  public readonly type = 'DevFixedKeyCredentialProvider';

  public async create(
    config?:
      | DevFixedKeyCredentialProviderConfig
      | Record<string, unknown>
      | null
  ): Promise<CredentialProvider> {
    const resolved = normalizeDevFixedConfig(config);

    if (resolved.keyHex) {
      return DevFixedKeyCredentialProvider.fromHex(resolved.keyHex);
    }

    if (resolved.keyBase64) {
      return DevFixedKeyCredentialProvider.fromBase64(resolved.keyBase64);
    }

    throw new Error(
      'DevFixedKeyCredentialProvider requires keyHex or keyBase64'
    );
  }
}

export const FACTORY_META = {
  base: CREDENTIAL_PROVIDER_FACTORY_BASE_TYPE,
  key: 'DevFixedKeyCredentialProvider',
} as const;

export default DevFixedKeyCredentialProviderFactory;
