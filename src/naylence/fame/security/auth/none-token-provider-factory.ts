import { registerFactory } from "naylence-factory";

import type { TokenProvider } from "./token-provider.js";
import {
  TOKEN_PROVIDER_FACTORY_BASE_TYPE,
  TokenProviderFactory,
  type TokenProviderConfig,
} from "./token-provider-factory.js";
import { NoneTokenProvider } from "./none-token-provider.js";

export interface NoneTokenProviderConfig extends TokenProviderConfig {
  type: "NoneTokenProvider";
}

export class NoneTokenProviderFactory extends TokenProviderFactory<NoneTokenProviderConfig> {
  public readonly type = "NoneTokenProvider";
  public readonly isDefault = true;

  public async create(): Promise<TokenProvider> {
    return new NoneTokenProvider();
  }
}

registerFactory<TokenProvider, NoneTokenProviderConfig>(
  TOKEN_PROVIDER_FACTORY_BASE_TYPE,
  "NoneTokenProvider",
  NoneTokenProviderFactory,
  { isDefault: true }
);
