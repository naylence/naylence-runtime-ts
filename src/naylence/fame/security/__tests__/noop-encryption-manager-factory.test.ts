import { FameAddress } from '@naylence/core';

import { NoopEncryptionManagerFactory } from '../encryption/noop-encryption-manager-factory.js';

describe('NoopEncryptionManagerFactory.supportsOptions', () => {
  it('returns true when options are absent', () => {
    const factory = new NoopEncryptionManagerFactory();

    expect(factory.supportsOptions()).toBe(true);
    expect(factory.supportsOptions(null)).toBe(true);
  });

  it('returns false when snake_case encryption keys are provided', () => {
    const factory = new NoopEncryptionManagerFactory();

    expect(
      factory.supportsOptions({
        recip_pub: new Uint8Array([1, 2, 3]),
      })
    ).toBe(false);

    expect(
      factory.supportsOptions({
        recipient_public_key: new Uint8Array([4, 5, 6]),
      } as unknown as Parameters<typeof factory.supportsOptions>[0])
    ).toBe(false);
  });

  it('returns false when snake_case metadata implies encryption', () => {
    const factory = new NoopEncryptionManagerFactory();

    expect(
      factory.supportsOptions({
        encryption_type: 'standard',
      } as unknown as Parameters<typeof factory.supportsOptions>[0])
    ).toBe(false);

    expect(
      factory.supportsOptions({
        request_address: FameAddress.create('peer@/route'),
      } as unknown as Parameters<typeof factory.supportsOptions>[0])
    ).toBe(false);
  });

  it('treats explicit none encryption_type as supported', () => {
    const factory = new NoopEncryptionManagerFactory();

    expect(
      factory.supportsOptions({
        encryption_type: 'none',
      } as unknown as Parameters<typeof factory.supportsOptions>[0])
    ).toBe(true);
  });
});
