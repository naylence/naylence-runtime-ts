import { createResource } from '@naylence/factory';
import { getLogger } from '../util/logging.js';
import {
  getProfile,
  registerProfile,
} from '../profile/profile-registry.js';
import {
  ROUTING_POLICY_FACTORY_BASE,
  RoutingPolicyFactory,
  type RoutingPolicy,
  type RoutingPolicyConfig,
} from './routing-policy.js';

const logger = getLogger('naylence.fame.sentinel.routing_profile_factory');

export const PROFILE_NAME_DEVELOPMENT = 'development';
export const PROFILE_NAME_PRODUCTION = 'production';
export const PROFILE_NAME_BASIC = 'basic';
export const PROFILE_NAME_CAPABILITY_AWARE = 'capability-aware';
export const PROFILE_NAME_HYBRID_ONLY = 'hybrid-only';

const DEVELOPMENT_PROFILE: RoutingPolicyConfig = {
  type: 'CompositeRoutingPolicy',
  policies: [
    {
      type: 'HybridPathRoutingPolicy',
      loadBalancingStrategy: { type: 'HRWLoadBalancingStrategy' },
    },
  ],
};

const PRODUCTION_PROFILE: RoutingPolicyConfig = {
  type: 'CompositeRoutingPolicy',
  policies: [
    { type: 'CapabilityAwareRoutingPolicy' },
    {
      type: 'HybridPathRoutingPolicy',
      loadBalancingStrategy: { type: 'HRWLoadBalancingStrategy' },
    },
  ],
};

const BASIC_PROFILE = DEVELOPMENT_PROFILE;

const CAPABILITY_AWARE_PROFILE: RoutingPolicyConfig = {
  type: 'CapabilityAwareRoutingPolicy',
};

const HYBRID_ONLY_PROFILE: RoutingPolicyConfig = {
  type: 'HybridPathRoutingPolicy',
  loadBalancingStrategy: { type: 'HRWLoadBalancingStrategy' },
};

registerProfile(
  ROUTING_POLICY_FACTORY_BASE,
  PROFILE_NAME_DEVELOPMENT,
  DEVELOPMENT_PROFILE,
  { source: 'routing-profile-factory' }
);
registerProfile(
  ROUTING_POLICY_FACTORY_BASE,
  PROFILE_NAME_PRODUCTION,
  PRODUCTION_PROFILE,
  { source: 'routing-profile-factory' }
);
registerProfile(
  ROUTING_POLICY_FACTORY_BASE,
  PROFILE_NAME_BASIC,
  BASIC_PROFILE,
  { source: 'routing-profile-factory' }
);
registerProfile(
  ROUTING_POLICY_FACTORY_BASE,
  PROFILE_NAME_CAPABILITY_AWARE,
  CAPABILITY_AWARE_PROFILE,
  { source: 'routing-profile-factory' }
);
registerProfile(
  ROUTING_POLICY_FACTORY_BASE,
  PROFILE_NAME_HYBRID_ONLY,
  HYBRID_ONLY_PROFILE,
  { source: 'routing-profile-factory' }
);

export interface RoutingProfileConfig extends RoutingPolicyConfig {
  type: 'RoutingProfile';
  profile?: string | null;
}

interface NormalizedRoutingProfileConfig {
  profile: string;
}

export const FACTORY_META = {
  base: ROUTING_POLICY_FACTORY_BASE,
  key: 'RoutingProfile',
} as const;

export class RoutingProfileFactory extends RoutingPolicyFactory {
  public readonly type = 'RoutingProfile';

  public async create(
    config?: RoutingProfileConfig | Record<string, unknown> | null,
    ...kwargs: unknown[]
  ): Promise<RoutingPolicy> {
    const normalized = this.normalizeConfig(config);
    logger.debug('enabling_routing_profile', { profile: normalized.profile });

    const routingConfig = this.getProfileConfig(normalized.profile);

    const policy = await createResource<RoutingPolicy>(
      ROUTING_POLICY_FACTORY_BASE,
      routingConfig,
      {
        factoryArgs: kwargs,
        validate: false,
      }
    );

    if (!policy) {
      throw new Error(
        `Failed to create routing policy for profile ${normalized.profile}`
      );
    }

    return policy;
  }

  private normalizeConfig(
    config?: RoutingProfileConfig | Record<string, unknown> | null
  ): NormalizedRoutingProfileConfig {
    if (!config) {
      return { profile: PROFILE_NAME_DEVELOPMENT };
    }

    if ('type' in config) {
      const typeValue = (config as { type?: unknown }).type;
      if (typeValue !== undefined && typeValue !== 'RoutingProfile') {
        throw new Error(
          `RoutingProfileFactory only supports RoutingProfile config, got type ${String(typeValue)}`
        );
      }
    }

    const profileValue = this.resolveProfileValue(config);

    if (profileValue === undefined || profileValue === null) {
      return { profile: PROFILE_NAME_DEVELOPMENT };
    }

    if (typeof profileValue !== 'string' || profileValue.trim().length === 0) {
      throw new Error('profile must be a non-empty string when provided');
    }

    return { profile: profileValue };
  }

  private resolveProfileValue(
    config: RoutingProfileConfig | Record<string, unknown>
  ): unknown {
    if ('profile' in config) {
      return (config as { profile?: unknown }).profile;
    }

    const candidate = config as Record<string, unknown>;
    for (const key of ['profile_name', 'profileName'] as const) {
      if (Object.prototype.hasOwnProperty.call(candidate, key)) {
        return candidate[key];
      }
    }

    return undefined;
  }

  private getProfileConfig(profile: string): RoutingPolicyConfig {
    const routingConfig = getProfile(
      ROUTING_POLICY_FACTORY_BASE,
      profile
    ) as RoutingPolicyConfig | null;
    if (!routingConfig) {
      throw new Error('Unknown routing profile');
    }

    return routingConfig;
  }
}

export default RoutingProfileFactory;
