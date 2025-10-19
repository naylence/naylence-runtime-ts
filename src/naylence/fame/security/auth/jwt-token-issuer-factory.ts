import { DEFAULT_JWT_TOKEN_TTL_SEC } from '../../constants/ttl-constants.js';
import { validateJwtTokenTtlSec } from '../../util/ttl-validation.js';
import type { CryptoProvider } from '../crypto/providers/crypto-provider.js';
import type { TokenIssuer } from './token-issuer.js';
import {
  TOKEN_ISSUER_FACTORY_BASE_TYPE,
  TokenIssuerFactory,
  type TokenIssuerConfig,
} from './token-issuer-factory.js';
import { safeImport } from '../../util/lazy-import.js';

interface StaticCredentialProviderConfig {
  type: 'StaticCredentialProvider';
  credentialValue?: string;
  credential_value?: string;
}

interface EnvCredentialProviderConfig {
  type: 'EnvCredentialProvider';
  varName?: string;
  var_name?: string;
}

interface SecretStoreCredentialProviderConfig {
  type: 'SecretStoreCredentialProvider';
  secretName?: string;
  secret_name?: string;
}

interface NoneCredentialProviderConfig {
  type: 'NoneCredentialProvider';
}

interface PromptCredentialProviderConfig {
  type: 'PromptCredentialProvider';
  credentialName?: string;
  credential_name?: string;
}

type CredentialProviderConfig =
  | StaticCredentialProviderConfig
  | EnvCredentialProviderConfig
  | SecretStoreCredentialProviderConfig
  | NoneCredentialProviderConfig
  | PromptCredentialProviderConfig
  | ({ type: string } & Record<string, unknown>);

type SecretSource = string | CredentialProviderConfig | null | undefined;

export interface JWTTokenIssuerConfig extends TokenIssuerConfig {
  type: 'JWTTokenIssuer';
  privateKeyPem?: SecretSource;
  private_key_pem?: SecretSource;
  hmacSecret?: SecretSource;
  hmac_secret?: SecretSource;
  algorithm?: string;
  kid?: string;
  issuer: string;
  ttlSec?: number;
  ttl_sec?: number;
  audience?: string;
}

interface NormalizedJWTTokenIssuerConfig {
  privateKeyPem?: SecretSource;
  hmacSecret?: SecretSource;
  algorithm: string;
  kid?: string;
  issuer: string;
  ttlSec: number;
  audience?: string;
}

export const FACTORY_META = {
  base: TOKEN_ISSUER_FACTORY_BASE_TYPE,
  key: 'JWTTokenIssuer',
} as const;

export class JWTTokenIssuerFactory extends TokenIssuerFactory<JWTTokenIssuerConfig> {
  public readonly type = 'JWTTokenIssuer';
  public readonly isDefault = true;

  public async create(
    config?: JWTTokenIssuerConfig | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<TokenIssuer> {
    if (!config) {
      throw new Error('JWTTokenIssuerFactory requires configuration');
    }

    const normalized = normalizeConfig(config);

    // Extract crypto provider from factory args
    let cryptoProvider1: CryptoProvider | null = null;
    for (const arg of factoryArgs) {
      if (arg && typeof arg === 'object' && 'signingPrivatePem' in arg) {
        cryptoProvider1 = arg as CryptoProvider;
        break;
      }
    }

    const algorithm = normalized.algorithm;
    const isHmac = algorithm.toUpperCase().startsWith('HS');

    let signingKey: string | undefined;
    let kid = normalized.kid;

    if (isHmac) {
      signingKey = await resolveSecret(normalized.hmacSecret);
      if (!signingKey) {
        throw new Error(
          `HMAC algorithm ${algorithm} requires explicit 'hmacSecret' configuration`
        );
      }
    } else {
      signingKey =
        (await resolveSecret(normalized.privateKeyPem)) ??
        getProviderSigningKey(cryptoProvider1);

      if (!signingKey) {
        throw new Error(
          `Asymmetric algorithm ${algorithm} requires 'privateKeyPem' configuration or crypto provider support`
        );
      }

      if (!kid) {
        kid = getProviderKeyId(cryptoProvider1);
      }
    }

    if (!kid) {
      throw new Error('JWT issuer requires "kid" value');
    }

    const validatedTtl = validateJwtTokenTtlSec(normalized.ttlSec);
    if (typeof validatedTtl !== 'number') {
      throw new Error(
        'JWT token TTL validation failed to produce a numeric value'
      );
    }

    const { JWTTokenIssuer } = await getJwtTokenIssuerModule();

    return new JWTTokenIssuer({
      signingKeyPem: signingKey,
      kid,
      issuer: normalized.issuer,
      algorithm,
      ttlSec: validatedTtl,
      ...(normalized.audience ? { audience: normalized.audience } : {}),
    });
  }
}

type JWTTokenIssuerModule = typeof import('./jwt-token-issuer.js');

let jwtTokenIssuerModulePromise: Promise<JWTTokenIssuerModule> | null = null;

function getJwtTokenIssuerModule(): Promise<JWTTokenIssuerModule> {
  if (!jwtTokenIssuerModulePromise) {
    jwtTokenIssuerModulePromise = safeImport(
      () => import('./jwt-token-issuer.js'),
      'jose',
      {
        helpMessage:
          'Missing optional dependency "jose". Install it to enable JWT token issuance.',
      }
    );
  }
  return jwtTokenIssuerModulePromise;
}

function normalizeConfig(
  config: JWTTokenIssuerConfig | Record<string, unknown>
): NormalizedJWTTokenIssuerConfig {
  const source = config as JWTTokenIssuerConfig & Record<string, unknown>;

  const issuer =
    typeof source.issuer === 'string' && source.issuer.trim() !== ''
      ? source.issuer
      : undefined;
  if (!issuer) {
    throw new Error('JWTTokenIssuer configuration requires "issuer"');
  }

  const algorithm =
    typeof source.algorithm === 'string' && source.algorithm.trim() !== ''
      ? source.algorithm
      : 'EdDSA';

  const ttlCandidate =
    typeof source.ttlSec === 'number'
      ? source.ttlSec
      : typeof source.ttl_sec === 'number'
        ? source.ttl_sec
        : DEFAULT_JWT_TOKEN_TTL_SEC;

  const kid =
    typeof source.kid === 'string' && source.kid.trim() !== ''
      ? source.kid
      : undefined;
  const audience =
    typeof source.audience === 'string' && source.audience.trim() !== ''
      ? source.audience
      : undefined;

  const privateKeyPem = source.privateKeyPem ?? source.private_key_pem;
  const hmacSecret = source.hmacSecret ?? source.hmac_secret;

  const normalized: NormalizedJWTTokenIssuerConfig = {
    algorithm,
    issuer,
    ttlSec: ttlCandidate,
  };

  if (privateKeyPem !== undefined) {
    normalized.privateKeyPem = privateKeyPem;
  }

  if (hmacSecret !== undefined) {
    normalized.hmacSecret = hmacSecret;
  }

  if (kid) {
    normalized.kid = kid;
  }

  if (audience) {
    normalized.audience = audience;
  }

  return normalized;
}

async function resolveSecret(
  source: SecretSource
): Promise<string | undefined> {
  if (!source) {
    return undefined;
  }

  if (typeof source === 'string') {
    if (source.startsWith('env://')) {
      const varName = source.slice(6);
      if (!varName) {
        throw new Error(
          'Environment variable name cannot be empty in env:// URI'
        );
      }
      return readEnvironmentVariable(varName);
    }

    if (source.startsWith('secret://')) {
      const secretName = source.slice(9);
      if (!secretName) {
        throw new Error('Secret name cannot be empty in secret:// URI');
      }
      throw new Error(
        `Secret store resolution for '${secretName}' is not yet implemented`
      );
    }

    return source;
  }

  switch (source.type) {
    case 'StaticCredentialProvider': {
      const value = source.credentialValue ?? source.credential_value;
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error(
          'StaticCredentialProvider requires a non-empty credentialValue'
        );
      }
      return value;
    }
    case 'EnvCredentialProvider': {
      const varName = source.varName ?? source.var_name;
      if (typeof varName !== 'string' || varName.length === 0) {
        throw new Error('EnvCredentialProvider requires a non-empty varName');
      }
      return readEnvironmentVariable(varName);
    }
    case 'SecretStoreCredentialProvider': {
      const secretName = source.secretName ?? source.secret_name;
      throw new Error(
        `Secret store credential provider for '${secretName ?? 'unknown'}' is not yet implemented`
      );
    }
    case 'NoneCredentialProvider':
      return undefined;
    case 'PromptCredentialProvider':
      throw new Error(
        'PromptCredentialProvider is not supported in the TypeScript runtime'
      );
    default:
      throw new Error(`Unsupported credential provider type: ${source.type}`);
  }
}

function readEnvironmentVariable(varName: string): string {
  if (typeof process === 'undefined' || !process.env) {
    throw new Error(
      `Environment variables are not accessible in this runtime; cannot read ${varName}`
    );
  }

  const value = process.env[varName];
  if (!value) {
    throw new Error(`Environment variable ${varName} is not set`);
  }
  return value;
}

function getProviderSigningKey(
  provider: CryptoProvider | null
): string | undefined {
  if (!provider) {
    return undefined;
  }

  const typed = provider.signingPrivatePem;
  if (typeof typed === 'string' && typed.length > 0) {
    return typed;
  }

  const legacy = (provider as Record<string, unknown>).signing_private_pem;
  return typeof legacy === 'string' && legacy.length > 0 ? legacy : undefined;
}

function getProviderKeyId(provider: CryptoProvider | null): string | undefined {
  if (!provider) {
    return undefined;
  }

  const typed = provider.signatureKeyId;
  if (typeof typed === 'string' && typed.length > 0) {
    return typed;
  }

  const legacy = (provider as Record<string, unknown>).signature_key_id;
  return typeof legacy === 'string' && legacy.length > 0 ? legacy : undefined;
}

export default JWTTokenIssuerFactory;
