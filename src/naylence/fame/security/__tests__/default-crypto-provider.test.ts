import { DefaultCryptoProvider } from '../crypto/providers/default-crypto-provider.js';
import { secureDigest } from '../../util/util.js';
import type { NodeLike } from '../../node/node-like.js';

describe('DefaultCryptoProvider', () => {
  const sampleCertificatePem = [
    '-----BEGIN CERTIFICATE-----',
    'MIIBvjCCAWWgAwIBAgIUbyGpBiA1H9/+nh2CjN2kFn84C0owCgYIKoZIzj0EAwIw',
    'EjEQMA4GA1UEAwwHREVNbyBDQTAeFw0yNTAxMDEwMDAwMDBaFw0yNjAxMDEwMDAw',
    'MDBaMBIxEDAOBgNVBAMMB0RFVFRlc3QwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNC',
    'AARXh4qM2OHFq6UU1Y2o8pTOEN4seL61KuJpOpS8b0bLIdK5l/E7pukWh7+h/SGw',
    'hQbYfYMPWVYxx8Y3x8mmzce0o2YwZDAOBgNVHQ8BAf8EBAMCAQYwDwYDVR0TAQH/',
    'BAUwAwEB/zAdBgNVHQ4EFgQUd4m+scu56R1E7LngX0wdpQ5V6oEwHwYDVR0jBBgw',
    'FoAUd4m+scu56R1E7LngX0wdpQ5V6oEwCgYIKoZIzj0EAwIDSAAwRQIhAPm1137Y',
    'cKLRkIlIiG9n8HxTwZucSlflOO9mQm3le7i6AiB2Vv+dFXBS8fCk+IxQ20ZAG0xP',
    'eM0Hz77o5HaKL3aFIQ==',
    '-----END CERTIFICATE-----',
  ].join('\n');

  const sampleChainPem = [
    '-----BEGIN CERTIFICATE-----',
    'MIIBhTCCASOgAwIBAgIUFjUCG8xJQFbLLq5yRvCNrI6VjOswCgYIKoZIzj0EAwIw',
    'EDEOMAwGA1UEAwwFUm9vdDAeFw0yNTAxMDEwMDAwMDBaFw0yNjAxMDEwMDAwMDBa',
    'MBQxEjAQBgNVBAMMCUludGVybWVkaWF0ZTBZMBMGByqGSM49AgEGCCqGSM49AwEH',
    'A0IABMI6P7Y6YDUQlcbVaW+tKFR9DCtaJgvZuM1Ot6wqpZkfWY5gmlWDVYj1WF7R',
    'SNh6Z9erjRzCQXDpUe1koXSP5NKjQjBAMA4GA1UdDwEB/wQEAwICBDAdBgNVHQ4E',
    'FgQU4L5kU4CzYQdh0dX8GZFODdgNpN8wHwYDVR0jBBgwFoAUb7y7sriW1rWzZbZm',
    'b7zWx/ju0iowCgYIKoZIzj0EAwIDSAAwRQIhAJZUsVTNff7kwh28ykVfoCENKz7L',
    'ftzIWBLL8GMDJ9ZhAiB8w7P3cu6UytzszbmWzxubUoil58x2oyWZMhUlCT3VkA==',
    '-----END CERTIFICATE-----',
    '-----BEGIN CERTIFICATE-----',
    'MIIBhTCCASOgAwIBAgIUQnM/xz7LxyzKk5XxhxL7sRKqz1YwCgYIKoZIzj0EAwIw',
    'EDEOMAwGA1UEAwwFUm9vdDIwHhcNMjUwMTAxMDAwMDAwWhcNMjYwMTAxMDAwMDAw',
    'WjAUMRIwEAYDVQQDDAlSb290UmVzMjBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IA',
    'BBqXc9E+u6KDAdAm8X1sC3yRyvE4s46HoPazTA/gkGEXLMaLLq5yRvCNrI6VjOs6',
    '21Hb+Jseb3CidRubc4QpfmijQjBAMA4GA1UdDwEB/wQEAwIBBjAdBgNVHQ4EFgQU',
    'XxNmO6PsK0uFUxnCLzpSw0eV6CswHwYDVR0jBBgwFoAU4L5kU4CzYQdh0dX8GZFO',
    'DdgNpN8wCgYIKoZIzj0EAwIDSAAwRQIgHo9dZYkTfGZNVVRFlE0YyqS/fWznuaCG',
    'VmOAXoJ1BsECIQD4bm/FvGV8eK3opgDdGztqKqRR3YKHy+XapnwXCfJOLL==',
    '-----END CERTIFICATE-----',
  ].join('\n');

  function stripPem(pem: string): string {
    return pem
      .replace(/-----BEGIN CERTIFICATE-----/g, '')
      .replace(/-----END CERTIFICATE-----/g, '')
      .replace(/\s+/g, '');
  }

  function extractChainEntries(pem: string): string[] {
    const matches = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    if (!matches) {
      return [];
    }
    return matches.map((entry) => stripPem(entry));
  }

  it('creates default provider with generated keys and issues tokens', async () => {
    const provider = await DefaultCryptoProvider.create();

    expect(provider.signingPrivatePem).toContain('BEGIN PRIVATE KEY');
    expect(provider.signingPublicPem).toContain('BEGIN PUBLIC KEY');
    expect(provider.encryptionPrivatePem).toContain('BEGIN PRIVATE KEY');
    expect(provider.encryptionPublicPem).toContain('BEGIN PUBLIC KEY');
    expect(provider.hmacSecret).toMatch(/^[A-Za-z0-9+/=]+$/);

    const jwks = provider.getJwks();
    expect(jwks.keys).toHaveLength(2);

    const signingJwk = jwks.keys.find((key) => key.use === 'sig');
    expect(signingJwk).toBeDefined();
    expect(signingJwk).toMatchObject({
      use: 'sig',
      alg: 'EdDSA',
      kid: provider.signatureKeyId,
    });

    const issuer = provider.getTokenIssuer();
    const token = await issuer.issue({ sub: 'user-123', scope: 'agents:read' });

    const verifier = provider.getTokenVerifier();
    const authorization = await verifier.verify(token);

    expect(authorization.principal).toBe('user-123');
    expect(authorization.grantedScopes).toContain('agents:read');
    expect(provider.getTokenIssuer()).toBe(issuer);
    expect(provider.getTokenVerifier()).toBe(verifier);
  });

  it('respects provided signing materials and key identifiers', async () => {
    const jose = await import('jose');
    const { publicKey, privateKey } = await jose.generateKeyPair('Ed25519');
    const signaturePrivatePem = await jose.exportPKCS8(privateKey);
    const signaturePublicPem = await jose.exportSPKI(publicKey);

    const provider = await DefaultCryptoProvider.create({
      signaturePrivatePem,
      signaturePublicPem,
      signatureKeyId: 'custom-signing-kid',
    });

    expect(provider.signingPrivatePem).toBe(signaturePrivatePem);
    expect(provider.signingPublicPem).toBe(signaturePublicPem);
    expect(provider.signatureKeyId).toBe('custom-signing-kid');

    const jwks = provider.getJwks();
    const signingJwk = jwks.keys.find((key) => key.use === 'sig');
    expect(signingJwk).toMatchObject({
      kid: 'custom-signing-kid',
      use: 'sig',
      alg: 'EdDSA',
    });
  });

  it('manages node context, certificates, and JWKS exposure', async () => {
    const provider = await DefaultCryptoProvider.create();

    provider.prepareForAttach('node-123', '/systems/node', ['logical.dev']);
    let context = provider.getCertificateContext();

    expect(context).toMatchObject({
      nodeId: 'node-123',
      physicalPath: '/systems/node',
      logicals: ['logical.dev'],
    });
    expect(context?.nodeSid).toBe(secureDigest('/systems/node'));

    provider.setLogicals(['logical.prod']);
    context = provider.getCertificateContext();
    expect(context?.logicals).toEqual(['logical.prod']);

    const nodeLike = {
      id: 'node-123',
      sid: 'provided-sid-xyz',
      physicalPath: '/systems/node',
      acceptedLogicals: new Set(['logical.from.node']),
    } as unknown as NodeLike;

    provider.setNodeContextFromNodeLike(nodeLike);
    context = provider.getCertificateContext();
    expect(context?.nodeSid).toBe('provided-sid-xyz');
    expect(context?.logicals).toEqual(['logical.from.node']);

    provider.storeSignedCertificate(sampleCertificatePem);
    expect(provider.hasCertificate()).toBe(true);
    expect(provider.nodeCertificatePem()).toBe(sampleCertificatePem);
    expect(provider.certificateChainPem()).toBeNull();

    let nodeJwk = provider.nodeJwk();
    expect(nodeJwk.x5c).toEqual([stripPem(sampleCertificatePem)]);

    provider.storeSignedCertificate(sampleCertificatePem, 'not-a-certificate');
    nodeJwk = provider.nodeJwk();
    expect(nodeJwk.x5c).toEqual([stripPem(sampleCertificatePem)]);

    provider.storeSignedCertificate(sampleCertificatePem, sampleChainPem);
    expect(provider.nodeCertificatePem()).toBe(sampleCertificatePem);
    expect(provider.certificateChainPem()).toBe(sampleChainPem);

    nodeJwk = provider.nodeJwk();
    expect(nodeJwk).toMatchObject({
      kid: provider.signatureKeyId,
      use: 'sig',
    });
    expect(Array.isArray(nodeJwk.x5c)).toBe(true);
    expect(nodeJwk.x5c).toEqual([
      stripPem(sampleCertificatePem),
      ...extractChainEntries(sampleChainPem),
    ]);

    const clonedContext = provider.getCertificateContext();
    clonedContext?.logicals.push('should-not-persist');
    expect(provider.getCertificateContext()?.logicals).toEqual(['logical.from.node']);
  });

  it('rejects unsupported algorithms when key material is missing', async () => {
    await expect(DefaultCryptoProvider.create({ algorithm: 'HS256' })).rejects.toThrow(
      'Unsupported signing algorithm: HS256',
    );
  });

  it('derives encryption artifacts from provided X25519 materials', async () => {
    const jose = await import('jose');
    const { publicKey, privateKey } = await jose.generateKeyPair('ECDH-ES', { extractable: true, crv: 'X25519' });
    const encryptionPrivatePem = await jose.exportPKCS8(privateKey);
    const encryptionPublicPem = await jose.exportSPKI(publicKey);

    const provider = await DefaultCryptoProvider.create({
      encryptionPrivatePem,
      encryptionPublicPem,
      encryptionKeyId: 'custom-enc-kid',
    });

    expect(provider.encryptionPrivatePem).toBe(encryptionPrivatePem);
    expect(provider.encryptionPublicPem).toBe(encryptionPublicPem);
    expect(provider.encryptionKeyId).toBe('custom-enc-kid');

    const jwks = provider.getJwks();
    const encryptionJwk = jwks.keys.find((key) => key.use === 'enc');
    expect(encryptionJwk).toMatchObject({
      kid: 'custom-enc-kid',
      use: 'enc',
      alg: 'ECDH-ES',
    });
  });

  it('indicates missing node context and rejects CSR creation', async () => {
    const provider = await DefaultCryptoProvider.create();

    expect(provider.getCertificateContext()).toBeNull();
    expect(provider.hasNodeContext()).toBe(false);

    provider.setLogicals(['ignored-before-context']);
    expect(provider.getCertificateContext()).toBeNull();

    expect(() => provider.createCsr()).toThrow(
      'CSR creation is not supported by the TypeScript default crypto provider yet.',
    );

    provider.prepareForAttach('node-prep', '/nodes/path', ['logical.updated']);
    expect(provider.hasNodeContext()).toBe(true);
  });

  it('normalizes Ed25519 algorithm and applies ttl overrides', async () => {
    const provider = await DefaultCryptoProvider.create({
      algorithm: 'Ed25519',
      ttlSec: 7200,
    });

    expect(provider.ttlSec).toBe(7200);

    const jwks = provider.getJwks();
    const signingJwk = jwks.keys.find((key) => key.use === 'sig');
    expect(signingJwk).toMatchObject({ alg: 'EdDSA' });
  });

  it('supports HS256 signing branches for token flows', async () => {
    const provider = await DefaultCryptoProvider.create();
    const internal = provider as unknown as {
      artifacts: {
        signing: { algorithm: string; jwk: Record<string, unknown> };
        hmacSecret: string;
      };
      tokenIssuerInstance: unknown;
      tokenVerifierInstance: unknown;
    };

    internal.artifacts.signing.algorithm = 'HS256';
    internal.artifacts.signing.jwk.alg = 'HS256';
    internal.artifacts.hmacSecret = 'c2VjcmV0LWhzLXRlc3Q=';
    internal.tokenIssuerInstance = null;
    internal.tokenVerifierInstance = null;

    const issuer = provider.getTokenIssuer();
    const token = await issuer.issue({ sub: 'hmac-user' });

    const verifier = provider.getTokenVerifier();
    const authorization = await verifier.verify(token);

    expect(authorization.principal).toBe('hmac-user');
    expect(provider.getTokenIssuer()).toBe(issuer);
    expect(provider.getTokenVerifier()).toBe(verifier);
  });

  it('propagates encryption JWK derivation failures for invalid PEM inputs', async () => {
    const invalidPublicPem = ['-----BEGIN PUBLIC KEY-----', 'invalid-material', '-----END PUBLIC KEY-----'].join('\n');

    await expect(
      DefaultCryptoProvider.create({
        encryptionPrivatePem: '-----BEGIN PRIVATE KEY-----\ninvalid\n-----END PRIVATE KEY-----',
        encryptionPublicPem: invalidPublicPem,
      })
    ).rejects.toThrow('Unable to derive JWK from X25519 public key PEM');
  });

  it('normalizes blank configuration values to defaults', async () => {
    const provider = await DefaultCryptoProvider.create({
      algorithm: '   ',
      signatureKeyId: '   ',
      encryptionKeyId: '   ',
      issuer: '   ',
      audience: '   ',
      ttlSec: 0,
      hmacSecret: '  shared-secret  ',
    });

    expect(provider.issuer).toBe('dev.naylence.ai');
    expect(provider.audience).toBe('router-dev');
    expect(provider.ttlSec).toBe(3600);
    expect(provider.hmacSecret).toBe('shared-secret');
    expect(provider.signatureKeyId.trim().length).toBeGreaterThan(0);
    expect(provider.encryptionKeyId.trim().length).toBeGreaterThan(0);
  });

  it('honors RSA algorithm configured via environment variables', async () => {
    const originalEnv = typeof process !== 'undefined' ? process.env.FAME_CRYPTO_ALGORITHM : undefined;

    if (typeof process === 'undefined' || !process.env) {
      throw new Error('process.env is not available for the RSA algorithm test');
    }

    process.env.FAME_CRYPTO_ALGORITHM = 'rsa';

    try {
      const provider = await DefaultCryptoProvider.create();
      const jwks = provider.getJwks();
      const signingJwk = jwks.keys.find((key) => key.use === 'sig');

      expect(signingJwk).toMatchObject({ alg: 'RS256', use: 'sig' });

      const issuer = provider.getTokenIssuer();
      const token = await issuer.issue({ sub: 'rsa-user' });
      const verifier = provider.getTokenVerifier();
      const authorization = await verifier.verify(token);

      expect(authorization.principal).toBe('rsa-user');
    } finally {
      if (originalEnv === undefined) {
        delete process.env.FAME_CRYPTO_ALGORITHM;
      } else {
        process.env.FAME_CRYPTO_ALGORITHM = originalEnv;
      }
    }
  });

  it('generates HMAC secrets via browser crypto when available', async () => {
    const globalWithCrypto = globalThis as typeof globalThis & {
      crypto?: Crypto;
    };
    const originalCrypto = globalWithCrypto.crypto;
    const deterministicBytes = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const getRandomValues = jest.fn((buffer: Uint8Array) => {
      buffer.set(deterministicBytes.subarray(0, buffer.length));
      return buffer;
    });

    globalWithCrypto.crypto = { getRandomValues, subtle: {} as SubtleCrypto } as unknown as Crypto;

    try {
      const provider = await DefaultCryptoProvider.create();
      const hmacCall = getRandomValues.mock.calls.find(([buffer]) => buffer.length === 32);
      expect(hmacCall).toBeDefined();
      expect(provider.hmacSecret).toBe(Buffer.from(deterministicBytes).toString('base64'));
    } finally {
      if (originalCrypto === undefined) {
        Reflect.deleteProperty(globalWithCrypto, 'crypto');
      } else {
        globalWithCrypto.crypto = originalCrypto;
      }
    }
  });

  it('generates HMAC secrets via node crypto when browser crypto unavailable', async () => {
    const globalWithCrypto = globalThis as typeof globalThis & {
      crypto?: Crypto;
    };
  const hadCrypto = 'crypto' in globalWithCrypto;
  const originalCrypto = globalWithCrypto.crypto;
  const fallbackCrypto = { subtle: {} as SubtleCrypto } as Crypto;

    try {
      globalWithCrypto.crypto = fallbackCrypto;

      const provider = await DefaultCryptoProvider.create();

      const decoded = Buffer.from(provider.hmacSecret, 'base64');
      expect(decoded).toHaveLength(32);
    } finally {
      if (hadCrypto) {
        globalWithCrypto.crypto = originalCrypto;
      } else {
        Reflect.deleteProperty(globalWithCrypto, 'crypto');
      }
    }
  });
});
