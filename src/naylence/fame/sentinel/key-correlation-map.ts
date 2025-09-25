import { DEFAULT_KEY_CORRELATION_TTL_SEC } from '../constants/ttl-constants.js';
import { getLogger } from '../util/logging.js';
import { delay } from '../util/task-utils.js';
import { validateKeyCorrelationTtlSec } from '../util/ttl-validation.js';

const logger = getLogger('key-correlation-map');

type CorrelationEntry = {
  route: string;
  expiresAt: number;
};

export interface KeyCorrelationMapOptions {
  ttlSec?: number;
  maxEntries?: number;
}

export class KeyCorrelationMap {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly data = new Map<string, CorrelationEntry>();

  constructor(options: KeyCorrelationMapOptions = {}) {
    const ttlSec = options.ttlSec ?? DEFAULT_KEY_CORRELATION_TTL_SEC;
    const validatedTtl = validateKeyCorrelationTtlSec(ttlSec);
    this.ttlMs = (validatedTtl ?? ttlSec) * 1000;
    this.maxEntries = options.maxEntries ?? 2048;
  }

  public add(correlationId: string, route: string): void {
    const expiresAt = Date.now() + this.ttlMs;
    // refresh LRU position by deleting if present
    this.data.delete(correlationId);
    this.data.set(correlationId, { route, expiresAt });
    this.evict();

    logger.trace('key_corr_added', { corr_id: correlationId, route, ttl: this.ttlMs / 1000 });
  }

  public pop(correlationId: string): string | null {
    const entry = this.data.get(correlationId);
    if (!entry) {
      logger.trace('key_corr_not_found', { corr_id: correlationId });
      return null;
    }

    this.data.delete(correlationId);

    if (entry.expiresAt < Date.now()) {
      logger.trace('key_corr_expired', { corr_id: correlationId, route: entry.route });
      return null;
    }

    logger.trace('key_corr_found', { corr_id: correlationId, route: entry.route });
    return entry.route;
  }

  public size(): number {
    return this.data.size;
  }

  public async runCleanup({
    intervalMs = 5000,
    signal,
  }: { intervalMs?: number; signal?: AbortSignal } = {}): Promise<void> {
    logger.debug('key_corr_cleanup_started', { interval: intervalMs / 1000 });
    try {
      while (!signal?.aborted) {
        await delay(intervalMs, signal);
        this.evict();
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'Aborted') {
        logger.debug('key_corr_cleanup_cancelled');
      } else {
        logger.error('key_corr_cleanup_error', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private evict(): void {
    const now = Date.now();

    // TTL eviction first to keep map tidy
    for (const [corrId, entry] of this.data) {
      if (entry.expiresAt < now) {
        this.data.delete(corrId);
        logger.trace('key_corr_ttl_evicted', { corr_id: corrId, route: entry.route });
      }
    }

    // LRU eviction if size exceeds max
    while (this.data.size > this.maxEntries) {
      const oldestKey = this.data.keys().next().value;
      if (!oldestKey) {
        break;
      }
      const removed = this.data.get(oldestKey);
      this.data.delete(oldestKey);
      if (removed) {
        logger.trace('key_corr_lru_evicted', { corr_id: oldestKey, route: removed.route });
      }
    }
  }
}
