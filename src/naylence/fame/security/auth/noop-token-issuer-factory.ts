import { registerFactory } from 'naylence-factory';

import type { TokenIssuer } from './token-issuer.js';
import {
  TOKEN_ISSUER_FACTORY_BASE_TYPE,
  TokenIssuerFactory,
  type TokenIssuerConfig,
} from './token-issuer-factory.js';
import { NoopTokenIssuer } from './noop-token-issuer.js';

export interface NoopTokenIssuerConfig extends TokenIssuerConfig {
  type: 'NoopTokenIssuer';
}

export class NoopTokenIssuerFactory extends TokenIssuerFactory<NoopTokenIssuerConfig> {
  public readonly type = 'NoopTokenIssuer';

  public async create(
    _config?: NoopTokenIssuerConfig | Record<string, unknown> | null
  ): Promise<TokenIssuer> {
    return new NoopTokenIssuer();
  }
}

registerFactory<TokenIssuer, NoopTokenIssuerConfig>(
  TOKEN_ISSUER_FACTORY_BASE_TYPE,
  'NoopTokenIssuer',
  NoopTokenIssuerFactory
);
