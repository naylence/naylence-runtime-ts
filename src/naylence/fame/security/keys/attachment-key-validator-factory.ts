import type { CreateResourceOptions, ResourceConfig } from 'naylence-factory';
import { AbstractResourceFactory, createDefaultResource, createResource } from 'naylence-factory';

import type { AttachmentKeyValidator } from './attachment-key-validator.js';

export const ATTACHMENT_KEY_VALIDATOR_FACTORY_BASE_TYPE = 'AttachmentKeyValidatorFactory';

export interface AttachmentKeyValidatorConfig extends ResourceConfig {
  type: string;
  [key: string]: unknown;
}

export abstract class AttachmentKeyValidatorFactory<
  C extends AttachmentKeyValidatorConfig = AttachmentKeyValidatorConfig
> extends AbstractResourceFactory<AttachmentKeyValidator, C> {
  public abstract create(
    config?: C | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<AttachmentKeyValidator>;

  public static async createAttachmentKeyValidator<
    C extends AttachmentKeyValidatorConfig = AttachmentKeyValidatorConfig
  >(
    config?: C | Record<string, unknown> | null,
    options: CreateResourceOptions = {}
  ): Promise<AttachmentKeyValidator | null> {
    const instance = config
      ? await createResource<AttachmentKeyValidator>(
          ATTACHMENT_KEY_VALIDATOR_FACTORY_BASE_TYPE,
          config,
          options
        )
      : await createDefaultResource<AttachmentKeyValidator>(
          ATTACHMENT_KEY_VALIDATOR_FACTORY_BASE_TYPE,
          null,
          options
        );

    return instance ?? null;
  }
}
