import { InMemoryStorageProvider } from '../storage/in-memory-storage.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { getLogger } from '../util/logging.js';
import { DefaultDeliveryTracker } from './default-delivery-tracker.js';
import type { DeliveryTrackerEventHandler } from './default-delivery-tracker.js';
import {
  DeliveryTrackerConfig,
  DeliveryTrackerFactory,
  DeliveryTrackerFactoryContext,
  registerDeliveryTrackerFactory,
} from './delivery-tracker-factory.js';

const logger = getLogger(
  'naylence.fame.delivery.default_delivery_tracker_factory'
);

export interface DefaultDeliveryTrackerConfig extends DeliveryTrackerConfig {
  type: 'DefaultDeliveryTracker';
  futuresGcGraceSecs?: number;
  futuresSweepIntervalSecs?: number;
}

interface NormalizedDefaultDeliveryTrackerConfig {
  readonly futuresGcGraceSecs?: number | undefined;
  readonly futuresSweepIntervalSecs?: number | undefined;
}

export class DefaultDeliveryTrackerFactory extends DeliveryTrackerFactory<DefaultDeliveryTrackerConfig> {
  public readonly type = 'DefaultDeliveryTracker';
  public override readonly isDefault = true;

  public async create(
    config?: DefaultDeliveryTrackerConfig | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<DefaultDeliveryTracker> {
    const context = (factoryArgs[0] ?? {}) as DeliveryTrackerFactoryContext;
    const normalizedConfig = normalizeDefaultDeliveryTrackerConfig(config);
    const storageProvider = resolveStorageProvider(context.storageProvider);

    logger.debug('creating_default_delivery_tracker', {
      futuresGcGraceSecs: normalizedConfig.futuresGcGraceSecs,
      futuresSweepIntervalSecs: normalizedConfig.futuresSweepIntervalSecs,
      storageProvider: storageProvider.constructor.name,
    });

    const trackerOptions: {
      futuresGcGraceSecs?: number;
      futuresSweepIntervalSecs?: number;
    } = {
      ...(normalizedConfig.futuresGcGraceSecs !== undefined
        ? { futuresGcGraceSecs: normalizedConfig.futuresGcGraceSecs }
        : {}),
      ...(normalizedConfig.futuresSweepIntervalSecs !== undefined
        ? {
            futuresSweepIntervalSecs: normalizedConfig.futuresSweepIntervalSecs,
          }
        : {}),
    };

    const tracker = new DefaultDeliveryTracker(storageProvider, trackerOptions);

    const handlers = normalizeEventHandlers(context.eventHandlers);
    for (const handler of handlers) {
      tracker.addEventHandler(handler);
    }

    return tracker;
  }
}

function normalizeDefaultDeliveryTrackerConfig(
  config:
    | DefaultDeliveryTrackerConfig
    | Record<string, unknown>
    | null
    | undefined
): NormalizedDefaultDeliveryTrackerConfig {
  if (!config) {
    return {};
  }

  const candidate = config as DefaultDeliveryTrackerConfig &
    Record<string, unknown>;

  const futuresGcGraceSecs = readNumberWithLegacy(candidate, 'futuresGcGraceSecs', [
    'futures_gc_grace_secs',
    'futures_gc_graceSeconds',
  ]);

  const futuresSweepIntervalSecs = readNumberWithLegacy(
    candidate,
    'futuresSweepIntervalSecs',
    ['futures_sweep_interval_secs', 'futures_sweepIntervalSecs']
  );

  return {
    futuresGcGraceSecs,
    futuresSweepIntervalSecs,
  };
}

function readNumberWithLegacy(
  source: Record<string, unknown>,
  camelKey: string,
  legacyKeys: string[]
): number | undefined {
  const camelValue = coerceNumber(source[camelKey]);
  if (camelValue !== undefined) {
    return camelValue;
  }

  for (const legacyKey of legacyKeys) {
    if (!(legacyKey in source)) {
      continue;
    }
    const coerced = coerceNumber(source[legacyKey]);
    if (coerced !== undefined) {
      source[camelKey] = coerced;
      return coerced;
    }
  }

  return undefined;
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function normalizeEventHandlers(
  handlers:
    | DeliveryTrackerEventHandler
    | DeliveryTrackerEventHandler[]
    | undefined
): DeliveryTrackerEventHandler[] {
  if (!handlers) {
    return [];
  }
  return Array.isArray(handlers) ? handlers : [handlers];
}

function resolveStorageProvider(
  provided: StorageProvider | undefined
): StorageProvider {
  if (provided) {
    return provided;
  }
  return new InMemoryStorageProvider();
}

registerDeliveryTrackerFactory(
  'DefaultDeliveryTracker',
  DefaultDeliveryTrackerFactory
);
