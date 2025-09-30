import { JWTTokenIssuerFactory } from "../auth/jwt-token-issuer-factory.js";
import { TokenIssuerFactory } from "../auth/token-issuer-factory.js";
import { JWTTokenIssuer } from "../auth/jwt-token-issuer.js";

const HMAC_SECRET = "factory-secret";

describe("JWTTokenIssuerFactory", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2025-01-02T00:00:00.000Z"));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("creates HMAC issuers via registry dispatch", async () => {
    const issuer = await TokenIssuerFactory.createTokenIssuer({
      type: "JWTTokenIssuer",
      algorithm: "HS256",
      issuer: "registry-issuer",
      kid: "registry-kid",
      hmacSecret: HMAC_SECRET,
    });

    expect(issuer).toBeInstanceOf(JWTTokenIssuer);

    const token = await issuer.issue({ scope: "factory:test" });
    const jose = await import("jose");
    const verificationKey = new TextEncoder().encode(HMAC_SECRET);
    const { payload } = await jose.jwtVerify(token, verificationKey, {
      issuer: "registry-issuer",
      algorithms: ["HS256"],
    });

    const expectedIssuedAt = Math.floor(Date.now() / 1000);
    expect(payload.iss).toBe("registry-issuer");
    expect(payload.scope).toBe("factory:test");
    expect(payload.iat).toBe(expectedIssuedAt);
    expect(payload.exp).toBe(expectedIssuedAt + 3600);
  });

  it("resolves secrets from environment variables", async () => {
    const envVar = "JWT_FACTORY_SECRET";
    const previous = process.env[envVar];
    process.env[envVar] = "env-secret";

    try {
      const factory = new JWTTokenIssuerFactory();
      const issuer = await factory.create({
        type: "JWTTokenIssuer",
        algorithm: "HS256",
        issuer: "env-issuer",
        kid: "env-kid",
        hmacSecret: `env://${envVar}`,
      });

      const token = await issuer.issue({ aud: "custom" });
      const jose = await import("jose");
      const { payload } = await jose.jwtVerify(token, new TextEncoder().encode("env-secret"), {
        issuer: "env-issuer",
        algorithms: ["HS256"],
      });

      expect(payload.aud).toBe("custom");
    } finally {
      if (previous === undefined) {
        delete process.env[envVar];
      } else {
        process.env[envVar] = previous;
      }
    }
  });

  it("rejects TTL values below minimum threshold", async () => {
    const factory = new JWTTokenIssuerFactory();

    await expect(
      factory.create({
        type: "JWTTokenIssuer",
        algorithm: "HS256",
        issuer: "ttl-check",
        kid: "ttl-kid",
        hmacSecret: HMAC_SECRET,
        ttlSec: 30,
      })
    ).rejects.toThrow("JWT token TTL");
  });
});
