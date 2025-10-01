import { ExtensionManager } from "naylence-factory";
import { FameFabric, type FameFabricConfig, type FameConfig } from "naylence-core";

import { InProcessFameFabric } from "../in-process-fame-fabric.js";
import {
  FAME_FABRIC_FACTORY_BASE_TYPE,
  InProcessFameFabricFactory,
} from "../in-process-fame-fabric-factory.js";
import { normalizeExtendedFameConfig } from "../../config/extended-fame-config.js";

describe("InProcessFameFabricFactory", () => {
  it("creates in-process fabrics using the provided root config", async () => {
    const factory = new InProcessFameFabricFactory();
    const rootConfig: FameConfig = {
      fabric: {
        type: "InProcessFameFabric",
      },
    };

    const fabric = await factory.create(undefined, rootConfig);

    expect(fabric).toBeInstanceOf(InProcessFameFabric);
  });

  it("registers itself as the default fabric factory", () => {
    const factories = ExtensionManager.getExtensionsByType<FameFabric, FameFabricConfig>(
      FAME_FABRIC_FACTORY_BASE_TYPE
    );
    const factoryInfo = factories.get("InProcessFameFabric");

    expect(factoryInfo).toBeDefined();

    const instance = factoryInfo?.instance ?? new factoryInfo!.constructor();
    expect(instance).toBeInstanceOf(InProcessFameFabricFactory);
    expect(instance.isDefault).toBe(true);
  });

  it("passes the extended root config through FameFabric.create", async () => {
    const rootConfig = {
      fabric: {
        type: "InProcessFameFabric",
      },
      node: {
        id: "extended-node",
        transport: "mock",
      },
    } satisfies FameConfig & { node: Record<string, unknown> };

    const fabric = await FameFabric.create({ rootConfig });

  const internalConfig = (fabric as unknown as { _config?: unknown })._config;

    expect(internalConfig).toEqual(normalizeExtendedFameConfig(rootConfig));
  });
});
