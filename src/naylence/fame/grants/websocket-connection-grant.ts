import type { ConnectorConfig } from '../connector/connector-config.js';
import type { AuthInjectionStrategyConfig } from '../security/auth/auth-injection-strategy-factory.js';
import { GRANT_PURPOSE_NODE_ATTACH } from './grant.js';
import {
  canonicalizeAuthConfig,
  assertConnectionGrant,
  type ConnectionGrant,
  type ConnectionGrantLike,
  isConnectionGrant,
} from './connection-grant.js';

export const WEBSOCKET_CONNECTION_GRANT_TYPE =
  'WebSocketConnectionGrant' as const;

export type WebSocketConnectionGrantAuth =
  | AuthInjectionStrategyConfig
  | Record<string, unknown>
  | undefined;

export interface WebSocketConnectionGrant extends ConnectionGrant {
  type: typeof WEBSOCKET_CONNECTION_GRANT_TYPE;
  url?: string;
  auth?: WebSocketConnectionGrantAuth;
}

export type WebSocketConnectionGrantLike = ConnectionGrantLike & {
  type?: string;
  url?: unknown;
  auth?: WebSocketConnectionGrantAuth;
};

export type WebSocketConnectorConfigLike = ConnectorConfig & {
  type: 'WebSocketConnector';
  url?: string;
  auth?: WebSocketConnectionGrantAuth;
};

export function isWebSocketConnectionGrant(
  candidate: unknown
): candidate is WebSocketConnectionGrant {
  return (
    isConnectionGrant(candidate) &&
    (candidate as Partial<WebSocketConnectionGrant>).type ===
      WEBSOCKET_CONNECTION_GRANT_TYPE &&
    (typeof (candidate as Partial<WebSocketConnectionGrant>).url === 'string' ||
      typeof (candidate as Partial<WebSocketConnectionGrant>).url ===
        'undefined')
  );
}

export function normalizeWebSocketConnectionGrant(
  candidate: WebSocketConnectionGrantLike
): WebSocketConnectionGrant {
  const type =
    typeof candidate.type === 'string'
      ? candidate.type
      : WEBSOCKET_CONNECTION_GRANT_TYPE;
  if (type !== WEBSOCKET_CONNECTION_GRANT_TYPE) {
    throw new TypeError(
      `WebSocketConnectionGrant expected type "${WEBSOCKET_CONNECTION_GRANT_TYPE}", received "${type}"`
    );
  }

  const purpose =
    typeof candidate.purpose === 'string' && candidate.purpose.length > 0
      ? candidate.purpose
      : GRANT_PURPOSE_NODE_ATTACH;

  assertConnectionGrant(
    { ...candidate, type, purpose },
    'WebSocketConnectionGrant requires a valid base grant'
  );

  const urlValue = candidate.url;
  if (
    urlValue !== undefined &&
    (typeof urlValue !== 'string' || urlValue.trim().length === 0)
  ) {
    throw new TypeError(
      'WebSocketConnectionGrant "url" must be a non-empty string when provided'
    );
  }

  const base: WebSocketConnectionGrant = {
    type,
    purpose,
  };

  if (typeof urlValue === 'string') {
    base.url = urlValue;
  }

  const authConfig = canonicalizeAuthConfig(
    candidate.auth as Record<string, unknown> | undefined
  );
  if (authConfig) {
    base.auth = authConfig;
  }

  return base;
}

export function websocketGrantToConnectorConfig(
  grant: WebSocketConnectionGrantLike
): WebSocketConnectorConfigLike {
  const normalized = normalizeWebSocketConnectionGrant(grant);
  const config: WebSocketConnectorConfigLike = {
    type: 'WebSocketConnector',
  };

  if (normalized.url) {
    config.url = normalized.url;
  }

  if (normalized.auth !== undefined) {
    config.auth = normalized.auth;
  }

  return config;
}
