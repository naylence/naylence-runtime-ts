import { z } from 'zod';

import type { NodePlacementStrategy } from './node-placement-strategy.js';
import {
  NODE_PLACEMENT_STRATEGY_FACTORY_BASE_TYPE,
  NodePlacementStrategyFactory,
  registerNodePlacementStrategyFactory,
  type NodePlacementConfig,
} from './node-placement-strategy-factory.js';
import { StaticNodePlacementStrategy } from './static-node-placement-strategy.js';

export interface StaticNodePlacementConfig extends NodePlacementConfig {
  type: 'StaticNodePlacementStrategy' | 'WebSocketNodePlacementStrategy';
  targetSystemId?: string;
  targetPhysicalPath?: string;
  target_system_id?: string;
  target_physical_path?: string;
}

const staticNodePlacementConfigSchema = z
  .object({
    type: z
      .enum(['StaticNodePlacementStrategy', 'WebSocketNodePlacementStrategy'])
      .default('StaticNodePlacementStrategy'),
    targetSystemId: z
      .string({ message: 'targetSystemId must be a string' })
      .min(1, { message: 'targetSystemId cannot be empty' }),
    targetPhysicalPath: z
      .string({ message: 'targetPhysicalPath must be a string' })
      .min(1, { message: 'targetPhysicalPath cannot be empty' }),
  })
  .passthrough();

function normalizeConfig(
  config?: StaticNodePlacementConfig | Record<string, unknown> | null
): StaticNodePlacementConfig & {
  targetSystemId: string;
  targetPhysicalPath: string;
} {
  const candidate: Record<string, unknown> = {
    ...(config as Record<string, unknown> | undefined),
  };

  if (candidate.type === 'WebSocketNodePlacementStrategy') {
    emitDeprecationWarning();
  }

  if (
    candidate.targetSystemId === undefined &&
    typeof candidate.target_system_id === 'string'
  ) {
    candidate.targetSystemId = candidate.target_system_id;
  }
  if (
    candidate.targetPhysicalPath === undefined &&
    typeof candidate.target_physical_path === 'string'
  ) {
    candidate.targetPhysicalPath = candidate.target_physical_path;
  }

  const parsed = staticNodePlacementConfigSchema.parse({
    ...candidate,
    type: 'StaticNodePlacementStrategy',
  });

  return {
    ...parsed,
    targetSystemId: parsed.targetSystemId,
    targetPhysicalPath: parsed.targetPhysicalPath,
  };
}

function emitDeprecationWarning(): void {
  const message =
    'WebSocketNodePlacementStrategy is deprecated; use StaticNodePlacementStrategy instead';
  if (
    typeof process !== 'undefined' &&
    typeof process.emitWarning === 'function'
  ) {
    process.emitWarning(message, { type: 'DeprecationWarning' });
  } else {
    console.warn(message);
  }
}

export class StaticNodePlacementStrategyFactory extends NodePlacementStrategyFactory<StaticNodePlacementConfig> {
  public readonly type = 'StaticNodePlacementStrategy';
  public readonly isDefault = true;

  public async create(
    config?: StaticNodePlacementConfig | Record<string, unknown> | null
  ): Promise<NodePlacementStrategy> {
    if (!config) {
      throw new Error('StaticNodePlacementStrategy requires configuration');
    }

    const normalized = normalizeConfig(config);

    return new StaticNodePlacementStrategy({
      targetSystemId: normalized.targetSystemId,
      targetPhysicalPath: normalized.targetPhysicalPath,
    });
  }
}

export const FACTORY_META = {
  base: NODE_PLACEMENT_STRATEGY_FACTORY_BASE_TYPE,
  key: 'StaticNodePlacementStrategy',
} as const;

registerNodePlacementStrategyFactory(
  'StaticNodePlacementStrategy',
  StaticNodePlacementStrategyFactory,
  {
    isDefault: true,
  }
);
registerNodePlacementStrategyFactory(
  'WebSocketNodePlacementStrategy',
  StaticNodePlacementStrategyFactory
);

export default StaticNodePlacementStrategyFactory;
