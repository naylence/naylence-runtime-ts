import type {
  AuthorizationContext,
  FameDeliveryContext,
  FameEnvelope,
} from '@naylence/core';
import type { NodeLike } from '../../node/node-like.js';
import type { RuleAction } from './policy/authorization-policy-definition.js';

/**
 * Route authorization result returned by authorizeRoute.
 */
export interface RouteAuthorizationResult {
  /**
   * Whether the route action is authorized.
   */
  authorized: boolean;

  /**
   * The authorization context (if authorized).
   */
  authContext?: AuthorizationContext;

  /**
   * Reason for denial (for internal logging only, not for on-wire disclosure).
   */
  denialReason?: string;

  /**
   * Matched rule ID (for logging/audit).
   */
  matchedRule?: string;
}

export interface Authorizer {
  authenticate(
    credentials: string | Uint8Array
  ): Promise<AuthorizationContext | undefined>;

  authorize(
    node: NodeLike,
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<AuthorizationContext | undefined>;

  /**
   * Authorizes a routing action after the routing decision has been made.
   *
   * This method is called with the explicitly mapped action token from the
   * routing decision (ForwardUpstream, ForwardDownstream, ForwardPeer,
   * DeliverLocal). It does NOT receive RoutingAction objects to avoid
   * coupling authorization logic to routing execution behavior.
   *
   * @param node - The node handling the request
   * @param envelope - The FAME envelope being routed
   * @param action - The authorization action token (route-oriented)
   * @param context - Optional delivery context
   * @returns RouteAuthorizationResult if implemented, or undefined to allow
   */
  authorizeRoute?(
    node: NodeLike,
    envelope: FameEnvelope,
    action: RuleAction,
    context?: FameDeliveryContext
  ): Promise<RouteAuthorizationResult | undefined>;

  createReverseAuthorizationConfig?(
    node: NodeLike
  ):
    | Promise<Record<string, unknown> | undefined>
    | Record<string, unknown>
    | undefined;
}
