import type { CreateResourceOptions, ResourceConfig } from "naylence-factory";
import { AbstractResourceFactory, createDefaultResource, createResource } from "naylence-factory";

import type { LoadBalancerStickinessManager } from "./load-balancer-stickiness-manager.js";

export const LOAD_BALANCER_STICKINESS_MANAGER_FACTORY_BASE_TYPE =
  "LoadBalancerStickinessManagerFactory";

export interface LoadBalancerStickinessManagerConfig extends ResourceConfig {
  type: string;
  [key: string]: unknown;
}

export abstract class LoadBalancerStickinessManagerFactory<
  C extends LoadBalancerStickinessManagerConfig = LoadBalancerStickinessManagerConfig,
> extends AbstractResourceFactory<LoadBalancerStickinessManager, C> {
  public abstract create(
    config?: C | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<LoadBalancerStickinessManager>;

  public static async createLoadBalancerStickinessManager<
    C extends LoadBalancerStickinessManagerConfig = LoadBalancerStickinessManagerConfig,
  >(
    config?: C | Record<string, unknown> | null,
    options: CreateResourceOptions = {}
  ): Promise<LoadBalancerStickinessManager | null> {
    const configRecord = (config ?? null) as Record<string, unknown> | null;

    const instance = configRecord
      ? await createResource<LoadBalancerStickinessManager>(
          LOAD_BALANCER_STICKINESS_MANAGER_FACTORY_BASE_TYPE,
          configRecord,
          options
        )
      : await createDefaultResource<LoadBalancerStickinessManager>(
          LOAD_BALANCER_STICKINESS_MANAGER_FACTORY_BASE_TYPE,
          null,
          options
        );

    return instance ?? null;
  }
}
