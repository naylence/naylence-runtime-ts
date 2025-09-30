import type { JWTPayload } from "jose";
import type { AuthorizationContext } from "naylence-core";

export function extractScopesFromPayload(payload: JWTPayload): Set<string> {
  const scopes = new Set<string>();

  const add = (value: unknown): void => {
    if (typeof value === "string") {
      value
        .split(/[\s,]+/)
        .filter(Boolean)
        .forEach((item) => scopes.add(item));
    } else if (Array.isArray(value)) {
      value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean)
        .forEach((item) => scopes.add(item));
    }
  };

  add(payload.scope);
  add(payload.scopes);
  add((payload as Record<string, unknown>).scp);

  return scopes;
}

export function buildAuthorizationContext(
  payload: JWTPayload,
  kid?: string,
  overrides?: Partial<AuthorizationContext>
): AuthorizationContext {
  const claims: Record<string, unknown> = { ...payload };
  const grantedScopes = Array.from(extractScopesFromPayload(payload));

  if (typeof payload.jti === "string") {
    claims.jti = payload.jti;
  }
  if (typeof kid === "string" && kid.length > 0) {
    claims.kid = kid;
  }

  return {
    authenticated: true,
    authorized: true,
    claims,
    grantedScopes,
    restrictions: {},
    ...(typeof payload.sub === "string" ? { principal: payload.sub } : {}),
    ...overrides,
  } satisfies AuthorizationContext;
}
