import { DEFAULT_JWKS_CACHE_TTL_SEC } from "../../constants/ttl-constants.js";
import { safeImport } from "../../util/lazy-import.js";
import { validateCacheTtlSec } from "../../util/ttl-validation.js";
import type { TokenVerifier } from "./token-verifier.js";
import {
  TOKEN_VERIFIER_FACTORY_BASE_TYPE,
  TokenVerifierFactory,
  type TokenVerifierConfig,
} from "./token-verifier-factory.js";
type JWKSJWTTokenVerifierModule = typeof import("./jwks-jwt-token-verifier.js");

let jwksJwtTokenVerifierModulePromise: Promise<JWKSJWTTokenVerifierModule> | null = null;
function getJwksJwtTokenVerifierModule(): Promise<JWKSJWTTokenVerifierModule> {
  if (!jwksJwtTokenVerifierModulePromise) {
    jwksJwtTokenVerifierModulePromise = safeImport(
      () => import("./jwks-jwt-token-verifier.js"),
      "jwks-jwt-token-verifier"
    );
  }

  return jwksJwtTokenVerifierModulePromise;
}

export interface JWKSJWTTokenVerifierConfig extends TokenVerifierConfig {
  type: "JWKSJWTTokenVerifier";
  issuer: string;
  jwksUrl?: string;
  jwks_url?: string;
  cacheTtlSec?: number;
  cache_ttl_sec?: number;
  algorithms?: string[];
}

interface NormalizedJWKSVerifierConfig {
  issuer: string;
  jwksUrl: string;
  cacheTtlSec: number;
  algorithms: string[];
}

export const FACTORY_META = {
  base: TOKEN_VERIFIER_FACTORY_BASE_TYPE,
  key: "JWKSJWTTokenVerifier",
} as const;

export class JWKSTokenVerifierFactory extends TokenVerifierFactory<JWKSJWTTokenVerifierConfig> {
  public readonly type = "JWKSJWTTokenVerifier";

  public async create(
    config?: JWKSJWTTokenVerifierConfig | Record<string, unknown> | null
  ): Promise<TokenVerifier> {
    if (!config) {
      throw new Error("JWKSJWTTokenVerifier requires configuration");
    }

    const normalized = normalizeConfig(config);

    const cacheTtlCandidate = validateCacheTtlSec(normalized.cacheTtlSec);
    const cacheTtlSec =
      typeof cacheTtlCandidate === "number" ? cacheTtlCandidate : normalized.cacheTtlSec;

    const { JWKSJWTTokenVerifier } = await getJwksJwtTokenVerifierModule();

    return new JWKSJWTTokenVerifier({
      issuer: normalized.issuer,
      jwksUrl: normalized.jwksUrl,
      cacheTtlSec,
      algorithms: normalized.algorithms,
    });
  }
}

function normalizeConfig(
  config: JWKSJWTTokenVerifierConfig | Record<string, unknown>
): NormalizedJWKSVerifierConfig {
  const source = config as JWKSJWTTokenVerifierConfig & Record<string, unknown>;

  const issuer =
    typeof source.issuer === "string" && source.issuer.trim().length > 0
      ? source.issuer
      : undefined;
  if (!issuer) {
    throw new Error('JWKSJWTTokenVerifier configuration requires "issuer"');
  }

  const jwksUrlRaw = source.jwksUrl ?? source.jwks_url;
  let jwksUrl: string | undefined;
  if (typeof jwksUrlRaw === "string" && jwksUrlRaw.trim().length > 0) {
    jwksUrl = jwksUrlRaw.trim();
  }

  if (!jwksUrl) {
    const trimmedIssuer = issuer.replace(/\/+$/, "");
    jwksUrl = `${trimmedIssuer}/.well-known/jwks.json`;
  }

  const cacheTtlSec =
    typeof source.cacheTtlSec === "number"
      ? source.cacheTtlSec
      : typeof source.cache_ttl_sec === "number"
        ? source.cache_ttl_sec
        : DEFAULT_JWKS_CACHE_TTL_SEC;

  const algorithms = Array.isArray(source.algorithms) ? source.algorithms : [];

  return {
    issuer,
    jwksUrl,
    cacheTtlSec,
    algorithms: algorithms
      .map((alg) => (typeof alg === "string" ? alg.trim() : ""))
      .filter((alg) => alg.length > 0),
  };
}

export default JWKSTokenVerifierFactory;
