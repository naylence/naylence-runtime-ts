import { z } from 'zod';

import type { CredentialProvider } from '../security/credential/credential-provider.js';
import type { CredentialProviderConfig } from '../security/credential/credential-provider-factory.js';
import { CredentialProviderFactory } from '../security/credential/credential-provider-factory.js';
import type { SecretSourceType } from '../security/credential/secret-source.js';
import { SecretSource } from '../security/credential/secret-source.js';

import { SQLiteStorageProvider } from './sqlite-storage-provider.js';
import {
  StorageProviderConfig,
  StorageProviderFactory,
  registerStorageProviderFactory,
} from './storage-provider-factory.js';

export interface SQLiteStorageProviderConfig extends StorageProviderConfig {
  type: 'SQLiteStorageProvider';
  dbDirectory?: string;
  isEncrypted?: boolean | string;
  isCached?: boolean | string;
  autoRecover?: boolean | string;
  masterKey?: SecretSourceType | CredentialProviderConfig | Record<string, unknown> | null;
}

interface NormalizedSQLiteConfig {
  type: 'SQLiteStorageProvider';
  dbDirectory: string;
  isEncrypted: boolean;
  isCached: boolean;
  autoRecover: boolean;
  masterKey: CredentialProviderConfig | Record<string, unknown> | null;
}

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'off', '']);

function coerceBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (TRUE_VALUES.has(normalized)) {
      return true;
    }
    if (FALSE_VALUES.has(normalized)) {
      return false;
    }
  }

  throw new Error(`Expected a boolean-like value for '${fieldName}' but received '${String(value)}'`);
}

const sqliteConfigSchema = z
  .object({
    type: z.literal('SQLiteStorageProvider').default('SQLiteStorageProvider'),
    dbDirectory: z.string().min(1).default('./data/sqlite'),
    isEncrypted: z.union([z.boolean(), z.string()]).default(false),
    isCached: z.union([z.boolean(), z.string()]).default(true),
    autoRecover: z.union([z.boolean(), z.string()]).default(true),
    masterKey: z
      .union([z.string(), z.record(z.string(), z.unknown()), z.null()])
      .optional()
      .default(null),
  })
  .passthrough();

function normalizeSQLiteConfig(
  config?: SQLiteStorageProviderConfig | Record<string, unknown> | null
): NormalizedSQLiteConfig {
  const candidate: Record<string, unknown> = {
    ...(config as Record<string, unknown> | undefined),
  };

  if (candidate.dbDirectory === undefined && typeof candidate.db_directory === 'string') {
    candidate.dbDirectory = candidate.db_directory;
  }
  if (candidate.isEncrypted === undefined && candidate.is_encrypted !== undefined) {
    candidate.isEncrypted = candidate.is_encrypted;
  }
  if (candidate.isCached === undefined && candidate.is_cached !== undefined) {
    candidate.isCached = candidate.is_cached;
  }
  if (candidate.autoRecover === undefined && candidate.auto_recover !== undefined) {
    candidate.autoRecover = candidate.auto_recover;
  }
  if (candidate.masterKey === undefined && candidate.master_key !== undefined) {
    candidate.masterKey = candidate.master_key;
  }

  const parsed = sqliteConfigSchema.parse({ ...candidate, type: 'SQLiteStorageProvider' });

  const isEncrypted = coerceBoolean(parsed.isEncrypted, 'isEncrypted');
  const isCached = coerceBoolean(parsed.isCached, 'isCached');
  const autoRecover = coerceBoolean(parsed.autoRecover, 'autoRecover');

  const masterKeyValue = parsed.masterKey;
  const normalizedMasterKey = masterKeyValue === null || masterKeyValue === ''
    ? null
    : SecretSource.normalize(masterKeyValue as SecretSourceType);

  if (isEncrypted && !normalizedMasterKey) {
    throw new Error('masterKey is required when isEncrypted is true');
  }

  return {
    type: 'SQLiteStorageProvider',
    dbDirectory: parsed.dbDirectory,
    isEncrypted,
    isCached,
    autoRecover,
    masterKey: normalizedMasterKey,
  };
}

export class SQLiteStorageProviderFactory extends StorageProviderFactory<SQLiteStorageProviderConfig> {
  public readonly type = 'SQLiteStorageProvider';

  public async create(
    config?: SQLiteStorageProviderConfig | Record<string, unknown> | null
  ): Promise<SQLiteStorageProvider> {
    const normalized = normalizeSQLiteConfig(config);

    let masterKeyProvider: CredentialProvider | null = null;
    if (normalized.isEncrypted) {
      masterKeyProvider = await CredentialProviderFactory.createCredentialProvider(
        normalized.masterKey as CredentialProviderConfig
      );
    } else if (normalized.masterKey) {
      console.warn(
        'SQLiteStorageProvider masterKey provided but isEncrypted=false. The master key will be ignored.'
      );
    }

    return new SQLiteStorageProvider(
      normalized.dbDirectory,
      normalized.isEncrypted,
      masterKeyProvider,
      normalized.isCached,
      normalized.autoRecover
    );
  }
}

registerStorageProviderFactory('SQLiteStorageProvider', SQLiteStorageProviderFactory);
