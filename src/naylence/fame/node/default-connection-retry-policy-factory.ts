import {
  DefaultConnectionRetryPolicy,
  type DefaultConnectionRetryPolicyOptions,
} from './default-connection-retry-policy.js';
import {
  CONNECTION_RETRY_POLICY_FACTORY_BASE_TYPE,
  ConnectionRetryPolicyFactory,
  type ConnectionRetryPolicyConfig,
} from './connection-retry-policy-factory.js';
import type { ConnectionRetryPolicy } from './connection-retry-policy.js';
import { getLogger } from '../util/logging.js';

const logger = getLogger(
  'naylence.fame.node.default-connection-retry-policy-factory'
);

export interface DefaultConnectionRetryPolicyConfig extends ConnectionRetryPolicyConfig {
  type: 'DefaultConnectionRetryPolicy';
}

export const FACTORY_META = {
  base: CONNECTION_RETRY_POLICY_FACTORY_BASE_TYPE,
  key: 'DefaultConnectionRetryPolicy',
} as const;

export class DefaultConnectionRetryPolicyFactory extends ConnectionRetryPolicyFactory<DefaultConnectionRetryPolicyConfig> {
  public readonly type = 'DefaultConnectionRetryPolicy';
  public readonly isDefault = true;

  public async create(
    config?: DefaultConnectionRetryPolicyConfig | Record<string, unknown> | null
  ): Promise<ConnectionRetryPolicy> {
    const options: DefaultConnectionRetryPolicyOptions = {};

    if (config) {
      const rawMax =
        (config as Record<string, unknown>).maxInitialAttempts ??
        (config as Record<string, unknown>).max_initial_attempts;

      if (rawMax !== undefined && rawMax !== null) {
        options.maxInitialAttempts =
          typeof rawMax === 'string' ? parseInt(rawMax, 10) : Number(rawMax);
      }
    }

    const policy = new DefaultConnectionRetryPolicy(options);
    logger.debug('connection_retry_policy_created', {
      maxInitialAttempts: policy.maxInitialAttempts,
    });
    return policy;
  }
}

export default DefaultConnectionRetryPolicyFactory;
