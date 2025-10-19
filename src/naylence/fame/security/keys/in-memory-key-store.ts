import { getLogger } from '../../util/logging.js';
import type { KeyRecord } from './key-store.js';
import { KeyStore } from './key-store.js';
import {
  JWKValidationError,
  validateJwkComplete,
} from '../crypto/jwk-validation.js';

const logger = getLogger('naylence.fame.security.keys.in_memory_key_store');

export class InMemoryKeyStore extends KeyStore {
  private readonly keys: Map<string, KeyRecord>;

  constructor(
    initialKeys:
      | Record<string, KeyRecord>
      | Map<string, KeyRecord>
      | null = null
  ) {
    super();
    this.keys = new Map();

    if (initialKeys instanceof Map) {
      for (const [kid, jwk] of initialKeys.entries()) {
        this.keys.set(kid, this.cloneKey(kid, jwk));
      }
    } else if (initialKeys) {
      for (const [kid, jwk] of Object.entries(initialKeys)) {
        this.keys.set(kid, this.cloneKey(kid, jwk));
      }
    }
  }

  public async addKey(kid: string, jwk: KeyRecord): Promise<void> {
    try {
      validateJwkComplete(jwk);
    } catch (error) {
      if (error instanceof JWKValidationError) {
        logger.warning('rejected_invalid_jwk_individual', {
          kid,
          error: error.message,
        });
        return;
      }
      throw error;
    }

    const keyToStore = this.cloneKey(kid, jwk);
    const physicalPath =
      typeof keyToStore.physical_path === 'string'
        ? (keyToStore.physical_path as string)
        : undefined;
    const use =
      typeof keyToStore.use === 'string'
        ? (keyToStore.use as string)
        : undefined;

    if (physicalPath && use) {
      const basePath = physicalPath.includes('@')
        ? (physicalPath.split('@', 2)[1] ?? physicalPath)
        : physicalPath;

      const staleKeys: string[] = [];
      for (const [existingKid, existingJwk] of this.keys.entries()) {
        if (existingKid === kid) {
          continue;
        }

        const existingUse =
          typeof existingJwk.use === 'string'
            ? (existingJwk.use as string)
            : undefined;
        const existingPath =
          typeof existingJwk.physical_path === 'string'
            ? (existingJwk.physical_path as string)
            : undefined;

        if (existingUse !== use) {
          continue;
        }

        if (!existingPath) {
          continue;
        }

        const matchesPath =
          existingPath === physicalPath ||
          existingPath === basePath ||
          existingPath.endsWith(`@${basePath}`);

        if (matchesPath) {
          staleKeys.push(existingKid);
        }
      }

      if (staleKeys.length > 0) {
        logger.debug('removing_stale_keys_before_adding_new_key', {
          new_kid: kid,
          physical_path: physicalPath,
          base_path: basePath,
          use,
          stale_key_ids: staleKeys,
          count: staleKeys.length,
        });

        for (const staleKid of staleKeys) {
          this.keys.delete(staleKid);
        }
      }
    }

    this.keys.set(kid, keyToStore);
  }

  public async getKey(kid: string): Promise<KeyRecord> {
    const key = this.keys.get(kid);
    if (!key) {
      const keysByPath: Record<string, string[]> = {};
      for (const [existingKid, existingJwk] of this.keys.entries()) {
        const path =
          typeof existingJwk.physical_path === 'string'
            ? (existingJwk.physical_path as string)
            : 'null';
        if (!keysByPath[path]) {
          keysByPath[path] = [];
        }
        keysByPath[path].push(existingKid);
      }

      logger.debug('key_lookup_failed', {
        missing_kid: kid,
        available_kids: Array.from(this.keys.keys()),
        keys_by_path: keysByPath,
      });
      throw new Error(`Unknown key id: ${kid}`);
    }
    return key;
  }

  public async hasKey(kid: string): Promise<boolean> {
    return this.keys.has(kid);
  }

  public async getKeys(): Promise<Iterable<KeyRecord>> {
    return this.keys.values();
  }

  public async getKeysForPath(
    physicalPath: string
  ): Promise<Iterable<KeyRecord>> {
    const matching: KeyRecord[] = [];
    for (const key of this.keys.values()) {
      if (key.physical_path === physicalPath) {
        matching.push(key);
      }
    }
    return matching;
  }

  public async getKeysGroupedByPath(): Promise<Record<string, KeyRecord[]>> {
    const grouped = new Map<string, KeyRecord[]>();
    for (const key of this.keys.values()) {
      const physicalPath = key.physical_path;
      if (typeof physicalPath !== 'string') {
        continue;
      }
      if (!grouped.has(physicalPath)) {
        grouped.set(physicalPath, []);
      }
      grouped.get(physicalPath)!.push(key);
    }
    return Object.fromEntries(grouped.entries());
  }

  public async removeKeysForPath(physicalPath: string): Promise<number> {
    const keysToRemove: string[] = [];
    for (const [kid, jwk] of this.keys.entries()) {
      if (jwk.physical_path === physicalPath) {
        keysToRemove.push(kid);
      }
    }

    for (const kid of keysToRemove) {
      this.keys.delete(kid);
    }

    if (keysToRemove.length > 0) {
      logger.debug('removed_keys_for_path', {
        physical_path: physicalPath,
        removed_key_ids: keysToRemove,
        count: keysToRemove.length,
      });
    }

    return keysToRemove.length;
  }

  public async removeKey(kid: string): Promise<boolean> {
    const removed = this.keys.delete(kid);
    if (removed) {
      logger.debug('removed_individual_key', { kid });
    }
    return removed;
  }

  private cloneKey(kid: string, jwk: KeyRecord): KeyRecord {
    return {
      ...(jwk as Record<string, unknown>),
      kid,
    } as KeyRecord;
  }
}
