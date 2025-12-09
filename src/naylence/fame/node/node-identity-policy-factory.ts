import type { CreateResourceOptions, ResourceConfig } from '@naylence/factory';
import {
  AbstractResourceFactory,
  createDefaultResource,
  createResource,
} from '@naylence/factory';
import type { NodeIdentityPolicy } from './node-identity-policy.js';

export const NODE_IDENTITY_POLICY_FACTORY_BASE_TYPE = 'NodeIdentityPolicyFactory';

export interface NodeIdentityPolicyConfig extends ResourceConfig {
  type: string;
  [key: string]: unknown;
}

export abstract class NodeIdentityPolicyFactory<
  C extends NodeIdentityPolicyConfig = NodeIdentityPolicyConfig,
> extends AbstractResourceFactory<NodeIdentityPolicy, C> {
  public abstract create(
    config?: C | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<NodeIdentityPolicy>;

  public static async createNodeIdentityPolicy<
    C extends NodeIdentityPolicyConfig = NodeIdentityPolicyConfig,
  >(
    config?: C | Record<string, unknown> | null,
    options: CreateResourceOptions = {}
  ): Promise<NodeIdentityPolicy> {
    if (config) {
      const policy = await createResource<NodeIdentityPolicy>(
        NODE_IDENTITY_POLICY_FACTORY_BASE_TYPE,
        config,
        options
      );

      if (!policy) {
        throw new Error('Failed to create node identity policy from configuration');
      }

      return policy;
    }

    const policy = await createDefaultResource<NodeIdentityPolicy>(
      NODE_IDENTITY_POLICY_FACTORY_BASE_TYPE,
      null,
      options
    );

    if (!policy) {
      throw new Error('Failed to create default node identity policy');
    }

    return policy;
  }
}
