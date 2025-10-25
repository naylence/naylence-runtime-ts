import type { ResourceConfig } from '@naylence/factory';

/**
 * Base configuration shape for security manager factories.
 */
export interface SecurityManagerConfig extends ResourceConfig {
  type: string;
  [key: string]: unknown;
}

/**
 * Configuration for node security profiles. This mirrors the Python implementation
 * where a profile name may be provided for lookups.
 */
export interface SecurityProfileConfig extends SecurityManagerConfig {
  type: 'SecurityProfile';
  profile?: string | null;
}
