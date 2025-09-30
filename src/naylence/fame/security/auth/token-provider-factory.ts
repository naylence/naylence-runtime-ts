import type { CreateResourceOptions, ResourceConfig } from "naylence-factory";
import { AbstractResourceFactory, createDefaultResource, createResource } from "naylence-factory";
import type { TokenProvider } from "./token-provider.js";

export const TOKEN_PROVIDER_FACTORY_BASE_TYPE = "TokenProviderFactory";

export interface TokenProviderConfig extends ResourceConfig {
  type: string;
  [key: string]: unknown;
}

export abstract class TokenProviderFactory<
  C extends TokenProviderConfig = TokenProviderConfig,
> extends AbstractResourceFactory<TokenProvider, C> {
  public abstract create(
    config?: C | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<TokenProvider>;

  public static async createTokenProvider<C extends TokenProviderConfig = TokenProviderConfig>(
    config?: C | Record<string, unknown> | null,
    options: CreateResourceOptions = {}
  ): Promise<TokenProvider> {
    if (config) {
      const provider = await createResource<TokenProvider>(
        TOKEN_PROVIDER_FACTORY_BASE_TYPE,
        config,
        options
      );

      if (!provider) {
        throw new Error("Failed to create token provider from configuration");
      }

      return provider;
    }

    let provider: TokenProvider | null = null;
    try {
      provider = await createDefaultResource<TokenProvider>(
        TOKEN_PROVIDER_FACTORY_BASE_TYPE,
        null,
        options
      );
    } catch (error) {
      const message =
        "Failed to create default token provider" +
        (error instanceof Error && error.message ? `: ${error.message}` : "");
      throw new Error(message);
    }

    if (!provider) {
      throw new Error("Failed to create default token provider");
    }

    return provider;
  }
}
