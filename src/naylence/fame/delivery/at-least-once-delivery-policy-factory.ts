import type { DeliveryPolicy } from './delivery-policy.js';
import type { DeliveryPolicyConfig } from './delivery-policy-config.js';
import {
  DELIVERY_POLICY_FACTORY_BASE_TYPE,
  DeliveryPolicyFactory,
} from './delivery-policy-factory.js';
import { AtLeastOnceDeliveryPolicy } from './at-least-once-delivery-policy.js';
import { RetryPolicy, type RetryPolicyOptions } from './retry-policy.js';

export interface AtLeastOnceDeliveryPolicyConfig extends DeliveryPolicyConfig {
  type: 'AtLeastOnceDeliveryPolicy';
  senderRetryPolicy?:
    | RetryPolicy
    | RetryPolicyOptions
    | Record<string, unknown>
    | null;
  receiverRetryPolicy?:
    | RetryPolicy
    | RetryPolicyOptions
    | Record<string, unknown>
    | null;
}

type RetryPolicyInput =
  | RetryPolicy
  | RetryPolicyOptions
  | Record<string, unknown>
  | null
  | undefined;

interface NormalizedAtLeastOnceConfig {
  readonly senderRetryPolicy?: RetryPolicy | undefined;
  readonly receiverRetryPolicy?: RetryPolicy | undefined;
}

const LEGACY_POLICY_KEYS: Record<
  'senderRetryPolicy' | 'receiverRetryPolicy',
  string[]
> = {
  senderRetryPolicy: ['sender_retry_policy', 'sender_retryPolicy'],
  receiverRetryPolicy: ['receiver_retry_policy', 'receiver_retryPolicy'],
};

export class AtLeastOnceDeliveryPolicyFactory extends DeliveryPolicyFactory<AtLeastOnceDeliveryPolicyConfig> {
  public readonly type = 'AtLeastOnceDeliveryPolicy';
  public override readonly isDefault = true;

  public async create(
    config?: AtLeastOnceDeliveryPolicyConfig | Record<string, unknown> | null
  ): Promise<DeliveryPolicy> {
    const normalized = normalizeAtLeastOnceConfig(config);

    const options = {
      ...(normalized.senderRetryPolicy
        ? { senderRetryPolicy: normalized.senderRetryPolicy }
        : {}),
      ...(normalized.receiverRetryPolicy
        ? { receiverRetryPolicy: normalized.receiverRetryPolicy }
        : {}),
    };

    return new AtLeastOnceDeliveryPolicy(options);
  }
}

function normalizeAtLeastOnceConfig(
  config:
    | AtLeastOnceDeliveryPolicyConfig
    | Record<string, unknown>
    | null
    | undefined
): NormalizedAtLeastOnceConfig {
  if (!config) {
    return {};
  }

  const candidate = config as AtLeastOnceDeliveryPolicyConfig &
    Record<string, unknown>;
  const senderPolicyInput = getRetryPolicyInput(candidate, 'senderRetryPolicy');
  const receiverPolicyInput = getRetryPolicyInput(
    candidate,
    'receiverRetryPolicy'
  );

  return {
    senderRetryPolicy: resolveRetryPolicy(senderPolicyInput),
    receiverRetryPolicy: resolveRetryPolicy(receiverPolicyInput),
  };
}

function getRetryPolicyInput(
  candidate: Record<string, unknown>,
  key: keyof typeof LEGACY_POLICY_KEYS
): RetryPolicyInput {
  const camelKey = key as string;
  const primary = candidate[camelKey] as RetryPolicyInput;
  if (primary !== undefined) {
    return primary;
  }

  const legacyKeys = LEGACY_POLICY_KEYS[key] ?? [];
  for (const legacyKey of legacyKeys) {
    const value = candidate[legacyKey];
    if (value !== undefined) {
      candidate[camelKey] = value;
      return value as RetryPolicyInput;
    }
  }

  return undefined;
}

function resolveRetryPolicy(input: RetryPolicyInput): RetryPolicy | undefined {
  if (!input) {
    return undefined;
  }

  if (input instanceof RetryPolicy) {
    return input;
  }

  const record = input as Record<string, unknown>;

  const options: RetryPolicyOptions = {
    ...(withOption(record, ['maxRetries', 'max_retries']) ?? {}),
    ...(withOption(record, ['baseDelayMs', 'base_delay_ms']) ?? {}),
    ...(withOption(record, ['maxDelayMs', 'max_delay_ms']) ?? {}),
    ...(withOption(record, ['jitterMs', 'jitter_ms']) ?? {}),
    ...(withOption(record, ['backoffFactor', 'backoff_factor']) ?? {}),
  };

  return new RetryPolicy(options);
}

function extractNumber(
  source: Record<string, unknown>,
  keys: string[]
): number | undefined {
  for (const key of keys) {
    if (key in source) {
      const value = source[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }
      if (typeof value === 'string' && value.trim().length > 0) {
        const parsed = Number(value);
        if (!Number.isNaN(parsed)) {
          return parsed;
        }
      }
    }
  }
  return undefined;
}

function withOption(
  source: Record<string, unknown>,
  keys: string[]
): Partial<RetryPolicyOptions> | undefined {
  const value = extractNumber(source, keys);
  if (value === undefined) {
    return undefined;
  }

  const camelKey = keys[0];
  return {
    [camelKey as keyof RetryPolicyOptions]: value,
  } as Partial<RetryPolicyOptions>;
}

export const FACTORY_META = {
  base: DELIVERY_POLICY_FACTORY_BASE_TYPE,
  key: 'AtLeastOnceDeliveryPolicy',
} as const;

export default AtLeastOnceDeliveryPolicyFactory;
