import type { CredentialProvider } from "../../security/credential/credential-provider.js";

type FactoryModules = {
  safeImportMock: jest.MockedFunction<(typeof import("../../util/lazy-import.js"))[("safeImport")]>,
  IndexedDBStorageProviderFactory: typeof import("../indexeddb-storage-provider-factory.js")["IndexedDBStorageProviderFactory"],
  CredentialProviderFactory: typeof import("../../security/credential/credential-provider-factory.js")["CredentialProviderFactory"],
};

jest.mock("../../util/lazy-import.js", () => ({
  safeImport: jest.fn(),
}));

async function loadFactoryModules(): Promise<FactoryModules> {
  jest.resetModules();
  const lazyImportModule = await import("../../util/lazy-import.js");
  const safeImportMock = lazyImportModule.safeImport as jest.MockedFunction<
    (typeof lazyImportModule)["safeImport"]
  >;
  safeImportMock.mockReset();

  const { IndexedDBStorageProviderFactory } = await import(
    "../indexeddb-storage-provider-factory.js"
  );
  const { CredentialProviderFactory } = await import(
    "../../security/credential/credential-provider-factory.js"
  );

  return {
    safeImportMock,
    IndexedDBStorageProviderFactory,
    CredentialProviderFactory,
  };
}

describe("IndexedDBStorageProviderFactory", () => {
  it("normalizes mixed-case config values and caches the provider import", async () => {
    const { safeImportMock, IndexedDBStorageProviderFactory, CredentialProviderFactory } =
      await loadFactoryModules();

    const mockInstance = { name: "indexeddb" } as unknown as CredentialProvider;
    const credentialSpy = jest
      .spyOn(CredentialProviderFactory, "createCredentialProvider")
      .mockResolvedValue(mockInstance);

    const providerCalls: Array<Record<string, unknown>> = [];
    const MockProvider = jest.fn((options: Record<string, unknown>) => {
      providerCalls.push(options);
      return { stop: jest.fn() };
    });

    safeImportMock.mockResolvedValue({ IndexedDBStorageProvider: MockProvider });

    const factory = new IndexedDBStorageProviderFactory();

    const config = {
      type: "IndexedDBStorageProvider" as const,
      db_name: "CustomDB",
      namespace_prefix: "CustomNS",
      enable_caching: "false",
      is_encrypted: "true",
      master_key: "env://MASTER_SECRET",
      version: "5",
    };

    await factory.create(config);
    await factory.create(config);

    expect(safeImportMock).toHaveBeenCalledTimes(1);
    expect(MockProvider).toHaveBeenCalledTimes(2);
    expect(credentialSpy).toHaveBeenCalledTimes(2);

    const [firstCall] = providerCalls;
    expect(firstCall).toMatchObject({
      dbName: "CustomDB",
      namespacePrefix: "CustomNS",
      enableCaching: false,
      isEncrypted: true,
      version: 5,
      masterKeyProvider: mockInstance,
    });

    expect(credentialSpy).toHaveBeenCalledWith({
      type: "EnvCredentialProvider",
      varName: "MASTER_SECRET",
    });

    credentialSpy.mockRestore();
  });

  it("defaults caching and encryption based on the selected mode", async () => {
    const { safeImportMock, IndexedDBStorageProviderFactory, CredentialProviderFactory } =
      await loadFactoryModules();

    const MockProvider = jest.fn(() => ({ stop: jest.fn() }));
    safeImportMock.mockResolvedValue({ IndexedDBStorageProvider: MockProvider });

    const credentialSpy = jest
      .spyOn(CredentialProviderFactory, "createCredentialProvider")
      .mockResolvedValue({} as CredentialProvider);

    const factory = new IndexedDBStorageProviderFactory();

    await factory.create({ type: "IndexedDBStorageProvider" });
    const dxOptions = getProviderOptions(MockProvider, 0);
    expect(dxOptions.enableCaching).toBe(true);
    expect(dxOptions.isEncrypted).toBe(true);

    await factory.create({
      type: "IndexedDBStorageProvider",
      mode: "hardened",
      masterKey: { type: "StaticCredentialProvider", credentialValue: "hard-key" },
    });
    const hardenedOptions = getProviderOptions(MockProvider, 1);
    expect(hardenedOptions.enableCaching).toBe(false);
    expect(hardenedOptions.isEncrypted).toBe(true);

    expect(credentialSpy).toHaveBeenCalledTimes(1);

    credentialSpy.mockRestore();
  });

  it("rejects boolean fields that cannot be coerced", async () => {
    const { IndexedDBStorageProviderFactory } = await loadFactoryModules();
    const factory = new IndexedDBStorageProviderFactory();

    await expect(
      factory.create({ type: "IndexedDBStorageProvider", enableCaching: "not-bool" })
    ).rejects.toThrow("Expected a boolean-like value for 'enableCaching'");
  });

  it("requires supported modes", async () => {
    const { IndexedDBStorageProviderFactory } = await loadFactoryModules();
    const factory = new IndexedDBStorageProviderFactory();

    await expect(
      factory.create({ type: "IndexedDBStorageProvider", mode: "invalid" })
    ).rejects.toThrow("mode must be either 'dx' or 'hardened'");
  });

  it("validates version values", async () => {
    const { IndexedDBStorageProviderFactory } = await loadFactoryModules();
    const factory = new IndexedDBStorageProviderFactory();

    await expect(
      factory.create({ type: "IndexedDBStorageProvider", version: "abc" })
    ).rejects.toThrow("version must be a positive integer");
  });

  it("enforces master key configuration for hardened mode", async () => {
    const { IndexedDBStorageProviderFactory } = await loadFactoryModules();
    const factory = new IndexedDBStorageProviderFactory();

    await expect(
      factory.create({ type: "IndexedDBStorageProvider", mode: "hardened" })
    ).rejects.toThrow("hardened mode requires a masterKey configuration");
  });
});

function getProviderOptions(
  mock: jest.Mock,
  index: number
): Record<string, unknown> & { enableCaching?: boolean; isEncrypted?: boolean } {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`Expected provider mock to be called at index ${index}`);
  }
  return (call[0] as Record<string, unknown>) ?? {};
}
