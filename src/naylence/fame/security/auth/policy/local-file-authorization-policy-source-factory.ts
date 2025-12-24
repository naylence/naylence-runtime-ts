import { safeImport } from '../../../util/lazy-import.js';
import type { AuthorizationPolicySource } from './authorization-policy-source.js';
import {
  AUTHORIZATION_POLICY_SOURCE_FACTORY_BASE_TYPE,
  AuthorizationPolicySourceFactory,
  type AuthorizationPolicySourceConfig,
} from './authorization-policy-source-factory.js';
import type { AuthorizationPolicyConfig } from './authorization-policy-factory.js';

/**
 * Configuration for LocalFileAuthorizationPolicySource.
 */
export interface LocalFileAuthorizationPolicySourceConfig
  extends AuthorizationPolicySourceConfig {
  type: 'LocalFileAuthorizationPolicySource';

  /**
   * Path to the policy file (YAML or JSON).
   */
  path: string;

  /**
   * Format of the policy file.
   * If not specified, auto-detects from file extension.
   * @default 'auto'
   */
  format?: 'yaml' | 'json' | 'auto';

  /**
   * Configuration for the policy factory to use when parsing the loaded file.
   * Determines which AuthorizationPolicy implementation is created.
   *
   * If not specified, the policy definition from the file is used directly
   * as the factory configuration (must include a 'type' field).
   */
  policyFactory?: AuthorizationPolicyConfig | Record<string, unknown>;
}

type LocalFileModuleType =
  typeof import('./local-file-authorization-policy-source.js');

let localFileModulePromise: Promise<LocalFileModuleType> | null = null;

async function getLocalFileModule(): Promise<LocalFileModuleType> {
  if (!localFileModulePromise) {
    localFileModulePromise = safeImport(
      () => import('./local-file-authorization-policy-source.js'),
      'local-file-authorization-policy-source'
    );
  }
  return localFileModulePromise;
}

interface NormalizedConfig {
  path: string;
  format: 'yaml' | 'json' | 'auto';
  policyFactory?: AuthorizationPolicyConfig | Record<string, unknown>;
}

function normalizeConfig(
  config?: LocalFileAuthorizationPolicySourceConfig | Record<string, unknown> | null
): NormalizedConfig {
  if (!config) {
    throw new Error(
      'LocalFileAuthorizationPolicySourceFactory requires a configuration with a path'
    );
  }

  const candidate = config as Record<string, unknown>;

  const path = candidate.path;
  if (typeof path !== 'string' || path.trim().length === 0) {
    throw new Error(
      'LocalFileAuthorizationPolicySourceConfig requires a non-empty path'
    );
  }

  const format = candidate.format as 'yaml' | 'json' | 'auto' | undefined;
  if (format !== undefined && !['yaml', 'json', 'auto'].includes(format)) {
    throw new Error(
      `Invalid format "${String(format)}". Must be "yaml", "json", or "auto"`
    );
  }

  const policyFactory = candidate.policyFactory as
    | AuthorizationPolicyConfig
    | Record<string, unknown>
    | undefined;

  return {
    path: path.trim(),
    format: format ?? 'auto',
    policyFactory,
  };
}

/**
 * Factory metadata for registration.
 */
export const FACTORY_META = {
  base: AUTHORIZATION_POLICY_SOURCE_FACTORY_BASE_TYPE,
  key: 'LocalFileAuthorizationPolicySource',
} as const;

/**
 * Factory for creating LocalFileAuthorizationPolicySource instances.
 *
 * This factory uses lazy loading to avoid pulling in Node.js-specific
 * code (filesystem operations) in browser environments.
 */
export class LocalFileAuthorizationPolicySourceFactory extends AuthorizationPolicySourceFactory<LocalFileAuthorizationPolicySourceConfig> {
  public readonly type = 'LocalFileAuthorizationPolicySource';

  /**
   * Creates a LocalFileAuthorizationPolicySource from the given configuration.
   *
   * @param config - Configuration specifying the policy file path and options
   * @returns The created policy source
   */
  public async create(
    config?:
      | LocalFileAuthorizationPolicySourceConfig
      | Record<string, unknown>
      | null
  ): Promise<AuthorizationPolicySource> {
    const normalized = normalizeConfig(config);

    const { LocalFileAuthorizationPolicySource } =
      await getLocalFileModule();

    return new LocalFileAuthorizationPolicySource({
      path: normalized.path,
      format: normalized.format,
      policyFactory: normalized.policyFactory,
    });
  }
}

export default LocalFileAuthorizationPolicySourceFactory;
