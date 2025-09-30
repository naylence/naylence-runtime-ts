import type {
  CredentialProviderConfig,
  EnvCredentialProviderConfig,
  PromptCredentialProviderConfig,
  SecretStoreCredentialProviderConfig,
  StaticCredentialProviderConfig,
} from "./credential-provider-factory.js";
import {
  normalizeEnvConfig,
  normalizePromptConfig,
  normalizeSecretStoreConfig,
  normalizeStaticConfig,
} from "./credential-provider-factory.js";

export type SecretSourceType = string | Record<string, unknown> | CredentialProviderConfig;

function isCredentialProviderConfig(value: unknown): value is CredentialProviderConfig {
  return Boolean(
    value && typeof value === "object" && "type" in (value as Record<string, unknown>)
  );
}

export class SecretSource {
  public static normalize(
    value: SecretSourceType
  ): CredentialProviderConfig | Record<string, unknown> {
    if (value === null || value === undefined) {
      throw new TypeError("Secret source cannot be null or undefined");
    }

    if (isCredentialProviderConfig(value)) {
      switch (value.type) {
        case "EnvCredentialProvider":
          return normalizeEnvConfig(value as EnvCredentialProviderConfig);
        case "SecretStoreCredentialProvider":
          return normalizeSecretStoreConfig(value as SecretStoreCredentialProviderConfig);
        case "StaticCredentialProvider":
          return normalizeStaticConfig(value as StaticCredentialProviderConfig);
        case "PromptCredentialProvider":
          return normalizePromptConfig(value as PromptCredentialProviderConfig);
        default:
          return { ...value };
      }
    }

    if (typeof value === "string") {
      if (value.startsWith("env://")) {
        const varName = value.slice("env://".length);
        if (!varName) {
          throw new Error("Environment variable name cannot be empty in 'env://' URI");
        }
        return normalizeEnvConfig({ type: "EnvCredentialProvider", varName });
      }

      if (value.startsWith("secret://")) {
        const secretName = value.slice("secret://".length);
        if (!secretName) {
          throw new Error("Secret name cannot be empty in 'secret://' URI");
        }
        return normalizeSecretStoreConfig({
          type: "SecretStoreCredentialProvider",
          secretName,
        });
      }

      return normalizeStaticConfig({
        type: "StaticCredentialProvider",
        credentialValue: value,
      });
    }

    if (typeof value === "object") {
      const recordValue = value as Record<string, unknown>;
      if (!("type" in recordValue) || typeof recordValue.type !== "string") {
        throw new TypeError("Secret source dict inputs must include a string 'type' field");
      }

      switch (recordValue.type) {
        case "EnvCredentialProvider":
          return normalizeEnvConfig(recordValue);
        case "SecretStoreCredentialProvider":
          return normalizeSecretStoreConfig(recordValue);
        case "StaticCredentialProvider":
          return normalizeStaticConfig(recordValue);
        case "PromptCredentialProvider":
          return normalizePromptConfig(recordValue);
        default:
          return { ...recordValue };
      }
    }

    throw new TypeError(
      `Unsupported secret source type: ${typeof value}. Expected string, dict with 'type' field, or CredentialProviderConfig instance.`
    );
  }
}

export function normalizeSecretSource(
  value: SecretSourceType
): CredentialProviderConfig | Record<string, unknown> {
  return SecretSource.normalize(value);
}
