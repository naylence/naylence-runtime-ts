import type { TokenProvider } from './token-provider.js';
import type { TokenProviderConfig } from './token-provider-factory.js';

export interface MaterializableTokenProvider extends TokenProvider {
  /**
   * Performs any necessary work to obtain a token (e.g. PKCE flow) and returns
   * a configuration for a TokenProvider that can supply that token statically.
   *
   * Returns undefined if materialization is not possible or not necessary.
   */
  materialize(): Promise<TokenProviderConfig | undefined>;
}

export function isMaterializableTokenProvider(
  candidate: unknown
): candidate is MaterializableTokenProvider {
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof (candidate as Partial<MaterializableTokenProvider>).materialize ===
      'function'
  );
}
