import { generateId } from '@naylence/core';
import { getLogger } from '../../../util/logging.js';
import { secureDigest } from '../../../util/util.js';
import type { NodeLike } from '../../../node/node-like.js';
import { JWTTokenIssuer } from '../../auth/jwt-token-issuer.js';
import { JWTTokenVerifier } from '../../auth/jwt-token-verifier.js';
import type { TokenIssuer } from '../../auth/token-issuer.js';
import type { TokenVerifier } from '../../auth/token-verifier.js';
import { requireJose } from '../../auth/jose-loader.js';
import type { DevKeyPair } from '../key-factories/dev-key-pair.js';
import {
  createEd25519Keypair,
  createRsaKeypair,
  createX25519Keypair,
} from '../key-factories/index.js';
import type { CryptoProvider } from './crypto-provider.js';

const logger = getLogger(
  'naylence.fame.security.crypto.providers.default_crypto_provider'
);

const ENV_VAR_CRYPTO_ALGORITHM = 'FAME_CRYPTO_ALGORITHM';
const DEFAULT_CRYPTO_ALGORITHM = 'EdDSA';
const DEFAULT_ISSUER = 'dev.naylence.ai';
const DEFAULT_AUDIENCE = 'router-dev';
const DEFAULT_TTL_SEC = 3600;
const DEFAULT_HMAC_SECRET_BYTES = 32;
const ENCRYPTION_ALG = 'ECDH-ES';

interface CertificateContext {
  nodeId: string;
  nodeSid: string;
  physicalPath: string;
  logicals: string[];
}

export interface DefaultCryptoProviderOptions {
  signaturePrivatePem?: string | null;
  signaturePublicPem?: string | null;
  signatureKeyId?: string | null;
  encryptionPrivatePem?: string | null;
  encryptionPublicPem?: string | null;
  encryptionKeyId?: string | null;
  hmacSecret?: string | null;
  issuer?: string | null;
  audience?: string | null;
  algorithm?: string | null;
  ttlSec?: number | null;
}

type DefaultCryptoProviderCreateInput =
  | DefaultCryptoProviderOptions
  | Record<string, unknown>
  | null
  | undefined;

function normalizeDefaultCryptoProviderOptions(
  options?: DefaultCryptoProviderCreateInput
): DefaultCryptoProviderOptions {
  if (!options) {
    return {};
  }

  const source = options as Record<string, unknown>;
  const normalized: DefaultCryptoProviderOptions = {};

  const readNullableString = (...keys: string[]): string | null | undefined => {
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) {
        continue;
      }

      const value = source[key];
      if (value === undefined) {
        return undefined;
      }
      if (value === null) {
        return null;
      }
      if (typeof value === 'string') {
        return value;
      }
      return String(value);
    }
    return undefined;
  };

  const readNullableNumber = (...keys: string[]): number | null | undefined => {
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) {
        continue;
      }

      const value = source[key];
      if (value === undefined) {
        return undefined;
      }
      if (value === null) {
        return null;
      }
      if (typeof value === 'number') {
        return Number.isFinite(value) ? value : undefined;
      }
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) {
          return undefined;
        }
        const parsed = Number(trimmed);
        return Number.isFinite(parsed) ? parsed : undefined;
      }
    }
    return undefined;
  };

  const assignStringOption = <Key extends keyof DefaultCryptoProviderOptions>(
    targetKey: Key,
    ...keys: string[]
  ): void => {
    const value = readNullableString(...keys);
    if (value !== undefined) {
      normalized[targetKey] = value as DefaultCryptoProviderOptions[Key];
    }
  };

  assignStringOption(
    'signaturePrivatePem',
    'signaturePrivatePem',
    'signature_private_pem'
  );
  assignStringOption(
    'signaturePublicPem',
    'signaturePublicPem',
    'signature_public_pem'
  );
  assignStringOption('signatureKeyId', 'signatureKeyId', 'signature_key_id');
  assignStringOption(
    'encryptionPrivatePem',
    'encryptionPrivatePem',
    'encryption_private_pem'
  );
  assignStringOption(
    'encryptionPublicPem',
    'encryptionPublicPem',
    'encryption_public_pem'
  );
  assignStringOption('encryptionKeyId', 'encryptionKeyId', 'encryption_key_id');
  assignStringOption('hmacSecret', 'hmacSecret', 'hmac_secret');
  assignStringOption('issuer', 'issuer', 'iss');
  assignStringOption('audience', 'audience', 'aud');
  assignStringOption('algorithm', 'algorithm', 'alg');

  const ttlSec = readNullableNumber('ttlSec', 'ttl_sec');
  if (ttlSec !== undefined) {
    normalized.ttlSec = ttlSec;
  }

  return normalized;
}

interface ProviderArtifacts {
  signing: {
    privatePem: string;
    publicPem: string;
    keyId: string;
    jwk: Record<string, unknown>;
    algorithm: string;
  };
  encryption: {
    privatePem: string;
    publicPem: string;
    keyId: string;
    jwk: Record<string, unknown>;
  };
  hmacSecret: string;
  issuer: string;
  audience: string;
  ttlSec: number;
}

export class DefaultCryptoProvider implements CryptoProvider {
  public static async create(
    options: DefaultCryptoProviderCreateInput = {}
  ): Promise<DefaultCryptoProvider> {
    const normalized = normalizeDefaultCryptoProviderOptions(options);
    const artifacts = await buildProviderArtifacts(normalized);
    return new DefaultCryptoProvider(artifacts);
  }

  private tokenIssuerInstance: TokenIssuer | null = null;
  private tokenVerifierInstance: TokenVerifier | null = null;
  private nodeCertPem: string | null = null;
  private nodeCertChainPem: string | null = null;
  private certContext: CertificateContext | null = null;

  private constructor(private readonly artifacts: ProviderArtifacts) {
    logger.debug('default_crypto_provider_initialized', {
      signature_key_id: artifacts.signing.keyId,
      encryption_key_id: artifacts.encryption.keyId,
      issuer: artifacts.issuer,
      audience: artifacts.audience,
      algorithm: artifacts.signing.algorithm,
    });
  }

  public get signingPrivatePem(): string {
    return this.artifacts.signing.privatePem;
  }

  public get signingPublicPem(): string {
    return this.artifacts.signing.publicPem;
  }

  public get signatureKeyId(): string {
    return this.artifacts.signing.keyId;
  }

  public get encryptionPrivatePem(): string {
    return this.artifacts.encryption.privatePem;
  }

  public get encryptionPublicPem(): string {
    return this.artifacts.encryption.publicPem;
  }

  public get encryptionKeyId(): string {
    return this.artifacts.encryption.keyId;
  }

  public get hmacSecret(): string {
    return this.artifacts.hmacSecret;
  }

  public get issuer(): string {
    return this.artifacts.issuer;
  }

  public get audience(): string {
    return this.artifacts.audience;
  }

  public get ttlSec(): number {
    return this.artifacts.ttlSec;
  }

  public getTokenIssuer(): TokenIssuer {
    if (this.tokenIssuerInstance) {
      return this.tokenIssuerInstance;
    }

    const algorithm = this.artifacts.signing.algorithm;

    if (algorithm.startsWith('HS')) {
      this.tokenIssuerInstance = new JWTTokenIssuer({
        signingKeyPem: this.hmacSecret,
        kid: this.signatureKeyId,
        issuer: this.issuer,
        algorithm,
        ttlSec: this.ttlSec,
        audience: this.audience,
      });
      return this.tokenIssuerInstance;
    }

    this.tokenIssuerInstance = new JWTTokenIssuer({
      signingKeyPem: this.signingPrivatePem,
      kid: this.signatureKeyId,
      issuer: this.issuer,
      algorithm,
      ttlSec: this.ttlSec,
      audience: this.audience,
    });
    return this.tokenIssuerInstance;
  }

  public getTokenVerifier(): TokenVerifier {
    if (this.tokenVerifierInstance) {
      return this.tokenVerifierInstance;
    }

    const algorithm = this.artifacts.signing.algorithm;
    const verificationKey = algorithm.startsWith('HS')
      ? this.hmacSecret
      : this.signingPublicPem;

    this.tokenVerifierInstance = new JWTTokenVerifier({
      verificationKey,
      issuer: this.issuer,
      ttlSec: this.ttlSec,
      algorithms: [algorithm],
    });
    return this.tokenVerifierInstance;
  }

  public getJwks(): { keys: Array<Record<string, unknown>> } {
    const { signing, encryption } = this.artifacts;
    const keys: Array<Record<string, unknown>> = [cloneJson(signing.jwk)];
    if (encryption.jwk) {
      keys.push(cloneJson(encryption.jwk));
    }
    return { keys };
  }

  public nodeJwk(): Record<string, unknown> {
    const signing = cloneJson(this.artifacts.signing.jwk);
    if (this.nodeCertPem) {
      signing.x5c = buildX5cChain(this.nodeCertPem, this.nodeCertChainPem);
    }
    return signing;
  }

  public nodeCertificatePem(): string | null {
    return this.nodeCertPem;
  }

  public certificateChainPem(): string | null {
    return this.nodeCertChainPem;
  }

  public hasCertificate(): boolean {
    return Boolean(this.nodeCertPem);
  }

  public getCertificateContext(): CertificateContext | null {
    return this.certContext ? cloneJson(this.certContext) : null;
  }

  public hasNodeContext(): boolean {
    return this.certContext !== null;
  }

  public setNodeContext(
    nodeId: string,
    physicalPath: string,
    logicals: string[],
    _parentPath?: string | null
  ): void {
    const nodeSid = secureDigest(physicalPath);
    this.certContext = {
      nodeId,
      nodeSid,
      physicalPath,
      logicals: [...logicals],
    };

    logger.debug('node_context_set', {
      node_id: nodeId,
      physical_path: physicalPath,
      logicals,
      message: 'Certificate generation via external CA service required',
    });
  }

  public setNodeContextFromNodeLike(nodeLike: NodeLike): void {
    this.setNodeContext(
      nodeLike.id,
      nodeLike.physicalPath,
      Array.from(nodeLike.acceptedLogicals)
    );

    if (
      this.certContext &&
      nodeLike.sid &&
      nodeLike.sid !== this.certContext.nodeSid
    ) {
      this.certContext = {
        ...this.certContext,
        nodeSid: nodeLike.sid,
      };

      logger.debug('node_context_updated_with_nodelike_sid', {
        node_id: nodeLike.id,
        provided_sid: nodeLike.sid,
        message: 'Certificate generation via external CA service required',
      });
    }
  }

  public prepareForAttach(
    nodeId: string,
    physicalPath: string,
    logicals: string[]
  ): void {
    const nodeSid = secureDigest(physicalPath);
    this.certContext = {
      nodeId,
      nodeSid,
      physicalPath,
      logicals: [...logicals],
    };

    logger.debug('prepared_context_for_attach', {
      node_id: nodeId,
      physical_path: physicalPath,
      node_sid: nodeSid,
      logicals,
      message: 'Certificate generation via external CA service required',
    });
  }

  public setLogicals(logicals: string[]): void {
    if (!this.certContext) {
      return;
    }
    this.certContext = {
      ...this.certContext,
      logicals: [...logicals],
    };

    logger.debug('logicals_updated', {
      node_id: this.certContext.nodeId,
      logicals,
      message: 'Certificate regeneration via external CA service required',
    });
  }

  public storeSignedCertificate(
    certificatePem: string,
    certificateChainPem?: string | null
  ): void {
    this.nodeCertPem = certificatePem;
    this.nodeCertChainPem = certificateChainPem ?? null;

    logger.debug('certificate_stored', {
      has_certificate: Boolean(certificatePem),
      has_chain: Boolean(certificateChainPem),
    });
  }
}

async function buildProviderArtifacts(
  options: DefaultCryptoProviderOptions
): Promise<ProviderArtifacts> {
  const algorithm = normalizeAlgorithm(options.algorithm ?? readEnvAlgorithm());
  const signatureKeyId = options.signatureKeyId?.trim() || generateId();
  const encryptionKeyId = options.encryptionKeyId?.trim() || generateId();
  const issuer = options.issuer?.trim() || DEFAULT_ISSUER;
  const audience = options.audience?.trim() || DEFAULT_AUDIENCE;
  const ttlSec =
    typeof options.ttlSec === 'number' && options.ttlSec > 0
      ? options.ttlSec
      : DEFAULT_TTL_SEC;

  const signingParams: {
    algorithm: string;
    keyId: string;
    privatePem?: string;
    publicPem?: string;
  } = {
    algorithm,
    keyId: signatureKeyId,
  };
  if (options.signaturePrivatePem) {
    signingParams.privatePem = options.signaturePrivatePem;
  }
  if (options.signaturePublicPem) {
    signingParams.publicPem = options.signaturePublicPem;
  }

  const signing = await resolveSigningArtifacts(signingParams);

  const encryptionParams: {
    keyId: string;
    privatePem?: string;
    publicPem?: string;
  } = {
    keyId: encryptionKeyId,
  };
  if (options.encryptionPrivatePem) {
    encryptionParams.privatePem = options.encryptionPrivatePem;
  }
  if (options.encryptionPublicPem) {
    encryptionParams.publicPem = options.encryptionPublicPem;
  }

  const encryption = await resolveEncryptionArtifacts(encryptionParams);

  const hmacSecret =
    options.hmacSecret?.trim() ||
    (await generateRandomSecretBase64(DEFAULT_HMAC_SECRET_BYTES));

  return {
    signing,
    encryption,
    hmacSecret,
    issuer,
    audience,
    ttlSec,
  };
}

async function resolveSigningArtifacts(params: {
  algorithm: string;
  keyId: string;
  privatePem?: string;
  publicPem?: string;
}): Promise<ProviderArtifacts['signing']> {
  const normalizedAlg = mapAlgorithmToJwt(params.algorithm);

  if (params.privatePem && params.publicPem) {
    const jwk = await buildSigningJwkFromPem(
      params.publicPem,
      params.keyId,
      normalizedAlg
    );
    return {
      privatePem: params.privatePem,
      publicPem: params.publicPem,
      keyId: params.keyId,
      jwk,
      algorithm: normalizedAlg,
    };
  }

  let keyPair: DevKeyPair;
  if (normalizedAlg === 'EdDSA') {
    keyPair = await createEd25519Keypair(params.keyId);
  } else if (normalizedAlg.startsWith('RS')) {
    keyPair = await createRsaKeypair(params.keyId);
  } else {
    throw new Error(`Unsupported signing algorithm: ${params.algorithm}`);
  }

  const baseJwk = Array.isArray(keyPair.jwks.keys)
    ? keyPair.jwks.keys[0]
    : undefined;
  const jwk = cloneJson(baseJwk ?? {});
  jwk.kid = params.keyId;
  jwk.alg = normalizedAlg;
  jwk.use = 'sig';

  return {
    privatePem: keyPair.privatePem,
    publicPem: keyPair.publicPem,
    keyId: params.keyId,
    jwk,
    algorithm: normalizedAlg,
  };
}

async function resolveEncryptionArtifacts(params: {
  keyId: string;
  privatePem?: string;
  publicPem?: string;
}): Promise<ProviderArtifacts['encryption']> {
  if (params.privatePem && params.publicPem) {
    const jwk = await buildEncryptionJwkFromPem(params.publicPem, params.keyId);
    return {
      privatePem: params.privatePem,
      publicPem: params.publicPem,
      keyId: params.keyId,
      jwk,
    };
  }

  const keyPair = await createX25519Keypair(params.keyId);
  const jwk = await buildEncryptionJwkFromPem(keyPair.publicPem, params.keyId);

  return {
    privatePem: keyPair.privatePem,
    publicPem: keyPair.publicPem,
    keyId: params.keyId,
    jwk,
  };
}

function normalizeAlgorithm(value: string | null | undefined): string {
  if (!value) {
    return DEFAULT_CRYPTO_ALGORITHM;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return DEFAULT_CRYPTO_ALGORITHM;
  }
  const upper = trimmed.toUpperCase();
  if (upper === 'EDDSA' || upper === 'ED25519') {
    return 'EdDSA';
  }
  if (upper === 'RSA') {
    return 'RSA';
  }
  if (
    upper.startsWith('RS') ||
    upper.startsWith('PS') ||
    upper.startsWith('ES') ||
    upper.startsWith('HS')
  ) {
    return upper;
  }
  return trimmed;
}

function mapAlgorithmToJwt(value: string): string {
  const upper = value.toUpperCase();
  if (upper === 'RSA') {
    return 'RS256';
  }
  return value;
}

function readEnvAlgorithm(): string | null {
  if (typeof process === 'undefined' || !process.env) {
    return null;
  }
  const envValue = process.env[ENV_VAR_CRYPTO_ALGORITHM];
  return envValue ?? null;
}

async function buildSigningJwkFromPem(
  publicPem: string,
  kid: string,
  preferredAlg: string
): Promise<Record<string, unknown>> {
  const jose = await requireJose();
  const candidates = preferredAlg
    ? [preferredAlg, 'EdDSA', 'RS256', 'ES256', 'ES384', 'ES512']
    : ['EdDSA', 'RS256', 'ES256', 'ES384', 'ES512'];

  for (const alg of candidates) {
    try {
      const key = await jose.importSPKI(publicPem, alg);
      const jwk = await jose.exportJWK(key);
      if (jwk && typeof jwk === 'object') {
        const result: Record<string, unknown> = {
          ...jwk,
          kid,
          use: 'sig',
          alg,
        };
        return result;
      }
    } catch {
      continue;
    }
  }

  throw new Error('Unable to derive JWK from signing public key PEM');
}

async function buildEncryptionJwkFromPem(
  publicPem: string,
  kid: string
): Promise<Record<string, unknown>> {
  const jose = await requireJose();
  try {
    const key = await jose.importSPKI(publicPem, ENCRYPTION_ALG);
    const jwk = await jose.exportJWK(key);
    if (jwk && typeof jwk === 'object') {
      return {
        ...jwk,
        kid,
        use: 'enc',
        alg: ENCRYPTION_ALG,
      };
    }
  } catch (error) {
    logger.warning('x25519_jwk_from_pem_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  throw new Error('Unable to derive JWK from X25519 public key PEM');
}

async function generateRandomSecretBase64(length: number): Promise<string> {
  if (
    typeof globalThis !== 'undefined' &&
    globalThis.crypto &&
    typeof globalThis.crypto.getRandomValues === 'function'
  ) {
    const bytes = new Uint8Array(length);
    globalThis.crypto.getRandomValues(bytes);
    return bytesToBase64(bytes);
  }

  if (typeof process !== 'undefined') {
    const { randomBytes } = await import('crypto');
    return randomBytes(length).toString('base64');
  }

  throw new Error(
    'No cryptographic random source available to generate HMAC secret'
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }

  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function buildX5cChain(
  certificatePem: string,
  chainPem: string | null
): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();

  const appendIfNew = (pem: string): void => {
    const derBase64 = pemToDerBase64(pem);
    if (seen.has(derBase64)) {
      return;
    }
    seen.add(derBase64);
    chain.push(derBase64);
  };

  appendIfNew(certificatePem);

  if (chainPem) {
    for (const cert of splitPemCertificates(chainPem)) {
      appendIfNew(cert);
    }
  }

  return chain;
}

function splitPemCertificates(pem: string): string[] {
  const matches = pem.match(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g
  );
  return matches ? matches : [];
}

function pemToDerBase64(pem: string): string {
  const lines = pem.replace(/\r/g, '').split('\n');
  const base64Lines = lines.filter(
    (line) => !line.startsWith('-----') && line.trim().length > 0
  );
  const base64 = base64Lines.join('');
  // Ensure the output is valid base64 without whitespace
  return base64.replace(/\s+/g, '');
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
