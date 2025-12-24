import type { FameDeliveryContext, FameEnvelope } from '@naylence/core';
import type { NodeLike } from '../../../node/node-like.js';
import type { RuleAction } from './authorization-policy-definition.js';

/**
 * The effect of an authorization decision.
 */
export type AuthorizationEffect = 'allow' | 'deny';

/**
 * Represents a single step in the policy evaluation process.
 * Useful for debugging and auditing authorization decisions.
 */
export interface AuthorizationEvaluationStep {
  /** Rule identifier that was evaluated */
  ruleId: string;

  /** Expression or condition that was evaluated */
  expression?: string;

  /** Result of the evaluation */
  result: boolean;

  /** Context values used in evaluation (for debugging) */
  boundValues?: Record<string, unknown>;
}

/**
 * The result of an authorization policy evaluation.
 */
export interface AuthorizationDecision {
  /** The authorization effect: allow or deny */
  effect: AuthorizationEffect;

  /** Human-readable reason for the decision */
  reason?: string;

  /** Identifier of the rule that matched (for debugging/audit) */
  matchedRule?: string;

  /** Evaluation trace for detailed debugging */
  evaluationTrace?: AuthorizationEvaluationStep[];
}

/**
 * Interface for authorization policies that evaluate whether a request
 * should be allowed or denied.
 *
 * The policy receives the same parameters as `Authorizer.authorize`,
 * giving it full access to the node, envelope, and delivery context
 * for making authorization decisions.
 */
export interface AuthorizationPolicy {
  /**
   * Evaluates an authorization request and returns a decision.
   *
   * @param node - The node handling the request
   * @param envelope - The FAME envelope being authorized
   * @param context - Optional delivery context with authorization info, origin, etc.
   * @param action - Optional authorization action token (route-oriented: Connect,
   *                 ForwardUpstream, ForwardDownstream, ForwardPeer, DeliverLocal, '*')
   * @returns A decision indicating whether to allow or deny the request
   */
  evaluateRequest(
    node: NodeLike,
    envelope: FameEnvelope,
    context?: FameDeliveryContext,
    action?: RuleAction
  ): Promise<AuthorizationDecision>;
}
