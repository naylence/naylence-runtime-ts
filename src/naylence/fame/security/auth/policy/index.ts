/**
 * Authorization policy module exports.
 *
 * This module provides interfaces and factories for pluggable authorization policies.
 */

// Core interfaces and types
export * from './authorization-policy.js';
export * from './authorization-policy-source.js';
export * from './authorization-policy-definition.js';

// Pattern and scope matchers
export {
  compilePattern,
  compileGlobPattern,
  getCompiledGlobPattern,
  matchPattern,
  isRegexPattern,
  assertNotRegexPattern,
} from './pattern-matcher.js';
export type { CompiledPattern } from './pattern-matcher.js';

export {
  evaluateScopeRequirement,
  compileScopeRequirement,
  normalizeScopeRequirement,
  compileGlobOnlyScopeRequirement,
} from './scope-matcher.js';

// Factory base classes
export {
  AUTHORIZATION_POLICY_FACTORY_BASE_TYPE,
  AuthorizationPolicyFactory,
} from './authorization-policy-factory.js';
export type * from './authorization-policy-factory.js';

export {
  AUTHORIZATION_POLICY_SOURCE_FACTORY_BASE_TYPE,
  AuthorizationPolicySourceFactory,
} from './authorization-policy-source-factory.js';
export type * from './authorization-policy-source-factory.js';

// Basic authorization policy (browser and node)
export { BasicAuthorizationPolicy } from './basic-authorization-policy.js';
export type { BasicAuthorizationPolicyOptions } from './basic-authorization-policy.js';

export { BasicAuthorizationPolicyFactory } from './basic-authorization-policy-factory.js';
export type { BasicAuthorizationPolicyConfig } from './basic-authorization-policy-factory.js';

// Note: LocalFileAuthorizationPolicySource and its factory are node-only
// and are registered via the factory manifest, not exported here directly.
