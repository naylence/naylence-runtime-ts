import type { KeyValueStore } from "./key-value-store.js";

const DEFAULT_DB_NAME = "naylence";
const DEFAULT_DB_VERSION = 1;

type IDBFactoryLike = Pick<IDBFactory, "open">;

export interface IndexedDBKeyValueStoreOptions {
  dbName?: string;
  storeName: string;
  version?: number;
  idbFactory?: IDBFactoryLike;
}

function ensureIndexedDB(factory?: IDBFactoryLike): IDBFactoryLike {
  if (factory) {
    return factory;
  }

  if (typeof indexedDB === "undefined") {
    throw new Error("IndexedDBKeyValueStore requires a browser environment with IndexedDB support");
  }

  return indexedDB;
}

function toError(error: unknown, fallback: string): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(fallback);
}

function requestToPromise<T>(request: IDBRequest<T>, description: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(toError(request.error, description));
  });
}

export class IndexedDBKeyValueStore<V> implements KeyValueStore<V> {
  private readonly dbName: string;
  private readonly storeName: string;
  private readonly version: number;
  private readonly factory: IDBFactoryLike;
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(options: IndexedDBKeyValueStoreOptions) {
    if (!options?.storeName) {
      throw new Error("storeName is required");
    }

    this.dbName = options.dbName ?? DEFAULT_DB_NAME;
    this.storeName = options.storeName;
    this.version = options.version ?? DEFAULT_DB_VERSION;
    this.factory = ensureIndexedDB(options.idbFactory);
  }

  async set(key: string, value: V): Promise<void> {
    await this.withStore("readwrite", async (store) => {
      await requestToPromise(store.put(value, key), "Failed to set value in IndexedDB");
    });
  }

  async update(key: string, value: V): Promise<void> {
    await this.withStore("readwrite", async (store) => {
      const existing = await requestToPromise(
        store.get(key),
        "Failed to read value from IndexedDB"
      );
      if (existing === undefined) {
        throw new Error(`Key '${key}' does not exist`);
      }
      await requestToPromise(store.put(value, key), "Failed to update value in IndexedDB");
    });
  }

  async get(key: string): Promise<V | undefined> {
    return this.withStore("readonly", (store) =>
      requestToPromise(store.get(key), "Failed to read value from IndexedDB")
    );
  }

  async delete(key: string): Promise<void> {
    await this.withStore("readwrite", async (store) => {
      await requestToPromise(store.delete(key), "Failed to delete value from IndexedDB");
    });
  }

  async list(): Promise<Record<string, V>> {
    return this.withStore(
      "readonly",
      (store) =>
        new Promise<Record<string, V>>((resolve, reject) => {
          const result: Record<string, V> = {};
          const request = store.openCursor();

          request.onerror = () =>
            reject(toError(request.error, "Failed to iterate IndexedDB store"));
          request.onsuccess = (event) => {
            const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
            if (!cursor) {
              resolve(result);
              return;
            }

            const key = cursor.key;
            if (typeof key === "string") {
              result[key] = cursor.value as V;
            }
            cursor.continue();
          };
        })
    );
  }

  private async withStore<T>(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => Promise<T> | T
  ): Promise<T> {
    const db = await this.ensureDatabase();

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const transaction = db.transaction(this.storeName, mode);
      const store = transaction.objectStore(this.storeName);

      const finalize = (value: T) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };

      transaction.onabort = () => {
        if (!settled) {
          settled = true;
          reject(toError(transaction.error, "IndexedDB transaction was aborted"));
        }
      };

      transaction.onerror = () => {
        if (!settled) {
          settled = true;
          reject(toError(transaction.error, "IndexedDB transaction failed"));
        }
      };

      transaction.oncomplete = () => {
        if (!settled) {
          settled = true;
          resolve(undefined as unknown as T);
        }
      };

      try {
        Promise.resolve(fn(store))
          .then((result) => {
            if (mode === "readonly") {
              finalize(result);
            } else {
              transaction.oncomplete = () => finalize(result);
            }
          })
          .catch((error) => {
            transaction.abort();
            reject(toError(error, "IndexedDB operation failed"));
          });
      } catch (error) {
        transaction.abort();
        reject(toError(error, "IndexedDB operation failed"));
      }
    });
  }

  private async ensureDatabase(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = this.openDatabase();
    }

    const db = await this.dbPromise;
    if (db.objectStoreNames.contains(this.storeName)) {
      return db;
    }

    db.close();
    this.dbPromise = this.upgradeDatabase(db.version + 1);
    return this.dbPromise;
  }

  private openDatabase(): Promise<IDBDatabase> {
    return this.createDatabase(this.version, true);
  }

  private upgradeDatabase(version: number): Promise<IDBDatabase> {
    return this.createDatabase(version, false);
  }

  private createDatabase(version: number, allowFallback: boolean): Promise<IDBDatabase> {
    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.factory.open(this.dbName, version);

      let resolved = false;

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName);
        }
      };

      request.onerror = () => {
        if (!resolved) {
          resolved = true;
          reject(toError(request.error, "Failed to open IndexedDB"));
        }
      };

      request.onsuccess = () => {
        if (!resolved) {
          resolved = true;
          const db = request.result;
          if (!db.objectStoreNames.contains(this.storeName) && allowFallback) {
            db.close();
            this.createDatabase(version + 1, false)
              .then(resolve)
              .catch(reject);
            return;
          }
          resolve(db);
        }
      };
    });
  }
}
