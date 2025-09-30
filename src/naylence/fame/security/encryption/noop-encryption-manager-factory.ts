import { registerFactory } from "naylence-factory";

import type { EncryptionManager } from "./encryption-manager.js";
import {
  ENCRYPTION_MANAGER_FACTORY_BASE_TYPE,
  EncryptionManagerFactory,
  type EncryptionManagerConfig,
} from "./encryption-manager-factory.js";
import { NoopEncryptionManager } from "./noop-encryption-manager.js";

export interface NoopEncryptionManagerConfig extends EncryptionManagerConfig {
  type: "NoopEncryptionManager";
}

export class NoopEncryptionManagerFactory extends EncryptionManagerFactory<NoopEncryptionManagerConfig> {
  public readonly type = "NoopEncryptionManager";
  public readonly isDefault = true;

  public getSupportedAlgorithms(): readonly string[] {
    return [];
  }

  public getEncryptionType(): string {
    return "none";
  }

  public supportsOptions(): boolean {
    return true;
  }

  public async create(): Promise<EncryptionManager> {
    return new NoopEncryptionManager();
  }
}

registerFactory(
  ENCRYPTION_MANAGER_FACTORY_BASE_TYPE,
  "NoopEncryptionManager",
  NoopEncryptionManagerFactory,
  { isDefault: true }
);
