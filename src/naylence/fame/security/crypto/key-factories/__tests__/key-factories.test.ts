import { createEd25519Keypair, createRsaKeypair, createX25519Keypair } from '../index.js';

jest.setTimeout(30000);

describe('Key factories', () => {

  it('creates Ed25519 development key pair with JWKS entry', async () => {
    const kid = 'test-ed25519';
    const keyPair = await createEd25519Keypair(kid);

    expect(keyPair.privatePem).toContain('BEGIN PRIVATE KEY');
    expect(keyPair.publicPem).toContain('BEGIN PUBLIC KEY');

  const keys = keyPair.jwks.keys ?? [];
  expect(Array.isArray(keys)).toBe(true);
  expect(keys).toHaveLength(1);

  const jwk = keys[0]!;
    expect(jwk.kid).toBe(kid);
    expect(jwk.alg).toBe('EdDSA');
    expect(jwk.use).toBe('sig');
    expect(jwk.kty).toBe('OKP');
    expect(jwk.crv).toBe('Ed25519');
    expect(typeof jwk.x).toBe('string');
  });

  it('creates RSA development key pair with JWKS entry', async () => {
    const kid = 'test-rsa';
    const keyPair = await createRsaKeypair(kid);

    expect(keyPair.privatePem).toContain('BEGIN PRIVATE KEY');
    expect(keyPair.publicPem).toContain('BEGIN PUBLIC KEY');

  const keys = keyPair.jwks.keys ?? [];
  expect(Array.isArray(keys)).toBe(true);
  expect(keys).toHaveLength(1);

  const jwk = keys[0]!;
    expect(jwk.kid).toBe(kid);
    expect(jwk.alg).toBe('RS256');
    expect(jwk.use).toBe('sig');
    expect(jwk.kty).toBe('RSA');
    expect(typeof jwk.n).toBe('string');
    expect(typeof jwk.e).toBe('string');
  });

  it('creates X25519 development key pair', async () => {
    const keyPair = await createX25519Keypair('test-x25519');

    expect(keyPair.privatePem).toContain('BEGIN PRIVATE KEY');
    expect(keyPair.publicPem).toContain('BEGIN PUBLIC KEY');

    expect(Array.isArray(keyPair.jwks.keys)).toBe(true);
    expect(keyPair.jwks.keys).toHaveLength(0);
  });
});
