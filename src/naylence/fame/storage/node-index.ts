/**
 * Node.js specific storage exports. This file registers the SQLite storage
 * provider and re-exports the related types so that the primary Node entry
 * point can expose them without forcing the browser bundle to load optional
 * dependencies.
 */
import './sqlite-storage-provider-factory.js';
import {
  registerStorageProfile,
  SQLITE_PROFILES,
} from './storage-profile-factory.js';

// Register SQLite profiles for Node.js environment
for (const [name, config] of Object.entries(SQLITE_PROFILES)) {
  registerStorageProfile(name, config as Record<string, unknown>);
}

export * from './sqlite-storage-provider.js';
export type * from './sqlite-storage-provider-factory.js';
