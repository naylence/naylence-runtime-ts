import type { AuthInjectionStrategy } from './auth-injection-strategy.js';
import type { QueryParamAuthInjectionStrategyConfig } from './query-param-auth-injection-strategy-factory.js';
import { TokenProviderFactory } from './token-provider-factory.js';

export interface QueryParamAuthInjectionStrategyOptions {
  type?: 'QueryParamAuth';
  tokenProvider: QueryParamAuthInjectionStrategyConfig['tokenProvider'];
  paramName: string;
}

export class QueryParamAuthInjectionStrategy implements AuthInjectionStrategy {
  public constructor(
    private readonly options: QueryParamAuthInjectionStrategyOptions
  ) {}

  public async apply(_connector: unknown): Promise<void> {
    // Query parameter strategies modify the URL at connection time only
  }

  public async modifyUrl(url: string): Promise<string> {
    const provider = await TokenProviderFactory.createTokenProvider(
      this.options.tokenProvider
    );
    const token = await provider.getToken();

    const [basePart, hashPart] = url.split('#', 2);
    const [pathPart, queryPart] = basePart.split('?', 2);
    const params = new URLSearchParams(queryPart ?? '');
    params.set(this.options.paramName, token.value);

    const queryString = params.toString();
    const rebuilt =
      queryString.length > 0 ? `${pathPart}?${queryString}` : pathPart;
    return hashPart ? `${rebuilt}#${hashPart}` : rebuilt;
  }

  public async cleanup(): Promise<void> {
    // Nothing to clean up for query parameter injection
  }
}
