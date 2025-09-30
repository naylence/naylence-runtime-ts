import type { FastifyReply, FastifyRequest } from "fastify";
import { Buffer } from "node:buffer";

import type { FameServerClientConfig, FameServerConfig } from "../fame-server-config.js";
import type { CryptoProvider } from "../../security/crypto/providers/crypto-provider.js";
import type { TokenIssuer } from "../../security/auth/token-issuer.js";

jest.mock("../../security/auth/jose-loader.js", () => ({
  requireJose: jest.fn(),
}));

import {
  aggregateScopes,
  buildAbsoluteUrl,
  buildBaseUrl,
  buildTokenClaims,
  coerceTokenPayload,
  inferExpiresIn,
  matchSecret,
  parseBasicCredentials,
  parseScopes,
  resolveAudience,
  resolveIssuer,
  resolveTokenIssuer,
  sanitizeJwks,
  sendOAuthError,
  validateScopes,
} from "../routes.js";

const requireJoseMock = jest.requireMock("../../security/auth/jose-loader.js")
  .requireJose as jest.Mock;

const baseClient: FameServerClientConfig = {
  id: "client",
  secret: "secret",
  scopes: ["read", "write"],
  metadata: { tier: "gold" },
};

const baseConfig: FameServerConfig = {
  host: "localhost",
  port: 8080,
  basePath: "/api",
  trustProxy: false,
  requestTimeoutMs: 30_000,
  keepAliveTimeoutMs: 5_000,
  headersTimeoutMs: 60_000,
  pluginTimeoutMs: 10_000,
  bodyLimitBytes: 1_048_576,
  maxParamLength: 100,
  enableIntrospection: false,
  routes: {
    token: "/oauth/token",
    jwks: "/.well-known/jwks.json",
    openIdConfiguration: "/.well-known/openid-configuration",
    health: "/healthz",
    metrics: "/metrics",
  },
  clients: [baseClient],
};

describe("routes helper utilities", () => {
  beforeEach(() => {
    requireJoseMock.mockReset();
  });

  it("coerces token payloads to include only string fields", () => {
    expect(coerceTokenPayload(null)).toEqual({});
    const payload = coerceTokenPayload({
      grant_type: "client_credentials",
      client_id: "abc",
      retries: 3,
      nested: { ok: true },
    });
    expect(payload).toEqual({ grant_type: "client_credentials", client_id: "abc" });
  });

  it("parses basic credentials from authorization header", () => {
    const header = `Basic ${Buffer.from("id:secret").toString("base64")}`;
    expect(parseBasicCredentials(header)).toEqual({ clientId: "id", clientSecret: "secret" });
    expect(parseBasicCredentials("Bearer token")).toBeUndefined();
    expect(parseBasicCredentials("Basic not-base64")).toBeUndefined();
    expect(
      parseBasicCredentials(`Basic ${Buffer.from("no-colon").toString("base64")}`)
    ).toBeUndefined();
    expect(
      parseBasicCredentials(`Basic ${Buffer.from(":missing").toString("base64")}`)
    ).toBeUndefined();
  });

  it("matches secrets in constant time", () => {
    expect(matchSecret("secret", "secret")).toBe(true);
    expect(matchSecret("secret", "SECRET")).toBe(false);
    expect(matchSecret("short", "longer")).toBe(false);
  });

  it("parses unique scopes and trims whitespace", () => {
    expect(parseScopes(undefined)).toEqual([]);
    expect(parseScopes("read write read   admin")).toEqual(["read", "write", "admin"]);
  });

  it("validates scopes based on client permissions", () => {
    expect(validateScopes([], baseClient)).toBe(true);
    const clientWithNoScopes = { ...baseClient, scopes: [] };
    expect(validateScopes(["any"], clientWithNoScopes)).toBe(true);
    expect(validateScopes(["read"], baseClient)).toBe(true);
    expect(validateScopes(["invalid"], baseClient)).toBe(false);
  });

  it("resolves audience with precedence overrides", () => {
    const cryptoProvider: CryptoProvider = {
      audience: "provider",
    } as CryptoProvider;
    const config = { ...baseConfig, defaultAudience: "config-default" };
    expect(resolveAudience(" requested ", baseClient, config, cryptoProvider)).toBe("requested");
    expect(
      resolveAudience(undefined, { ...baseClient, audience: "client" }, config, cryptoProvider)
    ).toBe("client");
    const configWithoutDefault = { ...baseConfig };
    delete (configWithoutDefault as Partial<FameServerConfig>).defaultAudience;
    expect(resolveAudience(undefined, baseClient, config, cryptoProvider)).toBe("config-default");
    expect(resolveAudience(undefined, baseClient, configWithoutDefault, cryptoProvider)).toBe(
      "provider"
    );
    expect(resolveAudience(undefined, baseClient, configWithoutDefault, null)).toBeUndefined();
  });

  it("builds token claims including scopes and metadata", () => {
    const claims = buildTokenClaims(baseClient, ["read", "write"], "aud");
    expect(claims).toMatchObject({
      client_id: "client",
      sub: "client",
      scope: "read write",
      scopes: ["read", "write"],
      capabilities: ["read", "write"],
      aud: "aud",
      client_metadata: baseClient.metadata,
    });
  });

  it("infers expires_in from exp and expires_in claims", async () => {
    const nowSeconds = 1_000_000;
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(nowSeconds * 1000);
    requireJoseMock.mockResolvedValueOnce({
      decodeJwt: jest.fn(() => ({ exp: nowSeconds + 30 })),
    });
    await expect(inferExpiresIn("token")).resolves.toBe(30);

    requireJoseMock.mockResolvedValueOnce({
      decodeJwt: jest.fn(() => ({ expires_in: 45.9 })),
    });
    await expect(inferExpiresIn("token")).resolves.toBe(45);

    requireJoseMock.mockRejectedValueOnce(new Error("decode failed"));
    await expect(inferExpiresIn("token")).resolves.toBeUndefined();
    nowSpy.mockRestore();
  });

  it("sends OAuth error responses with headers", () => {
    const headers: Record<string, string> = {};
    const reply = {
      header: jest.fn((name: string, value: string) => {
        headers[name] = value;
        return reply;
      }),
      code: jest.fn(() => reply),
      send: jest.fn((payload) => payload),
    } as unknown as FastifyReply;

    const payload = { error: "invalid" };
    sendOAuthError(reply, 401, payload);
    expect(headers).toMatchObject({ "Cache-Control": "no-store", Pragma: "no-cache" });
  });

  it("sanitizes JWKS output and rejects invalid input", () => {
    expect(sanitizeJwks(null)).toBeNull();
    expect(sanitizeJwks({ getJwks: () => ({}) } as CryptoProvider)).toBeNull();
    const jwksResult = sanitizeJwks({
      getJwks: () => ({
        keys: [{ kid: "1" }, null, { kid: "2" }],
      }),
    } as CryptoProvider);
    expect(jwksResult).toEqual({ keys: [{ kid: "1" }, { kid: "2" }] });
    const original = { key: true } as Record<string, unknown>;
    const sanitized = sanitizeJwks({ getJwks: () => ({ keys: [original] }) } as CryptoProvider)!;
    expect(sanitized.keys[0]).not.toBe(original);
  });

  it("builds base and absolute URLs using proxy headers", () => {
    const request = {
      headers: {
        "x-forwarded-host": ["edge.example"],
        "x-forwarded-proto": ["https"],
      },
      hostname: "internal",
      protocol: "http",
    } as unknown as FastifyRequest;
    expect(buildBaseUrl(request, baseConfig)).toBe("https://edge.example/api");
    expect(buildAbsoluteUrl("https://edge.example/api", "/oauth/token")).toBe(
      "https://edge.example/api/oauth/token"
    );
    expect(buildAbsoluteUrl("https://edge.example/api", "status")).toBe(
      "https://edge.example/api/status"
    );
    expect(buildAbsoluteUrl("https://edge.example/api", "/")).toBe("https://edge.example/api/");
  });

  it("resolves issuers and aggregates scopes", () => {
    expect(resolveIssuer({ issuer: "https://issuer" } as CryptoProvider, "fallback")).toBe(
      "https://issuer"
    );
    expect(resolveIssuer(null, "fallback")).toBe("fallback");
    const scopes = aggregateScopes([baseClient, { ...baseClient, scopes: ["admin", "read"] }]);
    expect(scopes).toEqual(["admin", "read", "write"]);
  });

  it("resolves token issuers and handles errors", () => {
    expect(resolveTokenIssuer(null)).toBeNull();
    expect(resolveTokenIssuer({} as CryptoProvider)).toBeNull();

    const issuer: TokenIssuer = { issue: jest.fn(), issuer: "https://issuer" };
    expect(resolveTokenIssuer({ getTokenIssuer: () => issuer } as CryptoProvider)).toBe(issuer);

    expect(
      resolveTokenIssuer({
        getTokenIssuer: () => {
          throw new Error("boom");
        },
      } as CryptoProvider)
    ).toBeNull();

    expect(resolveTokenIssuer({ getTokenIssuer: () => undefined } as CryptoProvider)).toBeNull();
  });
});
