import type { ConnectorConfig } from '../connector/connector-config.js';
import {
  BROADCAST_CHANNEL_CONNECTOR_TYPE,
  type BroadcastChannelConnectorConfig,
} from '../connector/broadcast-channel-connector.js';
import { GRANT_PURPOSE_NODE_ATTACH } from './grant.js';
import {
  assertConnectionGrant,
  type ConnectionGrant,
  type ConnectionGrantLike,
  isConnectionGrant,
} from './connection-grant.js';

export const BROADCAST_CHANNEL_CONNECTION_GRANT_TYPE =
  'BroadcastChannelConnectionGrant' as const;

export interface BroadcastChannelConnectionGrant extends ConnectionGrant {
  type: typeof BROADCAST_CHANNEL_CONNECTION_GRANT_TYPE;
  channelName?: string;
  inboxCapacity?: number;
}

export type BroadcastChannelConnectionGrantLike = ConnectionGrantLike & {
  type?: string;
  channelName?: unknown;
  channel_name?: unknown;
  inboxCapacity?: unknown;
  inbox_capacity?: unknown;
};

export type BroadcastChannelConnectorConfigLike = ConnectorConfig &
  BroadcastChannelConnectorConfig;

export function isBroadcastChannelConnectionGrant(
  candidate: unknown
): candidate is BroadcastChannelConnectionGrant {
  if (!isConnectionGrant(candidate)) {
    return false;
  }

  const record = candidate as Partial<BroadcastChannelConnectionGrant>;
  if (record.type !== BROADCAST_CHANNEL_CONNECTION_GRANT_TYPE) {
    return false;
  }

  if (
    record.channelName !== undefined &&
    (typeof record.channelName !== 'string' || record.channelName.length === 0)
  ) {
    return false;
  }

  if (
    record.inboxCapacity !== undefined &&
    (!Number.isFinite(record.inboxCapacity) ||
      (record.inboxCapacity as number) <= 0)
  ) {
    return false;
  }

  return true;
}

export function normalizeBroadcastChannelConnectionGrant(
  candidate: BroadcastChannelConnectionGrantLike
): BroadcastChannelConnectionGrant {
  const type =
    typeof candidate.type === 'string'
      ? candidate.type
      : BROADCAST_CHANNEL_CONNECTION_GRANT_TYPE;
  if (type !== BROADCAST_CHANNEL_CONNECTION_GRANT_TYPE) {
    throw new TypeError(
      `BroadcastChannelConnectionGrant expected type "${BROADCAST_CHANNEL_CONNECTION_GRANT_TYPE}", received "${type}"`
    );
  }

  const purpose =
    typeof candidate.purpose === 'string' && candidate.purpose.length > 0
      ? candidate.purpose
      : GRANT_PURPOSE_NODE_ATTACH;

  assertConnectionGrant(
    { ...candidate, type, purpose },
    'BroadcastChannelConnectionGrant requires a valid base grant'
  );

  const result: BroadcastChannelConnectionGrant = {
    type,
    purpose,
  };

  const channelValue =
    candidate.channelName ?? (candidate as Record<string, unknown>)['channel_name'];
  if (channelValue !== undefined) {
    if (typeof channelValue !== 'string' || channelValue.trim().length === 0) {
      throw new TypeError(
        'BroadcastChannelConnectionGrant "channelName" must be a non-empty string when provided'
      );
    }
    result.channelName = channelValue.trim();
  }

  const inboxValue =
    candidate.inboxCapacity ?? (candidate as Record<string, unknown>)['inbox_capacity'];
  if (inboxValue !== undefined) {
    if (
      typeof inboxValue !== 'number' ||
      !Number.isFinite(inboxValue) ||
      inboxValue <= 0
    ) {
      throw new TypeError(
        'BroadcastChannelConnectionGrant "inboxCapacity" must be a positive number when provided'
      );
    }
    result.inboxCapacity = Math.floor(inboxValue);
  }

  return result;
}

export function broadcastChannelGrantToConnectorConfig(
  grant: BroadcastChannelConnectionGrantLike
): BroadcastChannelConnectorConfigLike {
  const normalized = normalizeBroadcastChannelConnectionGrant(grant);
  const config: BroadcastChannelConnectorConfigLike = {
    type: BROADCAST_CHANNEL_CONNECTOR_TYPE,
  };

  if (normalized.channelName) {
    config.channelName = normalized.channelName;
  }

  if (normalized.inboxCapacity !== undefined) {
    config.inboxCapacity = normalized.inboxCapacity;
  }

  return config;
}
