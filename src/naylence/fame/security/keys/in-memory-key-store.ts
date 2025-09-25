import { getLogger } from '../../util/logging.js';
import type { KeyRecord } from './key-store.js';
import { KeyStore } from './key-store.js';
import { JWKValidationError, validateJwkComplete } from '../crypto/jwk-validation.js';

const logger = getLogger('in-memory-key-store');

type KeyMap = Map<string, KeyRecord>;

export class InMemoryKeyStore extends KeyStore {
  private readonly keys: KeyMap;

  constructor(initialKeys: Record<string, KeyRecord> | Map<string, KeyRecord> | null = null) {
    super();
    if (initialKeys instanceof Map) {
      this.keys = new Map(initialKeys);
    } else if (initialKeys) {
      this.keys = new Map(Object.entries(initialKeys));
    } else {
      this.keys = new Map();
    }
  }

  public async addKey(kid: string, jwk: KeyRecord): Promise<void> {
    try {
      validateJwkComplete(jwk);
    } catch (error) {
      if (error instanceof JWKValidationError) {
        logger.warning('rejected_invalid_jwk_individual', { kid, error: error.message });
        return;
      }
      throw error;
    }

    const physicalPath = typeof jwk.physical_path === 'string' ? jwk.physical_path : undefined;
    const use = typeof jwk.use === 'string' ? jwk.use : undefined;

    if (physicalPath && use) {
      const staleKeys: string[] = [];
      for (const [existingKid, existingJwk] of this.keys.entries()) {
        const existingPath = typeof existingJwk.physical_path === 'string' ? existingJwk.physical_path : undefined;
        const existingUse = typeof existingJwk.use === 'string' ? existingJwk.use : undefined;
        if (
          existingKid !== kid &&
          existingPath === physicalPath &&
          existingUse === use
        ) {
          staleKeys.push(existingKid);
        }
      }

      if (staleKeys.length > 0) {
        logger.debug('removing_stale_keys_before_adding_new_key', {
          new_kid: kid,
          physical_path: physicalPath,
          use,
          stale_key_ids: staleKeys,
          count: staleKeys.length,
        });

        for (const staleKid of staleKeys) {
          this.keys.delete(staleKid);
        }
      }
    }

    this.keys.set(kid, jwk);
  }

  public async getKey(kid: string): Promise<KeyRecord> {
    const key = this.keys.get(kid);
    if (!key) {
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

  public async getKeysForPath(physicalPath: string): Promise<Iterable<KeyRecord>> {
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
    const existed = this.keys.delete(kid);
    if (existed) {
      logger.debug('removed_individual_key', { kid });
    }
    return existed;
  }
}
