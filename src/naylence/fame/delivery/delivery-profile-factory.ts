import { Expressions } from 'naylence-factory';

import type { DeliveryPolicy } from './delivery-policy.js';
import type { DeliveryPolicyConfig } from './delivery-policy-config.js';
import {
  DELIVERY_POLICY_FACTORY_BASE_TYPE,
  DeliveryPolicyFactory,
} from './delivery-policy-factory.js';
import type { AtLeastOnceDeliveryPolicyConfig } from './at-least-once-delivery-policy-factory.js';
import type { AtMostOnceDeliveryPolicyConfig } from './at-most-once-delivery-policy-factory.js';
import { getLogger } from '../util/logging.js';

const logger = getLogger('delivery-profile-factory');

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

const PROFILE_MAP: Record<string, DeliveryPolicyConfig> = {
  [PROFILE_NAME_AT_LEAST_ONCE]: AT_LEAST_ONCE_PROFILE,
  [PROFILE_NAME_AT_MOST_ONCE]: AT_MOST_ONCE_PROFILE,
};

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
  const profileValue =
    typeof candidate.profile === 'string' && candidate.profile.trim().length > 0
      ? candidate.profile
      : typeof candidate.profile_name === 'string' &&
          candidate.profile_name.trim().length > 0
        ? candidate.profile_name
        : typeof candidate.profileName === 'string' &&
            candidate.profileName.trim().length > 0
          ? candidate.profileName
          : PROFILE_NAME_AT_LEAST_ONCE;

  return { profile: profileValue.toLowerCase() };
}

function resolveProfileConfig(profileName: string): DeliveryPolicyConfig {
  const profile = PROFILE_MAP[profileName];
  if (!profile) {
    throw new Error(`Unknown delivery profile: ${profileName}`);
  }

  return deepClone(profile);
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export const FACTORY_META = {
  base: DELIVERY_POLICY_FACTORY_BASE_TYPE,
  key: 'DeliveryProfile',
} as const;

export default DeliveryProfileFactory;
