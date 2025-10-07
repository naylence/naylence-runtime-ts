import type { KeyProvider } from './key-provider.js';
import {
  JWKValidationError,
  validateJwkComplete,
  type JsonWebKey,
} from '../crypto/jwk-validation.js';
import { secureDigest } from '../../util/util.js';
import { getLogger } from '../../util/logging.js';

const logger = getLogger('key-store');

export type KeyRecord = Record<string, unknown> & { kid: string };

export abstract class KeyStore implements KeyProvider {
  /** Store (or replace) a JWK under the given key-id. */
  public abstract addKey(kid: string, jwk: KeyRecord): Promise<void>;

  /** Return the JWK for *kid* or throw ``Error`` if missing. */
  public abstract getKey(kid: string): Promise<KeyRecord>;

  /** Check if the store contains the key for *kid*. */
  public abstract hasKey(kid: string): Promise<boolean>;

  /** Return all stored JWKs. */
  public abstract getKeys(): Promise<Iterable<KeyRecord>>;

  /** Return all JWKs that originated from the given physical path. */
  public abstract getKeysForPath(
    physicalPath: string
  ): Promise<Iterable<KeyRecord>>;

  /** Return a mapping sid → list[JWK] for all stored keys. */
  public abstract getKeysGroupedByPath(): Promise<Record<string, KeyRecord[]>>;

  /** Remove all keys associated with the given physical path. */
  public abstract removeKeysForPath(physicalPath: string): Promise<number>;

  /** Remove a specific key by its key ID. */
  public abstract removeKey(kid: string): Promise<boolean>;

  /**
   * Add a batch of keys that originated from the same physical path.
   */
  public async addKeys(
    keys: Array<JsonWebKey>,
    physicalPath: string
  ): Promise<void> {
    logger.debug('adding_keys', {
      from_physical_path: physicalPath,
      key_ids: keys.map((key) =>
        typeof key?.kid === 'string' ? key.kid : 'unknown'
      ),
    });

    const sid = secureDigest(physicalPath);

    for (const keyInfo of keys) {
      try {
        validateJwkComplete(keyInfo);
      } catch (error) {
        if (error instanceof JWKValidationError) {
          logger.warning('rejected_invalid_jwk', {
            kid: typeof keyInfo?.kid === 'string' ? keyInfo.kid : 'unknown',
            from_physical_path: physicalPath,
            error: error.message,
          });
          continue;
        }
        throw error;
      }

      const kid = keyInfo.kid as string;
      const keyWithMeta: KeyRecord = {
        ...(keyInfo as Record<string, unknown>),
        kid,
        sid,
        physical_path: physicalPath,
      } as KeyRecord;

      await this.addKey(kid, keyWithMeta);

      logger.debug('added_key', {
        kid,
        from_physical_path: physicalPath,
        use: typeof keyInfo.use === 'string' ? keyInfo.use : 'unknown',
      });
    }
  }
}

let instance: KeyStore | null = null;

export function setKeyStore(keyStore: KeyStore | null): void {
  instance = keyStore;
}

export function getKeyStore(): KeyStore {
  if (!instance) {
    // Lazy-load to avoid circular dependency
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { InMemoryKeyStore } = require('./in-memory-key-store.js');
    instance = new InMemoryKeyStore();
  }
  if (!instance) {
    throw new Error('Failed to initialize key store');
  }
  return instance;
}

export type KeyStoreClass = new (...args: any[]) => KeyStore;
