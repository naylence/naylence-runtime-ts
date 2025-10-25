import type { CreateResourceOptions, ResourceConfig } from '@naylence/factory';
import {
  AbstractResourceFactory,
  createDefaultResource,
  createResource,
} from '@naylence/factory';
import type { TokenVerifier } from './token-verifier.js';

export const TOKEN_VERIFIER_FACTORY_BASE_TYPE = 'TokenVerifierFactory';

export interface TokenVerifierConfig extends ResourceConfig {
  type: string;
  [key: string]: unknown;
}

export abstract class TokenVerifierFactory<
  C extends TokenVerifierConfig = TokenVerifierConfig,
> extends AbstractResourceFactory<TokenVerifier, C> {
  public abstract create(
    config?: C | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<TokenVerifier>;

  public static async createTokenVerifier<
    C extends TokenVerifierConfig = TokenVerifierConfig,
  >(
    config?: C | Record<string, unknown> | null,
    options: CreateResourceOptions = {}
  ): Promise<TokenVerifier> {
    if (config) {
      const instance = await createResource<TokenVerifier>(
        TOKEN_VERIFIER_FACTORY_BASE_TYPE,
        config,
        options
      );

      if (!instance) {
        throw new Error('Failed to create token verifier from configuration');
      }

      return instance;
    }

    const instance = await createDefaultResource<TokenVerifier>(
      TOKEN_VERIFIER_FACTORY_BASE_TYPE,
      null,
      options
    );

    if (!instance) {
      throw new Error('Failed to create default token verifier');
    }

    return instance;
  }
}
