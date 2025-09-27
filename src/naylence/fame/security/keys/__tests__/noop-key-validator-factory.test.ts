import { ResourceFactoryRegistry } from 'naylence-factory';

import {
  ATTACHMENT_KEY_VALIDATOR_FACTORY_BASE_TYPE,
} from '../attachment-key-validator-factory.js';
import { KeyInfo } from '../attachment-key-validator.js';
import { NoopKeyValidator } from '../noop-key-validator.js';
import { NoopKeyValidatorFactory } from '../noop-key-validator-factory.js';

describe('NoopKeyValidatorFactory', () => {
  afterEach(() => {
    ResourceFactoryRegistry.clearCache(ATTACHMENT_KEY_VALIDATOR_FACTORY_BASE_TYPE);
  });

  it('registers factory and creates noop validators', async () => {
    const factory = ResourceFactoryRegistry.getFactory<NoopKeyValidator, unknown>(
      ATTACHMENT_KEY_VALIDATOR_FACTORY_BASE_TYPE,
      'NoopKeyValidator'
    );

    expect(factory).toBeInstanceOf(NoopKeyValidatorFactory);

    const validator = await factory.create();

    expect(validator).toBeInstanceOf(NoopKeyValidator);
  });

  it('noop validator returns default info and authorizes logicals', async () => {
    const validator = new NoopKeyValidator();

    const info = await validator.validateKey({});
    expect(info).toBeInstanceOf(KeyInfo);
    expect(info.kid).toBeNull();

    const [allowed, reason] = await validator.validateChildAttachmentLogicals(null, null, 'child');
    expect(allowed).toBe(true);
    expect(reason).toMatch(/always authorizes logicals/i);
  });
});
