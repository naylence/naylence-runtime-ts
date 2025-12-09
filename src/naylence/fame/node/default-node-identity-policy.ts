import { generateIdAsync } from '@naylence/core';
import type {
  InitialIdentityContext,
  NodeIdentityPolicy,
  NodeIdentityPolicyContext,
} from './node-identity-policy.js';

export class DefaultNodeIdentityPolicy implements NodeIdentityPolicy {
  public async resolveInitialNodeId(
    context: InitialIdentityContext
  ): Promise<string> {
    if (context.configuredId) {
      return context.configuredId;
    }

    if (context.persistedId) {
      return context.persistedId;
    }

    return await generateIdAsync({ mode: 'fingerprint' });
  }

  public async resolveAdmissionNodeId(
    context: NodeIdentityPolicyContext
  ): Promise<string> {
    return context.currentNodeId;
  }
}
