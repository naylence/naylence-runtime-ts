import {
  CREDENTIAL_PROVIDER_FACTORY_BASE_TYPE,
  CredentialProviderFactory,
  type CredentialProviderConfig,
} from "./credential-provider-factory.js";
import type { CredentialProvider } from "./credential-provider.js";
import { StaticCredentialProvider } from "./static-credential-provider.js";

export interface StaticCredentialProviderConfig extends CredentialProviderConfig {
  type: "StaticCredentialProvider";
  credentialValue: string;
}

export function normalizeStaticConfig(
  config?: StaticCredentialProviderConfig | Record<string, unknown> | null
): StaticCredentialProviderConfig {
  if (!config) {
    return {
      type: "StaticCredentialProvider",
      credentialValue: "",
    };
  }

  if ("credentialValue" in config && typeof config.credentialValue === "string") {
    return {
      type: "StaticCredentialProvider",
      credentialValue: config.credentialValue,
    };
  }

  const rawValue =
    (config as Record<string, unknown>).credentialValue ??
    (config as Record<string, unknown>).credential_value;

  if (typeof rawValue !== "string") {
    throw new Error('StaticCredentialProvider requires a "credentialValue" string');
  }

  return {
    type: "StaticCredentialProvider",
    credentialValue: rawValue,
  };
}

export class StaticCredentialProviderFactory extends CredentialProviderFactory<StaticCredentialProviderConfig> {
  public readonly type = "StaticCredentialProvider";

  public async create(
    config?: StaticCredentialProviderConfig | Record<string, unknown> | null
  ): Promise<CredentialProvider> {
    const resolved = normalizeStaticConfig(config);
    return new StaticCredentialProvider(resolved.credentialValue);
  }
}

export const FACTORY_META = {
  base: CREDENTIAL_PROVIDER_FACTORY_BASE_TYPE,
  key: "StaticCredentialProvider",
} as const;

export default StaticCredentialProviderFactory;
