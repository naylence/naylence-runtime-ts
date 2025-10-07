import type { KeyValueStore } from './key-value-store.js';
import { EncryptedStorageProviderBase } from './encrypted-storage-provider-base.js';
import type { CredentialProvider } from '../security/credential/credential-provider.js';
import { IndexedDBKeyValueStore } from './indexeddb-key-value-store.js';

const DEFAULT_DB_NAME = 'naylence';
const DEFAULT_NAMESPACE_PREFIX = 'kv';

export type IndexedDBStorageProviderMode = 'dx' | 'hardened';

export interface IndexedDBStorageProviderOptions {
  mode?: IndexedDBStorageProviderMode;
  dbName?: string;
  version?: number;
  namespacePrefix?: string;
  idbFactory?: { open(name: string, version?: number): IDBOpenDBRequest };
  enableCaching?: boolean;
  masterKeyProvider?: CredentialProvider | null;
  isEncrypted?: boolean;
}

function sanitizeSegment(segment: string, fallback: string): string {
  const trimmed = segment.trim();
  const replaced = trimmed.replace(/[^A-Za-z0-9._-]+/g, '_');
  const cleaned = replaced.replace(/^[._-]+|[._-]+$/g, '');
  if (!cleaned) {
    return fallback;
  }
  return cleaned.slice(0, 120);
}

function buildStoreName(
  prefix: string,
  namespace: string,
  modelName: string
): string {
  const safePrefix = sanitizeSegment(prefix, DEFAULT_NAMESPACE_PREFIX);
  const safeNamespace = sanitizeSegment(namespace, 'namespace');
  const safeModel = sanitizeSegment(modelName || 'model', 'model');
  return `${safePrefix}:${safeNamespace}:${safeModel}`;
}

export class IndexedDBStorageProvider extends EncryptedStorageProviderBase {
  static readonly supportedModes: ReadonlySet<IndexedDBStorageProviderMode> =
    new Set(['dx', 'hardened']);

  readonly mode: IndexedDBStorageProviderMode;
  private readonly dbName: string;
  private readonly version: number;
  private readonly namespacePrefix: string;
  private readonly idbFactory:
    | { open(name: string, version?: number): IDBOpenDBRequest }
    | undefined;
  private readonly stores = new Map<string, KeyValueStore<any>>();

  constructor(options: IndexedDBStorageProviderOptions = {}) {
    const mode = options.mode ?? 'dx';
    if (!IndexedDBStorageProvider.supportedModes.has(mode)) {
      throw new Error(
        `Unsupported IndexedDB storage provider mode: ${mode}. Supported modes: ${Array.from(
          IndexedDBStorageProvider.supportedModes
        ).join(', ')}`
      );
    }

    const enableCaching = options.enableCaching ?? mode === 'dx';
    const isEncrypted = options.isEncrypted ?? true;
    const masterKeyProvider = options.masterKeyProvider ?? null;

    if (mode === 'hardened' && !masterKeyProvider) {
      throw new Error(
        'IndexedDBStorageProvider in hardened mode requires an explicit masterKeyProvider'
      );
    }

    super({
      isEncrypted,
      masterKeyProvider,
      enableCaching,
    });

    this.mode = mode;
    this.dbName = options.dbName ?? DEFAULT_DB_NAME;
    this.version = options.version ?? 1;
    this.namespacePrefix = options.namespacePrefix ?? DEFAULT_NAMESPACE_PREFIX;
    this.idbFactory = options.idbFactory ?? undefined;
  }

  get isBrowserOnly(): boolean {
    return true;
  }

  protected async getUnderlyingKeyValueStore<T>(
    modelCtor: new (...args: any[]) => T,
    namespace: string
  ): Promise<KeyValueStore<T>> {
    const modelName = modelCtor?.name ?? 'model';
    const storeKey = `${namespace}:${modelName}`;
    const existing = this.stores.get(storeKey) as KeyValueStore<T> | undefined;
    if (existing) {
      return existing;
    }

    const storeName = buildStoreName(
      this.namespacePrefix,
      namespace,
      modelName
    );
    const store = new IndexedDBKeyValueStore<T>({
      dbName: this.dbName,
      version: this.version,
      storeName,
      ...(this.idbFactory ? { idbFactory: this.idbFactory } : {}),
    });

    this.stores.set(storeKey, store as KeyValueStore<any>);
    return store;
  }
}
