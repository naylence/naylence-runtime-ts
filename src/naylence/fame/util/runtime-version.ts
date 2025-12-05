import { VERSION } from '../../../version.js';

/**
 * Resolves the runtime version.
 *
 * The version is now injected at build time from package.json into version.ts.
 * This function maintains backward compatibility by returning a Promise.
 *
 * @returns The runtime version string, or null if not available.
 */
export async function resolveRuntimeVersion(): Promise<string | null> {
  return VERSION || null;
}

/**
 * For testing purposes only. No-op since version is now static.
 * Kept for backward compatibility with existing tests.
 */
export function resetCachedRuntimeVersionForTesting(): void {
  // No-op: version is now static and injected at build time
}
