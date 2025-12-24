import type {
  AuthorizationContext,
  FameDeliveryContext,
  FameEnvelope,
} from '@naylence/core';
import { createAuthorizationContext } from '@naylence/core';

import { getLogger } from '../../util/logging.js';
import type { NodeLike } from '../../node/node-like.js';
import type { PolicyAuthorizer } from './policy-authorizer.js';
import type {
  AuthorizationPolicy,
  AuthorizationDecision,
} from './policy/authorization-policy.js';
import type { AuthorizationPolicySource } from './policy/authorization-policy-source.js';
import type { TokenVerifier } from './token-verifier.js';
import type { TokenVerifierProvider } from './token-verifier-provider.js';
import type { RouteAuthorizationResult } from './authorizer.js';
import type { RuleAction } from './policy/authorization-policy-definition.js';

const logger = getLogger(
  'naylence.fame.security.auth.default_policy_authorizer'
);

function decodeCredentials(credentials: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder().decode(credentials);
  }

  if (typeof Buffer !== 'undefined') {
    return Buffer.from(credentials).toString('utf-8');
  }

  throw new Error(
    'Unable to decode credential bytes without TextDecoder support'
  );
}

function normalizeToken(credentials: string | Uint8Array): string | undefined {
  const raw =
    typeof credentials === 'string'
      ? credentials
      : decodeCredentials(credentials);
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  if (trimmed.toLowerCase().startsWith('bearer ')) {
    const candidate = trimmed.slice(7).trim();
    return candidate.length > 0 ? candidate : undefined;
  }

  return trimmed;
}

/**
 * Options for creating a DefaultPolicyAuthorizer.
 */
export interface DefaultPolicyAuthorizerOptions {
  /**
   * Token verifier for authenticating credentials.
   */
  tokenVerifier?: TokenVerifier;
  token_verifier?: TokenVerifier;

  /**
   * The authorization policy to use for authorization decisions.
   * Either policy or policySource must be provided.
   */
  policy?: AuthorizationPolicy;

  /**
   * A source to load the authorization policy from.
   * Either policy or policySource must be provided.
   */
  policySource?: AuthorizationPolicySource;
  policy_source?: AuthorizationPolicySource;
}

interface NormalizedOptions {
  tokenVerifier?: TokenVerifier;
  policy?: AuthorizationPolicy;
  policySource?: AuthorizationPolicySource;
}

function normalizeOptions(
  options: DefaultPolicyAuthorizerOptions | null | undefined
): NormalizedOptions {
  if (options === undefined || options === null) {
    return {};
  }

  if (typeof options !== 'object') {
    throw new TypeError('DefaultPolicyAuthorizer options must be an object');
  }

  const candidate = options as DefaultPolicyAuthorizerOptions;
  return {
    tokenVerifier: candidate.tokenVerifier ?? candidate.token_verifier,
    policy: candidate.policy,
    policySource: candidate.policySource ?? candidate.policy_source,
  };
}

/**
 * An authorizer that delegates authorization decisions to a pluggable policy.
 *
 * This authorizer combines token-based authentication with policy-based
 * authorization. The token verifier handles authentication (validating
 * credentials), while the authorization policy handles authorization
 * decisions (allow/deny based on the request context).
 */
export class DefaultPolicyAuthorizer
  implements PolicyAuthorizer, TokenVerifierProvider
{
  private tokenVerifierImpl?: TokenVerifier;
  private policyImpl?: AuthorizationPolicy;
  private readonly policySource?: AuthorizationPolicySource;
  private policyLoaded = false;

  constructor(options: DefaultPolicyAuthorizerOptions = {}) {
    const normalized = normalizeOptions(options);

    if (normalized.tokenVerifier) {
      this.tokenVerifierImpl = normalized.tokenVerifier;
    }

    if (normalized.policy) {
      this.policyImpl = normalized.policy;
      this.policyLoaded = true;
    }

    if (normalized.policySource) {
      this.policySource = normalized.policySource;
    }

    // Validate that we have either a policy or a policy source
    if (!normalized.policy && !normalized.policySource) {
      throw new Error(
        'DefaultPolicyAuthorizer requires either a policy or a policySource'
      );
    }
  }

  /**
   * The currently active authorization policy.
   */
  public get policy(): AuthorizationPolicy {
    if (!this.policyImpl) {
      throw new Error(
        'Authorization policy not loaded. Call ensurePolicyLoaded() first.'
      );
    }
    return this.policyImpl;
  }

  /**
   * The token verifier used for authentication.
   */
  public get tokenVerifier(): TokenVerifier {
    if (!this.tokenVerifierImpl) {
      throw new Error(
        'DefaultPolicyAuthorizer is not initialized properly, missing tokenVerifier'
      );
    }
    return this.tokenVerifierImpl;
  }

  public set tokenVerifier(verifier: TokenVerifier) {
    this.tokenVerifierImpl = verifier;
  }

  /**
   * Ensures the authorization policy is loaded.
   * If using a policy source, loads the policy from it.
   */
  public async ensurePolicyLoaded(): Promise<void> {
    if (this.policyLoaded && this.policyImpl) {
      return;
    }

    if (!this.policySource) {
      throw new Error(
        'No policy source configured and no policy provided'
      );
    }

    logger.debug('loading_policy_from_source');
    this.policyImpl = await this.policySource.loadPolicy();
    this.policyLoaded = true;
    logger.info('policy_loaded_from_source');
  }

  /**
   * Reloads the authorization policy from the policy source.
   * Only works if a policy source was configured.
   */
  public async reloadPolicy(): Promise<void> {
    if (!this.policySource) {
      throw new Error('Cannot reload policy: no policy source configured');
    }

    logger.debug('reloading_policy_from_source');
    this.policyImpl = await this.policySource.loadPolicy();
    this.policyLoaded = true;
    logger.info('policy_reloaded_from_source');
  }

  /**
   * Authenticates credentials and returns an authorization context.
   *
   * @param credentials - The credentials to authenticate (token string or bytes)
   * @returns The authorization context if authentication succeeds, undefined otherwise
   */
  public async authenticate(
    credentials: string | Uint8Array
  ): Promise<AuthorizationContext | undefined> {
    const token = normalizeToken(credentials);
    if (!token) {
      return undefined;
    }

    try {
      const verifier = this.tokenVerifier;
      const context = await verifier.verify(token);

      return createAuthorizationContext({
        ...context,
        authenticated: true,
        authorized: false, // Authorization happens in authorize()
        authMethod: context.authMethod ?? 'jwt',
      });
    } catch (error) {
      logger.warning('token_verification_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * Authorizes a request using the configured authorization policy.
   *
   * For NodeAttach frames, evaluates policy with action='Connect'.
   * For other frames, this method performs basic authentication validation
   * but does NOT infer send/receive actions. Route-level authorization
   * is handled separately via authorizeRoute().
   *
   * @param node - The node handling the request
   * @param envelope - The FAME envelope being authorized
   * @param context - Optional delivery context
   * @returns The authorization context if authorized, undefined if denied
   */
  public async authorize(
    node: NodeLike,
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<AuthorizationContext | undefined> {
    const authorization = context?.security?.authorization;

    // Must be authenticated first
    if (!authorization || !authorization.authenticated) {
      logger.debug('authorization_denied_not_authenticated');
      return undefined;
    }

    // Ensure policy is loaded
    await this.ensurePolicyLoaded();

    // For NodeAttach frames, evaluate policy with 'Connect' action
    const frameType = envelope.frame?.type;
    if (frameType === 'NodeAttach') {
      let decision: AuthorizationDecision;
      try {
        decision = await this.policy.evaluateRequest(
          node,
          envelope,
          context,
          'Connect'
        );
      } catch (error) {
        logger.error('policy_evaluation_failed', {
          error: error instanceof Error ? error.message : String(error),
          action: 'Connect',
        });
        return undefined;
      }

      if (decision.effect === 'allow') {
        logger.debug('authorization_allowed', {
          matchedRule: decision.matchedRule,
          reason: decision.reason,
          action: 'Connect',
        });

        return createAuthorizationContext({
          ...authorization,
          authorized: true,
          authMethod: authorization.authMethod ?? 'policy',
        });
      } else {
        logger.debug('authorization_denied', {
          matchedRule: decision.matchedRule,
          reason: decision.reason,
          action: 'Connect',
        });

        return undefined;
      }
    }

    // For non-NodeAttach frames, authentication is sufficient at this stage.
    // Route-level authorization is performed via authorizeRoute() after
    // the routing decision is made.
    logger.debug('authorization_passed_authentication_only', {
      envp_id: envelope.id,
      frame_type: frameType,
    });

    return createAuthorizationContext({
      ...authorization,
      authorized: true,
      authMethod: authorization.authMethod ?? 'policy',
    });
  }

  /**
   * Authorizes a routing action after the routing decision has been made.
   *
   * This method evaluates the authorization policy with the explicitly
   * provided action token (ForwardUpstream, ForwardDownstream, ForwardPeer,
   * DeliverLocal).
   *
   * @param node - The node handling the request
   * @param envelope - The FAME envelope being routed
   * @param action - The authorization action token from the routing decision
   * @param context - Optional delivery context
   * @returns RouteAuthorizationResult with authorization decision
   */
  public async authorizeRoute(
    node: NodeLike,
    envelope: FameEnvelope,
    action: RuleAction,
    context?: FameDeliveryContext
  ): Promise<RouteAuthorizationResult | undefined> {
    const authorization = context?.security?.authorization;

    // If not authenticated, deny route authorization
    if (!authorization || !authorization.authenticated) {
      logger.debug('route_authorization_denied_not_authenticated', {
        action,
      });
      return {
        authorized: false,
        denialReason: 'not_authenticated',
      };
    }

    // Ensure policy is loaded
    await this.ensurePolicyLoaded();

    // Evaluate the policy with the provided action
    let decision: AuthorizationDecision;
    try {
      decision = await this.policy.evaluateRequest(
        node,
        envelope,
        context,
        action
      );
    } catch (error) {
      logger.error('route_policy_evaluation_failed', {
        error: error instanceof Error ? error.message : String(error),
        action,
      });
      return {
        authorized: false,
        denialReason: 'policy_evaluation_error',
      };
    }

    if (decision.effect === 'allow') {
      logger.debug('route_authorization_allowed', {
        matchedRule: decision.matchedRule,
        reason: decision.reason,
        action,
      });

      return {
        authorized: true,
        authContext: createAuthorizationContext({
          ...authorization,
          authorized: true,
          authMethod: authorization.authMethod ?? 'policy',
        }),
        matchedRule: decision.matchedRule,
      };
    } else {
      logger.debug('route_authorization_denied', {
        matchedRule: decision.matchedRule,
        reason: decision.reason,
        action,
      });

      return {
        authorized: false,
        denialReason: decision.reason ?? 'policy_denied',
        matchedRule: decision.matchedRule,
      };
    }
  }
}
