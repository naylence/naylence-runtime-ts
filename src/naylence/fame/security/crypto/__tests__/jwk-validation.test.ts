import {
  filterKeysByUse,
  JWKValidationError,
  validateEncryptionKey,
  validateJwkComplete,
  validateSigningKey,
} from '../jwk-validation.js';

const validSigningKey = {
  kid: 'sign-1',
  kty: 'OKP',
  crv: 'Ed25519',
  x: 'abc123',
  use: 'sig',
};

const validEncryptionKey = {
  kid: 'enc-1',
  kty: 'OKP',
  crv: 'X25519',
  x: 'def456',
  use: 'enc',
};

describe('jwk-validation', () => {
  it('validates complete JWKs and enforces use semantics', () => {
    expect(validateJwkComplete(validSigningKey)).toBe('sig');
    expect(validateJwkComplete(validEncryptionKey)).toBe('enc');

    const badUse = { ...validEncryptionKey, use: 'sig' };
    expect(() => validateJwkComplete(badUse)).toThrow(JWKValidationError);
  });

  it('rejects unsupported key types or missing fields', () => {
  const { x: _removed, ...missingField } = validSigningKey;
    expect(() => validateJwkComplete(missingField)).toThrow('missing required fields');

  const unsupported = { ...validSigningKey, kty: 'UNKNOWN' as const };
    expect(() => validateJwkComplete(unsupported)).toThrow('unsupported key type');
  });

  it('filters keys by intended use and skips invalid ones', () => {
    const keys = [validSigningKey, validEncryptionKey, { kid: 'bad', kty: 'RSA', use: 'enc' }];
    const signing = filterKeysByUse(keys, 'sig');
    expect(signing).toEqual([validSigningKey]);

    const encryption = filterKeysByUse(keys, 'enc');
    expect(encryption).toEqual([validEncryptionKey]);
  });

  it('validates encryption and signing keys with stricter checks', () => {
    expect(() => validateEncryptionKey(validEncryptionKey)).not.toThrow();
    expect(() => validateSigningKey(validSigningKey)).not.toThrow();

    const notEnc = { ...validSigningKey };
    expect(() => validateEncryptionKey(notEnc)).toThrow('not an encryption key');

    const notSig = { ...validEncryptionKey };
    expect(() => validateSigningKey(notSig)).toThrow('not a signing key');
  });
});
