import type { TokenVerifier } from './token-verifier.js';
import {
  TOKEN_VERIFIER_FACTORY_BASE_TYPE,
  TokenVerifierFactory,
  type TokenVerifierConfig,
} from './token-verifier-factory.js';
import { NoopTokenVerifier } from './noop-token-verifier.js';

export interface NoopTokenVerifierConfig extends TokenVerifierConfig {
  type: 'NoopTokenVerifier';
}

export const FACTORY_META = {
  base: TOKEN_VERIFIER_FACTORY_BASE_TYPE,
  key: 'NoopTokenVerifier',
} as const;

export class NoopTokenVerifierFactory extends TokenVerifierFactory<NoopTokenVerifierConfig> {
  public readonly type = 'NoopTokenVerifier';

  public async create(
    _config?: NoopTokenVerifierConfig | Record<string, unknown> | null
  ): Promise<TokenVerifier> {
    return new NoopTokenVerifier();
  }
}

export default NoopTokenVerifierFactory;
