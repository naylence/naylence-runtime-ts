import { registerFactory } from 'naylence-factory';

import {
  ATTACHMENT_KEY_VALIDATOR_FACTORY_BASE_TYPE,
  AttachmentKeyValidatorFactory,
  type AttachmentKeyValidatorConfig,
} from './attachment-key-validator-factory.js';
import { NoopKeyValidator } from './noop-key-validator.js';

export interface NoopKeyValidatorConfig extends AttachmentKeyValidatorConfig {
  type: 'NoopKeyValidator';
}

export class NoopKeyValidatorFactory extends AttachmentKeyValidatorFactory<NoopKeyValidatorConfig> {
  public readonly type = 'NoopKeyValidator';
  public readonly isDefault = true;
  public readonly priority = 0;

  public async create(
    _config?: NoopKeyValidatorConfig | Record<string, unknown> | null,
    ..._factoryArgs: unknown[]
  ): Promise<NoopKeyValidator> {
    return new NoopKeyValidator();
  }
}

registerFactory(
  ATTACHMENT_KEY_VALIDATOR_FACTORY_BASE_TYPE,
  'NoopKeyValidator',
  NoopKeyValidatorFactory,
  { isDefault: true, priority: 0 }
);
