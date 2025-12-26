/**
 * Authorization policy definition types.
 *
 * This module defines the schema for authorization policies that can be
 * loaded from YAML/JSON files and evaluated at runtime.
 */

/**
 * The effect of an authorization rule.
 */
export type RuleEffect = 'allow' | 'deny';

/**
 * The action type a rule applies to (route-oriented, DX-friendly tokens).
 *
 * These tokens represent "what will happen next" in routing, not inferred send/receive:
 * - Connect: NodeAttach connection handshake (pre-routing)
 * - ForwardUpstream: Envelope will be forwarded to parent node
 * - ForwardDownstream: Envelope will be forwarded to a child route
 * - ForwardPeer: Envelope will be forwarded to a peer node
 * - DeliverLocal: Envelope will be delivered to a local address handler
 * - '*': Matches all actions (wildcard)
 */
export type RuleAction =
  | 'Connect'
  | 'ForwardUpstream'
  | 'ForwardDownstream'
  | 'ForwardPeer'
  | 'DeliverLocal'
  | '*';

/**
 * Action input tokens accepted in policy definitions.
 * Values are normalized case-insensitively and support snake_case.
 */
export type RuleActionInput = RuleAction | string;

/**
 * Scope requirement using logical operators.
 *
 * Supports recursive nesting with a maximum depth enforced at parse time.
 */
export type ScopeRequirement =
  | string
  | { any_of: ScopeRequirement[] }
  | { all_of: ScopeRequirement[] }
  | { none_of: ScopeRequirement[] };

/**
 * Normalized scope requirement with explicit type discriminator.
 */
export type NormalizedScopeRequirement =
  | { type: 'pattern'; pattern: string }
  | { type: 'any_of'; requirements: NormalizedScopeRequirement[] }
  | { type: 'all_of'; requirements: NormalizedScopeRequirement[] }
  | { type: 'none_of'; requirements: NormalizedScopeRequirement[] };

/**
 * An authorization rule definition.
 */
export interface AuthorizationRuleDefinition {
  /**
   * Optional unique identifier for the rule.
   * Used in decision traces for debugging.
   */
  id?: string;

  /**
   * Optional human-readable description of the rule.
   */
  description?: string;

  /**
   * The effect when this rule matches: allow or deny.
   */
  effect: RuleEffect;

  /**
   * The action type this rule applies to.
   * Can be a single action or an array of actions (implicit any-of).
   * Values are matched case-insensitively and support snake_case equivalents.
   * @default '*' (all actions)
   */
  action?: RuleActionInput | RuleActionInput[];

  /**
   * Address pattern(s) to match using glob syntax.
   * Can be a single pattern or an array (implicit any-of).
   * If omitted, matches all addresses.
   *
   * Glob syntax:
   * - `*` matches any characters except dots (single segment)
   * - `**` matches any characters including dots (any depth)
   * - `?` matches a single character (not a dot)
   * - Other characters are matched literally
   *
   * Note: In OSS/basic policy, patterns are always treated as globs.
   * Patterns starting with `^` are NOT interpreted as regex.
   */
  address?: string | string[];

  /**
   * Optional frame type gating (reserved for advanced-security package).
   * Can be a single frame type string or an array (implicit any-of).
   * Matching is case-insensitive.
   * 
   * WARNING: Basic policy parser will skip rules containing this field
   * and log a warning during policy construction. This field is only
   * supported in the advanced-security package.
   */
  frame_type?: string | string[];

  /**
   * Optional delivery origin type gating.
   * Can be a single origin type or an array (implicit any-of).
   * Valid values: 'downstream', 'upstream', 'peer', 'local'.
   * Matching is case-insensitive with whitespace trimmed.
   * If omitted, matches any origin type.
   * If specified but context.originType is undefined, rule does not match.
   */
  origin_type?: string | string[];

  /**
   * Scope requirement for the rule to match.
   * If omitted, no scope check is performed.
   */
  scope?: ScopeRequirement;

  /**
   * Expression condition (reserved for advanced-security package).
   * Basic policy parser ignores this field.
   */
  when?: string;

  /**
   * Allow additional fields for forward compatibility.
   * Unknown fields are ignored with a warning.
   */
  [key: string]: unknown;
}

/**
 * Authorization policy definition loaded from a file.
 */
export interface AuthorizationPolicyDefinition {
  /**
   * Schema version for the policy format.
   */
  version: string;

  /**
   * Default effect when no rule matches.
   */
  default_effect?: RuleEffect;

  /**
   * List of authorization rules, evaluated in order.
   * First matching rule determines the outcome.
   */
  rules: AuthorizationRuleDefinition[];

  /**
   * Allow additional fields for forward compatibility.
   */
  [key: string]: unknown;
}

/**
 * Maximum nesting depth for scope requirements.
 */
export const MAX_SCOPE_NESTING_DEPTH = 5;

/**
 * Known fields in AuthorizationPolicyDefinition.
 */
export const KNOWN_POLICY_FIELDS = new Set([
  'version',
  'default_effect',
  'rules',
]);

/**
 * Known fields in AuthorizationRuleDefinition.
 * Fields not in this set trigger a warning.
 */
export const KNOWN_RULE_FIELDS = new Set([
  'id',
  'description',
  'effect',
  'action',
  'address',
  'frame_type', // Reserved for advanced-security
  'origin_type',
  'scope',
  'when', // Reserved for advanced-security
]);

/**
 * Valid action values.
 */
export const VALID_ACTIONS: readonly RuleAction[] = [
  'Connect',
  'ForwardUpstream',
  'ForwardDownstream',
  'ForwardPeer',
  'DeliverLocal',
  '*',
];

/**
 * Valid origin type values (lowercase, matching DeliveryOriginType string values).
 */
export const VALID_ORIGIN_TYPES: readonly string[] = [
  'downstream',
  'upstream',
  'peer',
  'local',
];

/**
 * Valid effect values.
 */
export const VALID_EFFECTS: readonly RuleEffect[] = ['allow', 'deny'];
