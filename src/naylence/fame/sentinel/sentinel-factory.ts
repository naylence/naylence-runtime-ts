import type { CreateResourceOptions } from 'naylence-factory';
import { createDefaultResource, createResource } from 'naylence-factory';

import { GRANT_PURPOSE_NODE_ATTACH } from '../grants/grant.js';
import { TTL_NEVER_EXPIRES } from '../constants/ttl-constants.js';
import type { AdmissionClient } from '../node/admission/admission-client.js';
import { AdmissionClientFactory } from '../node/admission/admission-client-factory.js';
import { makeCommonOptions } from '../node/factory-commons.js';
import type { NodeEventListener } from '../node/node-event-listener.js';
import {
  NODE_LIKE_FACTORY_BASE_TYPE,
  NodeLikeFactory,
  // registerNodeLikeFactory,
} from '../node/node-like-factory.js';
import { normalizeFameNodeConfig } from '../node/node-config.js';
import type { TransportListener } from '../connector/transport-listener.js';
import { TransportListenerFactory } from '../connector/transport-listener-factory.js';
import type { LoadBalancerStickinessManager } from '../stickiness/load-balancer-stickiness-manager.js';
import { LoadBalancerStickinessManagerFactory } from '../stickiness/load-balancer-stickiness-manager-factory.js';
import type { LoadBalancingStrategy } from './load-balancing/load-balancing-strategy.js';
import { CompositeLoadBalancingStrategy } from './load-balancing/composite-load-balancing-strategy.js';
import { StickyLoadBalancingStrategy } from './load-balancing/sticky-load-balancing-strategy.js';
import { LOAD_BALANCING_STRATEGY_FACTORY_BASE } from './load-balancing/load-balancing-strategy-factory.js';
import type { RoutingPolicy } from './routing-policy.js';
import {
  ROUTING_POLICY_FACTORY_BASE,
  RoutingPolicyFactory,
} from './routing-policy.js';
import { Peer } from './peer.js';
import { Sentinel } from './sentinel.js';
import type { SentinelOptions } from './sentinel.js';
import type { SentinelConfig } from './sentinel-config.js';
import { normalizeSentinelConfig } from './sentinel-config.js';
import type { PeerConfig } from './peer-config.js';
import {
  RouteStoreFactory,
  getDefaultRouteStore,
} from './store/route-store.js';
import type { RouteStore } from './store/route-store.js';
import type { LoadBalancerStickinessManagerConfig } from '../stickiness/load-balancer-stickiness-manager-factory.js';
import type { LoadBalancingStrategyConfig } from './load-balancing/load-balancing-strategy-factory.js';
import type { RoutingPolicyConfig } from './routing-policy.js';
import type { RouteStoreConfig } from './store/route-store-factory.js';
import type { AdmissionConfig } from './sentinel-config.js';

interface LoadBalancingOptions {
  strategyConfig: LoadBalancingStrategyConfig | Record<string, unknown> | null;
  stickinessManager: LoadBalancerStickinessManager | null;
}

export const FACTORY_META = {
  base: NODE_LIKE_FACTORY_BASE_TYPE,
  key: 'Sentinel',
} as const;

export class SentinelFactory extends NodeLikeFactory<SentinelConfig> {
  public readonly type = 'Sentinel';
  public readonly priority = 100;

  public async create(
    config?: SentinelConfig | Record<string, unknown> | null
  ): Promise<Sentinel> {
    const normalized = normalizeSentinelConfig(config);
    const baseNodeConfig = normalizeFameNodeConfig({
      ...(config ?? {}),
      type: 'Node' as const,
    });
    const components = await makeCommonOptions(baseNodeConfig);

    const eventListeners: NodeEventListener[] = [...components.eventListeners];
    const transportListeners = await this.ensureTransportListeners(
      components.transportListeners,
      eventListeners
    );

    const stickinessManager = await this.createStickinessManager(
      normalized.stickiness,
      components.keyStore
    );

    const loadBalancingStrategy = await this.createLoadBalancingStrategy({
      strategyConfig: normalized.loadBalancing,
      stickinessManager,
    });

    const routingPolicy = await this.createRoutingPolicy(
      normalized.routingPolicy,
      loadBalancingStrategy
    );

    const routeStore = await this.resolveRouteStore(normalized.routeStore);

    const peers = await this.createPeers(normalized.peers);

    const serviceConfigs = components.serviceConfigs.filter(
      (service): service is Record<string, unknown> =>
        Boolean(service && typeof service === 'object')
    );

    const sentinelOptions: SentinelOptions = {
      systemId: components.systemId,
      hasParent: components.hasParent,
      acceptedLogicals: components.requestedLogicals,
      requestedLogicals: components.requestedLogicals,
      storageProvider: components.storageProvider,
      deliveryPolicy: components.deliveryPolicy,
      eventListeners,
      admissionClient: components.admissionClient,
      attachClient: components.attachClient,
      securityManager: components.securityManager,
      cryptoProvider: components.cryptoProvider ?? null,
      publicUrl: components.publicUrl ?? null,
      deliveryTracker: components.deliveryTracker,
      bindingStore: components.bindingStore,
      nodeMetaStore: components.nodeMetaStore,
      transportListeners,
      defaultServiceConfigs: serviceConfigs,
      routeStore,
      routingPolicy,
      stickinessManager,
      attachmentKeyValidator: components.attachmentKeyValidator,
      peers,
    };

    if (normalized.maxAttachTtlSec !== undefined) {
      sentinelOptions.maxAttachTtlSec = normalized.maxAttachTtlSec;
    }
    if (normalized.bindingAckTimeoutMs !== null) {
      sentinelOptions.bindingAckTimeoutMs = normalized.bindingAckTimeoutMs;
    }

    return new Sentinel(sentinelOptions);
  }

  private async ensureTransportListeners(
    listeners: TransportListener[],
    eventListeners: NodeEventListener[]
  ): Promise<TransportListener[]> {
    const resolved = [...listeners];

    if (!resolved.length) {
      const defaultListener =
        await TransportListenerFactory.createTransportListener();
      if (defaultListener) {
        resolved.push(defaultListener);
        this.addEventListenerIfNeeded(defaultListener, eventListeners);
      }
    }

    for (const listener of resolved) {
      this.addEventListenerIfNeeded(listener, eventListeners);
    }

    return resolved;
  }

  private addEventListenerIfNeeded(
    listener: unknown,
    collection: NodeEventListener[]
  ): void {
    if (!listener || typeof listener !== 'object') {
      return;
    }

    const candidate = listener as NodeEventListener;
    if (typeof candidate.priority !== 'number') {
      return;
    }

    if (!collection.includes(candidate)) {
      collection.push(candidate);
      collection.sort((a, b) => a.priority - b.priority);
    }
  }

  private async createStickinessManager(
    config:
      | LoadBalancerStickinessManagerConfig
      | Record<string, unknown>
      | null,
    keyProvider: unknown
  ): Promise<LoadBalancerStickinessManager | null> {
    if (!config) {
      return null;
    }

    const manager =
      await LoadBalancerStickinessManagerFactory.createLoadBalancerStickinessManager(
        config,
        {
          factoryArgs: [{ keyProvider }],
        }
      );

    return manager ?? null;
  }

  private async createLoadBalancingStrategy(
    options: LoadBalancingOptions
  ): Promise<LoadBalancingStrategy> {
    const { strategyConfig, stickinessManager } = options;

    const factoryOptions: CreateResourceOptions = stickinessManager
      ? { factoryArgs: [{ stickinessManager }], validate: false }
      : { validate: false };

    let strategy: LoadBalancingStrategy | null = null;

    if (strategyConfig) {
      strategy = await createResource<LoadBalancingStrategy>(
        LOAD_BALANCING_STRATEGY_FACTORY_BASE,
        strategyConfig,
        factoryOptions
      );
    } else {
      strategy = await createDefaultResource<LoadBalancingStrategy>(
        LOAD_BALANCING_STRATEGY_FACTORY_BASE,
        null,
        factoryOptions
      );
    }

    if (!strategy) {
      throw new Error('Failed to create load balancing strategy');
    }

    if (!stickinessManager) {
      return strategy;
    }

    const stickyStrategy = new StickyLoadBalancingStrategy(stickinessManager);
    if (strategy instanceof StickyLoadBalancingStrategy) {
      return strategy;
    }

    return new CompositeLoadBalancingStrategy([stickyStrategy, strategy]);
  }

  private async createRoutingPolicy(
    config: RoutingPolicyConfig | Record<string, unknown> | null,
    loadBalancingStrategy: LoadBalancingStrategy
  ): Promise<RoutingPolicy> {
    if (config) {
      const policy = await createResource<RoutingPolicy>(
        ROUTING_POLICY_FACTORY_BASE,
        config,
        {
          factoryArgs: [loadBalancingStrategy],
          validate: false,
        }
      );

      if (!policy) {
        throw new Error('Failed to create routing policy from configuration');
      }

      return policy;
    }

    return RoutingPolicyFactory.createRoutingPolicy(loadBalancingStrategy);
  }

  private async resolveRouteStore(
    config: RouteStoreConfig | Record<string, unknown> | null
  ): Promise<RouteStore> {
    if (config) {
      const store = await RouteStoreFactory.createRouteStore(config);
      if (store) {
        return store;
      }
    }

    return getDefaultRouteStore();
  }

  private async createPeers(configs: PeerConfig[]): Promise<Peer[]> {
    if (!configs.length) {
      return [];
    }

    const peers: Peer[] = [];

    for (const config of configs) {
      const admissionClient = await this.resolvePeerAdmission(config);
      if (!admissionClient) {
        continue;
      }
      peers.push(new Peer({ admissionClient }));
    }

    return peers;
  }

  private async resolvePeerAdmission(
    config: PeerConfig
  ): Promise<AdmissionClient | null> {
    if (config.admission) {
      return AdmissionClientFactory.createAdmissionClient(
        config.admission as AdmissionConfig
      );
    }

    if (!config.directUrl) {
      return null;
    }

    const directAdmissionConfig = {
      type: 'DirectAdmissionClient',
      connectionGrants: [
        {
          type: 'WebSocketConnectionGrant',
          purpose: GRANT_PURPOSE_NODE_ATTACH,
          url: config.directUrl,
          auth: {
            type: 'WebSocketSubprotocolAuth',
            tokenProvider: { type: 'NoneTokenProvider' },
          },
        },
      ],
      ttlSec: TTL_NEVER_EXPIRES,
    } satisfies Record<string, unknown>;

    return AdmissionClientFactory.createAdmissionClient(directAdmissionConfig);
  }
}

// registerNodeLikeFactory("Sentinel", SentinelFactory as unknown as new () => SentinelFactory);

export default SentinelFactory;
