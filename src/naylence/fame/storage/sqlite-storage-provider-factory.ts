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
  isEncrypted?: boolean;
  isCached?: boolean;
  autoRecover?: boolean;
  masterKey?: SecretSourceType | CredentialProviderConfig | Record<string, unknown> | null;
}

interface NormalizedSQLiteConfig {
  type: 'SQLiteStorageProvider';
  dbDirectory: string;
  isEncrypted: boolean;
  isCached: boolean;
  autoRecover: boolean;
  masterKey?: CredentialProviderConfig | Record<string, unknown> | null;
}

function normalizeSQLiteConfig(
  config?: SQLiteStorageProviderConfig | Record<string, unknown> | null
): NormalizedSQLiteConfig {
  if (!config) {
    return {
      type: 'SQLiteStorageProvider',
      dbDirectory: './data/sqlite',
      isEncrypted: false,
      isCached: true,
      autoRecover: true,
      masterKey: null,
    };
  }

  const record = config as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : 'SQLiteStorageProvider';
  if (type !== 'SQLiteStorageProvider') {
    throw new Error(`Unexpected storage provider type: ${type}`);
  }

  const dbDirectory = typeof record.dbDirectory === 'string'
    ? record.dbDirectory
    : typeof record.db_directory === 'string'
      ? (record.db_directory as string)
      : './data/sqlite';

  const isEncrypted = Boolean(
    record.isEncrypted ?? record.is_encrypted ?? false
  );

  const isCached = record.isCached ?? record.is_cached;
  const autoRecover = record.autoRecover ?? record.auto_recover;

  const normalized: NormalizedSQLiteConfig = {
    type: 'SQLiteStorageProvider',
    dbDirectory,
    isEncrypted,
    isCached: typeof isCached === 'boolean' ? isCached : true,
    autoRecover: typeof autoRecover === 'boolean' ? autoRecover : true,
    masterKey: null,
  };

  const masterKey = record.masterKey ?? record.master_key;
  if (masterKey !== undefined && masterKey !== null) {
    normalized.masterKey = SecretSource.normalize(masterKey as SecretSourceType);
  }

  return normalized;
}

export class SQLiteStorageProviderFactory extends StorageProviderFactory<SQLiteStorageProviderConfig> {
  public readonly type = 'SQLiteStorageProvider';

  public async create(
    config?: SQLiteStorageProviderConfig | Record<string, unknown> | null
  ): Promise<SQLiteStorageProvider> {
    const normalized = normalizeSQLiteConfig(config);

    let masterKeyProvider: CredentialProvider | null = null;
    if (normalized.isEncrypted) {
      if (!normalized.masterKey) {
        throw new Error('masterKey is required when isEncrypted is true');
      }

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
