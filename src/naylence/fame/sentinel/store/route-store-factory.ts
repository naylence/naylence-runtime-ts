import type { CreateResourceOptions, ResourceConfig } from "naylence-factory";
import { AbstractResourceFactory,
  createDefaultResource,
  createResource } from "naylence-factory";
import { InMemoryKeyValueStore } from "../../storage/in-memory-storage.js";
import type { RouteEntry, RouteStore } from "./route-store.js";

export const ROUTE_STORE_FACTORY_BASE_TYPE = "RouteStoreFactory";

export interface RouteStoreConfig extends ResourceConfig {
  type: string;
  params?: Record<string, unknown> | null;
}

export abstract class RouteStoreFactory<
  C extends RouteStoreConfig = RouteStoreConfig,
> extends AbstractResourceFactory<RouteStore, C> {
  public abstract create(
    config?: C | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<RouteStore>;

  public static async createRouteStore(
    config?: RouteStoreConfig | Record<string, unknown> | null,
    options: CreateResourceOptions = {}
  ): Promise<RouteStore | null> {
    const configRecord = (config ?? null) as Record<string, unknown> | null;

    const store = configRecord
      ? await createResource<RouteStore>(ROUTE_STORE_FACTORY_BASE_TYPE, configRecord, options)
      : await createDefaultResource<RouteStore>(ROUTE_STORE_FACTORY_BASE_TYPE, null, options);

    return store ?? null;
  }
}

export const FACTORY_META = {
  base: ROUTE_STORE_FACTORY_BASE_TYPE,
  key: "InMemoryRouteStore",
} as const;

export class InMemoryRouteStoreFactory extends RouteStoreFactory {
  public readonly type = "InMemoryRouteStore";
  public readonly isDefault = true;
  public readonly priority = 100;

  public async create(
    _config?: RouteStoreConfig | Record<string, unknown> | null,
    ..._factoryArgs: unknown[]
  ): Promise<RouteStore> {
    return new InMemoryKeyValueStore<RouteEntry>();
  }
}

export default InMemoryRouteStoreFactory;
