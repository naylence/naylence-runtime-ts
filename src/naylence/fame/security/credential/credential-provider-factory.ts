import type { CreateResourceOptions, ResourceConfig } from "naylence-factory";
import {
  AbstractResourceFactory,
  createDefaultResource,
  createResource,
  registerFactory,
} from "naylence-factory";

import type { CredentialProvider } from "./credential-provider.js";
import { EnvCredentialProvider } from "./env-credential-provider.js";
import { NoneCredentialProvider } from "./none-credential-provider.js";
import { PromptCredentialProvider } from "./prompt-credential-provider.js";
import { SecretStoreCredentialProvider } from "./secret-store-credential-provider.js";
import { StaticCredentialProvider } from "./static-credential-provider.js";
import { SessionKeyCredentialProvider } from "./session-key-credential-provider.js";
import { DevFixedKeyCredentialProvider } from "./dev-fixed-key-credential-provider.js";

export const CREDENTIAL_PROVIDER_FACTORY_BASE_TYPE = "CredentialProviderFactory";

export interface CredentialProviderConfig extends ResourceConfig {
  type: string;
  [key: string]: unknown;
}

export abstract class CredentialProviderFactory<
  C extends CredentialProviderConfig = CredentialProviderConfig,
> extends AbstractResourceFactory<CredentialProvider, C> {
  public abstract create(
    config?: C | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<CredentialProvider>;

  public static async createCredentialProvider<
    C extends CredentialProviderConfig = CredentialProviderConfig,
  >(
    config?: C | Record<string, unknown> | null,
    options: CreateResourceOptions = {}
  ): Promise<CredentialProvider> {
    const instance = config
      ? await createResource<CredentialProvider>(
          CREDENTIAL_PROVIDER_FACTORY_BASE_TYPE,
          config,
          options
        )
      : await createDefaultResource<CredentialProvider>(
          CREDENTIAL_PROVIDER_FACTORY_BASE_TYPE,
          null,
          options
        );

    if (!instance) {
      throw new Error("Failed to create credential provider from configuration");
    }

    return instance;
  }
}

export interface NoneCredentialProviderConfig extends CredentialProviderConfig {
  type: "NoneCredentialProvider";
}

export class NoneCredentialProviderFactory extends CredentialProviderFactory<NoneCredentialProviderConfig> {
  public readonly type = "NoneCredentialProvider";
  public readonly isDefault = true;
  public readonly priority = 100;

  public async create(): Promise<CredentialProvider> {
    return new NoneCredentialProvider();
  }
}

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

export interface EnvCredentialProviderConfig extends CredentialProviderConfig {
  type: "EnvCredentialProvider";
  varName: string;
}

export function normalizeEnvConfig(
  config?: EnvCredentialProviderConfig | Record<string, unknown> | null
): EnvCredentialProviderConfig {
  if (!config) {
    return {
      type: "EnvCredentialProvider",
      varName: "DEFAULT_VAR",
    };
  }

  if ("varName" in config && typeof config.varName === "string" && config.varName.length > 0) {
    return {
      type: "EnvCredentialProvider",
      varName: config.varName,
    };
  }

  const rawName =
    (config as Record<string, unknown>).varName ?? (config as Record<string, unknown>).var_name;

  if (typeof rawName !== "string" || rawName.length === 0) {
    throw new Error('EnvCredentialProvider requires a non-empty "varName"');
  }

  return {
    type: "EnvCredentialProvider",
    varName: rawName,
  };
}

export class EnvCredentialProviderFactory extends CredentialProviderFactory<EnvCredentialProviderConfig> {
  public readonly type = "EnvCredentialProvider";

  public async create(
    config?: EnvCredentialProviderConfig | Record<string, unknown> | null
  ): Promise<CredentialProvider> {
    const resolved = normalizeEnvConfig(config);
    return new EnvCredentialProvider(resolved.varName);
  }
}

export interface SecretStoreCredentialProviderConfig extends CredentialProviderConfig {
  type: "SecretStoreCredentialProvider";
  secretName: string;
}

export function normalizeSecretStoreConfig(
  config?: SecretStoreCredentialProviderConfig | Record<string, unknown> | null
): SecretStoreCredentialProviderConfig {
  if (!config) {
    return {
      type: "SecretStoreCredentialProvider",
      secretName: "default",
    };
  }

  if (
    "secretName" in config &&
    typeof config.secretName === "string" &&
    config.secretName.length > 0
  ) {
    return {
      type: "SecretStoreCredentialProvider",
      secretName: config.secretName,
    };
  }

  const rawName =
    (config as Record<string, unknown>).secretName ??
    (config as Record<string, unknown>).secret_name;

  if (typeof rawName !== "string" || rawName.length === 0) {
    throw new Error('SecretStoreCredentialProvider requires a non-empty "secretName"');
  }

  return {
    type: "SecretStoreCredentialProvider",
    secretName: rawName,
  };
}

export class SecretStoreCredentialProviderFactory extends CredentialProviderFactory<SecretStoreCredentialProviderConfig> {
  public readonly type = "SecretStoreCredentialProvider";

  public async create(
    config?: SecretStoreCredentialProviderConfig | Record<string, unknown> | null
  ): Promise<CredentialProvider> {
    const resolved = normalizeSecretStoreConfig(config);
    return new SecretStoreCredentialProvider(resolved.secretName);
  }
}

export interface PromptCredentialProviderConfig extends CredentialProviderConfig {
  type: "PromptCredentialProvider";
  credentialName?: string;
}

export function normalizePromptConfig(
  config?: PromptCredentialProviderConfig | Record<string, unknown> | null
): PromptCredentialProviderConfig {
  if (!config) {
    return {
      type: "PromptCredentialProvider",
      credentialName: "credential",
    };
  }

  const credentialName =
    (config as PromptCredentialProviderConfig).credentialName ??
    (config as Record<string, unknown>).credential_name ??
    "credential";

  if (typeof credentialName !== "string" || credentialName.length === 0) {
    throw new Error('PromptCredentialProvider requires a non-empty "credentialName"');
  }

  return {
    type: "PromptCredentialProvider",
    credentialName,
  };
}

export class PromptCredentialProviderFactory extends CredentialProviderFactory<PromptCredentialProviderConfig> {
  public readonly type = "PromptCredentialProvider";

  public async create(
    config?: PromptCredentialProviderConfig | Record<string, unknown> | null
  ): Promise<CredentialProvider> {
    const resolved = normalizePromptConfig(config);
    return new PromptCredentialProvider(resolved.credentialName);
  }
}

registerFactory(
  CREDENTIAL_PROVIDER_FACTORY_BASE_TYPE,
  "NoneCredentialProvider",
  NoneCredentialProviderFactory,
  { isDefault: true, priority: 100 }
);

registerFactory(
  CREDENTIAL_PROVIDER_FACTORY_BASE_TYPE,
  "StaticCredentialProvider",
  StaticCredentialProviderFactory
);

registerFactory(
  CREDENTIAL_PROVIDER_FACTORY_BASE_TYPE,
  "EnvCredentialProvider",
  EnvCredentialProviderFactory
);

registerFactory(
  CREDENTIAL_PROVIDER_FACTORY_BASE_TYPE,
  "SecretStoreCredentialProvider",
  SecretStoreCredentialProviderFactory
);

registerFactory(
  CREDENTIAL_PROVIDER_FACTORY_BASE_TYPE,
  "PromptCredentialProvider",
  PromptCredentialProviderFactory
);

export interface SessionKeyCredentialProviderConfig extends CredentialProviderConfig {
  type: "SessionKeyCredentialProvider";
  length?: number;
}

export function normalizeSessionKeyConfig(
  config?: SessionKeyCredentialProviderConfig | Record<string, unknown> | null
): SessionKeyCredentialProviderConfig {
  if (!config) {
    return {
      type: "SessionKeyCredentialProvider",
    };
  }

  const lengthValue =
    (config as SessionKeyCredentialProviderConfig).length ??
    (config as Record<string, unknown>).length;

  if (lengthValue === undefined || lengthValue === null) {
    return {
      type: "SessionKeyCredentialProvider",
    };
  }

  if (typeof lengthValue !== "number" || !Number.isInteger(lengthValue) || lengthValue <= 0) {
    throw new Error("SessionKeyCredentialProvider length must be a positive integer");
  }

  return {
    type: "SessionKeyCredentialProvider",
    length: lengthValue,
  };
}

export class SessionKeyCredentialProviderFactory extends CredentialProviderFactory<SessionKeyCredentialProviderConfig> {
  public readonly type = "SessionKeyCredentialProvider";

  public async create(
    config?: SessionKeyCredentialProviderConfig | Record<string, unknown> | null
  ): Promise<CredentialProvider> {
    const resolved = normalizeSessionKeyConfig(config);
    return new SessionKeyCredentialProvider(resolved.length);
  }
}

registerFactory(
  CREDENTIAL_PROVIDER_FACTORY_BASE_TYPE,
  "SessionKeyCredentialProvider",
  SessionKeyCredentialProviderFactory
);

export interface DevFixedKeyCredentialProviderConfig extends CredentialProviderConfig {
  type: "DevFixedKeyCredentialProvider";
  keyHex?: string;
  keyBase64?: string;
}

export function normalizeDevFixedConfig(
  config?: DevFixedKeyCredentialProviderConfig | Record<string, unknown> | null
): DevFixedKeyCredentialProviderConfig {
  if (!config) {
    throw new Error("DevFixedKeyCredentialProvider requires configuration with a key value");
  }

  const keyHex =
    (config as DevFixedKeyCredentialProviderConfig).keyHex ??
    (config as Record<string, unknown>).key_hex ??
    (config as Record<string, unknown>).keyHex;
  const keyBase64 =
    (config as DevFixedKeyCredentialProviderConfig).keyBase64 ??
    (config as Record<string, unknown>).key_base64 ??
    (config as Record<string, unknown>).keyBase64;

  if (typeof keyHex === "string" && keyHex.length > 0) {
    if (typeof keyBase64 === "string" && keyBase64.length > 0) {
      throw new Error("Provide either keyHex or keyBase64, not both");
    }
    return {
      type: "DevFixedKeyCredentialProvider",
      keyHex,
    };
  }

  if (typeof keyBase64 === "string" && keyBase64.length > 0) {
    return {
      type: "DevFixedKeyCredentialProvider",
      keyBase64,
    };
  }

  throw new Error("DevFixedKeyCredentialProvider requires keyHex or keyBase64");
}

export class DevFixedKeyCredentialProviderFactory extends CredentialProviderFactory<DevFixedKeyCredentialProviderConfig> {
  public readonly type = "DevFixedKeyCredentialProvider";

  public async create(
    config?: DevFixedKeyCredentialProviderConfig | Record<string, unknown> | null
  ): Promise<CredentialProvider> {
    const resolved = normalizeDevFixedConfig(config);

    if (resolved.keyHex) {
      return DevFixedKeyCredentialProvider.fromHex(resolved.keyHex);
    }

    if (resolved.keyBase64) {
      return DevFixedKeyCredentialProvider.fromBase64(resolved.keyBase64);
    }

    throw new Error("DevFixedKeyCredentialProvider requires keyHex or keyBase64");
  }
}

registerFactory(
  CREDENTIAL_PROVIDER_FACTORY_BASE_TYPE,
  "DevFixedKeyCredentialProvider",
  DevFixedKeyCredentialProviderFactory
);
