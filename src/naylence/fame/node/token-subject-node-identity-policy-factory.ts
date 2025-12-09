import {
  NODE_IDENTITY_POLICY_FACTORY_BASE_TYPE,
  NodeIdentityPolicyFactory,
  type NodeIdentityPolicyConfig,
} from './node-identity-policy-factory.js';
import type { NodeIdentityPolicy } from './node-identity-policy.js';

export interface TokenSubjectNodeIdentityPolicyConfig
  extends NodeIdentityPolicyConfig {
  type: 'TokenSubjectNodeIdentityPolicy';
}

export const FACTORY_META = {
  base: NODE_IDENTITY_POLICY_FACTORY_BASE_TYPE,
  key: 'TokenSubjectNodeIdentityPolicy',
} as const;

export class TokenSubjectNodeIdentityPolicyFactory extends NodeIdentityPolicyFactory<TokenSubjectNodeIdentityPolicyConfig> {
  public readonly type = 'TokenSubjectNodeIdentityPolicy';

  public async create(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _config?:
      | TokenSubjectNodeIdentityPolicyConfig
      | Record<string, unknown>
      | null
  ): Promise<NodeIdentityPolicy> {
    const { TokenSubjectNodeIdentityPolicy } = await import(
      './token-subject-node-identity-policy.js'
    );
    return new TokenSubjectNodeIdentityPolicy();
  }
}

export default TokenSubjectNodeIdentityPolicyFactory;
