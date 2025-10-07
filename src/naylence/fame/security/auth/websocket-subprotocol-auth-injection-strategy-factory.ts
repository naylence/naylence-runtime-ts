import type { AuthInjectionStrategy } from './auth-injection-strategy.js';
import {
  AUTH_INJECTION_STRATEGY_FACTORY_BASE_TYPE,
  AuthInjectionStrategyFactory,
  type AuthInjectionStrategyConfig,
} from './auth-injection-strategy-factory.js';
import { WebSocketSubprotocolAuthInjectionStrategy } from './websocket-subprotocol-auth-injection-strategy.js';
import type { TokenProviderConfig } from './token-provider-factory.js';

export interface WebSocketSubprotocolAuthInjectionConfig
  extends AuthInjectionStrategyConfig {
  type: 'WebSocketSubprotocolAuth';
  tokenProvider: TokenProviderConfig | Record<string, unknown>;
  token_provider?: TokenProviderConfig | Record<string, unknown>;
  subprotocolPrefix?: string;
  subprotocol_prefix?: string;
  param?: string;
}

interface NormalizedWebSocketConfig {
  type: 'WebSocketSubprotocolAuth';
  tokenProvider: TokenProviderConfig | Record<string, unknown>;
  subprotocolPrefix: string;
}

export const FACTORY_META = {
  base: AUTH_INJECTION_STRATEGY_FACTORY_BASE_TYPE,
  key: 'WebSocketSubprotocolAuth',
} as const;

export class WebSocketSubprotocolAuthInjectionStrategyFactory extends AuthInjectionStrategyFactory<WebSocketSubprotocolAuthInjectionConfig> {
  public readonly type = 'WebSocketSubprotocolAuth';

  public async create(
    config?:
      | WebSocketSubprotocolAuthInjectionConfig
      | Record<string, unknown>
      | null
  ): Promise<AuthInjectionStrategy> {
    const normalized = normalizeConfig(config);
    return new WebSocketSubprotocolAuthInjectionStrategy(normalized);
  }
}

function normalizeConfig(
  config?:
    | WebSocketSubprotocolAuthInjectionConfig
    | Record<string, unknown>
    | null
): NormalizedWebSocketConfig {
  if (!config) {
    throw new Error(
      'WebSocketSubprotocolAuthInjectionStrategy requires configuration'
    );
  }

  const candidate = config as WebSocketSubprotocolAuthInjectionConfig &
    Record<string, unknown>;
  const type = typeof candidate.type === 'string' ? candidate.type : undefined;
  if (type !== 'WebSocketSubprotocolAuth') {
    throw new Error(
      `WebSocketSubprotocolAuthInjectionStrategyFactory expects type "WebSocketSubprotocolAuth", got "${type ?? 'undefined'}"`
    );
  }

  const tokenProvider = candidate.tokenProvider ?? candidate.token_provider;
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
    type: 'WebSocketSubprotocolAuth',
    tokenProvider,
    subprotocolPrefix,
  };
}

export default WebSocketSubprotocolAuthInjectionStrategyFactory;
