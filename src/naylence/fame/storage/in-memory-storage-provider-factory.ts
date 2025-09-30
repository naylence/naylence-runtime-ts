import { z } from "zod";

import { InMemoryStorageProvider } from "./in-memory-storage.js";
import {
  StorageProviderFactory,
  registerStorageProviderFactory,
  type StorageProviderConfig,
} from "./storage-provider-factory.js";

export interface InMemoryStorageProviderConfig extends StorageProviderConfig {
  type: "InMemoryStorageProvider";
}

const inMemoryStorageProviderConfigSchema = z
  .object({
    type: z.literal("InMemoryStorageProvider").default("InMemoryStorageProvider"),
  })
  .passthrough();

export class InMemoryStorageProviderFactory extends StorageProviderFactory<InMemoryStorageProviderConfig> {
  public readonly type = "InMemoryStorageProvider";

  public async create(
    config?: InMemoryStorageProviderConfig | Record<string, unknown> | null
  ): Promise<InMemoryStorageProvider> {
    // Validate configuration and ensure correct type information
    const candidate = config ?? { type: "InMemoryStorageProvider" };
    inMemoryStorageProviderConfigSchema.parse({ type: candidate.type, ...candidate });

    return new InMemoryStorageProvider();
  }
}

registerStorageProviderFactory("InMemoryStorageProvider", InMemoryStorageProviderFactory);
