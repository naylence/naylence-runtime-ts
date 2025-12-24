import { parse as parseYaml } from 'yaml';

import { getLogger } from '../../../util/logging.js';
import type { AuthorizationPolicy } from './authorization-policy.js';
import {
  AuthorizationPolicyFactory,
  type AuthorizationPolicyConfig,
} from './authorization-policy-factory.js';
import type { AuthorizationPolicySource } from './authorization-policy-source.js';

const logger = getLogger(
  'naylence.fame.security.auth.policy.local_file_authorization_policy_source'
);

/**
 * Format of the policy file.
 */
export type PolicyFileFormat = 'yaml' | 'json' | 'auto';

/**
 * Configuration options for LocalFileAuthorizationPolicySource.
 */
export interface LocalFileAuthorizationPolicySourceOptions {
  /**
   * Path to the policy file.
   */
  path: string;

  /**
   * Format of the policy file.
   * If 'auto', the format is detected from the file extension.
   * @default 'auto'
   */
  format?: PolicyFileFormat;

  /**
   * Configuration for the policy factory to use when parsing the loaded file.
   * Determines which AuthorizationPolicy implementation is created from the
   * loaded policy definition.
   *
   * If not specified, the policy definition from the file is used directly
   * as the factory configuration (must include a 'type' field).
   */
  policyFactory?: AuthorizationPolicyConfig | Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(content: string): Record<string, unknown> {
  const parsed = JSON.parse(content);
  if (!isPlainObject(parsed)) {
    throw new Error('Parsed JSON policy must be an object');
  }
  return parsed;
}

function parseYamlContent(content: string): Record<string, unknown> {
  const parsed = parseYaml(content ?? '') as unknown;
  if (parsed == null) {
    return {};
  }
  if (!isPlainObject(parsed)) {
    throw new Error('Parsed YAML policy must be an object');
  }
  return parsed;
}

function detectFormat(filePath: string): 'yaml' | 'json' {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) {
    return 'yaml';
  }
  if (lower.endsWith('.json')) {
    return 'json';
  }
  // Default to YAML for unknown extensions
  return 'yaml';
}

/**
 * An authorization policy source that loads policy definitions from a local file.
 *
 * Supports YAML and JSON formats. The file must contain a valid policy
 * configuration object that can be used to create an AuthorizationPolicy
 * via the factory system.
 *
 * This is a Node.js-only implementation that uses the filesystem.
 */
export class LocalFileAuthorizationPolicySource
  implements AuthorizationPolicySource
{
  private readonly path: string;
  private readonly format: PolicyFileFormat;
  private readonly policyFactoryConfig:
    | AuthorizationPolicyConfig
    | Record<string, unknown>
    | undefined;
  private cachedPolicy: AuthorizationPolicy | null = null;

  constructor(options: LocalFileAuthorizationPolicySourceOptions) {
    this.path = options.path;
    this.format = options.format ?? 'auto';
    this.policyFactoryConfig = options.policyFactory;
  }

  /**
   * Loads the authorization policy from the configured file.
   *
   * The file is read and parsed according to the configured format.
   * The parsed content is then used to create an AuthorizationPolicy
   * via the factory system.
   *
   * @returns The loaded authorization policy
   */
  async loadPolicy(): Promise<AuthorizationPolicy> {
    // Return cached policy if available
    if (this.cachedPolicy) {
      return this.cachedPolicy;
    }

    logger.debug('loading_policy_from_file', { path: this.path });

    // Dynamic import of fs for Node.js
    const fs = await import('node:fs/promises');

    // Read the file
    const content = await fs.readFile(this.path, 'utf-8');

    // Determine format
    const effectiveFormat =
      this.format === 'auto' ? detectFormat(this.path) : this.format;

    // Parse the content
    let policyDefinition: Record<string, unknown>;
    if (effectiveFormat === 'json') {
      policyDefinition = parseJson(content);
    } else {
      policyDefinition = parseYamlContent(content);
    }

    logger.debug('parsed_policy_definition', {
      path: this.path,
      format: effectiveFormat,
      hasType: 'type' in policyDefinition,
    });

    // Determine the factory configuration to use
    const factoryConfig = this.policyFactoryConfig ?? policyDefinition;

    // Ensure we have a type field for the factory
    if (!('type' in factoryConfig) || typeof factoryConfig.type !== 'string') {
      throw new Error(
        `Policy definition at ${this.path} must have a 'type' field, ` +
          `or policyFactory config must be provided`
      );
    }

    // Build the factory config with the policy definition
    // The file content IS the policy definition, so we extract the type
    // and wrap the remaining content as the policyDefinition
    const { type, ...restOfFile } = policyDefinition as { type?: string } & Record<string, unknown>;
    const mergedConfig =
      this.policyFactoryConfig != null
        ? { ...this.policyFactoryConfig, policyDefinition }
        : { type: factoryConfig.type, policyDefinition: restOfFile };

    // Create the policy using the factory system
    const policy =
      await AuthorizationPolicyFactory.createAuthorizationPolicy(mergedConfig);

    if (!policy) {
      throw new Error(
        `Failed to create authorization policy from ${this.path}`
      );
    }

    this.cachedPolicy = policy;
    logger.info('loaded_policy_from_file', {
      path: this.path,
      policyType: factoryConfig.type,
    });

    return policy;
  }

  /**
   * Clears the cached policy, forcing a reload on the next loadPolicy() call.
   */
  clearCache(): void {
    this.cachedPolicy = null;
  }

  /**
   * Reloads the policy from the file, clearing any cached version.
   *
   * @returns The reloaded authorization policy
   */
  async reloadPolicy(): Promise<AuthorizationPolicy> {
    this.clearCache();
    return this.loadPolicy();
  }
}
