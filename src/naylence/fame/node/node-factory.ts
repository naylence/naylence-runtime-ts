import type { NodeEventListener } from './node-event-listener.js';
import { FameNode } from './node.js';
import type { FameNodeConfig } from './node-config.js';
import { normalizeFameNodeConfig } from './node-config.js';
import { makeCommonOptions } from './factory-commons.js';
import {
  NODE_LIKE_FACTORY_BASE_TYPE,
  NodeLikeFactory,
  //   registerNodeLikeFactory,
} from './node-like-factory.js';

export const FACTORY_META = {
  base: NODE_LIKE_FACTORY_BASE_TYPE,
  key: 'Node',
} as const;

export class NodeFactory extends NodeLikeFactory<FameNodeConfig> {
  public readonly type = 'Node';
  public readonly isDefault = true;
  public readonly priority = 100;

  public async create(
    config?: FameNodeConfig | Record<string, unknown> | null
  ): Promise<FameNode> {
  const normalized = normalizeFameNodeConfig(config ?? null);

  const components = await makeCommonOptions(normalized, config ?? null);

    const eventListeners: NodeEventListener[] = [...components.eventListeners];
    const serviceConfigs = components.serviceConfigs.filter(
      (config): config is Record<string, unknown> =>
        Boolean(config && typeof config === 'object')
    );

    const node = new FameNode({
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
      transportListeners: components.transportListeners,
      defaultServiceConfigs: serviceConfigs,
    });

    return node;
  }
}

// registerNodeLikeFactory("Node", NodeFactory);

export default NodeFactory;
