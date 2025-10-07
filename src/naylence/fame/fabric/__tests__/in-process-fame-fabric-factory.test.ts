import { ExtensionManager } from 'naylence-factory';
import {
  FameFabric,
  type FameFabricConfig,
  type FameConfig,
  normalizeFameConfig,
} from 'naylence-core';

import { InProcessFameFabric } from '../in-process-fame-fabric.js';
import {
  FAME_FABRIC_FACTORY_BASE_TYPE,
  InProcessFameFabricFactory,
} from '../in-process-fame-fabric-factory.js';
import { normalizeExtendedFameConfig } from '../../config/extended-fame-config.js';

describe('InProcessFameFabricFactory', () => {
  it('creates in-process fabrics using the provided root config', async () => {
    const factory = new InProcessFameFabricFactory();
    const rootConfig: FameConfig = await normalizeFameConfig({
      fabric: {
        type: 'InProcessFameFabric',
      },
    });

    const fabric = await factory.create(undefined, rootConfig);

    expect(fabric).toBeInstanceOf(InProcessFameFabric);
  });

  it('registers itself as the default fabric factory', () => {
    const factories = ExtensionManager.getExtensionsByType<
      FameFabric,
      FameFabricConfig
    >(FAME_FABRIC_FACTORY_BASE_TYPE);
    const factoryInfo = factories.get('InProcessFameFabric');

    expect(factoryInfo).toBeDefined();

    const instance = factoryInfo?.instance ?? new factoryInfo!.constructor();
    expect(instance).toBeInstanceOf(InProcessFameFabricFactory);
    expect(instance.isDefault).toBe(true);
  });

  it('passes the extended root config through FameFabric.create', async () => {
    const rootConfig = await normalizeFameConfig({
      fabric: {
        type: 'InProcessFameFabric',
      },
      node: {
        id: 'extended-node',
        transport: 'mock',
      },
    } as Record<string, unknown>);

    const fabric = await FameFabric.create({ rootConfig });
    const internalConfig = (fabric as unknown as { _config?: unknown })._config;

    expect(internalConfig).toEqual(normalizeExtendedFameConfig(rootConfig));
  });

  it('prefers raw root config when provided to the factory', async () => {
    const factory = new InProcessFameFabricFactory();

    const normalizedRootConfig = await normalizeFameConfig({
      fabric: { type: 'InProcessFameFabric' },
    });

    const rawRootConfig = {
      fabric: { type: 'InProcessFameFabric' },
      node: { id: 'raw-node' },
    } as Record<string, unknown>;

    const fabric = await factory.create(
      undefined,
      normalizedRootConfig,
      rawRootConfig
    );
    const internalConfig = (fabric as unknown as { _config?: unknown })._config;

    expect(internalConfig).toEqual(normalizeExtendedFameConfig(rawRootConfig));
  });
});
