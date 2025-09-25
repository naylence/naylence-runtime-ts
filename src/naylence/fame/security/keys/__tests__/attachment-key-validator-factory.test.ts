import { registerFactory, ResourceFactoryRegistry } from 'naylence-factory';

import {
  AttachmentKeyValidator,
  KeyInfo,
  KeyValidationError,
  type AttachmentKey,
} from '../attachment-key-validator.js';
import {
  ATTACHMENT_KEY_VALIDATOR_FACTORY_BASE_TYPE,
  AttachmentKeyValidatorFactory,
  type AttachmentKeyValidatorConfig,
} from '../attachment-key-validator-factory.js';

class TestAttachmentKeyValidator extends AttachmentKeyValidator {
  public readonly validateKeySpy = jest.fn<Promise<KeyInfo>, [AttachmentKey]>(async (key) => {
    const kidValue = key['kid'];
    const kid = typeof kidValue === 'string' ? kidValue : 'unknown';
    return new KeyInfo({ kid });
  });

  public readonly validateChildAttachmentLogicalsSpy = jest.fn<
    Promise<readonly [boolean, string]>,
    Parameters<AttachmentKeyValidator['validateChildAttachmentLogicals']>
  >(async () => [true, ''] as const);

  public async validateKey(key: AttachmentKey): Promise<KeyInfo> {
    return await this.validateKeySpy(key);
  }

  public async validateChildAttachmentLogicals(
    childKeys: readonly AttachmentKey[] | null | undefined,
    authorizedLogicals: readonly string[] | null | undefined,
    childId: string
  ): Promise<readonly [boolean, string]> {
    return await this.validateChildAttachmentLogicalsSpy(childKeys, authorizedLogicals, childId);
  }
}

class TestAttachmentKeyValidatorFactory extends AttachmentKeyValidatorFactory {
  public readonly type = 'TestAttachmentKeyValidator';
  public readonly isDefault = true;
  public readonly priority = 100;

  public async create(): Promise<AttachmentKeyValidator> {
    return new TestAttachmentKeyValidator();
  }
}

beforeAll(() => {
  registerFactory(
    ATTACHMENT_KEY_VALIDATOR_FACTORY_BASE_TYPE,
    'TestAttachmentKeyValidator',
    TestAttachmentKeyValidatorFactory,
    { isDefault: true, priority: 100 }
  );
});

afterEach(() => {
  ResourceFactoryRegistry.clearCache(ATTACHMENT_KEY_VALIDATOR_FACTORY_BASE_TYPE);
});

describe('AttachmentKeyValidator', () => {
  it('returns empty array when validateKeys receives undefined', async () => {
    const validator = new TestAttachmentKeyValidator();
    const result = await validator.validateKeys();
    expect(result).toEqual([]);
    expect(validator.validateKeySpy).not.toHaveBeenCalled();
  });

  it('validates each provided key and returns key info list', async () => {
    const validator = new TestAttachmentKeyValidator();
    const keys: AttachmentKey[] = [{ kid: 'kid-1' }, { kid: 'kid-2' }];

    const result = await validator.validateKeys(keys);

    expect(result).toHaveLength(2);
    expect(result.map((info) => info.kid)).toEqual(['kid-1', 'kid-2']);
    expect(validator.validateKeySpy).toHaveBeenCalledTimes(2);
    expect(validator.validateKeySpy).toHaveBeenNthCalledWith(1, keys[0]);
    expect(validator.validateKeySpy).toHaveBeenNthCalledWith(2, keys[1]);
  });

  it('creates key info from strings and dates', () => {
    const expires = '2025-09-24T12:00:00Z';
    const info = new KeyInfo({
      kid: 'kid-123',
      expiresAt: expires,
      notBefore: new Date(expires),
      hasCertificate: true,
      certIssuer: 'Issuer',
      certSubject: 'Subject',
    });

    expect(info.kid).toBe('kid-123');
    expect(info.expiresAt).toBeInstanceOf(Date);
    expect(info.notBefore).toBeInstanceOf(Date);
    expect(info.hasCertificate).toBe(true);
    expect(info.certIssuer).toBe('Issuer');
    expect(info.certSubject).toBe('Subject');
  });

  it('handles numeric timestamps and non-date inputs gracefully', () => {
    const timestamp = Date.UTC(2025, 0, 1);
  const info = new KeyInfo({ expiresAt: timestamp, notBefore: {} as unknown as Date });

    expect(info.expiresAt).toBeInstanceOf(Date);
    expect(info.expiresAt?.getTime()).toBe(timestamp);
    expect(info.notBefore).toBeNull();

    const nonFinite = new KeyInfo({ expiresAt: Number.POSITIVE_INFINITY });
    expect(nonFinite.expiresAt).toBeNull();
  });

  it('throws when key info receives invalid date strings', () => {
    expect(() => new KeyInfo({ expiresAt: 'not-a-date' })).toThrow('Invalid date string provided');
  });

  it('creates key validation error with metadata copies', () => {
    const details = { reason: 'expired' } as const;
    const error = new KeyValidationError('expired', 'Key expired', { kid: 'kid-42', details });

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('expired');
    expect(error.kid).toBe('kid-42');
    expect(error.details).toEqual(details);

    (error.details as Record<string, unknown>).reason = 'mutated';
    expect(details.reason).toBe('expired');
  });
});

describe('AttachmentKeyValidatorFactory', () => {
  it('creates default validator when config omitted', async () => {
    const validator = await AttachmentKeyValidatorFactory.createAttachmentKeyValidator();
    expect(validator).toBeInstanceOf(TestAttachmentKeyValidator);
  });

  it('creates validator when config provided', async () => {
    const config: AttachmentKeyValidatorConfig = { type: 'TestAttachmentKeyValidator' };

    const validator = await AttachmentKeyValidatorFactory.createAttachmentKeyValidator(config);
    expect(validator).toBeInstanceOf(TestAttachmentKeyValidator);
  });
});
