import type { ConnectorConfig } from '../connector/connector-config.js';
import { assertGrant, isGrant, type Grant } from './grant.js';

export interface ConnectionGrant<
  TConfig extends ConnectorConfig = ConnectorConfig,
> extends Grant {
  /** Optional helper mirroring Python implementation. */
  toConnectorConfig?: () => TConfig;
}

export type ConnectionGrantLike<
  TConfig extends ConnectorConfig = ConnectorConfig,
> = ConnectionGrant<TConfig> | (Partial<Grant> & Record<string, unknown>);

const AUTH_INJECTION_STRATEGY_TYPE_ALIASES: Record<string, string> = {
  BearerTokenHeaderAuthInjectionStrategy: 'BearerTokenHeaderAuth',
  BearerTokenHeaderAuthStrategy: 'BearerTokenHeaderAuth',
  NoAuthInjectionStrategy: 'NoAuth',
  QueryParamAuthInjectionStrategy: 'QueryParamAuth',
  QueryParamAuthStrategy: 'QueryParamAuth',
  WebSocketSubprotocolAuthInjectionStrategy: 'WebSocketSubprotocolAuth',
  WebSocketSubprotocolAuthStrategy: 'WebSocketSubprotocolAuth',
};

export function canonicalizeAuthConfig(
  auth: Record<string, unknown> | undefined | null
): Record<string, unknown> | undefined {
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
    return undefined;
  }

  const typeValue = (auth as { type?: unknown }).type;
  if (typeof typeValue !== 'string') {
    return auth;
  }

  const normalizedType =
    AUTH_INJECTION_STRATEGY_TYPE_ALIASES[typeValue] ?? typeValue;
  if (normalizedType === typeValue) {
    return auth;
  }

  return {
    ...auth,
    type: normalizedType,
  };
}

export function isConnectionGrant<
  TConfig extends ConnectorConfig = ConnectorConfig,
>(candidate: unknown): candidate is ConnectionGrant<TConfig> {
  return isGrant(candidate);
}

export function assertConnectionGrant<
  TConfig extends ConnectorConfig = ConnectorConfig,
>(
  candidate: unknown,
  message = 'Invalid connection grant'
): asserts candidate is ConnectionGrant<TConfig> {
  assertGrant(candidate, message);
}
