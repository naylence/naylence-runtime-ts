/**
 * Runtime helper for registering Naylence Fame runtime factories.
 *
 * This wraps the auto-generated manifest data to register every default runtime factory
 * against a provided registry implementation. By default it wires the factories into
 * the global {@link Registry} from `naylence-factory`, but callers can provide their own
 * registry instance for isolated testing or multi-runtime scenarios.
 */
import type { ResourceFactory } from "naylence-factory";
import { Registry as DefaultRegistry } from "naylence-factory";

import { MODULES, type FactoryModuleSpec } from "../factory-manifest.js";

export type RuntimeFactoryRegistry = typeof DefaultRegistry;

function resolveModuleCandidates(spec: string): string[] {
  const base = spec.startsWith("./") ? `../${spec.slice(2)}` : spec;

  if (base.endsWith(".js")) {
    return [base.replace(/\.js$/u, ".ts"), base];
  }

  return [base];
}

export async function registerDefaultFactories(
  registry: RuntimeFactoryRegistry = DefaultRegistry
): Promise<void> {
  await Promise.all(
    MODULES.map(async (spec: FactoryModuleSpec) => {
      try {
        const candidates = resolveModuleCandidates(spec);
        let mod: Record<string, unknown> | undefined;
        let lastError: unknown;

        for (const candidate of candidates) {
          try {
            mod = await import(candidate);
            lastError = undefined;
            break;
          } catch (error) {
            lastError = error;

            const isLastCandidate = candidate === candidates[candidates.length - 1];
            if (isLastCandidate) {
              throw error;
            }

            const message = error instanceof Error ? error.message : String(error);
            const moduleNotFound =
              message.includes("Cannot find module") ||
              message.includes("ERR_MODULE_NOT_FOUND") ||
              message.includes("Unknown file extension");

            if (!moduleNotFound) {
              throw error;
            }
          }
        }

        if (!mod) {
          throw lastError ?? new Error(`Unable to import factory module: ${spec}`);
        }

        const meta = (mod as Record<string, unknown>).FACTORY_META as
          | { base?: string; key?: string }
          | undefined;
        const Ctor = (mod as Record<string, unknown>).default as
          | (new (...args: unknown[]) => ResourceFactory<unknown, unknown>)
          | undefined;

        if (!meta?.base || !meta?.key || typeof Ctor !== "function") {
          console.warn(
            "[factory-manifest] skipped",
            spec,
            "— missing FACTORY_META or default export ctor"
          );
          return;
        }

        registry.registerFactory(meta.base, meta.key, Ctor);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn("[factory-manifest] skipped", spec, "-", reason);
      }
    })
  );
}

/**
 * Register all default Naylence runtime factories into the supplied registry.
 *
 * @param registry Registry implementation to receive the default runtime factories.
 */
export async function registerRuntimeFactories(
  registry: RuntimeFactoryRegistry = DefaultRegistry
): Promise<void> {
  await registerDefaultFactories(registry);
}
