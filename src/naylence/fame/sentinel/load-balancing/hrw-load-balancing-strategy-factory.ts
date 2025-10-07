import { createResource } from 'naylence-factory';
import type { LoadBalancingStrategy } from './load-balancing-strategy.js';
import {
  LOAD_BALANCING_STRATEGY_FACTORY_BASE,
  LoadBalancingStrategyFactory,
  type LoadBalancingStrategyConfig,
} from './load-balancing-strategy-factory.js';
import { HRWLoadBalancingStrategy } from './hrw-load-balancing-strategy.js';

export interface HRWLoadBalancingStrategyConfig
  extends LoadBalancingStrategyConfig {
  type: 'HRWLoadBalancingStrategy';
  stickyAttribute?: string | null;
}

export const FACTORY_META = {
  base: LOAD_BALANCING_STRATEGY_FACTORY_BASE,
  key: 'HRWLoadBalancingStrategy',
} as const;

export class HRWLoadBalancingStrategyFactory extends LoadBalancingStrategyFactory {
  public readonly type = 'HRWLoadBalancingStrategy';
  public readonly isDefault = true;
  public readonly priority = 100;

  public async create(
    config?: HRWLoadBalancingStrategyConfig | Record<string, unknown> | null,
    ..._kwargs: unknown[]
  ): Promise<LoadBalancingStrategy> {
    const finalConfig = this.normalizeConfig(config);
    const strategy = new HRWLoadBalancingStrategy({
      stickyAttribute: finalConfig.stickyAttribute ?? null,
    });
    return strategy;
  }

  private normalizeConfig(
    config?: HRWLoadBalancingStrategyConfig | Record<string, unknown> | null
  ): HRWLoadBalancingStrategyConfig {
    if (!config) {
      return { type: 'HRWLoadBalancingStrategy', stickyAttribute: null };
    }

    if ('type' in config && config.type !== 'HRWLoadBalancingStrategy') {
      throw new Error(
        `HRWLoadBalancingStrategyFactory only supports HRWLoadBalancingStrategy config, got type ${String(
          (config as { type?: unknown }).type
        )}`
      );
    }

    if (
      typeof config.stickyAttribute === 'string' ||
      config.stickyAttribute === null ||
      config.stickyAttribute === undefined
    ) {
      return {
        type: 'HRWLoadBalancingStrategy',
        stickyAttribute: config.stickyAttribute ?? null,
      };
    }

    const stickyAttribute = (config as Record<string, unknown>).stickyAttribute;
    if (stickyAttribute !== undefined && typeof stickyAttribute !== 'string') {
      throw new Error('stickyAttribute must be a string when provided');
    }

    return {
      type: 'HRWLoadBalancingStrategy',
      stickyAttribute: (stickyAttribute as string | undefined) ?? null,
    };
  }
}

export async function createDefaultHRWStrategy(
  config?: HRWLoadBalancingStrategyConfig | Record<string, unknown> | null
): Promise<LoadBalancingStrategy> {
  const strategy = await createResource<LoadBalancingStrategy>(
    LOAD_BALANCING_STRATEGY_FACTORY_BASE,
    config ?? { type: 'HRWLoadBalancingStrategy' }
  );

  if (!strategy) {
    throw new Error('Failed to create HRW load balancing strategy');
  }

  return strategy;
}

export default HRWLoadBalancingStrategyFactory;
