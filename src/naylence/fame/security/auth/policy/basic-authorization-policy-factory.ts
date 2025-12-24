/**
 * Factory for creating BasicAuthorizationPolicy instances.
 */

import type { AuthorizationPolicyDefinition } from './authorization-policy-definition.js';
import type { AuthorizationPolicy } from './authorization-policy.js';
import {
  AUTHORIZATION_POLICY_FACTORY_BASE_TYPE,
  AuthorizationPolicyFactory,
  type AuthorizationPolicyConfig,
} from './authorization-policy-factory.js';

/**
 * Configuration for creating a BasicAuthorizationPolicy via factory.
 */
export interface BasicAuthorizationPolicyConfig
  extends AuthorizationPolicyConfig {
  type: 'BasicAuthorizationPolicy';

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

type BasicAuthorizationPolicyModule =
  typeof import('./basic-authorization-policy.js');

/**
 * Lazy import for tree-shaking.
 */
async function safeImportModule(): Promise<BasicAuthorizationPolicyModule> {
  return await import('./basic-authorization-policy.js');
}

interface NormalizedConfig {
  policyDefinition: AuthorizationPolicyDefinition;
  warnOnUnknownFields: boolean;
}

function normalizeConfig(
  config?: BasicAuthorizationPolicyConfig | Record<string, unknown> | null
): NormalizedConfig {
  if (!config) {
    throw new Error(
      'BasicAuthorizationPolicyFactory requires a configuration with a policyDefinition'
    );
  }

  const candidate = config as Record<string, unknown>;

  // Support both camelCase and snake_case for policyDefinition
  const policyDefinition = (candidate.policyDefinition ??
    candidate.policy_definition) as AuthorizationPolicyDefinition | undefined;
  if (!policyDefinition || typeof policyDefinition !== 'object') {
    throw new Error(
      'BasicAuthorizationPolicyConfig requires a policyDefinition object'
    );
  }

  // Support both camelCase and snake_case for warnOnUnknownFields
  const warnOnUnknownFields =
    candidate.warnOnUnknownFields ?? candidate.warn_on_unknown_fields;
  if (warnOnUnknownFields !== undefined && typeof warnOnUnknownFields !== 'boolean') {
    throw new Error(
      'warnOnUnknownFields must be a boolean'
    );
  }

  return {
    policyDefinition,
    warnOnUnknownFields: warnOnUnknownFields ?? true,
  };
}

/**
 * Factory metadata for registration.
 */
export const FACTORY_META = {
  base: AUTHORIZATION_POLICY_FACTORY_BASE_TYPE,
  key: 'BasicAuthorizationPolicy',
} as const;

/**
 * Factory for creating BasicAuthorizationPolicy instances.
 */
export class BasicAuthorizationPolicyFactory extends AuthorizationPolicyFactory<BasicAuthorizationPolicyConfig> {
  public readonly type = 'BasicAuthorizationPolicy';

  /**
   * Creates a BasicAuthorizationPolicy from the given configuration.
   *
   * @param config - Configuration with policyDefinition
   * @returns The created authorization policy
   */
  public async create(
    config?: BasicAuthorizationPolicyConfig | Record<string, unknown> | null
  ): Promise<AuthorizationPolicy> {
    const normalized = normalizeConfig(config);

    const { BasicAuthorizationPolicy } = await safeImportModule();

    return new BasicAuthorizationPolicy({
      policyDefinition: normalized.policyDefinition,
      warnOnUnknownFields: normalized.warnOnUnknownFields,
    });
  }
}

export default BasicAuthorizationPolicyFactory;
