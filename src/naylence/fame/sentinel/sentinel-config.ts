import { z } from 'zod';

import type { AdmissionConfig } from '../node/admission/admission-client-factory.js';
import type { FameNodeConfig } from '../node/node-config.js';
import { normalizeFameNodeConfig } from '../node/node-config.js';
import type { LoadBalancerStickinessManagerConfig } from '../stickiness/load-balancer-stickiness-manager-factory.js';
import type { LoadBalancingStrategyConfig } from './load-balancing/load-balancing-strategy-factory.js';
import type { RoutingPolicyConfig } from './routing-policy.js';
import type { RouteStoreConfig } from './store/route-store-factory.js';
import { normalizePeerConfigs, type PeerConfig } from './peer-config.js';

export type SentinelConfig = Omit<FameNodeConfig, 'type'> & {
  type: 'Sentinel';
  routingPolicy?: RoutingPolicyConfig | Record<string, unknown> | null;
  loadBalancing?: LoadBalancingStrategyConfig | Record<string, unknown> | null;
  stickiness?:
    | LoadBalancerStickinessManagerConfig
    | Record<string, unknown>
    | null;
  peers?: Array<PeerConfig | Record<string, unknown>> | null;
  maxAttachTtlSec?: number | null;
  bindingAckTimeoutMs?: number | null;
  attachTimeoutSec?: number | null;
  routeStore?: RouteStoreConfig | Record<string, unknown> | null;
};

export type NormalizedSentinelConfig = Omit<FameNodeConfig, 'type'> & {
  type: 'Sentinel';
  routingPolicy: RoutingPolicyConfig | Record<string, unknown> | null;
  loadBalancing: LoadBalancingStrategyConfig | Record<string, unknown> | null;
  stickiness:
    | LoadBalancerStickinessManagerConfig
    | Record<string, unknown>
    | null;
  peers: PeerConfig[];
  maxAttachTtlSec: number | null;
  bindingAckTimeoutMs: number | null;
  attachTimeoutSec: number | null;
  routeStore: RouteStoreConfig | Record<string, unknown> | null;
};

const SentinelExtrasSchema = z
  .object({
    type: z.literal('Sentinel').default('Sentinel'),
    routingPolicy: z.unknown().optional().nullable(),
    loadBalancing: z.unknown().optional().nullable(),
    stickiness: z.unknown().optional().nullable(),
    peers: z.unknown().optional().nullable(),
    maxAttachTtlSec: z.number().min(0).optional().nullable(),
    bindingAckTimeoutMs: z.number().min(0).optional().nullable(),
    attachTimeoutSec: z.number().min(0).optional().nullable(),
    routeStore: z.unknown().optional().nullable(),
  })
  .passthrough();

export function normalizeSentinelConfig(
  input?: Partial<SentinelConfig> | Record<string, unknown> | null
): NormalizedSentinelConfig {
  const source = SentinelExtrasSchema.parse(input ?? {});
  const extrasRecord = isPlainRecord(input)
    ? {
        ...(input as Record<string, unknown>),
        ...(source as Record<string, unknown>),
      }
    : (source as Record<string, unknown>);

  const base = normalizeFameNodeConfig({ ...(input ?? {}), type: 'Node' });

  const peersSource =
    source.peers ?? extrasRecord.peer_configs ?? extrasRecord.peers;
  const peers = normalizePeerConfigs(peersSource);

  const routingPolicyConfig = pickConfigEntry<
    RoutingPolicyConfig | Record<string, unknown>
  >(source.routingPolicy, extrasRecord, 'routing_policy');

  const loadBalancingConfig = pickConfigEntry<
    LoadBalancingStrategyConfig | Record<string, unknown>
  >(source.loadBalancing, extrasRecord, 'load_balancing');

  const stickinessConfig = pickConfigEntry<
    LoadBalancerStickinessManagerConfig | Record<string, unknown>
  >(source.stickiness, extrasRecord, 'stickiness_manager');

  const routeStoreConfig = pickConfigEntry<
    RouteStoreConfig | Record<string, unknown>
  >(source.routeStore, extrasRecord, 'route_store');

  const maxAttachTtlSec = pickNumberOption(
    source.maxAttachTtlSec,
    extrasRecord,
    'max_attach_ttl_sec'
  );

  const bindingAckTimeoutMs = pickNumberOption(
    source.bindingAckTimeoutMs,
    extrasRecord,
    'binding_ack_timeout_ms'
  );

  const attachTimeoutSec = pickNumberOption(
    source.attachTimeoutSec,
    extrasRecord,
    'attach_timeout_sec'
  );

  return {
    ...base,
    type: 'Sentinel',
    routingPolicy: routingPolicyConfig,
    loadBalancing: loadBalancingConfig,
    stickiness: stickinessConfig,
    peers,
    maxAttachTtlSec,
    bindingAckTimeoutMs,
    attachTimeoutSec,
    routeStore: routeStoreConfig,
  } satisfies NormalizedSentinelConfig;
}

export type { AdmissionConfig }; // re-export for convenience

function pickConfigEntry<T>(
  primary: unknown,
  record: Record<string, unknown>,
  ...aliases: string[]
): T | null {
  if (primary !== undefined && primary !== null) {
    return primary as T;
  }

  for (const alias of aliases) {
    if (alias in record) {
      const candidate = record[alias];
      if (candidate === null) {
        return null;
      }
      if (candidate !== undefined) {
        return candidate as T;
      }
    }
  }

  return null;
}

function pickNumberOption(
  primary: unknown,
  record: Record<string, unknown>,
  ...aliases: string[]
): number | null {
  if (typeof primary === 'number' && Number.isFinite(primary)) {
    return primary;
  }
  if (primary === null) {
    return null;
  }

  for (const alias of aliases) {
    if (!(alias in record)) {
      continue;
    }

    const candidate = record[alias];
    if (candidate === null) {
      return null;
    }

    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
  }

  return null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
