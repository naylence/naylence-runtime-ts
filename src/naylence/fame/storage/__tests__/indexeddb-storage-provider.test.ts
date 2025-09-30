import "fake-indexeddb/auto";

import {
  IndexedDBStorageProvider,
  type IndexedDBStorageProviderOptions,
} from "../indexeddb-storage-provider.js";
import { StaticCredentialProvider } from "../../security/credential/static-credential-provider.js";

class SampleModel {
  public readonly value: string;

  constructor(input: { value: string }) {
    this.value = input.value;
  }

  toJSON(): { value: string } {
    return { value: this.value };
  }
}

describe("IndexedDBStorageProvider", () => {
  const createProvider = (overrides: Parameters<typeof buildProvider>[0] = {}) =>
    buildProvider({
      dbName: `storage-${randomSuffix()}`,
      ...overrides,
    });

  it("creates encrypted stores that persist data", async () => {
    const provider = createProvider();
    const store = await provider.getKeyValueStore(SampleModel, "example");

    const model = new SampleModel({ value: "secret" });
    await store.set("item", model);

    const retrieved = await store.get("item");
    expect(retrieved).toBeInstanceOf(SampleModel);
    expect(retrieved?.value).toBe("secret");
  });

  it("reuses stores for identical namespaces and models", async () => {
    const provider = createProvider();

    const first = await provider.getKeyValueStore(SampleModel, "shared");
    const second = await provider.getKeyValueStore(SampleModel, "shared");

    await first.set("shared-entry", new SampleModel({ value: "pooled" }));
    const retrieved = await second.get("shared-entry");

    expect(retrieved?.value).toBe("pooled");
  });

  it("throws when hardened mode is missing a master key provider", () => {
    expect(() => createProvider({ mode: "hardened", masterKeyProvider: null })).toThrow(
      "requires an explicit masterKeyProvider"
    );
  });

  it("allows hardened mode with explicit master key provider", async () => {
    const provider = createProvider({
      mode: "hardened",
      masterKeyProvider: new StaticCredentialProvider("hard-key-value"),
    });

    const store = await provider.getKeyValueStore(SampleModel, "secure");
    await store.set("important", new SampleModel({ value: "protected" }));

    const retrieved = await store.get("important");
    expect(retrieved?.value).toBe("protected");
  });
});

type ProviderOverrides = Partial<{
  dbName: string;
  mode: "dx" | "hardened";
  masterKeyProvider: StaticCredentialProvider | null;
}>;

function buildProvider(overrides: ProviderOverrides = {}): IndexedDBStorageProvider {
  const { dbName, mode, masterKeyProvider } = overrides;

  const options: IndexedDBStorageProviderOptions = {
    idbFactory: indexedDB,
  };

  if (dbName !== undefined) {
    options.dbName = dbName;
  }

  if (mode) {
    options.mode = mode;
  }

  if (masterKeyProvider !== undefined) {
    options.masterKeyProvider = masterKeyProvider;
  }

  return new IndexedDBStorageProvider(options);
}

function randomSuffix(): string {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
}
