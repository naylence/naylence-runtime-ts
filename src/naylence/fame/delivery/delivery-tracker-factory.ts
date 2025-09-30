import type { CreateResourceOptions, ResourceConfig } from "naylence-factory";
import {
  AbstractResourceFactory,
  createDefaultResource,
  createResource,
  registerFactory,
} from "naylence-factory";

import type {
  DefaultDeliveryTracker,
  DeliveryTrackerEventHandler,
} from "./default-delivery-tracker.js";
import type { StorageProvider } from "../storage/storage-provider.js";

export const DELIVERY_TRACKER_FACTORY_BASE_TYPE = "DeliveryTrackerFactory";

export interface DeliveryTrackerConfig extends ResourceConfig {
  type: string;
  namespace?: string;
  futuresGcGraceSecs?: number;
  futuresSweepIntervalSecs?: number;
  [key: string]: unknown;
}

export interface DeliveryTrackerFactoryContext {
  storageProvider?: StorageProvider;
  eventHandlers?: DeliveryTrackerEventHandler | DeliveryTrackerEventHandler[];
}

export abstract class DeliveryTrackerFactory<
  C extends DeliveryTrackerConfig = DeliveryTrackerConfig,
> extends AbstractResourceFactory<DefaultDeliveryTracker, C> {
  public abstract create(
    config?: C | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<DefaultDeliveryTracker>;

  public static async createDeliveryTracker(
    config?: DeliveryTrackerConfig | Record<string, unknown> | null,
    options: CreateResourceOptions = {},
    context: DeliveryTrackerFactoryContext = {}
  ): Promise<DefaultDeliveryTracker | null> {
    const factoryArgs = [context, ...(options.factoryArgs ?? [])];
    const mergedOptions: CreateResourceOptions = {
      ...options,
      factoryArgs,
    };

    const configRecord = (config ?? null) as Record<string, unknown> | null;
    const typeValue = configRecord?.type;
    const hasType = typeof typeValue === "string" && typeValue.length > 0;

    if (hasType) {
      return createResource<DefaultDeliveryTracker>(
        DELIVERY_TRACKER_FACTORY_BASE_TYPE,
        configRecord,
        mergedOptions
      );
    }

    return createDefaultResource<DefaultDeliveryTracker>(
      DELIVERY_TRACKER_FACTORY_BASE_TYPE,
      configRecord ?? null,
      mergedOptions
    );
  }
}

export function registerDeliveryTrackerFactory(
  type: string,
  factory: new (...args: unknown[]) => DeliveryTrackerFactory
): void {
  registerFactory(DELIVERY_TRACKER_FACTORY_BASE_TYPE, type, factory);
}
