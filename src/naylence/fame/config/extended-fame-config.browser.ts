import {
  normalizeExtendedFameConfig,
  type ExtendedFameConfig,
  ExtendedFameConfigSchema,
} from './extended-fame-config-base.js';
import {
  getDefaultFameConfigResolver,
  setDefaultFameConfigResolver,
} from '@naylence/core';

export { ExtendedFameConfigSchema };
export { normalizeExtendedFameConfig };
export type { ExtendedFameConfig };

export const ENV_VAR_FAME_CONFIG = 'FAME_CONFIG';

let cachedRawConfig: Record<string, unknown> | null = null;
let cachedConfig: ExtendedFameConfig | null = null;

export function loadRawFameConfig(): Record<string, unknown> {
  if (!cachedRawConfig) {
    cachedRawConfig = {};
  }
  return { ...cachedRawConfig };
}

export function loadFameConfig(): ExtendedFameConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const normalized = normalizeExtendedFameConfig(loadRawFameConfig());
  cachedConfig = normalized;
  return normalized;
}

export async function loadPluginsFromConfig(): Promise<void> {
  // Browser builds cannot dynamically import runtime plugins from disk.
}

export function getFameConfig(): ExtendedFameConfig {
  return loadFameConfig();
}

export function resetFameConfigCache(): void {
  cachedRawConfig = null;
  cachedConfig = null;
}

if (!getDefaultFameConfigResolver()) {
  setDefaultFameConfigResolver(async () => loadRawFameConfig());
}
