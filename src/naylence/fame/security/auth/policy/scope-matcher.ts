/**
 * Scope matching utilities for authorization policies.
 *
 * Supports:
 * - Simple string patterns (glob only in OSS/basic policy)
 * - Logical operators: any_of, all_of, none_of
 * - Recursive nesting with depth limits
 */

import type {
  ScopeRequirement,
  NormalizedScopeRequirement,
} from './authorization-policy-definition.js';
import { MAX_SCOPE_NESTING_DEPTH } from './authorization-policy-definition.js';
import {
  matchPattern,
  compileGlobPattern,
  type CompiledPattern,
} from './pattern-matcher.js';

/**
 * Checks if any of the granted scopes match the given pattern.
 */
function anyScopeMatchesPattern(
  grantedScopes: readonly string[],
  pattern: string
): boolean {
  return grantedScopes.some((scope) => matchPattern(pattern, scope));
}

/**
 * Normalizes a scope requirement into a typed structure.
 *
 * @param requirement - The scope requirement to normalize
 * @param depth - Current nesting depth (for recursion limit)
 * @returns Normalized scope requirement
 * @throws Error if nesting exceeds maximum depth
 */
export function normalizeScopeRequirement(
  requirement: ScopeRequirement,
  depth: number = 0
): NormalizedScopeRequirement {
  if (depth > MAX_SCOPE_NESTING_DEPTH) {
    throw new Error(
      `Scope requirement nesting exceeds maximum depth of ${MAX_SCOPE_NESTING_DEPTH}`
    );
  }

  // Simple string pattern
  if (typeof requirement === 'string') {
    return { type: 'pattern', pattern: requirement };
  }

  // Object with logical operator
  if (typeof requirement !== 'object' || requirement === null) {
    throw new Error(`Invalid scope requirement: ${String(requirement)}`);
  }

  const keys = Object.keys(requirement);
  if (keys.length !== 1) {
    throw new Error(
      `Scope requirement object must have exactly one key (any_of, all_of, or none_of), got: ${keys.join(', ')}`
    );
  }

  const key = keys[0];
  const value = (requirement as Record<string, unknown>)[key];

  if (!Array.isArray(value)) {
    throw new Error(
      `Scope requirement "${key}" must have an array value, got: ${typeof value}`
    );
  }

  const nested = value.map((item) =>
    normalizeScopeRequirement(item as ScopeRequirement, depth + 1)
  );

  switch (key) {
    case 'any_of':
      return { type: 'any_of', requirements: nested };
    case 'all_of':
      return { type: 'all_of', requirements: nested };
    case 'none_of':
      return { type: 'none_of', requirements: nested };
    default:
      throw new Error(
        `Unknown scope requirement operator: "${key}". Expected any_of, all_of, or none_of`
      );
  }
}

/**
 * Evaluates a normalized scope requirement against granted scopes.
 *
 * @param requirement - The normalized scope requirement
 * @param grantedScopes - The scopes granted to the principal
 * @returns True if the requirement is satisfied
 */
export function evaluateNormalizedScopeRequirement(
  requirement: NormalizedScopeRequirement,
  grantedScopes: readonly string[]
): boolean {
  switch (requirement.type) {
    case 'pattern':
      return anyScopeMatchesPattern(grantedScopes, requirement.pattern);

    case 'any_of':
      return requirement.requirements.some((req) =>
        evaluateNormalizedScopeRequirement(req, grantedScopes)
      );

    case 'all_of':
      return requirement.requirements.every((req) =>
        evaluateNormalizedScopeRequirement(req, grantedScopes)
      );

    case 'none_of':
      return !requirement.requirements.some((req) =>
        evaluateNormalizedScopeRequirement(req, grantedScopes)
      );

    default:
      // Exhaustive check
      throw new Error(
        `Unknown scope requirement type: ${(requirement as NormalizedScopeRequirement).type}`
      );
  }
}

/**
 * Evaluates a scope requirement against granted scopes.
 *
 * This is the main entry point for scope matching.
 *
 * @param requirement - The scope requirement (string or object)
 * @param grantedScopes - The scopes granted to the principal
 * @returns True if the requirement is satisfied
 */
export function evaluateScopeRequirement(
  requirement: ScopeRequirement,
  grantedScopes: readonly string[]
): boolean {
  const normalized = normalizeScopeRequirement(requirement);
  return evaluateNormalizedScopeRequirement(normalized, grantedScopes);
}

/**
 * Pre-compiles a scope requirement for efficient repeated evaluation.
 *
 * @param requirement - The scope requirement to compile
 * @returns A function that evaluates the requirement against granted scopes
 */
export function compileScopeRequirement(
  requirement: ScopeRequirement
): (grantedScopes: readonly string[]) => boolean {
  const normalized = normalizeScopeRequirement(requirement);
  return (grantedScopes) =>
    evaluateNormalizedScopeRequirement(normalized, grantedScopes);
}

/**
 * Compiled scope requirement for efficient repeated evaluation with glob-only patterns.
 */
interface CompiledScopeRequirement {
  evaluate: (grantedScopes: readonly string[]) => boolean;
}

/**
 * Pre-compiles a scope requirement for OSS/basic policy (glob-only, no regex).
 *
 * This version rejects patterns starting with `^` at compile time.
 *
 * @param requirement - The scope requirement to compile
 * @param ruleId - Rule ID for error messages
 * @returns A compiled scope requirement
 * @throws Error if any pattern starts with `^` (regex attempt)
 */
export function compileGlobOnlyScopeRequirement(
  requirement: ScopeRequirement,
  ruleId: string
): CompiledScopeRequirement {
  const context = `scope in rule "${ruleId}"`;

  // Compile the requirement, pre-compiling all patterns as globs
  const compiled = compileGlobOnlyNormalized(
    normalizeScopeRequirement(requirement),
    context
  );

  return {
    evaluate: (grantedScopes) => evaluateCompiledScope(compiled, grantedScopes),
  };
}

/**
 * Compiled scope node for evaluation.
 */
type CompiledScopeNode =
  | { type: 'pattern'; matcher: CompiledPattern }
  | { type: 'any_of'; requirements: CompiledScopeNode[] }
  | { type: 'all_of'; requirements: CompiledScopeNode[] }
  | { type: 'none_of'; requirements: CompiledScopeNode[] };

/**
 * Compiles a normalized scope requirement into efficient matchers (glob-only).
 */
function compileGlobOnlyNormalized(
  requirement: NormalizedScopeRequirement,
  context: string
): CompiledScopeNode {
  switch (requirement.type) {
    case 'pattern':
      return {
        type: 'pattern',
        matcher: compileGlobPattern(requirement.pattern, context),
      };
    case 'any_of':
      return {
        type: 'any_of',
        requirements: requirement.requirements.map((r) =>
          compileGlobOnlyNormalized(r, context)
        ),
      };
    case 'all_of':
      return {
        type: 'all_of',
        requirements: requirement.requirements.map((r) =>
          compileGlobOnlyNormalized(r, context)
        ),
      };
    case 'none_of':
      return {
        type: 'none_of',
        requirements: requirement.requirements.map((r) =>
          compileGlobOnlyNormalized(r, context)
        ),
      };
  }
}

/**
 * Evaluates a compiled scope node against granted scopes.
 */
function evaluateCompiledScope(
  node: CompiledScopeNode,
  grantedScopes: readonly string[]
): boolean {
  switch (node.type) {
    case 'pattern':
      return grantedScopes.some((scope) => node.matcher.match(scope));
    case 'any_of':
      return node.requirements.some((r) =>
        evaluateCompiledScope(r, grantedScopes)
      );
    case 'all_of':
      return node.requirements.every((r) =>
        evaluateCompiledScope(r, grantedScopes)
      );
    case 'none_of':
      return !node.requirements.some((r) =>
        evaluateCompiledScope(r, grantedScopes)
      );
  }
}
