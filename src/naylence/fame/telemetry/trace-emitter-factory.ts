import type { CreateResourceOptions } from "naylence-factory";
import { AbstractResourceFactory, createDefaultResource, createResource } from "naylence-factory";

import type { TraceEmitter } from "./trace-emitter.js";
import type { TraceEmitterConfig } from "./trace-emitter-config.js";

export const TRACE_EMITTER_FACTORY_BASE_TYPE = "TraceEmitterFactory";

export abstract class TraceEmitterFactory<
  C extends TraceEmitterConfig = TraceEmitterConfig,
> extends AbstractResourceFactory<TraceEmitter, C> {
  public abstract create(
    config?: C | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<TraceEmitter>;

  public static async createTraceEmitter(
    config?: TraceEmitterConfig | Record<string, unknown> | null,
    options: CreateResourceOptions = {}
  ): Promise<TraceEmitter> {
    const traceEmitter = config
      ? await createResource<TraceEmitter>(TRACE_EMITTER_FACTORY_BASE_TYPE, config, options)
      : await createDefaultResource<TraceEmitter>(TRACE_EMITTER_FACTORY_BASE_TYPE, null, options);

    if (!traceEmitter) {
      throw new Error("Failed to create trace emitter");
    }

    return traceEmitter;
  }
}

// Ensure default factories are registered lazily to avoid circular ESM initialization issues
void import("./noop-trace-emitter-factory.js");
void import("./open-telemetry-trace-emitter-factory.js");
void import("./trace-emitter-profile-factory.js");
