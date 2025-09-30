import "fake-indexeddb/auto";

import { IndexedDBKeyValueStore } from "../indexeddb-key-value-store.js";

describe("IndexedDBKeyValueStore", () => {
  const randomSuffix = () =>
    globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  const generateStoreName = () => `kv-store-${randomSuffix()}`;

  it("persists and retrieves values", async () => {
    const store = new IndexedDBKeyValueStore<string>({
      dbName: `db-${randomSuffix()}`,
      storeName: generateStoreName(),
    });

    await store.set("greeting", "hello");
    await store.set("farewell", "bye");

    expect(await store.get("greeting")).toBe("hello");
    expect(await store.get("farewell")).toBe("bye");
  });

  it("updates existing values and throws when missing", async () => {
    const store = new IndexedDBKeyValueStore<number>({
      dbName: `db-${randomSuffix()}`,
      storeName: generateStoreName(),
    });

    await store.set("count", 1);
    await store.update("count", 2);

    await expect(store.update("missing", 3)).rejects.toThrow("does not exist");
    expect(await store.get("count")).toBe(2);
  });

  it("lists and deletes values", async () => {
    const store = new IndexedDBKeyValueStore<{ flag: boolean }>({
      dbName: `db-${randomSuffix()}`,
      storeName: generateStoreName(),
    });

    await store.set("alpha", { flag: true });
    await store.set("beta", { flag: false });

    const listed = await store.list();
    expect(listed).toEqual({
      alpha: { flag: true },
      beta: { flag: false },
    });

    await store.delete("alpha");
    expect(await store.get("alpha")).toBeUndefined();
  });
});
