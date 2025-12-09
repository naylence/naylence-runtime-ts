import type { AuthIdentity } from '../security/auth/auth-identity.js';

export interface NodeIdentityPolicyContext {
  /**
   * The node ID determined so far (e.g. provided by caller, or generated
   * via fingerprint/random).
   */
  currentNodeId: string;
  identities: AuthIdentity[];
}

export interface InitialIdentityContext {
  readonly configuredId?: string | null;
  readonly persistedId?: string | null;
}

export interface NodeIdentityPolicy {
  /**
   * Determines the initial node ID for the node.
   * This is called during node initialization, before any admission attempts.
   */
  resolveInitialNodeId(context: InitialIdentityContext): Promise<string>;

  /**
   * Optionally adjusts the node ID based on the provided context.
   * Returns the final node ID to use.
   */
  resolveAdmissionNodeId(context: NodeIdentityPolicyContext): Promise<string>;
}

