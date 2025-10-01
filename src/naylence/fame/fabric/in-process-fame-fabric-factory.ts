import type { FameFabric, FameFabricConfig, FameConfig } from "naylence-core";
import { FameFabricFactory } from "naylence-core";
import { registerFactory } from "naylence-factory";

import { InProcessFameFabric } from "./in-process-fame-fabric.js";

export const FAME_FABRIC_FACTORY_BASE_TYPE = "FameFabricFactory";

export class InProcessFameFabricFactory extends FameFabricFactory {
  public readonly type = "InProcessFameFabric";
  public readonly isDefault = true;

  public async create(
    _config?: FameFabricConfig | Record<string, unknown> | null,
    ...args: [FameConfig | Record<string, unknown> | null | undefined]
  ): Promise<FameFabric> {
    const [rootConfig] = args;
    return new InProcessFameFabric(undefined, rootConfig ?? undefined);
  }
}

registerFactory<FameFabric, FameFabricConfig>(
  FAME_FABRIC_FACTORY_BASE_TYPE,
  "InProcessFameFabric",
  InProcessFameFabricFactory
);
