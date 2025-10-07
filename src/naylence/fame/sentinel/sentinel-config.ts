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

  const base = normalizeFameNodeConfig({ ...(input ?? {}), type: 'Node' });

  const peers = normalizePeerConfigs(source.peers);

  return {
    ...base,
    type: 'Sentinel',
    routingPolicy: (source.routingPolicy ?? null) as
      | RoutingPolicyConfig
      | Record<string, unknown>
      | null,
    loadBalancing: (source.loadBalancing ?? null) as
      | LoadBalancingStrategyConfig
      | Record<string, unknown>
      | null,
    stickiness: (source.stickiness ?? null) as
      | LoadBalancerStickinessManagerConfig
      | Record<string, unknown>
      | null,
    peers,
    maxAttachTtlSec: source.maxAttachTtlSec ?? null,
    bindingAckTimeoutMs: source.bindingAckTimeoutMs ?? null,
    attachTimeoutSec: source.attachTimeoutSec ?? null,
    routeStore: (source.routeStore ?? null) as
      | RouteStoreConfig
      | Record<string, unknown>
      | null,
  } satisfies NormalizedSentinelConfig;
}

export type { AdmissionConfig }; // re-export for convenience
