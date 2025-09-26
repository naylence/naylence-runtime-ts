import type { CreateResourceOptions, ResourceConfig } from 'naylence-factory';
import { AbstractResourceFactory, createDefaultResource, createResource } from 'naylence-factory';
import type { NodeHelloFrame } from 'naylence-core';

export const NODE_PLACEMENT_STRATEGY_FACTORY_BASE_TYPE = 'NodePlacementStrategyFactory' as const;

export interface PlacementDecision {
  accept: boolean;
  assignedPath: string;
  targetSystemId?: string | null;
  targetPhysicalPath?: string | null;
  acceptedLogicals?: string[] | null;
  rejectedLogicals?: string[] | null;
  metadata?: Record<string, unknown> | null;
  expiresAt?: Date | string | null;
  reason?: string | null;
  [key: string]: unknown;
}

export interface NodePlacementStrategy {
  place(helloFrame: NodeHelloFrame): Promise<PlacementDecision>;
}

export interface NodePlacementConfig extends ResourceConfig {
  type: string;
  [key: string]: unknown;
}

export abstract class NodePlacementStrategyFactory<
  C extends NodePlacementConfig = NodePlacementConfig
> extends AbstractResourceFactory<NodePlacementStrategy, C> {
  public abstract create(
    config?: C | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<NodePlacementStrategy>;

  public static async createNodePlacementStrategy<
    C extends NodePlacementConfig = NodePlacementConfig
  >(
    config?: C | Record<string, unknown> | null,
    options: CreateResourceOptions = {}
  ): Promise<NodePlacementStrategy> {
    if (config) {
      const strategy = await createResource<NodePlacementStrategy>(
        NODE_PLACEMENT_STRATEGY_FACTORY_BASE_TYPE,
        config,
        options
      );

      if (!strategy) {
        throw new Error('Failed to create node placement strategy from configuration');
      }

      return strategy;
    }

    let strategy: NodePlacementStrategy | null = null;
    try {
      strategy = await createDefaultResource<NodePlacementStrategy>(
        NODE_PLACEMENT_STRATEGY_FACTORY_BASE_TYPE,
        null,
        options
      );
    } catch (error) {
      const message =
        'Failed to create default node placement strategy' +
        (error instanceof Error && error.message ? `: ${error.message}` : '');
      throw new Error(message);
    }

    if (!strategy) {
      throw new Error('Failed to create default node placement strategy');
    }

    return strategy;
  }
}
