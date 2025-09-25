import { registerFactory } from 'naylence-factory';

import type { Authorizer } from './authorizer.js';
import {
  AUTHORIZER_FACTORY_BASE_TYPE,
  AuthorizerFactory,
  type AuthorizerConfig,
} from './authorizer-factory.js';
import { DefaultAuthorizer } from './default-authorizer.js';
import type { TokenVerifier } from './token-verifier.js';
import {
  TokenVerifierFactory,
  type TokenVerifierConfig,
} from './token-verifier-factory.js';

export interface DefaultAuthorizerConfig extends AuthorizerConfig {
  type: 'DefaultAuthorizer';
  verifier?: TokenVerifierConfig | Record<string, unknown> | null;
}

interface NormalizedDefaultAuthorizerConfig {
  verifier?: TokenVerifierConfig | Record<string, unknown> | null;
}

function normalizeConfig(
  config?: DefaultAuthorizerConfig | Record<string, unknown> | null
): NormalizedDefaultAuthorizerConfig {
  if (!config) {
    return {};
  }

  const candidate = config as DefaultAuthorizerConfig & Record<string, unknown>;
  const verifierConfig = candidate.verifier ?? null;

  if (verifierConfig && typeof verifierConfig !== 'object') {
    throw new Error('DefaultAuthorizer verifier configuration must be an object');
  }

  return {
    verifier: verifierConfig as TokenVerifierConfig | Record<string, unknown> | null,
  };
}

function isTokenVerifier(candidate: unknown): candidate is TokenVerifier {
  return Boolean(candidate && typeof (candidate as TokenVerifier).verify === 'function');
}

export class DefaultAuthorizerFactory extends AuthorizerFactory<DefaultAuthorizerConfig> {
  public readonly type = 'DefaultAuthorizer';
  public readonly isDefault = true;

  public async create(
    config?: DefaultAuthorizerConfig | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<Authorizer> {
    let tokenVerifier = factoryArgs.find(isTokenVerifier) as TokenVerifier | undefined;

    const normalized = normalizeConfig(config);

    if (!tokenVerifier) {
      if (!normalized.verifier) {
        throw new Error('DefaultAuthorizer requires a verifier configuration or instance');
      }

      tokenVerifier = await TokenVerifierFactory.createTokenVerifier(normalized.verifier);
    }

    if (!tokenVerifier) {
      throw new Error('Failed to resolve token verifier for DefaultAuthorizer');
    }

    return new DefaultAuthorizer({ tokenVerifier });
  }
}

registerFactory<Authorizer, DefaultAuthorizerConfig>(
  AUTHORIZER_FACTORY_BASE_TYPE,
  'DefaultAuthorizer',
  DefaultAuthorizerFactory,
  { isDefault: true }
);
