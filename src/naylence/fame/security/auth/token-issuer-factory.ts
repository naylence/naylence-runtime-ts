import type { CreateResourceOptions, ResourceConfig } from 'naylence-factory';
import {
  AbstractResourceFactory,
  createDefaultResource,
  createResource,
} from 'naylence-factory';
import type { TokenIssuer } from './token-issuer.js';

export const TOKEN_ISSUER_FACTORY_BASE_TYPE = 'TokenIssuerFactory';

export interface TokenIssuerConfig extends ResourceConfig {
  type: string;
  [key: string]: unknown;
}

export abstract class TokenIssuerFactory<
  C extends TokenIssuerConfig = TokenIssuerConfig,
> extends AbstractResourceFactory<TokenIssuer, C> {
  public abstract create(
    config?: C | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<TokenIssuer>;

  public static async createTokenIssuer<
    C extends TokenIssuerConfig = TokenIssuerConfig,
  >(
    config?: C | Record<string, unknown> | null,
    options: CreateResourceOptions = {}
  ): Promise<TokenIssuer> {
    if (config) {
      const tokenIssuer = await createResource<TokenIssuer>(
        TOKEN_ISSUER_FACTORY_BASE_TYPE,
        config,
        options
      );

      if (!tokenIssuer) {
        throw new Error('Failed to create token issuer from configuration');
      }

      return tokenIssuer;
    }

    const tokenIssuer = await createDefaultResource<TokenIssuer>(
      TOKEN_ISSUER_FACTORY_BASE_TYPE,
      null,
      options
    );

    if (!tokenIssuer) {
      throw new Error('Failed to create default token issuer');
    }

    return tokenIssuer;
  }
}
