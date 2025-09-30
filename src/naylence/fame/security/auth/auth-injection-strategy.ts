export interface AuthInjectionStrategy {
  apply(connector: unknown): Promise<void>;
  cleanup(): Promise<void>;
}

export function isAuthInjectionStrategy(candidate: unknown): candidate is AuthInjectionStrategy {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof (candidate as Partial<AuthInjectionStrategy>).apply === "function" &&
    typeof (candidate as Partial<AuthInjectionStrategy>).cleanup === "function"
  );
}
