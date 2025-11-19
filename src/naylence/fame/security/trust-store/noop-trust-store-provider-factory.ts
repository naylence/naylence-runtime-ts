import {
  NoopTrustStoreProvider,
  TrustStoreProviderFactory,
  TRUST_STORE_PROVIDER_FACTORY_BASE_TYPE,
  type TrustStoreProviderConfig,
} from "./trust-store-provider-factory.js";
import type { TrustStoreProvider } from "./trust-store-provider.js";

export interface NoopTrustStoreProviderConfig extends TrustStoreProviderConfig {
  readonly type: "NoopTrustStoreProvider";
}

export const FACTORY_META = {
  base: TRUST_STORE_PROVIDER_FACTORY_BASE_TYPE,
  key: "NoopTrustStoreProvider",
  isDefault: true,
  priority: 10,
} as const;

export class NoopTrustStoreProviderFactory extends TrustStoreProviderFactory<NoopTrustStoreProviderConfig> {
  public readonly type = "NoopTrustStoreProvider";
  public readonly isDefault = true;
  public readonly priority = 10;

  public async create(
    _config?: NoopTrustStoreProviderConfig | Record<string, unknown> | null,
    ..._factoryArgs: unknown[]
  ): Promise<TrustStoreProvider> {
    return new NoopTrustStoreProvider();
  }
}

export default NoopTrustStoreProviderFactory;
