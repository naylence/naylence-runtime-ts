export type JoseModule = typeof import("jose");

let joseModulePromise: Promise<JoseModule> | null = null;

export async function requireJose(): Promise<JoseModule> {
  if (!joseModulePromise) {
    joseModulePromise = import("jose").catch((error) => {
      joseModulePromise = null;
      const dependencyError = new Error(
        'The "jose" dependency is required for JWT verification. Install it with: npm install jose'
      );
      (dependencyError as Error & { cause?: unknown }).cause = error;
      throw dependencyError;
    });
  }

  return joseModulePromise;
}

export type { JWTVerifyOptions } from "jose";
