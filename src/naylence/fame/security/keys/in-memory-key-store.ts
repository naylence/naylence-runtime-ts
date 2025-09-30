import { getLogger } from "../../util/logging.js";
import type { KeyRecord } from "./key-store.js";
import { KeyStore } from "./key-store.js";
import { JWKValidationError, validateJwkComplete } from "../crypto/jwk-validation.js";

const logger = getLogger("in-memory-key-store");

export class InMemoryKeyStore extends KeyStore {
  private readonly keysByStorageKey: Map<string, KeyRecord>;
  private readonly storageKeysByKid: Map<string, Set<string>>;

  constructor(initialKeys: Record<string, KeyRecord> | Map<string, KeyRecord> | null = null) {
    super();
    this.keysByStorageKey = new Map();
    this.storageKeysByKid = new Map();

    if (initialKeys instanceof Map) {
      for (const [kid, jwk] of initialKeys.entries()) {
        this.storeKey(kid, jwk);
      }
    } else if (initialKeys) {
      for (const [kid, jwk] of Object.entries(initialKeys)) {
        this.storeKey(kid, jwk);
      }
    }
  }

  private buildStorageKey(kid: string, jwk: KeyRecord): string {
    const physicalPath = typeof jwk.physical_path === "string" ? jwk.physical_path : "";
    const use = typeof jwk.use === "string" ? jwk.use : "";
    return `${kid}::${physicalPath}::${use}`;
  }

  private storeKey(kid: string, jwk: KeyRecord): void {
    const storageKey = this.buildStorageKey(kid, jwk);
    this.keysByStorageKey.set(storageKey, jwk);
    let storageKeys = this.storageKeysByKid.get(kid);
    if (!storageKeys) {
      storageKeys = new Set();
      this.storageKeysByKid.set(kid, storageKeys);
    }
    storageKeys.add(storageKey);
  }

  private deleteStorageKey(kid: string, storageKey: string): void {
    this.keysByStorageKey.delete(storageKey);
    const storageKeys = this.storageKeysByKid.get(kid);
    if (!storageKeys) {
      return;
    }
    storageKeys.delete(storageKey);
    if (storageKeys.size === 0) {
      this.storageKeysByKid.delete(kid);
    }
  }

  public async addKey(kid: string, jwk: KeyRecord): Promise<void> {
    try {
      validateJwkComplete(jwk);
    } catch (error) {
      if (error instanceof JWKValidationError) {
        logger.warning("rejected_invalid_jwk_individual", { kid, error: error.message });
        return;
      }
      throw error;
    }

    const physicalPath = typeof jwk.physical_path === "string" ? jwk.physical_path : undefined;
    const use = typeof jwk.use === "string" ? jwk.use : undefined;

    const storageKey = this.buildStorageKey(kid, jwk);

    if (physicalPath && use) {
      const staleKeys: Array<{ kid: string; storageKey: string }> = [];
      for (const [existingStorageKey, existingJwk] of this.keysByStorageKey.entries()) {
        if (existingStorageKey === storageKey) {
          continue;
        }
        const existingKid = typeof existingJwk.kid === "string" ? existingJwk.kid : undefined;
        const existingPath =
          typeof existingJwk.physical_path === "string" ? existingJwk.physical_path : undefined;
        const existingUse = typeof existingJwk.use === "string" ? existingJwk.use : undefined;
        if (existingKid && existingPath === physicalPath && existingUse === use) {
          staleKeys.push({ kid: existingKid, storageKey: existingStorageKey });
        }
      }

      if (staleKeys.length > 0) {
        logger.debug("removing_stale_keys_before_adding_new_key", {
          new_kid: kid,
          physical_path: physicalPath,
          use,
          stale_key_ids: staleKeys.map(({ kid: staleKid }) => staleKid),
          count: staleKeys.length,
        });

        for (const { kid: staleKid, storageKey: staleStorageKey } of staleKeys) {
          this.deleteStorageKey(staleKid, staleStorageKey);
        }
      }
    }

    const existingKeysForKid = this.storageKeysByKid.get(kid);
    if (existingKeysForKid?.has(storageKey)) {
      this.deleteStorageKey(kid, storageKey);
    }

    this.storeKey(kid, jwk);
  }

  public async getKey(kid: string): Promise<KeyRecord> {
    const storageKeys = this.storageKeysByKid.get(kid);
    const firstStorageKey = storageKeys ? storageKeys.values().next().value : undefined;
    if (!firstStorageKey) {
      throw new Error(`Unknown key id: ${kid}`);
    }
    const key = this.keysByStorageKey.get(firstStorageKey);
    if (!key) {
      throw new Error(`Unknown key id: ${kid}`);
    }
    return key;
  }

  public async hasKey(kid: string): Promise<boolean> {
    return this.storageKeysByKid.has(kid);
  }

  public async getKeys(): Promise<Iterable<KeyRecord>> {
    return this.keysByStorageKey.values();
  }

  public async getKeysForPath(physicalPath: string): Promise<Iterable<KeyRecord>> {
    const matching: KeyRecord[] = [];
    for (const key of this.keysByStorageKey.values()) {
      if (key.physical_path === physicalPath) {
        matching.push(key);
      }
    }
    return matching;
  }

  public async getKeysGroupedByPath(): Promise<Record<string, KeyRecord[]>> {
    const grouped = new Map<string, KeyRecord[]>();
    for (const key of this.keysByStorageKey.values()) {
      const physicalPath = key.physical_path;
      if (typeof physicalPath !== "string") {
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
    const keysToRemove: Array<{ kid: string; storageKey: string }> = [];
    for (const [storageKey, jwk] of this.keysByStorageKey.entries()) {
      if (jwk.physical_path === physicalPath) {
        keysToRemove.push({ kid: jwk.kid as string, storageKey });
      }
    }

    for (const { kid, storageKey } of keysToRemove) {
      this.deleteStorageKey(kid, storageKey);
    }

    if (keysToRemove.length > 0) {
      logger.debug("removed_keys_for_path", {
        physical_path: physicalPath,
        removed_key_ids: keysToRemove.map(({ kid }) => kid),
        count: keysToRemove.length,
      });
    }

    return keysToRemove.length;
  }

  public async removeKey(kid: string): Promise<boolean> {
    const storageKeys = this.storageKeysByKid.get(kid);
    if (!storageKeys || storageKeys.size === 0) {
      return false;
    }

    for (const storageKey of Array.from(storageKeys)) {
      this.deleteStorageKey(kid, storageKey);
    }

    logger.debug("removed_individual_key", { kid });
    return true;
  }
}
