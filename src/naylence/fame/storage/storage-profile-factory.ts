import { z } from 'zod';
import { createResource, Expressions, type CreateResourceOptions } from 'naylence-factory';

import type { StorageProvider } from './storage-provider.js';
import {
  type StorageProviderConfig,
  StorageProviderFactory,
  registerStorageProviderFactory,
  STORAGE_PROVIDER_FACTORY_BASE_TYPE,
} from './storage-provider-factory.js';

const ENV_VAR_STORAGE_DB_DIRECTORY = 'FAME_STORAGE_DB_DIRECTORY';
const ENV_VAR_STORAGE_MASTER_KEY = 'FAME_STORAGE_MASTER_KEY';
const ENV_VAR_STORAGE_ENCRYPTED = 'FAME_STORAGE_ENCRYPTED';

const PROFILE_NAME_MEMORY = 'memory';
const PROFILE_NAME_SQLITE = 'sqlite';
const PROFILE_NAME_ENCRYPTED_SQLITE = 'encrypted-sqlite';

const storageProfileSchema = z
  .object({
    type: z.literal('StorageProfile').default('StorageProfile'),
    profile: z
      .string()
      .optional()
      .describe('Storage profile name (memory | sqlite | encrypted-sqlite)'),
  })
  .passthrough();

const MEMORY_PROFILE_CONFIG = {
  type: 'InMemoryStorageProvider',
} as const;

const SQLITE_PROFILE_CONFIG = {
  type: 'SQLiteStorageProvider',
  dbDirectory: Expressions.env(ENV_VAR_STORAGE_DB_DIRECTORY, './data/sqlite'),
  isEncrypted: Expressions.env(ENV_VAR_STORAGE_ENCRYPTED, 'false'),
  masterKey: Expressions.env(ENV_VAR_STORAGE_MASTER_KEY, ''),
  isCached: true,
} as const;

const ENCRYPTED_SQLITE_PROFILE_CONFIG = {
  type: 'SQLiteStorageProvider',
  dbDirectory: Expressions.env(ENV_VAR_STORAGE_DB_DIRECTORY, './data/sqlite'),
  isEncrypted: 'true',
  masterKey: Expressions.env(ENV_VAR_STORAGE_MASTER_KEY),
  isCached: true,
} as const;

const PROFILE_MAP: Record<string, Record<string, unknown>> = {
  [PROFILE_NAME_MEMORY]: MEMORY_PROFILE_CONFIG,
  [PROFILE_NAME_SQLITE]: SQLITE_PROFILE_CONFIG,
  [PROFILE_NAME_ENCRYPTED_SQLITE]: ENCRYPTED_SQLITE_PROFILE_CONFIG,
};

export interface StorageProfileConfig extends StorageProviderConfig {
  type: 'StorageProfile';
  profile?: string;
}

export class StorageProfileFactory extends StorageProviderFactory<StorageProfileConfig> {
  public readonly type = 'StorageProfile';

  public async create(
    config?: StorageProfileConfig | Record<string, unknown> | null,
    options?: CreateResourceOptions
  ): Promise<StorageProvider> {
    const candidate = config ?? { type: 'StorageProfile' };
    const parsed = storageProfileSchema.parse({ ...(candidate as Record<string, unknown>), type: 'StorageProfile' });

    const profileName = (parsed.profile ?? PROFILE_NAME_MEMORY).toLowerCase();
    const profileConfig = PROFILE_MAP[profileName];
    if (!profileConfig) {
      throw new Error(
        `Unknown storage profile '${profileName}'. Supported profiles: ${Object.keys(PROFILE_MAP).join(', ')}`
      );
    }

    const createOptions: CreateResourceOptions = {
      ...options,
      validate: options?.validate ?? true,
    };

    const provider = await createResource<StorageProvider>(
      STORAGE_PROVIDER_FACTORY_BASE_TYPE,
      profileConfig,
      createOptions
    );

    if (!provider) {
      throw new Error(`Failed to create storage provider for profile '${profileName}'`);
    }

    return provider;
  }
}

registerStorageProviderFactory('StorageProfile', StorageProfileFactory);
