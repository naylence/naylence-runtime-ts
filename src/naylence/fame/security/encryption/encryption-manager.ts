import type { FameAddress, FameEnvelope } from "naylence-core";
import type { CreateResourceOptions, ResourceConfig } from "naylence-factory";
import { AbstractResourceFactory, createDefaultResource, createResource } from "naylence-factory";

import type { CryptoProvider } from "../crypto/providers/crypto-provider.js";
import type { KeyProvider } from "../keys/key-provider.js";
import type { SecureChannelManager } from "./secure-channel-manager.js";

export const FIXED_PREFIX_LEN = 44; // 32-byte ephemeral public key + 12-byte nonce prefix

export interface EncryptionOptions {
  readonly recipPub?: Uint8Array;
  readonly recip_pub?: Uint8Array;
  readonly recipientPublicKey?: Uint8Array;
  readonly privKey?: Uint8Array;
  readonly priv_key?: Uint8Array;
  readonly privateKey?: Uint8Array;
  readonly channelKey?: Uint8Array;
  readonly channel_key?: Uint8Array;
  readonly nonce?: Uint8Array;
  readonly recipKid?: string;
  readonly recip_kid?: string;
  readonly recipientKeyId?: string;
  readonly requestAddress?: FameAddress;
  readonly encryptionType?: "standard" | "channel" | string;
  readonly destination?: FameAddress;
  readonly [key: string]: unknown;
}

export enum EncryptionStatus {
  OK = "OK",
  SKIPPED = "SKIPPED",
  QUEUED = "QUEUED",
}

export class EncryptionResult {
  public static ok(envelope: FameEnvelope): EncryptionResult {
    return new EncryptionResult(EncryptionStatus.OK, envelope);
  }

  public static skipped(envelope: FameEnvelope): EncryptionResult {
    return new EncryptionResult(EncryptionStatus.SKIPPED, envelope);
  }

  public static queued(): EncryptionResult {
    return new EncryptionResult(EncryptionStatus.QUEUED, undefined);
  }

  constructor(
    public readonly status: EncryptionStatus,
    public readonly envelope?: FameEnvelope
  ) {}
}

export interface EncryptionFactoryDependencies {
  readonly secureChannelManager?: SecureChannelManager | null;
  readonly cryptoProvider?: CryptoProvider | null;
  readonly keyProvider?: KeyProvider | null;
  readonly [key: string]: unknown;
}

export interface EncryptionManagerConfig extends ResourceConfig {
  type: string;
  supportedAlgorithms?: readonly string[] | null;
  encryptionType?: string | null;
  priority?: number | null;
  [key: string]: unknown;
}

export interface CreateEncryptionManagerOptions extends Omit<CreateResourceOptions, "factoryArgs"> {
  factoryArgs?: unknown[];
  dependencies?: EncryptionFactoryDependencies;
}

export const ENCRYPTION_MANAGER_FACTORY_BASE_TYPE = "EncryptionManagerFactory";

export interface EncryptionManager {
  readonly nodeStaticPublicKey?: Uint8Array;

  encryptEnvelope(envelope: FameEnvelope, opts?: EncryptionOptions): Promise<EncryptionResult>;

  decryptEnvelope(envelope: FameEnvelope, opts?: EncryptionOptions): Promise<FameEnvelope>;

  notifyChannelEstablished?(channelId: string): Promise<void> | void;

  notifyChannelFailed?(channelId: string, reason?: string): Promise<void> | void;
}

export abstract class EncryptionManagerFactory<
  C extends EncryptionManagerConfig = EncryptionManagerConfig,
> extends AbstractResourceFactory<EncryptionManager, C> {
  public abstract getSupportedAlgorithms(): readonly string[];

  public abstract getEncryptionType(): string;

  public abstract supportsOptions(opts?: EncryptionOptions | null): boolean;

  public getPriority(): number {
    return this.priority ?? 0;
  }

  public abstract create(
    config?: C | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<EncryptionManager>;

  public static async createEncryptionManager<
    C extends EncryptionManagerConfig = EncryptionManagerConfig,
  >(
    config?: C | Record<string, unknown> | null,
    options: CreateEncryptionManagerOptions = {}
  ): Promise<EncryptionManager | null> {
    const { dependencies, factoryArgs, ...restOptions } = options;
    const mergedFactoryArgs = [...(dependencies ? [dependencies] : []), ...(factoryArgs ?? [])];

    const creationOptions: CreateResourceOptions = {
      ...restOptions,
      factoryArgs: mergedFactoryArgs,
    };

    if (config) {
      const instance = await createResource<EncryptionManager>(
        ENCRYPTION_MANAGER_FACTORY_BASE_TYPE,
        config,
        creationOptions
      );

      if (instance) {
        return instance;
      }

      return null;
    }

    return await createDefaultResource<EncryptionManager>(
      ENCRYPTION_MANAGER_FACTORY_BASE_TYPE,
      null,
      creationOptions
    );
  }
}
