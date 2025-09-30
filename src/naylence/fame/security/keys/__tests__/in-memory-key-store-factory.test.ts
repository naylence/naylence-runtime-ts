import { ResourceFactoryRegistry } from "naylence-factory";
import {
  InMemoryKeyStoreFactory,
  type InMemoryKeyStoreConfig,
} from "../in-memory-key-store-factory.js";
import { InMemoryKeyStore } from "../in-memory-key-store.js";
import { KeyStoreFactory, KEY_STORE_FACTORY_BASE_TYPE } from "../key-store-factory.js";
import type { KeyRecord } from "../key-store.js";

describe("InMemoryKeyStoreFactory", () => {
  afterEach(() => {
    ResourceFactoryRegistry.clearCache(KEY_STORE_FACTORY_BASE_TYPE);
  });

  it("registers as default key store factory", async () => {
    const store = await KeyStoreFactory.createKeyStore();
    expect(store).toBeInstanceOf(InMemoryKeyStore);
  });

  it("creates store seeded from camelCase initial keys", async () => {
    const factory = new InMemoryKeyStoreFactory();
    const config: InMemoryKeyStoreConfig = {
      type: "InMemoryKeyStore",
      initialKeys: {
        seeded: {
          kid: "seeded",
          kty: "OKP",
          crv: "Ed25519",
          x: "abc",
        } as KeyRecord,
      },
    };

    const store = await factory.create(config);

    await expect(store.hasKey("seeded")).resolves.toBe(true);
  });

  it("supports snake_case initial keys for parity", async () => {
    const factory = new InMemoryKeyStoreFactory();
    const config = {
      type: "InMemoryKeyStore",
      initial_keys: {
        legacy: {
          kid: "legacy",
          kty: "OKP",
          crv: "Ed25519",
          x: "xyz",
        } as KeyRecord,
      },
    };

    const store = await factory.create(config);

    await expect(store.hasKey("legacy")).resolves.toBe(true);
  });

  it("accepts map-based initial keys", async () => {
    const factory = new InMemoryKeyStoreFactory();
    const mapConfig: InMemoryKeyStoreConfig = {
      type: "InMemoryKeyStore",
      initialKeys: new Map([
        [
          "from-map",
          {
            kid: "from-map",
            kty: "OKP",
            crv: "Ed25519",
            x: "def",
          } as KeyRecord,
        ],
      ]),
    };

    const store = await factory.create(mapConfig);

    await expect(store.hasKey("from-map")).resolves.toBe(true);
  });

  it("is discoverable among default factories", () => {
    const defaults = ResourceFactoryRegistry.getDefaultTypes(KEY_STORE_FACTORY_BASE_TYPE);
    const defaultTypes = defaults.map(([, type]) => type);
    expect(defaultTypes).toContain("InMemoryKeyStore");
  });
});
