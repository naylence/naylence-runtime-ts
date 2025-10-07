import type { ConnectorConfig } from '../connector/connector-config.js';
import type { AuthInjectionStrategyConfig } from '../security/auth/auth-injection-strategy-factory.js';
import {
  assertConnectionGrant,
  type ConnectionGrant,
  type ConnectionGrantLike,
  isConnectionGrant,
} from './connection-grant.js';

export const HTTP_CONNECTION_GRANT_TYPE = 'HttpConnectionGrant' as const;
export const HTTP_STATELESS_CONNECTOR_TYPE = 'HttpStatelessConnector' as const;

export type HttpConnectionGrantAuth =
  | AuthInjectionStrategyConfig
  | Record<string, unknown>
  | undefined;

export interface HttpConnectionGrant extends ConnectionGrant {
  type: typeof HTTP_CONNECTION_GRANT_TYPE;
  url: string;
  auth?: HttpConnectionGrantAuth;
}

export type HttpConnectionGrantLike = ConnectionGrantLike & {
  type?: string;
  url?: unknown;
  auth?: HttpConnectionGrantAuth;
};

export type HttpStatelessConnectorConfigLike = ConnectorConfig & {
  type: typeof HTTP_STATELESS_CONNECTOR_TYPE;
  url: string;
  auth?: HttpConnectionGrantAuth;
};

export function isHttpConnectionGrant(
  candidate: unknown
): candidate is HttpConnectionGrant {
  return (
    isConnectionGrant(candidate) &&
    (candidate as Partial<HttpConnectionGrant>).type ===
      HTTP_CONNECTION_GRANT_TYPE &&
    typeof (candidate as Partial<HttpConnectionGrant>).url === 'string'
  );
}

export function normalizeHttpConnectionGrant(
  candidate: HttpConnectionGrantLike
): HttpConnectionGrant {
  assertConnectionGrant(
    candidate,
    'HttpConnectionGrant requires a valid base grant'
  );

  const type = candidate.type ?? HTTP_CONNECTION_GRANT_TYPE;
  if (type !== HTTP_CONNECTION_GRANT_TYPE) {
    throw new TypeError(
      `HttpConnectionGrant expected type "${HTTP_CONNECTION_GRANT_TYPE}", received "${type}"`
    );
  }

  const urlValue = candidate.url;
  if (typeof urlValue !== 'string' || urlValue.trim().length === 0) {
    throw new TypeError(
      'HttpConnectionGrant requires a non-empty string "url" field'
    );
  }

  return {
    type,
    purpose:
      typeof candidate.purpose === 'string' && candidate.purpose.length > 0
        ? candidate.purpose
        : 'connection',
    url: urlValue,
    auth: candidate.auth,
  };
}

export function httpGrantToConnectorConfig(
  grant: HttpConnectionGrantLike
): HttpStatelessConnectorConfigLike {
  const normalized = normalizeHttpConnectionGrant(grant);
  return {
    type: HTTP_STATELESS_CONNECTOR_TYPE,
    url: normalized.url,
    auth: normalized.auth,
  } satisfies HttpStatelessConnectorConfigLike;
}
