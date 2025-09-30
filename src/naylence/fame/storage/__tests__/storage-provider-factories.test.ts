import { jest } from "@jest/globals";

import { InMemoryKeyValueStore, InMemoryStorageProvider } from "../in-memory-storage.js";
import { InMemoryStorageProviderFactory } from "../in-memory-storage-provider-factory.js";
import { StorageProfileFactory } from "../storage-profile-factory.js";
import { SQLiteStorageProviderFactory } from "../sqlite-storage-provider-factory.js";
import { CredentialProviderFactory } from "../../security/credential/credential-provider-factory.js";

jest.mock("../sqlite-storage-provider.js", () => {
  class FakeSQLiteStorageProvider {
    constructor(
      public readonly dbDirectory: string,
      public readonly isEncrypted: boolean,
      public readonly masterKeyProvider: unknown,
      public readonly isCached: boolean,
      public readonly autoRecover: boolean
    ) {}
  }

  return { SQLiteStorageProvider: FakeSQLiteStorageProvider };
});

describe("InMemoryKeyValueStore", () => {
  test("update throws when key is missing", async () => {
    const store = new InMemoryKeyValueStore<{ value: string }>();

    await expect(store.update("missing", { value: "test" })).rejects.toThrow(
      "Key 'missing' not found for update."
    );
  });
});

describe("InMemoryStorageProvider", () => {
  class ModelA {
    constructor(public readonly value: string) {}
  }

  class ModelB {
    constructor(public readonly value: number) {}
  }

  test("creates isolated stores per model within the same namespace", async () => {
    const provider = new InMemoryStorageProvider();

    const storeA = await provider.getKeyValueStore(ModelA, "shared");
    const storeB = await provider.getKeyValueStore(ModelB, "shared");

    expect(storeA).not.toBe(storeB);

    await storeA.set("id", new ModelA("value-a"));
    await storeB.set("id", new ModelB(42));

    const [valueA, valueB] = await Promise.all([storeA.get("id"), storeB.get("id")]);

    expect(valueA).toEqual({ value: "value-a" });
    expect(valueB).toEqual({ value: 42 });
  });
});

describe("InMemoryStorageProviderFactory", () => {
  test("returns an in-memory storage provider instance", async () => {
    const factory = new InMemoryStorageProviderFactory();
    const provider = await factory.create();

    expect(provider).toBeInstanceOf(InMemoryStorageProvider);
  });
});

describe("StorageProfileFactory", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("defaults to the memory profile", async () => {
    const factory = new StorageProfileFactory();
    const provider = await factory.create();

    expect(provider).toBeInstanceOf(InMemoryStorageProvider);
  });

  test("throws for unknown profiles", async () => {
    const factory = new StorageProfileFactory();

    await expect(
      factory.create({ type: "StorageProfile", profile: "unknown-profile" })
    ).rejects.toThrow("Unknown storage profile 'unknown-profile'");
  });
});

describe("SQLiteStorageProviderFactory", () => {
  const providerFactory = new SQLiteStorageProviderFactory();

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("enforces presence of master key when encryption is enabled", async () => {
    await expect(
      providerFactory.create({ type: "SQLiteStorageProvider", isEncrypted: true })
    ).rejects.toThrow("masterKey is required when isEncrypted is true");
  });

  test("normalizes secret sources before constructing provider", async () => {
    const credentialProvider = { name: "credential-provider" };
    const createCredentialSpy = jest
      .spyOn(CredentialProviderFactory, "createCredentialProvider")
      .mockResolvedValue(credentialProvider as never);

    const provider = await providerFactory.create({
      type: "SQLiteStorageProvider",
      dbDirectory: "./data",
      isEncrypted: true,
      masterKey: "env://FAME_KEY",
      isCached: "false",
      autoRecover: "on",
    });

    expect(createCredentialSpy).toHaveBeenCalledWith({
      type: "EnvCredentialProvider",
      varName: "FAME_KEY",
    });

    expect(provider).toBeDefined();
    const fakeProvider = provider as unknown as {
      isCached: boolean;
      autoRecover: boolean;
      masterKeyProvider: unknown;
    };

    expect(fakeProvider.masterKeyProvider).toBe(credentialProvider);
    expect(fakeProvider.isCached).toBe(false);
    expect(fakeProvider.autoRecover).toBe(true);
  });
});
