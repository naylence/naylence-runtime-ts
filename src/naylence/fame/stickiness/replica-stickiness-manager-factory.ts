import type { CreateResourceOptions, ResourceConfig } from 'naylence-factory';
import { AbstractResourceFactory, createDefaultResource, createResource } from 'naylence-factory';

import type { ReplicaStickinessManager } from './replica-stickiness-manager.js';

export const REPLICA_STICKINESS_MANAGER_FACTORY_BASE_TYPE = 'ReplicaStickinessManagerFactory';

export interface ReplicaStickinessManagerConfig extends ResourceConfig {
  type: string;
  [key: string]: unknown;
}

export abstract class ReplicaStickinessManagerFactory<
  C extends ReplicaStickinessManagerConfig = ReplicaStickinessManagerConfig
> extends AbstractResourceFactory<ReplicaStickinessManager, C> {
  public abstract create(
    config?: C | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<ReplicaStickinessManager>;

  public static async createReplicaStickinessManager<
    C extends ReplicaStickinessManagerConfig = ReplicaStickinessManagerConfig
  >(
    config?: C | Record<string, unknown> | null,
    options: CreateResourceOptions = {}
  ): Promise<ReplicaStickinessManager | null> {
    const configRecord = (config ?? null) as Record<string, unknown> | null;

    const instance = configRecord
      ? await createResource<ReplicaStickinessManager>(
          REPLICA_STICKINESS_MANAGER_FACTORY_BASE_TYPE,
          configRecord,
          options
        )
      : await createDefaultResource<ReplicaStickinessManager>(
          REPLICA_STICKINESS_MANAGER_FACTORY_BASE_TYPE,
          null,
          options
        );

    return instance ?? null;
  }
}
