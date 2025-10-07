import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

type SqliteModule = typeof import('../sqlite-storage-provider.js');

type LoggerMock = {
  warning: jest.Mock;
  error: jest.Mock;
  info: jest.Mock;
  debug: jest.Mock;
};

type RunCallback = (sql: string, args: unknown[]) => void;

type ControlOptions = {
  execErrors: Error[];
  runErrors: Error[];
  closeErrors: Error[];
  getErrors: Error[];
  allErrors: Error[];
  runCallbacks: RunCallback[];
};

class MockDatabase {
  public readonly tables = new Map<string, Map<string, string>>();
  public readonly pragma = jest.fn();
  public readonly exec = jest.fn((sql: string) => {
    const next = this.control.execErrors.shift();
    if (next) {
      throw next;
    }
    this.control.execSql.push(sql);
  });
  public readonly prepare = jest.fn(
    (sql: string) => new MockStatement(this, sql, this.control)
  );
  public readonly close = jest.fn(() => {
    this.control.closeCalls.push(this.filePath);
    const next = this.control.closeErrors.shift();
    if (next) {
      throw next;
    }
  });

  constructor(
    public readonly filePath: string,
    _options: { timeout?: number },
    private readonly control: SqliteMockControl
  ) {
    control.instances.push(this);
  }

  public setValue(table: string, key: string, value: string): void {
    this.getTable(table).set(key, value);
  }

  public getValue(table: string, key: string): string | undefined {
    return this.getTable(table).get(key);
  }

  public deleteValue(table: string, key: string): boolean {
    const tableMap = this.getTable(table);
    const existed = tableMap.delete(key);
    return existed;
  }

  public getEntries(table: string): Array<[string, string]> {
    return [...this.getTable(table).entries()];
  }

  private getTable(table: string): Map<string, string> {
    let map = this.tables.get(table);
    if (!map) {
      map = new Map<string, string>();
      this.tables.set(table, map);
    }
    return map;
  }
}

class MockStatement {
  public readonly run = jest.fn((...args: unknown[]) => {
    const callback = this.control.runCallbacks.shift();
    if (callback) {
      callback(this.sql, args);
    }

    const nextRunError = this.control.runErrors.shift();
    if (nextRunError) {
      throw nextRunError;
    }

    if (/INSERT OR REPLACE INTO/i.test(this.sql)) {
      const [key, value] = args as [string, string];
      this.db.setValue(this.table, key, value);
      return { changes: 1 };
    }

    if (/UPDATE/i.test(this.sql)) {
      const [value, key] = args as [string, string];
      const current = this.db.getValue(this.table, key);
      if (current === undefined) {
        return { changes: 0 };
      }
      this.db.setValue(this.table, key, value);
      return { changes: 1 };
    }

    if (/DELETE FROM/i.test(this.sql)) {
      const [key] = args as [string];
      this.db.deleteValue(this.table, key);
      return { changes: 1 };
    }

    return { changes: 0 };
  });

  public readonly get = jest.fn((key: string) => {
    const next = this.control.getErrors.shift();
    if (next) {
      throw next;
    }
    const value = this.db.getValue(this.table, key);
    if (value === undefined) {
      return undefined;
    }
    return { value };
  });

  public readonly all = jest.fn(() => {
    const next = this.control.allErrors.shift();
    if (next) {
      throw next;
    }
    return this.db
      .getEntries(this.table)
      .map(([key, value]) => ({ key, value }));
  });

  constructor(
    private readonly db: MockDatabase,
    private readonly sql: string,
    private readonly control: SqliteMockControl
  ) {}

  private get table(): string {
    const match = this.sql.match(/(?:INTO|UPDATE|FROM)\s+([A-Za-z0-9_]+)/i);
    if (!match) {
      throw new Error(`Unsupported SQL for mock: ${this.sql}`);
    }
    return match[1];
  }
}

type SqliteMockControl = ControlOptions & {
  DatabaseCtor: jest.MockedClass<typeof MockDatabase>;
  instances: MockDatabase[];
  execSql: string[];
  closeCalls: string[];
};

const createSqliteMockControl = (): SqliteMockControl => {
  const control: SqliteMockControl = {
    execErrors: [],
    runErrors: [],
    closeErrors: [],
    getErrors: [],
    allErrors: [],
    runCallbacks: [],
    execSql: [],
    closeCalls: [],
    instances: [],
    DatabaseCtor: jest.fn(
      (filePath: string, options: { timeout?: number }) =>
        new MockDatabase(filePath, options, control)
    ) as unknown as jest.MockedClass<typeof MockDatabase>,
  };

  return control;
};

const getLastDatabaseInstance = (control: SqliteMockControl): MockDatabase => {
  const results = control.DatabaseCtor.mock.results;
  const lastResult = results[results.length - 1];
  if (!lastResult || lastResult.type !== 'return') {
    throw new Error('expected mock database instance');
  }

  return lastResult.value as MockDatabase;
};

type SetupOptions = {
  moduleBehavior?: 'valid' | 'invalid-format';
  configureControl?: (control: SqliteMockControl) => void;
};

const setupModule = async (
  options?: SetupOptions
): Promise<{
  module: SqliteModule;
  control: SqliteMockControl;
  logger: LoggerMock;
}> => {
  const logger: LoggerMock = {
    warning: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  };

  const behavior = options?.moduleBehavior ?? 'valid';

  const control = createSqliteMockControl();
  options?.configureControl?.(control);

  jest.resetModules();

  jest.doMock('../../util/logging.js', () => ({
    getLogger: jest.fn(() => logger),
  }));

  jest.doMock('better-sqlite3', () => ({
    __esModule: true,
    default: behavior === 'invalid-format' ? {} : control.DatabaseCtor,
  }));

  const module = await import('../sqlite-storage-provider.js');

  return { module, control, logger };
};

describe('SQLite storage provider', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  it('throws helpful errors when better-sqlite3 is unavailable and caches failure', async () => {
    const { module, logger } = await setupModule({
      moduleBehavior: 'invalid-format',
    });
    const { SQLiteKeyValueStore } = module;

    class Model {
      public value!: string;
    }

    const store = new SQLiteKeyValueStore<Model>({
      dbPath: path.join(os.tmpdir(), 'missing-sqlite.db'),
      tableName: 'kv_missing',
      modelCtor: Model,
    });

    await expect(store.get('missing')).rejects.toThrow(
      'Failed to load better-sqlite3. Install it to enable SQLite storage support.'
    );

    await expect(store.get('missing')).rejects.toThrow(
      'better-sqlite3 is not available. Install it to use SQLiteStorageProvider.'
    );

    expect(logger.error).toHaveBeenCalledWith(
      'failed-to-load-better-sqlite3',
      expect.objectContaining({
        error: 'Unexpected better-sqlite3 module format',
      })
    );
  });

  it('throws when running outside of a Node.js environment', async () => {
    const { module } = await setupModule({});
    const { SQLiteKeyValueStore } = module;

    class Model {
      public value!: string;
    }

    const store = new SQLiteKeyValueStore<Model>({
      dbPath: path.join(os.tmpdir(), 'non-node.db'),
      tableName: 'kv_non_node',
      modelCtor: Model,
    });

    const originalProcess = globalThis.process;
    (globalThis as Record<string, unknown>).process = undefined;

    try {
      await expect(store.get('missing')).rejects.toThrow(
        'SQLiteStorageProvider is only supported in Node.js environments'
      );
    } finally {
      (globalThis as Record<string, unknown>).process = originalProcess;
    }
  });

  it('recovers from SQLite corruption by quarantining files and retrying operations', async () => {
    const tempDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), 'sqlite-provider-')
    );
    const dbPath = path.join(tempDir, 'store.db');

    await fsPromises.writeFile(dbPath, 'not a database');
    await fsPromises.writeFile(`${dbPath}-wal`, 'wal');
    await fsPromises.writeFile(`${dbPath}-shm`, 'shm');

    const { module, control, logger } = await setupModule({});

    control.execErrors.push(new Error('database disk image is malformed'));
    control.runCallbacks.push(() => {
      control.closeErrors.push(new Error('close failure'));
    });
    control.runErrors.push(new Error('file is encrypted or is not a database'));

    const { SQLiteKeyValueStore } = module;

    class Model {
      public value: string;

      public constructor(payload: { value: string }) {
        this.value = payload.value;
      }

      public toJSON(): { value: string } {
        return { value: this.value };
      }
    }

    const store = new SQLiteKeyValueStore<Model>({
      dbPath,
      tableName: 'kv_model',
      modelCtor: Model,
      autoRecover: true,
    });

    try {
      await store.set('alpha', new Model({ value: 'one' }));

      await expect(store.get('alpha')).resolves.toEqual(
        expect.objectContaining({ value: 'one' })
      );

      const files = await fsPromises.readdir(tempDir);
      const quarantined = files.filter((name) => name.includes('.corrupt.'));
      expect(quarantined).toHaveLength(3);

      expect(logger.warning).toHaveBeenCalledWith(
        'detected-corrupted-db',
        expect.objectContaining({ path: dbPath })
      );
      expect(logger.warning).toHaveBeenCalledWith(
        'quarantined-corrupted-db',
        expect.objectContaining({ path: dbPath })
      );
      expect(logger.warning).toHaveBeenCalledWith(
        'failed-to-close-sqlite-db',
        expect.objectContaining({ path: dbPath, error: 'close failure' })
      );

      expect(control.DatabaseCtor).toHaveBeenCalledTimes(3);
    } finally {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('logs errors when quarantine rename fails', async () => {
    const tempDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), 'sqlite-provider-rename-')
    );
    const dbPath = path.join(tempDir, 'store.db');
    await fsPromises.writeFile(dbPath, 'not a database');
    await fsPromises.writeFile(`${dbPath}-wal`, 'wal');
    await fsPromises.writeFile(`${dbPath}-shm`, 'shm');

    const realRename = fsPromises.rename;
    const renameErrors = [new Error('permission denied')];
    const renameSpy = jest
      .spyOn(fsPromises, 'rename')
      .mockImplementation(
        async (...args: Parameters<typeof fsPromises.rename>) => {
          const next = renameErrors.shift();
          if (next) {
            throw next;
          }
          return realRename(...args);
        }
      );

    const { module, control, logger } = await setupModule({});

    control.execErrors.push(new Error('database disk image is malformed'));

    const { SQLiteKeyValueStore } = module;

    class RenameModel {
      public constructor(public value: string) {}
    }

    const store = new SQLiteKeyValueStore<RenameModel>({
      dbPath,
      tableName: 'kv_rename_model',
      modelCtor: RenameModel,
    });

    try {
      await store.set('alpha', new RenameModel('one'));

      expect(renameSpy).toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        'failed-to-quarantine-sqlite-file',
        expect.objectContaining({
          file: dbPath,
          error: 'permission denied',
        })
      );
    } finally {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('skips corrupted rows during list and enforces update preconditions', async () => {
    const { module, control, logger } = await setupModule({});

    const { SQLiteKeyValueStore } = module;

    class BasicModel {
      public message: string;

      public constructor(payload: { message: string }) {
        this.message = payload.message;
      }
    }

    const store = new SQLiteKeyValueStore<BasicModel>({
      dbPath: path.join(os.tmpdir(), `basic-${Date.now()}.db`),
      tableName: 'kv_basic_model',
      modelCtor: BasicModel,
    });

    await store.set('good', new BasicModel({ message: 'hello' }));

    const activeDb = getLastDatabaseInstance(control);
    activeDb.setValue('kv_basic_model', 'corrupt', 'not json');

    const listed = await store.list();
    expect(Object.keys(listed)).toEqual(['good']);
    expect(listed.good.message).toBe('hello');

    await expect(store.get('missing')).resolves.toBeUndefined();

    expect(logger.warning).toHaveBeenCalledWith(
      'skipping-corrupted-sqlite-entry',
      expect.objectContaining({ key: 'corrupt' })
    );

    await expect(
      store.update('missing', new BasicModel({ message: 'noop' }))
    ).rejects.toThrow("Key 'missing' not found for update.");

    await store.delete('good');
    await expect(store.get('good')).resolves.toBeUndefined();
  });

  it('deserializes values using all supported strategies', async () => {
    const { module, control } = await setupModule({});

    const { SQLiteKeyValueStore } = module;

    class FromJSONModel {
      public constructor(public value: string) {}

      public toJSON(): { value: string } {
        return { value: this.value };
      }

      public static fromJSON(input: { value: string }): FromJSONModel {
        return new FromJSONModel(`${input.value}-parsed`);
      }
    }

    const fromJSONStore = new SQLiteKeyValueStore<FromJSONModel>({
      dbPath: path.join(os.tmpdir(), `fromjson-${Date.now()}.db`),
      tableName: 'kv_from_json',
      modelCtor: FromJSONModel,
    });

    await fromJSONStore.set('key', new FromJSONModel('alpha'));
    const fromJSONValue = await fromJSONStore.get('key');
    expect(fromJSONValue?.value).toBe('alpha-parsed');

    const fromJSONDb = getLastDatabaseInstance(control);
    expect(fromJSONDb.getValue('kv_from_json', 'key')).toBe(
      JSON.stringify({ value: 'alpha' })
    );

    class FromJsonModel {
      public constructor(public value: string) {}

      public static fromJson(input: { value: string }): FromJsonModel {
        return new FromJsonModel(`${input.value}-camel`);
      }
    }

    const fromJsonStore = new SQLiteKeyValueStore<FromJsonModel>({
      dbPath: path.join(os.tmpdir(), `fromjson-alt-${Date.now()}.db`),
      tableName: 'kv_from_json_model',
      modelCtor: FromJsonModel,
    });

    await fromJsonStore.set('key', new FromJsonModel('beta'));
    const fromJsonValue = await fromJsonStore.get('key');
    expect(fromJsonValue?.value).toBe('beta-camel');

    class DeserializeModel {
      public constructor(public value: string) {}

      public static deserialize(input: { value: string }): DeserializeModel {
        return new DeserializeModel(`${input.value}-deserialized`);
      }
    }

    const deserializeStore = new SQLiteKeyValueStore<DeserializeModel>({
      dbPath: path.join(os.tmpdir(), `deserialize-${Date.now()}.db`),
      tableName: 'kv_deserialize',
      modelCtor: DeserializeModel,
    });

    await deserializeStore.set('key', new DeserializeModel('gamma'));
    const deserializeValue = await deserializeStore.get('key');
    expect(deserializeValue?.value).toBe('gamma-deserialized');

    class ConstructableModel {
      public name: string;

      public constructor(payload: { name: string }) {
        this.name = payload.name;
      }
    }

    const constructableStore = new SQLiteKeyValueStore<ConstructableModel>({
      dbPath: path.join(os.tmpdir(), `constructable-${Date.now()}.db`),
      tableName: 'kv_constructable',
      modelCtor: ConstructableModel,
    });

    await constructableStore.set(
      'key',
      new ConstructableModel({ name: 'delta' })
    );
    const constructableValue = await constructableStore.get('key');
    expect(constructableValue?.name).toBe('delta');

    class PrototypeOnly {
      public greeting!: string;

      public constructor() {
        throw new Error('constructor should not be invoked');
      }

      public salute(): string {
        return `hello ${this.greeting}`;
      }
    }

    const prototypeStore = new SQLiteKeyValueStore<PrototypeOnly>({
      dbPath: path.join(os.tmpdir(), `prototype-${Date.now()}.db`),
      tableName: 'kv_prototype_only',
      modelCtor: PrototypeOnly,
    });

    await prototypeStore.set('key', {
      greeting: 'world',
    } as unknown as PrototypeOnly);
    const prototypeValue = await prototypeStore.get('key');
    expect(prototypeValue?.greeting).toBe('world');
    expect(prototypeValue?.salute()).toBe('hello world');
  });

  it('sanitizes namespaces and caches stores on the storage provider', async () => {
    const tempDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), 'sqlite-provider-root-')
    );
    const { module } = await setupModule({});
    const { SQLiteStorageProvider } = module;

    class SampleModel {
      public value: string;

      public constructor(payload: { value: string }) {
        this.value = payload.value;
      }
    }

    class TestableProvider extends SQLiteStorageProvider {
      public async getStore<T>(
        modelCtor: new (...args: any[]) => T,
        namespace: string
      ) {
        return super.getUnderlyingKeyValueStore(modelCtor, namespace);
      }
    }

    const provider = new TestableProvider(tempDir, false, null, false, true);

    const invalidNamespaceStore = await provider.getStore(SampleModel, '!!!');

    const invalidPath = (invalidNamespaceStore as unknown as { dbPath: string })
      .dbPath;
    expect(path.basename(invalidPath)).toBe('ns.db');

    const repeatStore = await provider.getStore(SampleModel, '!!!');
    expect(repeatStore).toBe(invalidNamespaceStore);

    const longNamespace = 'a'.repeat(400);
    const longStore = await provider.getStore(SampleModel, longNamespace);
    const longPath = (longStore as unknown as { dbPath: string }).dbPath;
    const filename = path.basename(longPath, '.db');
    expect(filename.length).toBeLessThanOrEqual(120);

    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

  it('throws when recovery cannot restore the database handle', async () => {
    const tempDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), 'sqlite-recovery-failure-')
    );
    const dbPath = path.join(tempDir, 'failure.db');
    const { module, control, logger } = await setupModule({});
    const { SQLiteKeyValueStore } = module;

    class BrokenModel {
      public constructor(public value: string) {}
    }

    const store = new SQLiteKeyValueStore<BrokenModel>({
      dbPath,
      tableName: 'kv_broken_model',
      modelCtor: BrokenModel,
    });

    const originalOpen = (
      store as unknown as { openDatabase: () => Promise<unknown> }
    ).openDatabase.bind(store);
    let openAttempts = 0;
    (
      store as unknown as { openDatabase: () => Promise<unknown> }
    ).openDatabase = jest.fn(async () => {
      openAttempts += 1;
      const result = await originalOpen();
      if (openAttempts >= 2) {
        (store as unknown as { db: unknown }).db = null;
      }
      return result;
    });

    control.execErrors.push(new Error('database disk image is malformed'));

    await expect(store.set('broken', new BrokenModel('value'))).rejects.toThrow(
      'Failed to recover SQLite database'
    );

    expect(logger.warning).toHaveBeenCalledWith(
      'detected-corrupted-db',
      expect.objectContaining({ path: dbPath })
    );

    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

  it('propagates non-corruption errors without retrying', async () => {
    const { module, control } = await setupModule({});
    const { SQLiteKeyValueStore } = module;

    class PlainModel {
      public constructor(public value: string) {}
    }

    const store = new SQLiteKeyValueStore<PlainModel>({
      dbPath: path.join(os.tmpdir(), `non-corruption-${Date.now()}.db`),
      tableName: 'kv_plain_model',
      modelCtor: PlainModel,
    });

    control.runErrors.push(new Error('unexpected failure'));

    await expect(store.set('key', new PlainModel('value'))).rejects.toThrow(
      'unexpected failure'
    );
    expect(control.DatabaseCtor).toHaveBeenCalledTimes(1);
  });

  it('propagates non-error throwables without retrying', async () => {
    const { module, control, logger } = await setupModule({});
    const { SQLiteKeyValueStore } = module;

    class PrimitiveErrorModel {
      public constructor(public value: string) {}
    }

    const store = new SQLiteKeyValueStore<PrimitiveErrorModel>({
      dbPath: path.join(os.tmpdir(), `non-error-${Date.now()}.db`),
      tableName: 'kv_primitive_error_model',
      modelCtor: PrimitiveErrorModel,
    });

    control.runErrors.push('primitive failure' as unknown as Error);

    await expect(
      store.set('key', new PrimitiveErrorModel('value'))
    ).rejects.toBe('primitive failure');
    expect(control.DatabaseCtor).toHaveBeenCalledTimes(1);
    expect(logger.warning).not.toHaveBeenCalledWith(
      'detected-corrupted-db',
      expect.anything()
    );
  });

  it('does not attempt recovery when autoRecover is disabled', async () => {
    const { module, control, logger } = await setupModule({});
    const { SQLiteKeyValueStore } = module;

    class NoRecoverModel {
      public constructor(public value: string) {}
    }

    const store = new SQLiteKeyValueStore<NoRecoverModel>({
      dbPath: path.join(os.tmpdir(), `no-recover-${Date.now()}.db`),
      tableName: 'kv_no_recover_model',
      modelCtor: NoRecoverModel,
      autoRecover: false,
    });

    control.runErrors.push(new Error('file is not a database'));

    await expect(store.set('key', new NoRecoverModel('value'))).rejects.toThrow(
      'file is not a database'
    );

    expect(logger.warning).not.toHaveBeenCalledWith(
      'detected-corrupted-db',
      expect.anything()
    );
  });
});
