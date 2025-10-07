import { NoSecurityPolicy } from './no-security-policy.js';
import type { SecurityPolicy } from './security-policy.js';
import type { SecurityPolicyConfig } from './security-policy.js';
import {
  SECURITY_POLICY_FACTORY_BASE_TYPE,
  SecurityPolicyFactory,
} from './security-policy-factory.js';

export interface NoSecurityPolicyConfig extends SecurityPolicyConfig {
  type: 'NoSecurityPolicy';
}

export const FACTORY_META = {
  base: SECURITY_POLICY_FACTORY_BASE_TYPE,
  key: 'NoSecurityPolicy',
} as const;

export class NoSecurityPolicyFactory extends SecurityPolicyFactory<NoSecurityPolicyConfig> {
  public readonly type = 'NoSecurityPolicy';

  public async create(
    config?: NoSecurityPolicyConfig | Record<string, unknown> | null
  ): Promise<SecurityPolicy> {
    void normalizeConfig(config);
    return new NoSecurityPolicy();
  }
}

export default NoSecurityPolicyFactory;

function normalizeConfig(
  config?: NoSecurityPolicyConfig | Record<string, unknown> | null
): NoSecurityPolicyConfig {
  if (!config) {
    return { type: 'NoSecurityPolicy' };
  }

  const candidate = config as Record<string, unknown>;
  const typeValue =
    typeof candidate.type === 'string' ? candidate.type : 'NoSecurityPolicy';

  if (typeValue !== 'NoSecurityPolicy') {
    throw new Error(
      `NoSecurityPolicyFactory expects type "NoSecurityPolicy", got "${String(candidate.type)}"`
    );
  }

  return { type: 'NoSecurityPolicy' };
}
