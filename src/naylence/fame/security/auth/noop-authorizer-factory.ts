import type { Authorizer } from './authorizer.js';
import {
  AUTHORIZER_FACTORY_BASE_TYPE,
  AuthorizerFactory,
  type AuthorizerConfig,
} from './authorizer-factory.js';
import { NoopAuthorizer } from './noop-authorizer.js';

export interface NoopAuthorizerConfig extends AuthorizerConfig {
  type: 'NoopAuthorizer';
}

export const FACTORY_META = {
  base: AUTHORIZER_FACTORY_BASE_TYPE,
  key: 'NoopAuthorizer',
} as const;

export class NoopAuthorizerFactory extends AuthorizerFactory<NoopAuthorizerConfig> {
  public readonly type = 'NoopAuthorizer';

  public async create(
    _config?: NoopAuthorizerConfig | Record<string, unknown> | null
  ): Promise<Authorizer> {
    return new NoopAuthorizer();
  }
}

export default NoopAuthorizerFactory;
