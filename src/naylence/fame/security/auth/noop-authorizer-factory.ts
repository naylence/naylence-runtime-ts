import { registerFactory } from "naylence-factory";

import type { Authorizer } from "./authorizer.js";
import {
  AUTHORIZER_FACTORY_BASE_TYPE,
  AuthorizerFactory,
  type AuthorizerConfig,
} from "./authorizer-factory.js";
import { NoopAuthorizer } from "./noop-authorizer.js";

export interface NoopAuthorizerConfig extends AuthorizerConfig {
  type: "NoopAuthorizer";
}

export class NoopAuthorizerFactory extends AuthorizerFactory<NoopAuthorizerConfig> {
  public readonly type = "NoopAuthorizer";

  public async create(
    _config?: NoopAuthorizerConfig | Record<string, unknown> | null
  ): Promise<Authorizer> {
    return new NoopAuthorizer();
  }
}

registerFactory<Authorizer, NoopAuthorizerConfig>(
  AUTHORIZER_FACTORY_BASE_TYPE,
  "NoopAuthorizer",
  NoopAuthorizerFactory
);
