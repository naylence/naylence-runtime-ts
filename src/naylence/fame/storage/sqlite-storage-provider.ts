import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';

import type { KeyValueStore } from './key-value-store.js';
import { EncryptedStorageProviderBase } from './encrypted-storage-provider-base.js';
import type { CredentialProvider } from '../security/credential/credential-provider.js';
import { camelToSnakeCase } from '../util/util.js';
import { getLogger } from '../util/logging.js';

type BetterSqlite3Constructor = typeof import('better-sqlite3');
type BetterSqlite3Database = import('better-sqlite3').Database;

const logger = getLogger('sqlite-storage-provider');

let cachedSqliteCtor: BetterSqlite3Constructor | null | undefined;

async function loadSqliteConstructor(): Promise<BetterSqlite3Constructor> {
  if (cachedSqliteCtor !== undefined) {
    if (cachedSqliteCtor === null) {
      throw new Error(
        'better-sqlite3 is not available. Install it to use SQLiteStorageProvider.'
      );
    }
    return cachedSqliteCtor;
  }

  if (typeof process === 'undefined' || !process.versions?.node) {
    cachedSqliteCtor = null;
    throw new Error('SQLiteStorageProvider is only supported in Node.js environments');
  }

  try {
    const imported = await import('better-sqlite3');
    const candidate = (imported as { default?: unknown }).default ?? imported;
    if (typeof candidate !== 'function') {
      throw new Error('Unexpected better-sqlite3 module format');
    }

    cachedSqliteCtor = candidate as BetterSqlite3Constructor;
    return cachedSqliteCtor;
  } catch (error) {
    cachedSqliteCtor = null;
    logger.error('failed-to-load-better-sqlite3', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error('Failed to load better-sqlite3. Install it to enable SQLite storage support.');
  }
}

class AsyncLock {
  private tail: Promise<void> = Promise.resolve();

  public async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    let release: (() => void) | undefined;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });

    const previous = this.tail;
    this.tail = previous.then(() => next, () => next);

    await previous;

    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}

interface SQLiteKeyValueStoreOptions<V> {
  dbPath: string;
  tableName: string;
  modelCtor: new (...args: any[]) => V;
  autoRecover?: boolean;
}

function formatTimestampSuffix(date: Date): string {
  const year = date.getUTCFullYear().toString().padStart(4, '0');
  const month = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = date.getUTCDate().toString().padStart(2, '0');
  const hours = date.getUTCHours().toString().padStart(2, '0');
  const minutes = date.getUTCMinutes().toString().padStart(2, '0');
  const seconds = date.getUTCSeconds().toString().padStart(2, '0');
  return `${year}${month}${day}T${hours}${minutes}${seconds}Z`;
}

export class SQLiteKeyValueStore<V> implements KeyValueStore<V> {
  private readonly dbPath: string;
  private readonly tableName: string;
  private readonly modelCtor: new (...args: any[]) => V;
  private readonly autoRecover: boolean;
  private readonly lock = new AsyncLock();
  private db: BetterSqlite3Database | null = null;

  constructor(options: SQLiteKeyValueStoreOptions<V>) {
    this.dbPath = options.dbPath;
    this.tableName = options.tableName;
    this.modelCtor = options.modelCtor;
    this.autoRecover = options.autoRecover ?? true;
  }

  private async getDatabase(): Promise<BetterSqlite3Database> {
    if (this.db) {
      return this.db;
    }

    try {
      return await this.openDatabase();
    } catch (error) {
      if (this.autoRecover && this.isCorruptionError(error)) {
  logger.warning('detected-corrupted-db', { path: this.dbPath });
        await this.recoverCorruptedDb();
        if (!this.db) {
          throw new Error('Failed to recover SQLite database');
        }
        return this.db;
      }
      throw error;
    }
  }

  private async openDatabase(): Promise<BetterSqlite3Database> {
    const DatabaseCtor = await loadSqliteConstructor();
    await fsPromises.mkdir(path.dirname(this.dbPath), { recursive: true });

    const db = new DatabaseCtor(this.dbPath, { timeout: 30_000 }) as BetterSqlite3Database;
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      db.pragma('foreign_keys = ON');
      this.createSchema(db);
      this.db = db;
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private createSchema(db: BetterSqlite3Database): void {
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${this.tableName} (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );`
    );

    db.exec(
      `CREATE TRIGGER IF NOT EXISTS update_${this.tableName}_timestamp
       AFTER UPDATE ON ${this.tableName}
       BEGIN
         UPDATE ${this.tableName} SET updated_at = CURRENT_TIMESTAMP WHERE key = NEW.key;
       END;`
    );
  }

  private isCorruptionError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const message = error.message.toLowerCase();
    return (
      message.includes('database disk image is malformed') ||
      message.includes('file is not a database') ||
      message.includes('file is encrypted or is not a database')
    );
  }

  private async recoverCorruptedDb(): Promise<void> {
    await this.closeDatabase();
    await this.quarantineCorruptedFiles();
    await this.openDatabase();
  logger.warning('quarantined-corrupted-db', { path: this.dbPath });
  }

  private async closeDatabase(): Promise<void> {
    if (this.db) {
      try {
        this.db.close();
      } catch (error) {
        logger.warning('failed-to-close-sqlite-db', {
          path: this.dbPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.db = null;
  }

  private async quarantineCorruptedFiles(): Promise<void> {
    const timestamp = formatTimestampSuffix(new Date());
    const basePath = this.dbPath;
    const candidates = [basePath, `${basePath}-wal`, `${basePath}-shm`];

    await Promise.all(
      candidates.map(async (candidate) => {
        if (!fs.existsSync(candidate)) {
          return;
        }

        const dirname = path.dirname(candidate);
        const basename = path.basename(candidate);
        const quarantinedName = path.join(dirname, `${basename}.corrupt.${timestamp}`);

        try {
          await fsPromises.rename(candidate, quarantinedName);
        } catch (error) {
          logger.error('failed-to-quarantine-sqlite-file', {
            file: candidate,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })
    );
  }

  private async executeWithRecovery<T>(
    operation: (db: BetterSqlite3Database) => Promise<T> | T
  ): Promise<T> {
    const db = await this.getDatabase();

    try {
      return await operation(db);
    } catch (error) {
      if (this.autoRecover && this.isCorruptionError(error)) {
        await this.recoverCorruptedDb();
        const retryDb = await this.getDatabase();
        return await operation(retryDb);
      }

      throw error;
    }
  }

  private serialize(value: V): string {
    const candidate = value as unknown as { toJSON?: () => unknown };
    if (candidate && typeof candidate.toJSON === 'function') {
      return JSON.stringify(candidate.toJSON());
    }

    return JSON.stringify(value);
  }

  private deserialize(json: string): V {
    const data = JSON.parse(json);

    const ctorAsAny = this.modelCtor as unknown as {
      fromJSON?: (input: unknown) => V;
      fromJson?: (input: unknown) => V;
      deserialize?: (input: unknown) => V;
    };

    if (typeof ctorAsAny.fromJSON === 'function') {
      return ctorAsAny.fromJSON(data);
    }
    if (typeof ctorAsAny.fromJson === 'function') {
      return ctorAsAny.fromJson(data);
    }
    if (typeof ctorAsAny.deserialize === 'function') {
      return ctorAsAny.deserialize(data);
    }

    try {
      return new this.modelCtor(data);
    } catch {
      return Object.assign(Object.create(this.modelCtor.prototype), data);
    }
  }

  public async set(key: string, value: V): Promise<void> {
    const serialized = this.serialize(value);

    await this.lock.runExclusive(async () => {
      await this.executeWithRecovery(async (db) => {
        db.prepare(
          `INSERT OR REPLACE INTO ${this.tableName} (key, value) VALUES (?, ?)`
        ).run(key, serialized);
      });
    });
  }

  public async update(key: string, value: V): Promise<void> {
    const serialized = this.serialize(value);

    await this.lock.runExclusive(async () => {
      await this.executeWithRecovery(async (db) => {
        const result = db
          .prepare(`UPDATE ${this.tableName} SET value = ? WHERE key = ?`)
          .run(serialized, key);

        if (!result || (typeof result.changes === 'number' && result.changes === 0)) {
          throw new Error(`Key '${key}' not found for update.`);
        }
      });
    });
  }

  public async get(key: string): Promise<V | undefined> {
    return this.lock.runExclusive(async () => {
      return this.executeWithRecovery(async (db) => {
        const row = db
          .prepare(`SELECT value FROM ${this.tableName} WHERE key = ?`)
          .get(key) as { value: string } | undefined;

        if (!row) {
          return undefined;
        }

        return this.deserialize(row.value);
      });
    });
  }

  public async delete(key: string): Promise<void> {
    await this.lock.runExclusive(async () => {
      await this.executeWithRecovery(async (db) => {
        db.prepare(`DELETE FROM ${this.tableName} WHERE key = ?`).run(key);
      });
    });
  }

  public async list(): Promise<Record<string, V>> {
    return this.lock.runExclusive(async () => {
      return this.executeWithRecovery(async (db) => {
        const rows = db.prepare(`SELECT key, value FROM ${this.tableName}`).all() as Array<{
          key: string;
          value: string;
        }>;

        const result: Record<string, V> = {};
        for (const row of rows) {
          try {
            result[row.key] = this.deserialize(row.value);
          } catch (error) {
            logger.warning('skipping-corrupted-sqlite-entry', {
              key: row.key,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        return result;
      });
    });
  }
}

export class SQLiteStorageProvider extends EncryptedStorageProviderBase {
  private readonly dbDirectory: string;
  private readonly autoRecover: boolean;
  private readonly stores = new Map<string, SQLiteKeyValueStore<any>>();

  constructor(
    dbDirectory: string,
    isEncrypted = false,
    masterKeyProvider: CredentialProvider | null = null,
    isCached = false,
    autoRecover = true
  ) {
    super({
      isEncrypted,
      masterKeyProvider: masterKeyProvider ?? null,
      enableCaching: isCached,
    });

    this.dbDirectory = dbDirectory;
    this.autoRecover = autoRecover;
  }

  private sanitizeNamespace(namespace: string): string {
    const cleaned = namespace.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+|[._-]+$/g, '');
    if (!cleaned) {
      return 'ns';
    }
    return cleaned.slice(0, 120);
  }

  protected async getUnderlyingKeyValueStore<T>(
    modelCtor: new (...args: any[]) => T,
    namespace: string
  ): Promise<KeyValueStore<T>> {
    const safeNamespace = this.sanitizeNamespace(namespace);
    const cacheKey = `${safeNamespace}:${modelCtor.name}`;

    const existing = this.stores.get(cacheKey);
    if (existing) {
      return existing;
    }

    const dbPath = path.join(this.dbDirectory, `${safeNamespace}.db`);
    const tableName = `kv_${camelToSnakeCase(modelCtor.name)}`;

    const store = new SQLiteKeyValueStore<T>({
      dbPath,
      tableName,
      modelCtor,
      autoRecover: this.autoRecover,
    });

    this.stores.set(cacheKey, store as SQLiteKeyValueStore<any>);
    return store;
  }
}
