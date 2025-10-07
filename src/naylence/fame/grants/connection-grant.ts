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
> = ConnectionGrant<TConfig> | (Grant & Record<string, unknown>);

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
