import type { AuthInjectionStrategy } from "./auth-injection-strategy.js";
import type { WebSocketSubprotocolAuthInjectionConfig } from "./websocket-subprotocol-auth-injection-strategy-factory.js";
import { TokenProviderFactory } from "./token-provider-factory.js";

export interface WebSocketSubprotocolAuthInjectionOptions {
  type?: "WebSocketSubprotocolAuth";
  tokenProvider: WebSocketSubprotocolAuthInjectionConfig["tokenProvider"];
  subprotocolPrefix: string;
}

export class WebSocketSubprotocolAuthInjectionStrategy implements AuthInjectionStrategy {
  public constructor(private readonly options: WebSocketSubprotocolAuthInjectionOptions) {}

  public async apply(_connector: unknown): Promise<void> {
    // Authentication occurs during WebSocket handshake via subprotocol list
  }

  public async getSubprotocols(): Promise<string[]> {
    const provider = await TokenProviderFactory.createTokenProvider(this.options.tokenProvider);
    const token = await provider.getToken();

    if (!token || typeof token.value !== "string" || token.value.length === 0) {
      return [];
    }

    return [this.options.subprotocolPrefix, token.value];
  }

  public async cleanup(): Promise<void> {
    // Nothing to clean up for WebSocket subprotocol injection
  }
}
