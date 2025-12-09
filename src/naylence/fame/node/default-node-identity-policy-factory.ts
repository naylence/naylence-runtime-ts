import { DefaultNodeIdentityPolicy } from './default-node-identity-policy.js';
import {
  NODE_IDENTITY_POLICY_FACTORY_BASE_TYPE,
  NodeIdentityPolicyFactory,
  type NodeIdentityPolicyConfig,
} from './node-identity-policy-factory.js';
import type { NodeIdentityPolicy } from './node-identity-policy.js';

export interface DefaultNodeIdentityPolicyConfig extends NodeIdentityPolicyConfig {
  type: 'DefaultNodeIdentityPolicy';
}

export const FACTORY_META = {
  base: NODE_IDENTITY_POLICY_FACTORY_BASE_TYPE,
  key: 'DefaultNodeIdentityPolicy',
} as const;

export class DefaultNodeIdentityPolicyFactory extends NodeIdentityPolicyFactory<DefaultNodeIdentityPolicyConfig> {
  public readonly type = 'DefaultNodeIdentityPolicy';
  public readonly isDefault = true;

  public async create(
    _config?: DefaultNodeIdentityPolicyConfig | Record<string, unknown> | null
  ): Promise<NodeIdentityPolicy> {
    return new DefaultNodeIdentityPolicy();
  }
}

export default DefaultNodeIdentityPolicyFactory;
