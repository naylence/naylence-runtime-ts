import { Buffer } from "node:buffer";
import type {
  DataFrame,
  FameEnvelope,
  SecureAcceptFrame,
  SecureCloseFrame,
  SecureOpenFrame,
} from "naylence-core";
import * as FactoryRegistry from "naylence-factory";

import {
  ENCRYPTION_MANAGER_FACTORY_BASE_TYPE,
  FIXED_PREFIX_LEN,
  EncryptionManagerFactory,
  EncryptionResult,
  EncryptionStatus,
  type CreateEncryptionManagerOptions,
  type EncryptionFactoryDependencies,
  type EncryptionManager,
  type EncryptionManagerConfig,
} from "../encryption/encryption-manager.js";
import {
  SECURE_CHANNEL_MANAGER_FACTORY_BASE_TYPE,
  SecureChannelManagerFactory,
  type CreateSecureChannelManagerOptions,
  type SecureChannelManagerConfig,
} from "../encryption/secure-channel-manager-factory.js";
import type {
  SecureChannelManager,
  SecureChannelState,
} from "../encryption/secure-channel-manager.js";

const { registerFactory } = FactoryRegistry;
const ZERO_KEY_BASE64 = Buffer.alloc(32).toString("base64");

describe("Encryption manager primitives", () => {
  it("defines constant prefix length used for channel payloads", () => {
    expect(FIXED_PREFIX_LEN).toBe(44);
  });

  it("wraps encryption results with factory helpers", () => {
    const envelope = { frame: { type: "DataFrame" } } as unknown as FameEnvelope;

    expect(EncryptionResult.ok(envelope)).toEqual({
      status: EncryptionStatus.OK,
      envelope,
    });

    expect(EncryptionResult.skipped(envelope)).toEqual({
      status: EncryptionStatus.SKIPPED,
      envelope,
    });

    expect(EncryptionResult.queued()).toEqual({
      status: EncryptionStatus.QUEUED,
      envelope: undefined,
    });
  });
});

describe("EncryptionManagerFactory without registrations", () => {
  it("returns null when no default factory is registered and config is undefined", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const manager = await EncryptionManagerFactory.createEncryptionManager(null);
    warnSpy.mockRestore();
    expect(manager).toBeNull();
  });

  it("returns null when createResource yields no instance", async () => {
    const resourceSpy = jest.spyOn(FactoryRegistry, "createResource").mockResolvedValueOnce(null);
    const manager = await EncryptionManagerFactory.createEncryptionManager({
      type: "TestEncryptionManager",
      label: "missing",
    });
    expect(manager).toBeNull();
    resourceSpy.mockRestore();
  });
});

describe("EncryptionManagerFactory with registered factory", () => {
  class TestEncryptionManager implements EncryptionManager {
    public constructor(public readonly label: string) {}

    public async encryptEnvelope(envelope: FameEnvelope): Promise<EncryptionResult> {
      return EncryptionResult.ok(envelope);
    }

    public async decryptEnvelope(envelope: FameEnvelope): Promise<FameEnvelope> {
      return envelope;
    }
  }

  interface TestEncryptionManagerConfig extends EncryptionManagerConfig {
    type: "TestEncryptionManager";
    label: string;
  }

  class TestEncryptionManagerFactory extends EncryptionManagerFactory<TestEncryptionManagerConfig> {
    public static lastArgs: unknown[] | null = null;
    public static lastConfig: TestEncryptionManagerConfig | Record<string, unknown> | null = null;

    public readonly type = "TestEncryptionManager";
    public readonly isDefault = true;
    public override readonly priority = 42;

    public getSupportedAlgorithms(): readonly string[] {
      return ["X25519"];
    }

    public getEncryptionType(): string {
      return "sealed";
    }

    public supportsOptions(): boolean {
      return true;
    }

    public async create(
      config?: TestEncryptionManagerConfig | Record<string, unknown> | null,
      ...factoryArgs: unknown[]
    ): Promise<EncryptionManager> {
      TestEncryptionManagerFactory.lastArgs = factoryArgs;
      TestEncryptionManagerFactory.lastConfig = config ?? null;
      const resolvedLabel = (config as TestEncryptionManagerConfig | undefined)?.label ?? "default";
      return new TestEncryptionManager(resolvedLabel);
    }
  }

  beforeAll(() => {
    registerFactory(
      ENCRYPTION_MANAGER_FACTORY_BASE_TYPE,
      "TestEncryptionManager",
      TestEncryptionManagerFactory,
      { isDefault: true, priority: 42 }
    );
  });

  beforeEach(() => {
    TestEncryptionManagerFactory.lastArgs = null;
    TestEncryptionManagerFactory.lastConfig = null;
  });

  it("creates an encryption manager with config and dependency bundle", async () => {
    const dependencies: EncryptionFactoryDependencies = {
      secureChannelManager: {
        channels: {},
        generateOpenFrame: (cid: string, algorithm = "CHACHA20P1305"): SecureOpenFrame => ({
          type: "SecureOpen",
          cid,
          ephPub: ZERO_KEY_BASE64,
          alg: algorithm,
          opts: 0,
        }),
        handleOpenFrame: async (): Promise<SecureAcceptFrame> => ({
          type: "SecureAccept",
          cid: "example",
          ok: true,
          ephPub: ZERO_KEY_BASE64,
          alg: "CHACHA20P1305",
        }),
        handleAcceptFrame: async (_frame: SecureAcceptFrame): Promise<boolean> => true,
        handleCloseFrame: (_frame: SecureCloseFrame): void => {
          /* noop */
        },
        isChannelEncrypted: (_frame: DataFrame): boolean => true,
        hasChannel: (_cid: string): boolean => true,
        getChannelInfo: (_cid: string): Record<string, unknown> | null => ({ established: true }),
        closeChannel: (cid: string, reason = "User requested"): SecureCloseFrame => ({
          type: "SecureClose",
          cid,
          reason,
        }),
        cleanupExpiredChannels: (): number => 0,
        addChannel: (_cid: string, _state: SecureChannelState): void => {
          /* noop */
        },
        removeChannel: (_cid: string): boolean => true,
      },
      cryptoProvider: {
        signingPrivatePem: null,
      },
      keyProvider: {
        async getKey(): Promise<never> {
          throw new Error("not implemented");
        },
        async getKeysForPath(): Promise<Iterable<never>> {
          return [];
        },
      },
    } satisfies EncryptionFactoryDependencies;

    const manager = await EncryptionManagerFactory.createEncryptionManager(
      { type: "TestEncryptionManager", label: "configured" },
      { dependencies }
    );

    expect(manager).toBeInstanceOf(TestEncryptionManager);
    expect(TestEncryptionManagerFactory.lastConfig).toEqual({
      type: "TestEncryptionManager",
      label: "configured",
    });
    expect(TestEncryptionManagerFactory.lastArgs).toHaveLength(1);
    expect(TestEncryptionManagerFactory.lastArgs?.[0]).toBe(dependencies);
  });

  it("creates default encryption manager when config is omitted", async () => {
    const manager = await EncryptionManagerFactory.createEncryptionManager(
      undefined,
      {} satisfies CreateEncryptionManagerOptions
    );
    expect(manager).toBeInstanceOf(TestEncryptionManager);
  });

  it("falls back to zero priority when value is unset", () => {
    const factory = new TestEncryptionManagerFactory();
    expect(factory.getPriority()).toBe(42);
    delete (factory as { priority?: number }).priority;
    expect(factory.getPriority()).toBe(0);
  });
});

describe("SecureChannelManagerFactory without registrations", () => {
  it("returns null when no default manager is registered", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const manager = await SecureChannelManagerFactory.createSecureChannelManager(null);
    warnSpy.mockRestore();
    expect(manager).toBeNull();
  });

  it("returns null when createResource yields no instance", async () => {
    const resourceSpy = jest.spyOn(FactoryRegistry, "createResource").mockResolvedValueOnce(null);
    const manager = await SecureChannelManagerFactory.createSecureChannelManager({
      type: "TestSecureChannelManager",
    });
    expect(manager).toBeNull();
    resourceSpy.mockRestore();
  });
});

describe("SecureChannelManagerFactory with registered factory", () => {
  class TestSecureChannelManager implements SecureChannelManager {
    public readonly channels: Readonly<Record<string, SecureChannelState>> = {};

    public generateOpenFrame(channelId: string, algorithm = "CHACHA20P1305"): SecureOpenFrame {
      return {
        type: "SecureOpen",
        cid: channelId,
        ephPub: ZERO_KEY_BASE64,
        alg: algorithm,
        opts: 0,
      };
    }

    public async handleOpenFrame(frame: SecureOpenFrame): Promise<SecureAcceptFrame> {
      return {
        type: "SecureAccept",
        cid: frame.cid,
        ok: true,
        ephPub: ZERO_KEY_BASE64,
        alg: frame.alg,
      };
    }

    public async handleAcceptFrame(_: SecureAcceptFrame): Promise<boolean> {
      return true;
    }

    public handleCloseFrame(_: SecureCloseFrame): void {
      /* noop */
    }

    public isChannelEncrypted(_: DataFrame): boolean {
      return true;
    }

    public hasChannel(_: string): boolean {
      return true;
    }

    public getChannelInfo(_: string): Record<string, unknown> | null {
      return { active: true };
    }

    public closeChannel(channelId: string, reason = "User requested"): SecureCloseFrame {
      return { type: "SecureClose", cid: channelId, reason };
    }

    public cleanupExpiredChannels(): number {
      return 0;
    }

    public addChannel(_: string, __: SecureChannelState): void {
      /* noop */
    }

    public removeChannel(_: string): boolean {
      return true;
    }
  }

  interface TestSecureChannelConfig extends SecureChannelManagerConfig {
    type: "TestSecureChannelManager";
    [key: string]: unknown;
  }

  class TestSecureChannelManagerFactory extends SecureChannelManagerFactory<TestSecureChannelConfig> {
    public static lastArgs: unknown[] | null = null;
    public static lastConfig: TestSecureChannelConfig | Record<string, unknown> | null = null;

    public readonly type = "TestSecureChannelManager";
    public readonly isDefault = true;

    public async create(
      config?: TestSecureChannelConfig | Record<string, unknown> | null,
      ...factoryArgs: unknown[]
    ): Promise<SecureChannelManager> {
      TestSecureChannelManagerFactory.lastArgs = factoryArgs;
      TestSecureChannelManagerFactory.lastConfig = config ?? null;
      return new TestSecureChannelManager();
    }
  }

  beforeAll(() => {
    registerFactory(
      SECURE_CHANNEL_MANAGER_FACTORY_BASE_TYPE,
      "TestSecureChannelManager",
      TestSecureChannelManagerFactory,
      { isDefault: true }
    );
  });

  beforeEach(() => {
    TestSecureChannelManagerFactory.lastArgs = null;
    TestSecureChannelManagerFactory.lastConfig = null;
  });

  it("creates a manager using explicit config", async () => {
    const manager = await SecureChannelManagerFactory.createSecureChannelManager({
      type: "TestSecureChannelManager",
    });

    expect(manager).toBeInstanceOf(TestSecureChannelManager);
    expect(TestSecureChannelManagerFactory.lastConfig).toEqual({
      type: "TestSecureChannelManager",
    });
    expect(TestSecureChannelManagerFactory.lastArgs).toEqual([]);
  });

  it("creates a default manager when config is omitted", async () => {
    const manager = await SecureChannelManagerFactory.createSecureChannelManager(
      undefined,
      {} satisfies CreateSecureChannelManagerOptions
    );
    expect(manager).toBeInstanceOf(TestSecureChannelManager);
  });
});
