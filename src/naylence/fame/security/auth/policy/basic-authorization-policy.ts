/**
 * Basic authorization policy implementation.
 *
 * Evaluates authorization rules defined in YAML/JSON policy files.
 * Uses first-match-wins semantics with glob/regex pattern matching.
 */

import type {
  FameDeliveryContext,
  FameEnvelope,
} from '@naylence/core';

import { getLogger } from '../../../util/logging.js';
import type { NodeLike } from '../../../node/node-like.js';
import type {
  AuthorizationPolicy,
  AuthorizationDecision,
  AuthorizationEvaluationStep,
} from './authorization-policy.js';
import type {
  AuthorizationPolicyDefinition,
  AuthorizationRuleDefinition,
  RuleAction,
  ScopeRequirement,
} from './authorization-policy-definition.js';
import {
  KNOWN_POLICY_FIELDS,
  KNOWN_RULE_FIELDS,
  VALID_ACTIONS,
  VALID_EFFECTS,
  VALID_ORIGIN_TYPES,
} from './authorization-policy-definition.js';
import { type CompiledPattern, compileGlobPattern } from './pattern-matcher.js';
import { compileGlobOnlyScopeRequirement } from './scope-matcher.js';

const logger = getLogger(
  'naylence.fame.security.auth.policy.basic_authorization_policy'
);

/**
 * Compiled rule for efficient repeated evaluation.
 */
interface CompiledRule {
  id: string;
  description?: string;
  effect: 'allow' | 'deny';
  /** Set of allowed actions. Contains '*' if wildcard. */
  actions: Set<RuleAction>;
  frameTypes?: Set<string>;
  /** Set of allowed origin types (lowercase). If undefined, matches any origin. */
  originTypes?: Set<string>;
  /** Address matchers (any-of). If undefined, matches any address. */
  addressPatterns?: CompiledPattern[];
  scopeMatcher?: (grantedScopes: readonly string[]) => boolean;
  hasWhenClause: boolean;
}

/**
 * Extracts the target address string from the envelope.
 */
function extractAddress(envelope: FameEnvelope): string | undefined {
  const to = envelope.to;
  if (!to) {
    return undefined;
  }

  // FameAddress can be a string or object with toString()
  if (typeof to === 'string') {
    return to;
  }

  if (typeof to === 'object' && 'toString' in to) {
    return to.toString();
  }

  return undefined;
}

/**
 * Extracts granted scopes from the authorization context.
 */
function extractGrantedScopes(
  context?: FameDeliveryContext
): readonly string[] {
  const authContext = context?.security?.authorization;
  if (!authContext) {
    return [];
  }

  // Check grantedScopes first
  if (Array.isArray(authContext.grantedScopes)) {
    return authContext.grantedScopes;
  }

  // Fall back to claims.scope if available
  const claims = authContext.claims as Record<string, unknown> | undefined;
  if (claims) {
    const scopeClaim = claims.scope ?? claims.scopes ?? claims.scp;

    if (typeof scopeClaim === 'string') {
      // Space-separated scopes (OAuth2 convention)
      return scopeClaim.split(/\s+/).filter((s) => s.length > 0);
    }

    if (Array.isArray(scopeClaim)) {
      return scopeClaim.filter(
        (s): s is string => typeof s === 'string'
      );
    }
  }

  return [];
}

/**
 * Options for creating a BasicAuthorizationPolicy.
 */
export interface BasicAuthorizationPolicyOptions {
  /**
   * The policy definition to evaluate.
   */
  policyDefinition: AuthorizationPolicyDefinition;

  /**
   * Whether to log warnings for unknown fields.
   * @default true
   */
  warnOnUnknownFields?: boolean;
}

/**
 * Basic authorization policy that evaluates rules from a policy definition.
 *
 * Features:
 * - First-match-wins rule evaluation
 * - Glob and regex pattern matching for addresses
 * - Scope matching with any_of/all_of/none_of operators
 * - Action-based filtering (connect, send, receive)
 */
export class BasicAuthorizationPolicy implements AuthorizationPolicy {
  private readonly defaultEffect: 'allow' | 'deny';
  private readonly compiledRules: CompiledRule[];

  constructor(options: BasicAuthorizationPolicyOptions) {
    const { policyDefinition, warnOnUnknownFields = true } = options;

    // Validate and extract default effect
    this.defaultEffect = this.validateDefaultEffect(
      policyDefinition.default_effect
    );

    // Warn about unknown policy fields
    if (warnOnUnknownFields) {
      this.warnUnknownPolicyFields(policyDefinition);
    }

    // Compile rules for efficient evaluation
    this.compiledRules = this.compileRules(
      policyDefinition.rules,
      warnOnUnknownFields
    );

    logger.debug('policy_compiled', {
      defaultEffect: this.defaultEffect,
      ruleCount: this.compiledRules.length,
    });
  }

  /**
   * Evaluates the policy against a request with an explicitly provided action.
   *
   * @param _node - The node handling the request (unused in basic policy)
   * @param envelope - The FAME envelope being authorized
   * @param context - Optional delivery context with authorization info
   * @param action - The authorization action token (required, no inference)
   * @returns Authorization decision indicating allow/deny
   */
  async evaluateRequest(
    _node: NodeLike,
    envelope: FameEnvelope,
    context?: FameDeliveryContext,
    action?: RuleAction
  ): Promise<AuthorizationDecision> {
    // Action must be explicitly provided; default to wildcard if omitted
    // for backward compatibility during transition
    const resolvedAction: RuleAction = action ?? '*';
    const address = extractAddress(envelope);
    const grantedScopes = extractGrantedScopes(context);
    const rawFrameType = (envelope.frame as { type?: string } | undefined)
      ?.type;
    const frameTypeNormalized =
      typeof rawFrameType === 'string' && rawFrameType.trim().length > 0
        ? rawFrameType.trim().toLowerCase()
        : '';
    // Extract and normalize origin type for rule matching
    const rawOriginType = context?.originType;
    const originTypeNormalized =
      typeof rawOriginType === 'string' && rawOriginType.trim().length > 0
        ? rawOriginType.trim().toLowerCase()
        : undefined;

    const evaluationTrace: AuthorizationEvaluationStep[] = [];

    // Evaluate rules in order (first match wins)
    for (const rule of this.compiledRules) {
      const step: AuthorizationEvaluationStep = {
        ruleId: rule.id,
        result: false,
      };

      // Skip rules with 'when' clause (handled by advanced policy)
      if (rule.hasWhenClause) {
        step.expression = 'when clause (skipped by basic policy)';
        step.result = false;
        evaluationTrace.push(step);
        continue;
      }

      // Check frame type match
      if (rule.frameTypes) {
        if (!frameTypeNormalized) {
          step.expression = 'frame_type: missing';
          step.result = false;
          evaluationTrace.push(step);
          continue;
        }

        if (!rule.frameTypes.has(frameTypeNormalized)) {
          step.expression = `frame_type: ${rawFrameType ?? 'unknown'} not in rule set`;
          step.result = false;
          evaluationTrace.push(step);
          continue;
        }
      }

      // Check origin type match (early gate for efficiency)
      if (rule.originTypes) {
        if (originTypeNormalized === undefined) {
          step.expression = 'origin_type: missing (rule requires origin)';
          step.result = false;
          evaluationTrace.push(step);
          continue;
        }

        if (!rule.originTypes.has(originTypeNormalized)) {
          step.expression = `origin_type: ${rawOriginType ?? 'unknown'} not in [${Array.from(rule.originTypes).join(', ')}]`;
          step.result = false;
          evaluationTrace.push(step);
          continue;
        }
      }

      // Check action match
      if (!rule.actions.has('*') && !rule.actions.has(resolvedAction)) {
        step.expression = `action: ${resolvedAction} not in [${Array.from(rule.actions).join(', ')}]`;
        step.result = false;
        evaluationTrace.push(step);
        continue;
      }

      // Check address match (any pattern in the list matches)
      if (rule.addressPatterns) {
        if (!address) {
          step.expression = `address: pattern requires address, but none provided`;
          step.result = false;
          evaluationTrace.push(step);
          continue;
        }

        const matched = rule.addressPatterns.some((p) => p.match(address));
        if (!matched) {
          const patterns = rule.addressPatterns.map((p) => p.source).join(', ');
          step.expression = `address: none of [${patterns}] matched ${address}`;
          step.result = false;
          evaluationTrace.push(step);
          continue;
        }
      }

      // Check scope match
      if (rule.scopeMatcher) {
        if (!rule.scopeMatcher(grantedScopes)) {
          step.expression = `scope: requirement not satisfied`;
          step.boundValues = { grantedScopes: [...grantedScopes] };
          step.result = false;
          evaluationTrace.push(step);
          continue;
        }
      }

      // Rule matched
      step.result = true;
      step.expression = 'all conditions matched';
      step.boundValues = {
        action: resolvedAction,
        address,
        grantedScopes: [...grantedScopes],
      };
      evaluationTrace.push(step);

      logger.debug('rule_matched', {
        ruleId: rule.id,
        effect: rule.effect,
        action: resolvedAction,
        address,
      });

      return {
        effect: rule.effect,
        reason: rule.description ?? `Matched rule: ${rule.id}`,
        matchedRule: rule.id,
        evaluationTrace,
      };
    }

    // No rule matched, apply default effect
    logger.debug('no_rule_matched', {
      defaultEffect: this.defaultEffect,
      action: resolvedAction,
      address,
    });

    return {
      effect: this.defaultEffect,
      reason: `No rule matched, applying default effect: ${this.defaultEffect}`,
      evaluationTrace,
    };
  }

  private validateDefaultEffect(effect: unknown): 'allow' | 'deny' {
    if (effect !== 'allow' && effect !== 'deny') {
      throw new Error(
        `Invalid default_effect: "${String(effect)}". Must be "allow" or "deny"`
      );
    }
    return effect;
  }

  private warnUnknownPolicyFields(
    definition: AuthorizationPolicyDefinition
  ): void {
    for (const key of Object.keys(definition)) {
      if (!KNOWN_POLICY_FIELDS.has(key)) {
        logger.warning('unknown_policy_field', { field: key });
      }
    }
  }

  private compileRules(
    rules: AuthorizationRuleDefinition[],
    warnOnUnknown: boolean
  ): CompiledRule[] {
    return rules.map((rule, index) => this.compileRule(rule, index, warnOnUnknown));
  }

  private compileRule(
    rule: AuthorizationRuleDefinition,
    index: number,
    warnOnUnknown: boolean
  ): CompiledRule {
    // Generate ID if not provided
    const id = rule.id ?? `rule_${index}`;

    // Validate effect
    if (!VALID_EFFECTS.includes(rule.effect)) {
      throw new Error(
        `Invalid effect in rule "${id}": "${String(rule.effect)}". Must be "allow" or "deny"`
      );
    }

    // Validate and compile action(s)
    const actions = this.compileActions(rule.action, id);

    // Compile address patterns (glob-only, no regex)
    const addressPatterns = this.compileAddress(rule.address, id);

    // Compile frame type gating
    const frameTypes = this.compileFrameTypes(rule.frame_type, id);

    // Compile origin type gating
    const originTypes = this.compileOriginTypes(rule.origin_type, id);

    // Compile scope matcher (glob-only, no regex)
    let scopeMatcher: ((scopes: readonly string[]) => boolean) | undefined;
    if (rule.scope !== undefined) {
      try {
        const compiled = compileGlobOnlyScopeRequirement(
          rule.scope as ScopeRequirement,
          id
        );
        scopeMatcher = (scopes) => compiled.evaluate(scopes);
      } catch (error) {
        throw new Error(
          `Invalid scope requirement in rule "${id}": ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // Warn about unknown fields
    if (warnOnUnknown) {
      for (const key of Object.keys(rule)) {
        if (!KNOWN_RULE_FIELDS.has(key)) {
          logger.warning('unknown_rule_field', { ruleId: id, field: key });
        }
      }
    }

    return {
      id,
      description: rule.description,
      effect: rule.effect,
      actions,
      frameTypes,
      originTypes,
      addressPatterns,
      scopeMatcher,
      hasWhenClause: typeof rule.when === 'string' && rule.when.length > 0,
    };
  }

  /**
   * Compiles action field into a Set of valid actions.
   * Supports single RuleAction or array of RuleAction (implicit any-of).
   */
  private compileActions(
    action: RuleAction | RuleAction[] | undefined,
    ruleId: string
  ): Set<RuleAction> {
    // Default to wildcard if not specified
    if (action === undefined) {
      return new Set(['*']);
    }

    // Handle single action
    if (typeof action === 'string') {
      if (!VALID_ACTIONS.includes(action)) {
        throw new Error(
          `Invalid action in rule "${ruleId}": "${action}". Must be one of: ${VALID_ACTIONS.join(', ')}`
        );
      }
      return new Set([action]);
    }

    // Handle array of actions
    if (!Array.isArray(action)) {
      throw new Error(
        `Invalid action in rule "${ruleId}": must be a string or array of strings`
      );
    }

    if (action.length === 0) {
      throw new Error(
        `Invalid action in rule "${ruleId}": array must not be empty`
      );
    }

    const actions = new Set<RuleAction>();
    for (const a of action) {
      if (typeof a !== 'string') {
        throw new Error(
          `Invalid action in rule "${ruleId}": all values must be strings`
        );
      }
      if (!VALID_ACTIONS.includes(a as RuleAction)) {
        throw new Error(
          `Invalid action in rule "${ruleId}": "${a}". Must be one of: ${VALID_ACTIONS.join(', ')}`
        );
      }
      actions.add(a as RuleAction);
    }

    return actions;
  }

  /**
   * Compiles address field into an array of glob matchers.
   * Supports single string or array of strings (implicit any-of).
   * Returns undefined if not specified (no address gating).
   *
   * All patterns are treated as globs - `^` prefix is rejected as an error.
   */
  private compileAddress(
    address: string | string[] | undefined,
    ruleId: string
  ): CompiledPattern[] | undefined {
    if (address === undefined) {
      return undefined;
    }

    const context = `address in rule "${ruleId}"`;

    // Handle single address pattern
    if (typeof address === 'string') {
      const trimmed = address.trim();
      if (!trimmed) {
        throw new Error(
          `Invalid address in rule "${ruleId}": value must not be empty`
        );
      }
      try {
        return [compileGlobPattern(trimmed, context)];
      } catch (error) {
        throw new Error(
          `Invalid address in rule "${ruleId}": ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // Handle array of address patterns
    if (!Array.isArray(address)) {
      throw new Error(
        `Invalid address in rule "${ruleId}": must be a string or array of strings`
      );
    }

    if (address.length === 0) {
      throw new Error(
        `Invalid address in rule "${ruleId}": array must not be empty`
      );
    }

    const patterns: CompiledPattern[] = [];
    for (const addr of address) {
      if (typeof addr !== 'string') {
        throw new Error(
          `Invalid address in rule "${ruleId}": all values must be strings`
        );
      }
      const trimmed = addr.trim();
      if (!trimmed) {
        throw new Error(
          `Invalid address in rule "${ruleId}": values must not be empty`
        );
      }
      try {
        patterns.push(compileGlobPattern(trimmed, context));
      } catch (error) {
        throw new Error(
          `Invalid address in rule "${ruleId}": ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    return patterns;
  }

  /**
   * Compiles frame_type field into a Set of normalized frame types.
   * Supports single string or array of strings (implicit any-of).
   * Returns undefined if not specified (no frame type gating).
   */
  private compileFrameTypes(
    frameType: string | string[] | undefined,
    ruleId: string
  ): Set<string> | undefined {
    if (frameType === undefined) {
      return undefined;
    }

    // Handle single frame type
    if (typeof frameType === 'string') {
      const normalized = frameType.trim().toLowerCase();
      if (!normalized) {
        throw new Error(
          `Invalid frame_type in rule "${ruleId}": value must not be empty`
        );
      }
      return new Set([normalized]);
    }

    // Handle array of frame types
    if (!Array.isArray(frameType)) {
      throw new Error(
        `Invalid frame_type in rule "${ruleId}": must be a string or array of strings`
      );
    }

    if (frameType.length === 0) {
      throw new Error(
        `Invalid frame_type in rule "${ruleId}": array must not be empty`
      );
    }

    const frameTypes = new Set<string>();
    for (const ft of frameType) {
      if (typeof ft !== 'string') {
        throw new Error(
          `Invalid frame_type in rule "${ruleId}": all values must be strings`
        );
      }
      const normalized = ft.trim().toLowerCase();
      if (!normalized) {
        throw new Error(
          `Invalid frame_type in rule "${ruleId}": values must not be empty`
        );
      }
      frameTypes.add(normalized);
    }

    return frameTypes;
  }

  /**
   * Compiles origin_type field into a Set of normalized origin types.
   * Supports single string or array of strings (implicit any-of).
   * Returns undefined if not specified (no origin type gating).
   * Valid values: 'downstream', 'upstream', 'peer', 'local' (case-insensitive).
   */
  private compileOriginTypes(
    originType: string | string[] | undefined,
    ruleId: string
  ): Set<string> | undefined {
    if (originType === undefined) {
      return undefined;
    }

    // Handle single origin type
    if (typeof originType === 'string') {
      const normalized = originType.trim().toLowerCase();
      if (!normalized) {
        throw new Error(
          `Invalid origin_type in rule "${ruleId}": value must not be empty`
        );
      }
      if (!VALID_ORIGIN_TYPES.includes(normalized)) {
        throw new Error(
          `Invalid origin_type in rule "${ruleId}": "${originType}". Must be one of: ${VALID_ORIGIN_TYPES.join(', ')}`
        );
      }
      return new Set([normalized]);
    }

    // Handle array of origin types
    if (!Array.isArray(originType)) {
      throw new Error(
        `Invalid origin_type in rule "${ruleId}": must be a string or array of strings`
      );
    }

    if (originType.length === 0) {
      throw new Error(
        `Invalid origin_type in rule "${ruleId}": array must not be empty`
      );
    }

    const originTypes = new Set<string>();
    for (const ot of originType) {
      if (typeof ot !== 'string') {
        throw new Error(
          `Invalid origin_type in rule "${ruleId}": all values must be strings`
        );
      }
      const normalized = ot.trim().toLowerCase();
      if (!normalized) {
        throw new Error(
          `Invalid origin_type in rule "${ruleId}": values must not be empty`
        );
      }
      if (!VALID_ORIGIN_TYPES.includes(normalized)) {
        throw new Error(
          `Invalid origin_type in rule "${ruleId}": "${ot}". Must be one of: ${VALID_ORIGIN_TYPES.join(', ')}`
        );
      }
      originTypes.add(normalized);
    }

    return originTypes;
  }
}
