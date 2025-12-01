import type { ConnectorConfig } from '../connector/connector-config.js';
import { INPAGE_CONNECTOR_TYPE } from '../connector/inpage-connector.js';
import { GRANT_PURPOSE_NODE_ATTACH } from './grant.js';
import {
  assertConnectionGrant,
  type ConnectionGrant,
  type ConnectionGrantLike,
  isConnectionGrant,
} from './connection-grant.js';

export const INPAGE_CONNECTION_GRANT_TYPE = 'InPageConnectionGrant' as const;

export interface InPageConnectionGrant extends ConnectionGrant {
  type: typeof INPAGE_CONNECTION_GRANT_TYPE;
  channelName?: string;
  inboxCapacity?: number;
}

export type InPageConnectionGrantLike = ConnectionGrantLike & {
  type?: string;
  channelName?: unknown;
  channel_name?: unknown;
  inboxCapacity?: unknown;
  inbox_capacity?: unknown;
};

export type InPageConnectorConfigLike = ConnectorConfig & {
  type: typeof INPAGE_CONNECTOR_TYPE;
  channelName?: string;
  inboxCapacity?: number;
  initialTargetNodeId?: string | '*';
  localNodeId?: string;
};

export function isInPageConnectionGrant(
  candidate: unknown
): candidate is InPageConnectionGrant {
  if (!isConnectionGrant(candidate)) {
    return false;
  }

  const record = candidate as Partial<InPageConnectionGrant>;
  if (record.type !== INPAGE_CONNECTION_GRANT_TYPE) {
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

export function normalizeInPageConnectionGrant(
  candidate: InPageConnectionGrantLike
): InPageConnectionGrant {
  const type =
    typeof candidate.type === 'string'
      ? candidate.type
      : INPAGE_CONNECTION_GRANT_TYPE;
  if (type !== INPAGE_CONNECTION_GRANT_TYPE) {
    throw new TypeError(
      `InPageConnectionGrant expected type "${INPAGE_CONNECTION_GRANT_TYPE}", received "${type}"`
    );
  }

  const purpose =
    typeof candidate.purpose === 'string' && candidate.purpose.length > 0
      ? candidate.purpose
      : GRANT_PURPOSE_NODE_ATTACH;

  assertConnectionGrant(
    { ...candidate, type, purpose },
    'InPageConnectionGrant requires a valid base grant'
  );

  const result: InPageConnectionGrant = {
    type,
    purpose,
  };

  const channelValue =
    candidate.channelName ?? (candidate as Record<string, unknown>)['channel_name'];
  if (channelValue !== undefined) {
    if (typeof channelValue !== 'string' || channelValue.trim().length === 0) {
      throw new TypeError(
        'InPageConnectionGrant "channelName" must be a non-empty string when provided'
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
        'InPageConnectionGrant "inboxCapacity" must be a positive number when provided'
      );
    }
    result.inboxCapacity = Math.floor(inboxValue);
  }

  return result;
}

export function inPageGrantToConnectorConfig(
  grant: InPageConnectionGrantLike
): InPageConnectorConfigLike {
  const normalized = normalizeInPageConnectionGrant(grant);
  const config: InPageConnectorConfigLike = {
    type: INPAGE_CONNECTOR_TYPE,
  };

  if (normalized.channelName) {
    config.channelName = normalized.channelName;
  }

  if (normalized.inboxCapacity !== undefined) {
    config.inboxCapacity = normalized.inboxCapacity;
  }

  return config;
}
