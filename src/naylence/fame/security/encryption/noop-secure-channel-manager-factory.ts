import { registerFactory } from "naylence-factory";

import {
  SECURE_CHANNEL_MANAGER_FACTORY_BASE_TYPE,
  SecureChannelManagerFactory,
  type SecureChannelManagerConfig,
} from "./secure-channel-manager-factory.js";
import type { SecureChannelManager } from "./secure-channel-manager.js";
import { NoopSecureChannelManager } from "./noop-secure-channel-manager.js";

export interface NoopSecureChannelManagerConfig extends SecureChannelManagerConfig {
  type: "NoopSecureChannelManager";
}

export class NoopSecureChannelManagerFactory extends SecureChannelManagerFactory<NoopSecureChannelManagerConfig> {
  public readonly type = "NoopSecureChannelManager";
  public readonly isDefault = true;

  public async create(): Promise<SecureChannelManager> {
    return new NoopSecureChannelManager();
  }
}

registerFactory(
  SECURE_CHANNEL_MANAGER_FACTORY_BASE_TYPE,
  "NoopSecureChannelManager",
  NoopSecureChannelManagerFactory,
  { isDefault: true }
);
