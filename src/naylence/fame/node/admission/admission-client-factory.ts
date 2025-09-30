import type { CreateResourceOptions, ResourceConfig } from "naylence-factory";
import { AbstractResourceFactory, createDefaultResource, createResource } from "naylence-factory";
import type { AdmissionClient } from "./admission-client.js";

export const ADMISSION_CLIENT_FACTORY_BASE_TYPE = "AdmissionClientFactory";

export interface AdmissionConfig extends ResourceConfig {
  type: string;
  [key: string]: unknown;
}

export abstract class AdmissionClientFactory<
  C extends AdmissionConfig = AdmissionConfig,
> extends AbstractResourceFactory<AdmissionClient, C> {
  public abstract create(
    config?: C | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<AdmissionClient>;

  public static async createAdmissionClient<C extends AdmissionConfig = AdmissionConfig>(
    config?: C | Record<string, unknown> | null,
    options: CreateResourceOptions = {}
  ): Promise<AdmissionClient> {
    if (config) {
      const client = await createResource<AdmissionClient>(
        ADMISSION_CLIENT_FACTORY_BASE_TYPE,
        config,
        options
      );

      if (!client) {
        throw new Error("Failed to create admission client from configuration");
      }

      return client;
    }

    const client = await createDefaultResource<AdmissionClient>(
      ADMISSION_CLIENT_FACTORY_BASE_TYPE,
      null,
      options
    );

    if (!client) {
      throw new Error("Failed to create default admission client");
    }

    return client;
  }
}
