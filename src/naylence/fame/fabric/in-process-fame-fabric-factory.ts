import type { FameFabric, FameFabricConfig, FameConfig } from "naylence-core";
import { FameFabricFactory } from "naylence-core";

import { InProcessFameFabric } from "./in-process-fame-fabric.js";
// import { registerRuntimeFactories } from "../../runtime/register-runtime-factories.js";

export const FAME_FABRIC_FACTORY_BASE_TYPE = "FameFabricFactory";

export const FACTORY_META = {
  base: FAME_FABRIC_FACTORY_BASE_TYPE,
  key: "InProcessFameFabric",
} as const;

export class InProcessFameFabricFactory extends FameFabricFactory {
  public readonly type = "InProcessFameFabric";
  public readonly isDefault = true;

  public async create(
    _config?: FameFabricConfig | Record<string, unknown> | null,
    ...args: [
      FameConfig | Record<string, unknown> | null | undefined,
      (FameConfig | Record<string, unknown> | null | undefined)?
    ]
  ): Promise<FameFabric> {
    const [rootConfig, rawRootConfig] = args;
    // await registerRuntimeFactories();
    const configForFabric = rawRootConfig ?? rootConfig ?? undefined;
    return new InProcessFameFabric(undefined, configForFabric);
  }
}

export default InProcessFameFabricFactory;
