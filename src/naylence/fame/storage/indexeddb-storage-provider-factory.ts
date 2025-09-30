import { z } from "zod";

import type { CredentialProvider } from "../security/credential/credential-provider.js";
import type { CredentialProviderConfig } from "../security/credential/credential-provider-factory.js";
import { CredentialProviderFactory } from "../security/credential/credential-provider-factory.js";
import type { SecretSourceType } from "../security/credential/secret-source.js";
import { SecretSource } from "../security/credential/secret-source.js";
import { safeImport } from "../util/lazy-import.js";

import type { IndexedDBStorageProvider } from "./indexeddb-storage-provider.js";
import type { IndexedDBStorageProviderMode } from "./indexeddb-storage-provider.js";
import {
  type StorageProviderConfig,
  StorageProviderFactory,
  registerStorageProviderFactory,
} from "./storage-provider-factory.js";

export interface IndexedDBStorageProviderConfig extends StorageProviderConfig {
  type: "IndexedDBStorageProvider";
  mode?: IndexedDBStorageProviderMode | string;
  dbName?: string;
  db_name?: string;
  version?: number | string;
  namespacePrefix?: string;
  namespace_prefix?: string;
  enableCaching?: boolean | string;
  enable_caching?: boolean | string;
  isEncrypted?: boolean | string;
  is_encrypted?: boolean | string;
  masterKey?: SecretSourceType | CredentialProviderConfig | Record<string, unknown> | null;
  master_key?: SecretSourceType | CredentialProviderConfig | Record<string, unknown> | null;
}

interface NormalizedIndexedDBConfig {
  type: "IndexedDBStorageProvider";
  mode: IndexedDBStorageProviderMode;
  dbName: string;
  version: number;
  namespacePrefix: string;
  enableCaching: boolean;
  isEncrypted: boolean;
  masterKey: CredentialProviderConfig | Record<string, unknown> | null;
}

const indexedDBConfigSchema = z
  .object({
    type: z.literal("IndexedDBStorageProvider").default("IndexedDBStorageProvider"),
    mode: z
      .union([z.literal("dx"), z.literal("hardened"), z.string()])
      .optional()
      .default("dx"),
    dbName: z.string().min(1).default("naylence"),
    version: z.union([z.number().int().positive(), z.string()]).default(1),
    namespacePrefix: z.string().optional().default("kv"),
    enableCaching: z.union([z.boolean(), z.string()]).optional(),
    isEncrypted: z.union([z.boolean(), z.string()]).optional(),
    masterKey: z
      .union([z.string(), z.record(z.string(), z.unknown()), z.null()])
      .optional()
      .default(null),
  })
  .passthrough();

const TRUE_VALUES = new Set(["true", "1", "yes", "on"]);
const FALSE_VALUES = new Set(["false", "0", "no", "off", ""]);

function coerceBoolean(value: unknown, fieldName: string, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (TRUE_VALUES.has(normalized)) {
      return true;
    }
    if (FALSE_VALUES.has(normalized)) {
      return false;
    }
  }

  throw new Error(
    `Expected a boolean-like value for '${fieldName}' but received '${String(value)}'`
  );
}

function normalizeIndexedDBConfig(
  config?: IndexedDBStorageProviderConfig | Record<string, unknown> | null
): NormalizedIndexedDBConfig {
  const candidate: Record<string, unknown> = { ...(config as Record<string, unknown> | undefined) };

  if (candidate.dbName === undefined && typeof candidate.db_name === "string") {
    candidate.dbName = candidate.db_name;
  }
  if (candidate.namespacePrefix === undefined && typeof candidate.namespace_prefix === "string") {
    candidate.namespacePrefix = candidate.namespace_prefix;
  }
  if (candidate.enableCaching === undefined && candidate.enable_caching !== undefined) {
    candidate.enableCaching = candidate.enable_caching;
  }
  if (candidate.isEncrypted === undefined && candidate.is_encrypted !== undefined) {
    candidate.isEncrypted = candidate.is_encrypted;
  }
  if (candidate.masterKey === undefined && candidate.master_key !== undefined) {
    candidate.masterKey = candidate.master_key;
  }

  const parsed = indexedDBConfigSchema.parse({ ...candidate, type: "IndexedDBStorageProvider" });

  const normalizedMode = (typeof parsed.mode === "string" ? parsed.mode : "dx").toLowerCase();
  if (normalizedMode !== "dx" && normalizedMode !== "hardened") {
    throw new Error("mode must be either 'dx' or 'hardened'");
  }

  const versionValue =
    typeof parsed.version === "string" ? parseInt(parsed.version, 10) : parsed.version;
  if (!Number.isInteger(versionValue) || versionValue <= 0) {
    throw new Error("version must be a positive integer");
  }

  const enableCaching = coerceBoolean(
    parsed.enableCaching,
    "enableCaching",
    normalizedMode === "dx"
  );

  const isEncrypted = coerceBoolean(parsed.isEncrypted, "isEncrypted", true);

  let masterKeyConfig: CredentialProviderConfig | Record<string, unknown> | null = null;
  if (parsed.masterKey !== null && parsed.masterKey !== undefined) {
    masterKeyConfig = SecretSource.normalize(parsed.masterKey as SecretSourceType);
  }

  if (normalizedMode === "hardened" && !masterKeyConfig) {
    throw new Error("hardened mode requires a masterKey configuration");
  }

  return {
    type: "IndexedDBStorageProvider",
    mode: normalizedMode as IndexedDBStorageProviderMode,
    dbName: parsed.dbName,
    version: versionValue,
    namespacePrefix: parsed.namespacePrefix ?? "kv",
    enableCaching,
    isEncrypted,
    masterKey: masterKeyConfig,
  };
}

export class IndexedDBStorageProviderFactory extends StorageProviderFactory<IndexedDBStorageProviderConfig> {
  public readonly type = "IndexedDBStorageProvider";
  public readonly isDefault = true;
  public readonly priority = 50;

  public async create(
    config?: IndexedDBStorageProviderConfig | Record<string, unknown> | null
  ): Promise<IndexedDBStorageProvider> {
    const normalized = normalizeIndexedDBConfig(config);

    const { IndexedDBStorageProvider } = await getIndexedDbStorageProviderModule();

    let masterKeyProvider: CredentialProvider | null = null;
    if (normalized.masterKey) {
      masterKeyProvider = await CredentialProviderFactory.createCredentialProvider(
        normalized.masterKey as CredentialProviderConfig
      );
    }

    return new IndexedDBStorageProvider({
      mode: normalized.mode,
      dbName: normalized.dbName,
      version: normalized.version,
      namespacePrefix: normalized.namespacePrefix,
      enableCaching: normalized.enableCaching,
      isEncrypted: normalized.isEncrypted,
      masterKeyProvider,
    });
  }
}

type IndexedDbStorageProviderModule = typeof import("./indexeddb-storage-provider.js");

let indexedDbStorageProviderModulePromise: Promise<IndexedDbStorageProviderModule> | null = null;

function getIndexedDbStorageProviderModule(): Promise<IndexedDbStorageProviderModule> {
  if (!indexedDbStorageProviderModulePromise) {
    indexedDbStorageProviderModulePromise = safeImport(
      () => import("./indexeddb-storage-provider.js"),
      "IndexedDBStorageProvider",
      {
        helpMessage:
          "Failed to load the IndexedDB storage provider. Ensure IndexedDB is available or install the required polyfills.",
      }
    );
  }
  return indexedDbStorageProviderModulePromise;
}

registerStorageProviderFactory("IndexedDBStorageProvider", IndexedDBStorageProviderFactory);
