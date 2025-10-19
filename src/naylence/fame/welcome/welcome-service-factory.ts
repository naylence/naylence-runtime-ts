import type { CreateResourceOptions, ResourceConfig } from 'naylence-factory';
import {
  AbstractResourceFactory,
  createDefaultResource,
  createResource,
} from 'naylence-factory';

import type { WelcomeService } from './welcome-service.js';

export const WELCOME_SERVICE_FACTORY_BASE_TYPE =
  'WelcomeServiceFactory' as const;

export interface WelcomeServiceConfig extends ResourceConfig {
  type: string;
  [key: string]: unknown;
}

export abstract class WelcomeServiceFactory<
  C extends WelcomeServiceConfig = WelcomeServiceConfig,
> extends AbstractResourceFactory<WelcomeService, C> {
  public abstract create(
    config?: C | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<WelcomeService>;

  public static async createWelcomeService<
    C extends WelcomeServiceConfig = WelcomeServiceConfig,
  >(
    config?: C | Record<string, unknown> | null,
    options: CreateResourceOptions = {}
  ): Promise<WelcomeService> {
    // If no config provided, load from fame config
    if (!config) {
      const { getFameConfig, loadPluginsFromConfig } = await import(
        '../config/extended-fame-config.js'
      );

      // Load plugins before creating the service
      await loadPluginsFromConfig();

      const fameConfig = getFameConfig();
      config = fameConfig.welcome as Record<string, unknown> | undefined;

      if (!config) {
        throw new Error(
          'No welcome service configuration found in fame config'
        );
      }
    }

    const candidate = config as Record<string, unknown>;
    const hasTypeField =
      typeof candidate.type === 'string' && candidate.type.trim().length > 0;

    if (!hasTypeField) {
      const service = await createDefaultResource<WelcomeService>(
        WELCOME_SERVICE_FACTORY_BASE_TYPE,
        candidate,
        options
      );

      if (!service) {
        throw new Error(
          'Failed to create default welcome service from partial configuration'
        );
      }

      return service;
    }

    const typedConfig: WelcomeServiceConfig = {
      ...candidate,
      type: candidate.type as string,
    };

    const service = await createResource<WelcomeService>(
      WELCOME_SERVICE_FACTORY_BASE_TYPE,
      typedConfig,
      options
    );

    if (!service) {
      throw new Error('Failed to create welcome service from configuration');
    }

    return service;
  }
}
