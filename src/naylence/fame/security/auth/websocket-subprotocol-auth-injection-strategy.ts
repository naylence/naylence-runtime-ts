import type { AuthInjectionStrategy } from './auth-injection-strategy.js';
import type { WebSocketSubprotocolAuthInjectionConfig } from './websocket-subprotocol-auth-injection-strategy-factory.js';
import { TokenProviderFactory } from './token-provider-factory.js';

export interface WebSocketSubprotocolAuthInjectionOptions {
  type?: 'WebSocketSubprotocolAuth';
  tokenProvider?:
    | WebSocketSubprotocolAuthInjectionConfig['tokenProvider']
    | null;
  token_provider?:
    | WebSocketSubprotocolAuthInjectionConfig['tokenProvider']
    | null;
  subprotocolPrefix?: string;
  subprotocol_prefix?: string;
  param?: string;
}

interface NormalizedWebSocketSubprotocolAuthInjectionOptions {
  tokenProvider: WebSocketSubprotocolAuthInjectionConfig['tokenProvider'];
  subprotocolPrefix: string;
}

function normalizeOptions(
  options: WebSocketSubprotocolAuthInjectionOptions | null | undefined
): NormalizedWebSocketSubprotocolAuthInjectionOptions {
  if (!options || typeof options !== 'object') {
    throw new TypeError(
      'WebSocketSubprotocolAuthInjectionStrategy options must be an object'
    );
  }

  const candidate = options as WebSocketSubprotocolAuthInjectionOptions &
    Record<string, unknown>;
  const type =
    typeof candidate.type === 'string'
      ? candidate.type
      : 'WebSocketSubprotocolAuth';
  if (type !== 'WebSocketSubprotocolAuth') {
    throw new Error(
      `WebSocketSubprotocolAuthInjectionStrategy expects type "WebSocketSubprotocolAuth", got "${type ?? 'undefined'}"`
    );
  }

  const tokenProvider =
    candidate.tokenProvider ?? candidate.token_provider ?? null;
  if (!tokenProvider) {
    throw new Error(
      'WebSocketSubprotocolAuthInjectionStrategy requires a tokenProvider configuration'
    );
  }

  const prefixCandidate =
    candidate.subprotocolPrefix ??
    candidate.subprotocol_prefix ??
    candidate.param;
  const subprotocolPrefix =
    typeof prefixCandidate === 'string' && prefixCandidate.trim().length > 0
      ? prefixCandidate.trim()
      : 'bearer';

  return {
    tokenProvider,
    subprotocolPrefix,
  };
}

export class WebSocketSubprotocolAuthInjectionStrategy
  implements AuthInjectionStrategy
{
  private readonly options: NormalizedWebSocketSubprotocolAuthInjectionOptions;

  public constructor(options: WebSocketSubprotocolAuthInjectionOptions) {
    this.options = normalizeOptions(options);
  }

  public async apply(_connector: unknown): Promise<void> {
    // Authentication occurs during WebSocket handshake via subprotocol list
  }

  public async getSubprotocols(): Promise<string[]> {
    const provider = await TokenProviderFactory.createTokenProvider(
      this.options.tokenProvider
    );
    const token = await provider.getToken();

    if (!token || typeof token.value !== 'string' || token.value.length === 0) {
      return [];
    }

    return [this.options.subprotocolPrefix, token.value];
  }

  public async cleanup(): Promise<void> {
    // Nothing to clean up for WebSocket subprotocol injection
  }
}
