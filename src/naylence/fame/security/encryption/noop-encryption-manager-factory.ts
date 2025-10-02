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

export const FACTORY_META = {
  base: ENCRYPTION_MANAGER_FACTORY_BASE_TYPE,
  key: "NoopEncryptionManager",
} as const;

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

export default NoopEncryptionManagerFactory;
