import type { AuthInjectionStrategy } from './auth-injection-strategy.js';
import type { QueryParamAuthInjectionStrategyConfig } from './query-param-auth-injection-strategy-factory.js';
import { TokenProviderFactory } from './token-provider-factory.js';

export interface QueryParamAuthInjectionStrategyOptions {
  type?: 'QueryParamAuth';
  tokenProvider?: QueryParamAuthInjectionStrategyConfig['tokenProvider'] | null;
  token_provider?:
    | QueryParamAuthInjectionStrategyConfig['tokenProvider']
    | null;
  paramName?: string;
  param_name?: string;
  param?: string;
}

interface NormalizedQueryParamAuthInjectionStrategyOptions {
  tokenProvider: QueryParamAuthInjectionStrategyConfig['tokenProvider'];
  paramName: string;
}

function normalizeOptions(
  options: QueryParamAuthInjectionStrategyOptions | null | undefined
): NormalizedQueryParamAuthInjectionStrategyOptions {
  if (!options || typeof options !== 'object') {
    throw new TypeError(
      'QueryParamAuthInjectionStrategy options must be an object'
    );
  }

  const candidate = options as QueryParamAuthInjectionStrategyOptions &
    Record<string, unknown>;
  const type =
    typeof candidate.type === 'string' ? candidate.type : 'QueryParamAuth';
  if (type !== 'QueryParamAuth') {
    throw new Error(
      `QueryParamAuthInjectionStrategy expects type "QueryParamAuth", got "${type ?? 'undefined'}"`
    );
  }

  const tokenProvider =
    candidate.tokenProvider ?? candidate.token_provider ?? null;
  if (!tokenProvider) {
    throw new Error(
      'QueryParamAuthInjectionStrategy requires a tokenProvider configuration'
    );
  }

  const paramCandidate =
    candidate.paramName ?? candidate.param_name ?? candidate.param;
  const paramName =
    typeof paramCandidate === 'string' && paramCandidate.trim().length > 0
      ? paramCandidate.trim()
      : 'token';

  return {
    tokenProvider,
    paramName,
  };
}

export class QueryParamAuthInjectionStrategy implements AuthInjectionStrategy {
  private readonly options: NormalizedQueryParamAuthInjectionStrategyOptions;

  public constructor(options: QueryParamAuthInjectionStrategyOptions) {
    this.options = normalizeOptions(options);
  }

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
