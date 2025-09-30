import type { ConnectorConfig } from "../../connector/connector-config.js";
import { InMemoryKeyValueStore } from "../../storage/in-memory-storage.js";
import type { KeyValueStore } from "../../storage/key-value-store.js";

export interface RouteEntry {
  systemId?: string;
  system_id?: string;
  assignedPath?: string | null;
  assigned_path?: string | null;
  instanceId?: string | null;
  instance_id?: string | null;
  connectorConfig?: ConnectorConfig | null;
  connector_config?: ConnectorConfig | null;
  durable?: boolean;
  attachExpiresAt?: string | number | Date | null;
  attach_expires_at?: string | number | Date | null;
  metadata?: Record<string, unknown> | null;
  callbackGrants?: Array<Record<string, unknown>> | null;
  callback_grants?: Array<Record<string, unknown>> | null;
  [key: string]: unknown;
}

export interface NormalizedRouteEntry {
  systemId: string;
  assignedPath: string | null;
  instanceId: string | null;
  connectorConfig: ConnectorConfig | null;
  durable: boolean;
  attachExpiresAt: Date | null;
  metadata: Record<string, unknown> | null;
  callbackGrants: Array<Record<string, unknown>> | null;
}

export type RouteStore = KeyValueStore<RouteEntry>;

let defaultRouteStore: RouteStore | null = null;

export function getDefaultRouteStore(): RouteStore {
  if (!defaultRouteStore) {
    defaultRouteStore = new InMemoryKeyValueStore<RouteEntry>();
  }
  return defaultRouteStore;
}

export {
  RouteStoreFactory,
  type RouteStoreConfig,
  ROUTE_STORE_FACTORY_BASE_TYPE,
} from "./route-store-factory.js";

export function normalizeRouteEntry(entry: RouteEntry): NormalizedRouteEntry {
  const systemId = pickString(entry.systemId ?? entry.system_id) ?? "";
  const assignedPath = pickString(entry.assignedPath ?? entry.assigned_path);
  const instanceId = pickString(entry.instanceId ?? entry.instance_id);
  const connectorConfig = pickConnectorConfig(entry.connectorConfig ?? entry.connector_config);
  const attachExpiresAt = pickDate(entry.attachExpiresAt ?? entry.attach_expires_at);
  const metadata = pickRecord(entry.metadata);
  const callbackGrants = pickRecordArray(entry.callbackGrants ?? entry.callback_grants);
  const durable = Boolean(entry.durable);

  return {
    systemId,
    assignedPath: assignedPath ?? null,
    instanceId: instanceId ?? null,
    connectorConfig: connectorConfig ?? null,
    durable,
    attachExpiresAt,
    metadata,
    callbackGrants,
  };
}

function pickString(value: unknown): string | null {
  if (typeof value === "string" && value.length) {
    return value;
  }
  return null;
}

function pickConnectorConfig(value: unknown): ConnectorConfig | null {
  if (
    value &&
    typeof value === "object" &&
    "type" in value &&
    typeof (value as { type?: unknown }).type === "string"
  ) {
    return value as ConnectorConfig;
  }
  return null;
}

function pickDate(value: unknown): Date | null {
  if (!value && value !== 0) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}

function pickRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function pickRecordArray(value: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const records: Array<Record<string, unknown>> = [];
  for (const item of value) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      records.push(item as Record<string, unknown>);
    }
  }

  return records.length ? records : null;
}
