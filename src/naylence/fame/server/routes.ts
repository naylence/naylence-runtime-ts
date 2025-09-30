import type { FastifyReply, FastifyRequest } from "fastify";
import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { getLogger } from "../util/logging.js";
import type { CryptoProvider } from "../security/crypto/providers/crypto-provider.js";
import { requireJose } from "../security/auth/jose-loader.js";
import type { TokenIssuer } from "../security/auth/token-issuer.js";
import {
  registerFameServerRoutes,
  type FameFastifyServer,
  type FameServerRouteRegistrar,
} from "./fame-server.js";
import type { FameServerClientConfig, FameServerConfig } from "./fame-server-config.js";

const logger = getLogger("fame-fastify-default-routes");

const SUPPORTED_GRANT_TYPES = new Set(["client_credentials"]);
const DEFAULT_EXPIRES_IN_SECONDS = 3600;
const CACHE_MAX_AGE_SECONDS = 300;

interface OAuthTokenPayload {
  grant_type?: string;
  client_id?: string;
  client_secret?: string;
  scope?: string;
  audience?: string;
  [key: string]: unknown;
}

interface BasicCredentials {
  clientId: string;
  clientSecret: string;
}

interface OAuthErrorPayload {
  error: string;
  error_description?: string;
}

export interface FameServerRouteDependencies {
  resolveCryptoProvider: () => CryptoProvider | null;
}

export async function registerDefaultFameServerRoutes(
  server: FameFastifyServer,
  dependencies: FameServerRouteDependencies
): Promise<void> {
  const resolveCryptoProvider = dependencies.resolveCryptoProvider;

  const registrar: FameServerRouteRegistrar = async (instance, config) => {
    instance.get(config.routes.health, async (_request, reply) => {
      reply.header("Cache-Control", "no-store");
      return reply.send({
        status: "ok",
        uptime_sec: process.uptime(),
        timestamp: new Date().toISOString(),
      });
    });

    instance.get(config.routes.metrics, async (_request, reply) => {
      reply.header("Content-Type", "text/plain; charset=utf-8");
      reply.header("Cache-Control", "no-store");
      return reply.send("# metrics_not_implemented 1\n");
    });

    instance.get(config.routes.jwks, async (_request, reply) => {
      const cryptoProvider = resolveCryptoProvider();
      const jwks = sanitizeJwks(cryptoProvider);
      if (!jwks) {
        logger.warning("jwks_unavailable");
        return reply.code(503).send({ error: "jwks_unavailable" });
      }

      reply.header("Cache-Control", `public, max-age=${CACHE_MAX_AGE_SECONDS}`);
      return reply.send(jwks);
    });

    instance.get(config.routes.openIdConfiguration, async (request, reply) => {
      const cryptoProvider = resolveCryptoProvider();
      const baseUrl = buildBaseUrl(request, config);
      const issuer = resolveIssuer(cryptoProvider, baseUrl);
      const tokenEndpoint = buildAbsoluteUrl(baseUrl, config.routes.token);
      const jwksUri = buildAbsoluteUrl(baseUrl, config.routes.jwks);
      const scopesSupported = aggregateScopes(config.clients);

      const payload = {
        issuer,
        token_endpoint: tokenEndpoint,
        jwks_uri: jwksUri,
        grant_types_supported: Array.from(SUPPORTED_GRANT_TYPES),
        token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
        response_types_supported: ["token"],
        scopes_supported: scopesSupported.length > 0 ? scopesSupported : undefined,
      };

      reply.header("Cache-Control", `public, max-age=${CACHE_MAX_AGE_SECONDS}`);
      return reply.send(payload);
    });

    instance.post(config.routes.token, async (request, reply) => {
      const body = coerceTokenPayload(request.body);
      const grantType = (body.grant_type ?? "").toLowerCase();
      if (!SUPPORTED_GRANT_TYPES.has(grantType)) {
        logger.debug("unsupported_grant_type", { grant_type: body.grant_type });
        return sendOAuthError(reply, 400, {
          error: "unsupported_grant_type",
          error_description: "Only client_credentials grant is supported",
        });
      }

      const basicCredentials = parseBasicCredentials(request.headers.authorization);
      const clientId = (body.client_id ?? basicCredentials?.clientId ?? "").trim();
      const clientSecret = body.client_secret ?? basicCredentials?.clientSecret ?? "";

      if (!clientId || !clientSecret) {
        logger.debug("invalid_client_credentials_missing");
        return sendOAuthError(reply, 401, {
          error: "invalid_client",
          error_description: "Client authentication failed",
        });
      }

      const client = server.getClientById(clientId);
      if (!client) {
        logger.debug("invalid_client_id", { client_id: clientId });
        return sendOAuthError(reply, 401, {
          error: "invalid_client",
          error_description: "Client authentication failed",
        });
      }

      if (!matchSecret(client.secret, clientSecret)) {
        logger.debug("invalid_client_secret", { client_id: clientId });
        return sendOAuthError(reply, 401, {
          error: "invalid_client",
          error_description: "Client authentication failed",
        });
      }

      const requestedScopes = parseScopes(body.scope);
      if (!validateScopes(requestedScopes, client)) {
        logger.debug("invalid_scope_request", {
          client_id: clientId,
          requested_scopes: requestedScopes,
        });
        return sendOAuthError(reply, 400, {
          error: "invalid_scope",
          error_description: "Requested scopes are not permitted for this client",
        });
      }

      const grantedScopes = requestedScopes.length > 0 ? requestedScopes : client.scopes;

      const cryptoProvider = resolveCryptoProvider();
      const tokenIssuer = resolveTokenIssuer(cryptoProvider);
      if (!tokenIssuer) {
        logger.error("token_issuer_unavailable");
        return sendOAuthError(reply, 500, {
          error: "server_error",
          error_description: "Token issuer is not configured",
        });
      }

      const audience = resolveAudience(body.audience, client, config, cryptoProvider);
      const claims = buildTokenClaims(client, grantedScopes, audience);

      let accessToken: string;
      try {
        accessToken = await tokenIssuer.issue(claims);
      } catch (error) {
        logger.error("token_issue_failed", {
          client_id: client.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return sendOAuthError(reply, 500, {
          error: "server_error",
          error_description: "Unable to issue access token",
        });
      }

      const expiresIn = (await inferExpiresIn(accessToken)) ?? DEFAULT_EXPIRES_IN_SECONDS;

      const responsePayload: Record<string, unknown> = {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: expiresIn,
      };

      if (grantedScopes.length > 0) {
        responsePayload.scope = grantedScopes.join(" ");
      }

      reply.header("Cache-Control", "no-store");
      reply.header("Pragma", "no-cache");
      return reply.send(responsePayload);
    });
  };

  await registerFameServerRoutes(server, registrar);
}

export function coerceTokenPayload(body: unknown): OAuthTokenPayload {
  if (!body || typeof body !== "object") {
    return {};
  }

  const payload: OAuthTokenPayload = {};
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === "string") {
      payload[key] = value;
    }
  }
  return payload;
}

export function parseBasicCredentials(header?: string): BasicCredentials | undefined {
  if (!header) {
    return undefined;
  }

  const trimmed = header.trim();
  if (!trimmed.toLowerCase().startsWith("basic ")) {
    return undefined;
  }

  const encoded = trimmed.slice(6).trim();
  if (!encoded) {
    return undefined;
  }

  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const separatorIndex = decoded.indexOf(":");
    if (separatorIndex === -1) {
      return undefined;
    }

    const clientId = decoded.slice(0, separatorIndex);
    const clientSecret = decoded.slice(separatorIndex + 1);
    if (!clientId) {
      return undefined;
    }

    return {
      clientId,
      clientSecret,
    };
  } catch {
    return undefined;
  }
}

export function matchSecret(expected: string, provided: string): boolean {
  const expectedBuffer = Buffer.from(expected, "utf8");
  const providedBuffer = Buffer.from(provided, "utf8");
  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, providedBuffer);
}

export function parseScopes(scopeParam?: string): string[] {
  if (!scopeParam) {
    return [];
  }

  const scopes = new Set<string>();
  for (const scope of scopeParam.split(/\s+/)) {
    const trimmed = scope.trim();
    if (trimmed.length > 0) {
      scopes.add(trimmed);
    }
  }
  return Array.from(scopes);
}

export function validateScopes(requested: string[], client: FameServerClientConfig): boolean {
  if (requested.length === 0 || client.scopes.length === 0) {
    return true;
  }

  const allowed = new Set(client.scopes);
  return requested.every((scope) => allowed.has(scope));
}

export function resolveAudience(
  requestedAudience: string | undefined,
  client: FameServerClientConfig,
  config: FameServerConfig,
  cryptoProvider: CryptoProvider | null
): string | undefined {
  if (requestedAudience && requestedAudience.trim().length > 0) {
    return requestedAudience.trim();
  }

  if (client.audience && client.audience.length > 0) {
    return client.audience;
  }

  if (config.defaultAudience) {
    return config.defaultAudience;
  }

  const providerAudience = cryptoProvider?.audience ?? undefined;
  if (providerAudience && providerAudience.length > 0) {
    return providerAudience;
  }

  return undefined;
}

export function buildTokenClaims(
  client: FameServerClientConfig,
  scopes: string[],
  audience: string | undefined
): Record<string, unknown> {
  const claims: Record<string, unknown> = {
    client_id: client.id,
    sub: client.id,
    grant_type: "client_credentials",
  };

  if (scopes.length > 0) {
    const scopeString = scopes.join(" ");
    claims.scope = scopeString;
    claims.scopes = scopes;
    claims.capabilities = scopes;
  }

  if (audience) {
    claims.aud = audience;
  }

  if (Object.keys(client.metadata).length > 0) {
    claims.client_metadata = client.metadata;
  }

  return claims;
}

export async function inferExpiresIn(token: string): Promise<number | undefined> {
  try {
    const jose = await requireJose();
    const payload = jose.decodeJwt(token);
    if (typeof payload.exp === "number") {
      const nowSeconds = Math.floor(Date.now() / 1000);
      return Math.max(0, payload.exp - nowSeconds);
    }

    const expiresIn = (payload as Record<string, unknown>).expires_in;
    if (typeof expiresIn === "number" && Number.isFinite(expiresIn)) {
      return Math.max(0, Math.floor(expiresIn));
    }
  } catch (error) {
    logger.debug("token_expiry_inference_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return undefined;
}

export function sendOAuthError(
  reply: FastifyReply,
  statusCode: number,
  payload: OAuthErrorPayload
) {
  reply.header("Cache-Control", "no-store");
  reply.header("Pragma", "no-cache");
  return reply.code(statusCode).send(payload);
}

export function sanitizeJwks(
  cryptoProvider: CryptoProvider | null
): { keys: Array<Record<string, unknown>> } | null {
  const jwks = cryptoProvider?.getJwks?.();
  if (!jwks || typeof jwks !== "object") {
    return null;
  }

  const keys = Array.isArray((jwks as { keys?: unknown }).keys)
    ? (jwks as { keys: unknown[] }).keys
    : [];

  const normalizedKeys = keys
    .filter((key): key is Record<string, unknown> => Boolean(key && typeof key === "object"))
    .map((key) => ({ ...key }));

  if (normalizedKeys.length === 0) {
    return null;
  }

  return { keys: normalizedKeys };
}

export function buildBaseUrl(request: FastifyRequest, config: FameServerConfig): string {
  const hostHeader =
    request.headers["x-forwarded-host"] ?? request.headers.host ?? request.hostname;
  const protocolHeader = request.headers["x-forwarded-proto"];
  const protocol = Array.isArray(protocolHeader)
    ? protocolHeader[0]
    : (protocolHeader ?? request.protocol ?? "http");
  const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  const normalizedHost = host ?? "localhost";
  const basePath = config.basePath || "";
  return `${protocol}://${normalizedHost}${basePath}`;
}

export function buildAbsoluteUrl(baseUrl: string, relativePath: string): string {
  if (!relativePath || relativePath === "/") {
    return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  }

  if (relativePath.startsWith("/")) {
    return `${baseUrl}${relativePath}`;
  }
  return `${baseUrl}/${relativePath}`;
}

export function resolveIssuer(cryptoProvider: CryptoProvider | null, fallback: string): string {
  const issuer = cryptoProvider?.issuer ?? undefined;
  if (issuer && issuer.length > 0) {
    return issuer;
  }
  return fallback;
}

export function aggregateScopes(clients: FameServerClientConfig[]): string[] {
  const scopes = new Set<string>();
  for (const client of clients) {
    for (const scope of client.scopes) {
      scopes.add(scope);
    }
  }
  return Array.from(scopes).sort();
}

export function resolveTokenIssuer(cryptoProvider: CryptoProvider | null): TokenIssuer | null {
  if (!cryptoProvider?.getTokenIssuer) {
    return null;
  }

  try {
    return cryptoProvider.getTokenIssuer() ?? null;
  } catch (error) {
    logger.error("token_issuer_resolution_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
