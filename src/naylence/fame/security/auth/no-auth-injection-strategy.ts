import type { AuthInjectionStrategy } from "./auth-injection-strategy.js";
import type { NoAuthInjectionStrategyConfig } from "./no-auth-injection-strategy-factory.js";

export class NoAuthInjectionStrategy implements AuthInjectionStrategy {
  public constructor(_config: NoAuthInjectionStrategyConfig) {}

  public async apply(_connector: unknown): Promise<void> {
    // Intentionally no-op
  }

  public async cleanup(): Promise<void> {
    // Intentionally no-op
  }
}
