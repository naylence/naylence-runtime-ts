import { createResource } from '@naylence/factory';
import { getLogger } from '../../util/logging.js';

import type { LoadBalancingStrategy } from './load-balancing-strategy.js';
import {
  LOAD_BALANCING_STRATEGY_FACTORY_BASE,
  LoadBalancingStrategyFactory,
  type LoadBalancingStrategyConfig,
} from './load-balancing-strategy-factory.js';

const logger = getLogger(
  'naylence.fame.sentinel.load_balancing.load_balancing_profile_factory'
);

export const PROFILE_NAME_RANDOM = 'random';
export const PROFILE_NAME_ROUND_ROBIN = 'round_robin';
export const PROFILE_NAME_HRW = 'hrw';
export const PROFILE_NAME_STICKY_HRW = 'sticky-hrw';
export const PROFILE_NAME_DEVELOPMENT = 'development';

const RANDOM_PROFILE: LoadBalancingStrategyConfig = {
  type: 'RandomLoadBalancingStrategy',
};
const ROUND_ROBIN_PROFILE: LoadBalancingStrategyConfig = {
  type: 'RoundRobinLoadBalancingStrategy',
};
const HRW_PROFILE: LoadBalancingStrategyConfig = {
  type: 'HRWLoadBalancingStrategy',
};
const STICKY_HRW_PROFILE: LoadBalancingStrategyConfig = {
  type: 'HRWLoadBalancingStrategy',
  stickyAttribute: 'session_id',
} as LoadBalancingStrategyConfig & { stickyAttribute: string };
const DEVELOPMENT_PROFILE: LoadBalancingStrategyConfig = {
  type: 'RoundRobinLoadBalancingStrategy',
};

export interface LoadBalancingProfileConfig
  extends LoadBalancingStrategyConfig {
  type: 'LoadBalancingProfile';
  profile?: string | null;
}

export const FACTORY_META = {
  base: LOAD_BALANCING_STRATEGY_FACTORY_BASE,
  key: 'LoadBalancingProfile',
} as const;

export class LoadBalancingProfileFactory extends LoadBalancingStrategyFactory {
  public readonly type = 'LoadBalancingProfile';

  public async create(
    config?: LoadBalancingProfileConfig | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<LoadBalancingStrategy> {
    const finalConfig = this.normalizeConfig(config);

    const profileName = finalConfig.profile ?? PROFILE_NAME_DEVELOPMENT;
    logger.debug('enabling_load_balancing_profile', { profile: profileName });

    const strategyConfig = this.resolveProfile(profileName);

    const strategy = await createResource<LoadBalancingStrategy>(
      LOAD_BALANCING_STRATEGY_FACTORY_BASE,
      strategyConfig,
      { factoryArgs }
    );

    if (!strategy) {
      throw new Error(
        `Failed to instantiate load balancing profile: ${profileName}`
      );
    }

    return strategy;
  }

  private normalizeConfig(
    config?: LoadBalancingProfileConfig | Record<string, unknown> | null
  ): LoadBalancingProfileConfig {
    if (!config) {
      return { type: this.type, profile: PROFILE_NAME_DEVELOPMENT };
    }

    if (
      (config as { type?: unknown }).type &&
      (config as { type?: unknown }).type !== this.type
    ) {
      throw new Error(
        'LoadBalancingProfileFactory only supports profile configurations'
      );
    }

  const profileCandidate = this.extractProfile(config);
    if (
      profileCandidate !== undefined &&
      profileCandidate !== null &&
      typeof profileCandidate !== 'string'
    ) {
      throw new Error('profile must be a string when provided');
    }

    return {
      type: this.type,
      profile:
        (profileCandidate as string | undefined | null) ??
        PROFILE_NAME_DEVELOPMENT,
    };
  }

  private extractProfile(
    config: LoadBalancingProfileConfig | Record<string, unknown>
  ): unknown {
    const typedCandidate = config as { profile?: unknown };
    if (Object.prototype.hasOwnProperty.call(typedCandidate, 'profile')) {
      return typedCandidate.profile;
    }

    const recordCandidate = config as Record<string, unknown>;
    for (const key of ['profile_name', 'profileName'] as const) {
      if (Object.prototype.hasOwnProperty.call(recordCandidate, key)) {
        return recordCandidate[key];
      }
    }

    return undefined;
  }

  private resolveProfile(profile: string): LoadBalancingStrategyConfig {
    switch (profile) {
      case PROFILE_NAME_RANDOM:
        return RANDOM_PROFILE;
      case PROFILE_NAME_ROUND_ROBIN:
        return ROUND_ROBIN_PROFILE;
      case PROFILE_NAME_HRW:
        return HRW_PROFILE;
      case PROFILE_NAME_STICKY_HRW:
        return STICKY_HRW_PROFILE;
      case PROFILE_NAME_DEVELOPMENT:
        return DEVELOPMENT_PROFILE;
      default:
        throw new Error(`Unknown load balancing profile: ${profile}`);
    }
  }
}

export default LoadBalancingProfileFactory;
