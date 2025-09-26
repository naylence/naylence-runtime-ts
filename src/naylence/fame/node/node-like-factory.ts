import type { CreateResourceOptions, ResourceConfig } from 'naylence-factory';
import { AbstractResourceFactory, createDefaultResource, createResource, registerFactory } from 'naylence-factory';

import type { NodeLike } from './node-like.js';

export const NODE_LIKE_FACTORY_BASE_TYPE = 'NodeLikeFactory';

export interface NodeLikeConfig extends ResourceConfig {
  type: string;
  [key: string]: unknown;
}

export abstract class NodeLikeFactory<C extends NodeLikeConfig = NodeLikeConfig>
  extends AbstractResourceFactory<NodeLike, C>
{
  public abstract create(
    config?: C | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<NodeLike>;

  public static async createNode(
    config?: NodeLikeConfig | Record<string, unknown> | null,
    options: CreateResourceOptions = {}
  ): Promise<NodeLike> {
    const configRecord = (config ?? null) as Record<string, unknown> | null;

    if (!configRecord) {
      const node = await createDefaultResource<NodeLike>(NODE_LIKE_FACTORY_BASE_TYPE, null, options);
      if (!node) {
        throw new Error('Failed to create default NodeLike resource');
      }
      return node;
    }

    const typeValue = configRecord.type as unknown;
    const hasType = typeof typeValue === 'string' && typeValue.length > 0;

    const node = hasType
      ? await createResource<NodeLike>(NODE_LIKE_FACTORY_BASE_TYPE, configRecord, options)
      : await createDefaultResource<NodeLike>(NODE_LIKE_FACTORY_BASE_TYPE, configRecord, options);

    if (!node) {
      throw new Error('Failed to create NodeLike resource');
    }

    return node;
  }
}

export function registerNodeLikeFactory(
  type: string,
  factory: new (...args: unknown[]) => NodeLikeFactory
): void {
  registerFactory(NODE_LIKE_FACTORY_BASE_TYPE, type, factory);
}
