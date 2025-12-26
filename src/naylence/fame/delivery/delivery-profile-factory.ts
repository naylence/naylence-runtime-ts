import { Expressions } from '@naylence/factory';

import type { DeliveryPolicy } from './delivery-policy.js';
import type { DeliveryPolicyConfig } from './delivery-policy-config.js';
import {
  DELIVERY_POLICY_FACTORY_BASE_TYPE,
  DeliveryPolicyFactory,
} from './delivery-policy-factory.js';
import type { AtLeastOnceDeliveryPolicyConfig } from './at-least-once-delivery-policy-factory.js';
import type { AtMostOnceDeliveryPolicyConfig } from './at-most-once-delivery-policy-factory.js';
import { getLogger } from '../util/logging.js';
import {
  getProfile,
  registerProfile,
} from '../profile/profile-registry.js';

const logger = getLogger('naylence.fame.delivery.delivery_profile_factory');

export interface DeliveryProfileConfig extends DeliveryPolicyConfig {
  type: 'DeliveryProfile';
  profile?: string | null;
}

export const PROFILE_NAME_AT_LEAST_ONCE = 'at-least-once';
export const PROFILE_NAME_AT_MOST_ONCE = 'at-most-once';

const ENV_VAR_FAME_DELIVERY_MAX_RETRIES = 'FAME_DELIVERY_MAX_RETRIES';
const ENV_VAR_FAME_DELIVERY_BASE_DELAY_MS = 'FAME_DELIVERY_BASE_DELAY_MS';
const ENV_VAR_FAME_DELIVERY_MAX_DELAY_MS = 'FAME_DELIVERY_MAX_DELAY_MS';
const ENV_VAR_FAME_DELIVERY_JITTER_MS = 'FAME_DELIVERY_JITTER_MS';
const ENV_VAR_FAME_DELIVERY_BACKOFF_FACTOR = 'FAME_DELIVERY_BACKOFF_FACTOR';

const AT_LEAST_ONCE_PROFILE: AtLeastOnceDeliveryPolicyConfig = {
  type: 'AtLeastOnceDeliveryPolicy',
  senderRetryPolicy: {
    maxRetries: Expressions.env(ENV_VAR_FAME_DELIVERY_MAX_RETRIES, '5'),
    baseDelayMs: Expressions.env(ENV_VAR_FAME_DELIVERY_BASE_DELAY_MS, '1000'),
    maxDelayMs: Expressions.env(ENV_VAR_FAME_DELIVERY_MAX_DELAY_MS, '10000'),
    jitterMs: Expressions.env(ENV_VAR_FAME_DELIVERY_JITTER_MS, '200'),
    backoffFactor: Expressions.env(ENV_VAR_FAME_DELIVERY_BACKOFF_FACTOR, '2.0'),
  },
  receiverRetryPolicy: {
    maxRetries: Expressions.env(ENV_VAR_FAME_DELIVERY_MAX_RETRIES, '6'),
    baseDelayMs: Expressions.env(ENV_VAR_FAME_DELIVERY_BASE_DELAY_MS, '100'),
    maxDelayMs: Expressions.env(ENV_VAR_FAME_DELIVERY_MAX_DELAY_MS, '2000'),
    jitterMs: Expressions.env(ENV_VAR_FAME_DELIVERY_JITTER_MS, '50'),
    backoffFactor: Expressions.env(ENV_VAR_FAME_DELIVERY_BACKOFF_FACTOR, '1.8'),
  },
};

const AT_MOST_ONCE_PROFILE: AtMostOnceDeliveryPolicyConfig = {
  type: 'AtMostOnceDeliveryPolicy',
};

registerProfile(
  DELIVERY_POLICY_FACTORY_BASE_TYPE,
  PROFILE_NAME_AT_LEAST_ONCE,
  AT_LEAST_ONCE_PROFILE,
  { source: 'delivery-profile-factory' }
);
registerProfile(
  DELIVERY_POLICY_FACTORY_BASE_TYPE,
  PROFILE_NAME_AT_MOST_ONCE,
  AT_MOST_ONCE_PROFILE,
  { source: 'delivery-profile-factory' }
);

export class DeliveryProfileFactory extends DeliveryPolicyFactory<DeliveryProfileConfig> {
  public readonly type = 'DeliveryProfile';

  public async create(
    config?: DeliveryProfileConfig | Record<string, unknown> | null
  ): Promise<DeliveryPolicy> {
    const normalized = normalizeDeliveryProfileConfig(config);
    const profileConfig = resolveProfileConfig(normalized.profile);

    logger.debug('enabling_delivery_profile', { profile: normalized.profile });

    const policy =
      await DeliveryPolicyFactory.createDeliveryPolicy(profileConfig);
    if (!policy) {
      throw new Error(
        `Failed to create delivery policy for profile: ${normalized.profile}`
      );
    }

    return policy;
  }
}

interface NormalizedDeliveryProfileConfig {
  readonly profile: string;
}

function normalizeDeliveryProfileConfig(
  config: DeliveryProfileConfig | Record<string, unknown> | null | undefined
): NormalizedDeliveryProfileConfig {
  if (!config) {
    return { profile: PROFILE_NAME_AT_LEAST_ONCE };
  }

  const candidate = config as DeliveryProfileConfig & Record<string, unknown>;
  const profileValue = resolveProfileName(candidate);
  candidate.profile = profileValue;

  return { profile: profileValue.toLowerCase() };
}

function resolveProfileName(candidate: Record<string, unknown>): string {
  const value = coerceProfileString(candidate.profile);
  if (value) {
    return value;
  }

  const legacyKeys = ['profile_name', 'profileName'] as const;
  for (const legacyKey of legacyKeys) {
    const legacyValue = coerceProfileString(candidate[legacyKey]);
    if (legacyValue) {
      candidate.profile = legacyValue;
      return legacyValue;
    }
  }

  return PROFILE_NAME_AT_LEAST_ONCE;
}

function coerceProfileString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveProfileConfig(profileName: string): DeliveryPolicyConfig {
  const profile = getProfile(
    DELIVERY_POLICY_FACTORY_BASE_TYPE,
    profileName
  ) as DeliveryPolicyConfig | null;
  if (!profile) {
    throw new Error(`Unknown delivery profile: ${profileName}`);
  }

  return profile;
}

export const FACTORY_META = {
  base: DELIVERY_POLICY_FACTORY_BASE_TYPE,
  key: 'DeliveryProfile',
} as const;

export default DeliveryProfileFactory;
