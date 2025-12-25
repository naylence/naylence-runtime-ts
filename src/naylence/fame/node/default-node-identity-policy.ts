import { generateIdAsync } from '@naylence/core';
import type {
  InitialIdentityContext,
  NodeIdentityPolicy,
  NodeIdentityPolicyContext,
} from './node-identity-policy.js';

/**
 * Default node identity policy that preserves the current node ID.
 *
 * This policy does NOT derive identity from tokens or grants.
 * For token-subject-based identity, use TokenSubjectNodeIdentityPolicy.
 */
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
    if (context.currentNodeId) {
      return context.currentNodeId;
    }
    return await generateIdAsync({ mode: 'fingerprint' });
  }
}
