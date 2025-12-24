import { safeImport } from '../../util/lazy-import.js';
import type { Authorizer } from './authorizer.js';
import {
  AUTHORIZER_FACTORY_BASE_TYPE,
  AuthorizerFactory,
  type AuthorizerConfig,
} from './authorizer-factory.js';
import type { TokenVerifier } from './token-verifier.js';
import {
  TokenVerifierFactory,
  type TokenVerifierConfig,
} from './token-verifier-factory.js';
import type { AuthorizationPolicy } from './policy/authorization-policy.js';
import type { AuthorizationPolicySource } from './policy/authorization-policy-source.js';
import {
  AuthorizationPolicySourceFactory,
  type AuthorizationPolicySourceConfig,
} from './policy/authorization-policy-source-factory.js';
import {
  AuthorizationPolicyFactory,
  type AuthorizationPolicyConfig,
} from './policy/authorization-policy-factory.js';

/**
 * Configuration for DefaultPolicyAuthorizer.
 */
export interface DefaultPolicyAuthorizerConfig extends AuthorizerConfig {
  type: 'PolicyAuthorizer';

  /**
   * Token verifier configuration.
   */
  verifier?: TokenVerifierConfig | Record<string, unknown> | null;

  /**
   * Authorization policy configuration.
   * Either policy or policySource must be provided.
   */
  policy?: AuthorizationPolicyConfig | Record<string, unknown> | null;

  /**
   * Authorization policy source configuration.
   * Either policy or policySource must be provided.
   */
  policySource?: AuthorizationPolicySourceConfig | Record<string, unknown> | null;
  policy_source?: AuthorizationPolicySourceConfig | Record<string, unknown> | null;
}

type DefaultPolicyAuthorizerModule =
  typeof import('./default-policy-authorizer.js');

let defaultPolicyAuthorizerModulePromise: Promise<DefaultPolicyAuthorizerModule> | null =
  null;

async function getDefaultPolicyAuthorizerModule(): Promise<DefaultPolicyAuthorizerModule> {
  if (!defaultPolicyAuthorizerModulePromise) {
    defaultPolicyAuthorizerModulePromise = safeImport(
      () => import('./default-policy-authorizer.js'),
      'default-policy-authorizer'
    );
  }
  return defaultPolicyAuthorizerModulePromise;
}

interface NormalizedConfig {
  verifier?: TokenVerifierConfig | Record<string, unknown> | null;
  policy?: AuthorizationPolicyConfig | Record<string, unknown> | null;
  policySource?: AuthorizationPolicySourceConfig | Record<string, unknown> | null;
}

function normalizeConfig(
  config?: DefaultPolicyAuthorizerConfig | Record<string, unknown> | null
): NormalizedConfig {
  if (!config) {
    return {};
  }

  const candidate = config as DefaultPolicyAuthorizerConfig &
    Record<string, unknown>;

  const verifierConfig = candidate.verifier ?? null;
  if (verifierConfig && typeof verifierConfig !== 'object') {
    throw new Error(
      'PolicyAuthorizer verifier configuration must be an object'
    );
  }

  const policyConfig = candidate.policy ?? null;
  if (policyConfig && typeof policyConfig !== 'object') {
    throw new Error(
      'PolicyAuthorizer policy configuration must be an object'
    );
  }

  const policySourceConfig =
    candidate.policySource ?? candidate.policy_source ?? null;
  if (policySourceConfig && typeof policySourceConfig !== 'object') {
    throw new Error(
      'PolicyAuthorizer policySource configuration must be an object'
    );
  }

  return {
    verifier: verifierConfig as
      | TokenVerifierConfig
      | Record<string, unknown>
      | null,
    policy: policyConfig as
      | AuthorizationPolicyConfig
      | Record<string, unknown>
      | null,
    policySource: policySourceConfig as
      | AuthorizationPolicySourceConfig
      | Record<string, unknown>
      | null,
  };
}

function isTokenVerifier(candidate: unknown): candidate is TokenVerifier {
  return Boolean(
    candidate && typeof (candidate as TokenVerifier).verify === 'function'
  );
}

function isAuthorizationPolicy(
  candidate: unknown
): candidate is AuthorizationPolicy {
  return Boolean(
    candidate &&
      typeof (candidate as AuthorizationPolicy).evaluateRequest === 'function'
  );
}

function isAuthorizationPolicySource(
  candidate: unknown
): candidate is AuthorizationPolicySource {
  return Boolean(
    candidate &&
      typeof (candidate as AuthorizationPolicySource).loadPolicy === 'function'
  );
}

/**
 * Factory metadata for registration.
 */
export const FACTORY_META = {
  base: AUTHORIZER_FACTORY_BASE_TYPE,
  key: 'PolicyAuthorizer',
} as const;

/**
 * Factory for creating DefaultPolicyAuthorizer instances.
 *
 * This factory uses lazy loading to avoid pulling in Node.js-specific
 * code in browser environments.
 */
export class DefaultPolicyAuthorizerFactory extends AuthorizerFactory<DefaultPolicyAuthorizerConfig> {
  public readonly type = 'PolicyAuthorizer';
  public readonly isDefault = true;

  /**
   * Creates a DefaultPolicyAuthorizer from the given configuration.
   *
   * @param config - Configuration for the authorizer
   * @param factoryArgs - Additional factory arguments:
   *   - TokenVerifier instance
   *   - AuthorizationPolicy instance
   *   - AuthorizationPolicySource instance
   * @returns The created authorizer
   */
  public async create(
    config?: DefaultPolicyAuthorizerConfig | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<Authorizer> {
    const normalized = normalizeConfig(config);

    // Resolve token verifier
    let tokenVerifier = factoryArgs.find(isTokenVerifier) as
      | TokenVerifier
      | undefined;

    if (!tokenVerifier && normalized.verifier) {
      tokenVerifier = await TokenVerifierFactory.createTokenVerifier(
        normalized.verifier
      );
    }

    if (!tokenVerifier) {
      throw new Error(
        'PolicyAuthorizer requires a verifier configuration or instance'
      );
    }

    // Resolve policy or policy source
    let policy = factoryArgs.find(isAuthorizationPolicy) as
      | AuthorizationPolicy
      | undefined;

    let policySource = factoryArgs.find(isAuthorizationPolicySource) as
      | AuthorizationPolicySource
      | undefined;

    // Create policy from config if not provided as argument
    if (!policy && normalized.policy) {
      policy = await AuthorizationPolicyFactory.createAuthorizationPolicy(
        normalized.policy
      );
    }

    // Create policy source from config if not provided as argument
    if (!policySource && normalized.policySource) {
      policySource =
        await AuthorizationPolicySourceFactory.createAuthorizationPolicySource(
          normalized.policySource
        );
    }

    // Validate that we have either policy or policy source
    if (!policy && !policySource) {
      throw new Error(
        'PolicyAuthorizer requires either a policy or policySource configuration'
      );
    }

    const { DefaultPolicyAuthorizer } =
      await getDefaultPolicyAuthorizerModule();

    return new DefaultPolicyAuthorizer({
      tokenVerifier,
      policy,
      policySource,
    });
  }
}

export default DefaultPolicyAuthorizerFactory;
