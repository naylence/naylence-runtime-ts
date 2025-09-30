import { registerFactory } from "naylence-factory";
import { DEFAULT_JWT_TOKEN_TTL_SEC } from "../../constants/ttl-constants.js";
import { validateJwtTokenTtlSec } from "../../util/ttl-validation.js";
import type { CryptoProvider } from "../crypto/providers/crypto-provider.js";
import { JWTTokenVerifier } from "./jwt-token-verifier.js";
import type { TokenVerifier } from "./token-verifier.js";
import {
  TOKEN_VERIFIER_FACTORY_BASE_TYPE,
  TokenVerifierFactory,
  type TokenVerifierConfig,
} from "./token-verifier-factory.js";

interface StaticCredentialProviderConfig {
  type: "StaticCredentialProvider";
  credentialValue?: string;
  credential_value?: string;
}

interface EnvCredentialProviderConfig {
  type: "EnvCredentialProvider";
  varName?: string;
  var_name?: string;
}

interface SecretStoreCredentialProviderConfig {
  type: "SecretStoreCredentialProvider";
  secretName?: string;
  secret_name?: string;
}

interface NoneCredentialProviderConfig {
  type: "NoneCredentialProvider";
}

interface PromptCredentialProviderConfig {
  type: "PromptCredentialProvider";
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

export interface JWTTokenVerifierConfig extends TokenVerifierConfig {
  type: "JWTTokenVerifier";
  issuer: string;
  publicKeyPem?: SecretSource;
  public_key_pem?: SecretSource;
  hmacSecret?: SecretSource;
  hmac_secret?: SecretSource;
  ttlSec?: number;
  ttl_sec?: number;
  revokedCapacity?: number;
  revoked_capacity?: number;
  requiredScopes?: string[];
  required_scopes?: string[];
  algorithms?: string[];
}

interface NormalizedJWTTokenVerifierConfig {
  issuer: string;
  publicKeyPem?: SecretSource;
  hmacSecret?: SecretSource;
  ttlSec: number;
  revokedCapacity: number;
  requiredScopes: string[];
  algorithms: string[];
}

export class JWTTokenVerifierFactory extends TokenVerifierFactory<JWTTokenVerifierConfig> {
  public readonly type = "JWTTokenVerifier";
  public readonly isDefault = true;

  public async create(
    config?: JWTTokenVerifierConfig | Record<string, unknown> | null,
    cryptoProvider?: CryptoProvider
  ): Promise<TokenVerifier> {
    if (!config) {
      throw new Error("JWTTokenVerifierFactory requires configuration");
    }

    const normalized = normalizeConfig(config);
    const cryptoProvider1 = cryptoProvider ?? null;

    let verificationKey: string | undefined;

    if (normalized.hmacSecret !== undefined) {
      verificationKey = await resolveSecret(normalized.hmacSecret);
    } else if (normalized.publicKeyPem !== undefined) {
      verificationKey = await resolveSecret(normalized.publicKeyPem);
    } else {
      verificationKey = getProviderVerificationKey(cryptoProvider1);
    }

    if (!verificationKey) {
      throw new Error("JWT token verifier requires a verification key");
    }

    const ttl = validateJwtTokenTtlSec(normalized.ttlSec);
    const ttlSec = typeof ttl === "number" ? ttl : normalized.ttlSec;

    return new JWTTokenVerifier({
      verificationKey,
      issuer: normalized.issuer,
      ttlSec,
      revokedCapacity: normalized.revokedCapacity,
      requiredScopes: normalized.requiredScopes,
      algorithms: normalized.algorithms,
    });
  }
}

function normalizeConfig(
  config: JWTTokenVerifierConfig | Record<string, unknown>
): NormalizedJWTTokenVerifierConfig {
  const source = config as JWTTokenVerifierConfig & Record<string, unknown>;

  const issuer =
    typeof source.issuer === "string" && source.issuer.trim() !== "" ? source.issuer : undefined;
  if (!issuer) {
    throw new Error('JWTTokenVerifier configuration requires "issuer"');
  }

  const publicKeyPem = source.publicKeyPem ?? source.public_key_pem;
  const hmacSecret = source.hmacSecret ?? source.hmac_secret;

  const ttlCandidate =
    typeof source.ttlSec === "number"
      ? source.ttlSec
      : typeof source.ttl_sec === "number"
        ? source.ttl_sec
        : DEFAULT_JWT_TOKEN_TTL_SEC;

  const revokedCandidate =
    typeof source.revokedCapacity === "number"
      ? source.revokedCapacity
      : typeof source.revoked_capacity === "number"
        ? source.revoked_capacity
        : 1000;

  const requiredScopes = Array.isArray(source.requiredScopes)
    ? source.requiredScopes
    : Array.isArray(source.required_scopes)
      ? source.required_scopes
      : [];

  const algorithms = Array.isArray(source.algorithms) ? source.algorithms : [];

  const normalized: NormalizedJWTTokenVerifierConfig = {
    issuer,
    ttlSec: ttlCandidate,
    revokedCapacity: Math.max(0, revokedCandidate),
    requiredScopes: requiredScopes
      .map((scope) => (typeof scope === "string" ? scope.trim() : ""))
      .filter((scope) => scope.length > 0),
    algorithms: algorithms
      .map((alg) => (typeof alg === "string" ? alg.trim() : ""))
      .filter((alg) => alg.length > 0),
  };

  if (publicKeyPem !== undefined) {
    normalized.publicKeyPem = publicKeyPem;
  }

  if (hmacSecret !== undefined) {
    normalized.hmacSecret = hmacSecret;
  }

  return normalized;
}

async function resolveSecret(source: SecretSource): Promise<string | undefined> {
  if (!source) {
    return undefined;
  }

  if (typeof source === "string") {
    if (source.startsWith("env://")) {
      const varName = source.slice(6);
      if (!varName) {
        throw new Error("Environment variable name cannot be empty in env:// URI");
      }
      return readEnvironmentVariable(varName);
    }

    if (source.startsWith("secret://")) {
      const secretName = source.slice(9);
      if (!secretName) {
        throw new Error("Secret name cannot be empty in secret:// URI");
      }
      throw new Error(`Secret store resolution for '${secretName}' is not yet implemented`);
    }

    return source;
  }

  switch (source.type) {
    case "StaticCredentialProvider": {
      const value = source.credentialValue ?? source.credential_value;
      if (typeof value !== "string" || value.length === 0) {
        throw new Error("StaticCredentialProvider requires a non-empty credentialValue");
      }
      return value;
    }
    case "EnvCredentialProvider": {
      const varName = source.varName ?? source.var_name;
      if (typeof varName !== "string" || varName.length === 0) {
        throw new Error("EnvCredentialProvider requires a non-empty varName");
      }
      return readEnvironmentVariable(varName);
    }
    case "SecretStoreCredentialProvider": {
      const secretName = source.secretName ?? source.secret_name;
      throw new Error(
        `Secret store credential provider for '${secretName ?? "unknown"}' is not yet implemented`
      );
    }
    case "NoneCredentialProvider":
      return undefined;
    case "PromptCredentialProvider":
      throw new Error("PromptCredentialProvider is not supported in the TypeScript runtime");
    default:
      throw new Error(`Unsupported credential provider type: ${source.type}`);
  }
}

function readEnvironmentVariable(varName: string): string {
  if (typeof process === "undefined" || !process.env) {
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

function getProviderVerificationKey(provider: CryptoProvider | null): string | undefined {
  if (!provider) {
    return undefined;
  }

  const typed = provider.signingPublicPem;
  if (typeof typed === "string" && typed.length > 0) {
    return typed;
  }

  const legacy = (provider as Record<string, unknown>).signing_public_pem;
  return typeof legacy === "string" && legacy.length > 0 ? legacy : undefined;
}

registerFactory<TokenVerifier, JWTTokenVerifierConfig>(
  TOKEN_VERIFIER_FACTORY_BASE_TYPE,
  "JWTTokenVerifier",
  JWTTokenVerifierFactory,
  { isDefault: true }
);
