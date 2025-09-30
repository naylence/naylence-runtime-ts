import type { Tracer } from "@opentelemetry/api";
import { registerFactory } from "naylence-factory";

import {
  AuthInjectionStrategyFactory,
  type AuthInjectionStrategyConfig,
} from "../security/auth/auth-injection-strategy-factory.js";
import { OpenTelemetryTraceEmitter } from "./open-telemetry-trace-emitter.js";
import { setupOtel } from "./otel-setup.js";
import type { TraceEmitter } from "./trace-emitter.js";
import type { TraceEmitterConfig } from "./trace-emitter-config.js";
import { TRACE_EMITTER_FACTORY_BASE_TYPE, TraceEmitterFactory } from "./trace-emitter-factory.js";

export interface OpenTelemetryTraceEmitterConfig extends TraceEmitterConfig {
  type: "OpenTelemetryTraceEmitter";
  serviceName?: string;
  endpoint?: string | null;
  environment?: string | null;
  sampler?: string | null;
  headers?: Record<string, string>;
  auth?: AuthInjectionStrategyConfig | null;
}

interface NormalizedOpenTelemetryTraceEmitterConfig {
  serviceName: string;
  endpoint: string | null;
  environment: string | null;
  sampler: string | null;
  headers: Record<string, string>;
  auth: AuthInjectionStrategyConfig | null;
}

interface OpenTelemetryTraceEmitterFactoryOptions {
  tracer?: Tracer;
  headers?: Record<string, string>;
}

export class OpenTelemetryTraceEmitterFactory extends TraceEmitterFactory<OpenTelemetryTraceEmitterConfig> {
  public readonly type = "OpenTelemetryTraceEmitter";

  public async create(
    config?: OpenTelemetryTraceEmitterConfig | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<TraceEmitter> {
    const options = (factoryArgs[0] ?? {}) as OpenTelemetryTraceEmitterFactoryOptions;
    const normalized = normalizeConfig(config);

    const mergedHeaders: Record<string, string> = {
      ...normalized.headers,
      ...(options.headers ?? {}),
    };

    if (normalized.auth) {
      const authStrategy = await AuthInjectionStrategyFactory.createAuthInjectionStrategy(
        normalized.auth
      );
      await authStrategy.apply(mergedHeaders);
    }

    await setupOtel({
      serviceName: normalized.serviceName,
      endpoint: normalized.endpoint,
      environment: normalized.environment,
      sampler: normalized.sampler,
      headers: Object.keys(mergedHeaders).length > 0 ? mergedHeaders : undefined,
    });

    const emitterOptions: { serviceName: string; tracer?: Tracer } = {
      serviceName: normalized.serviceName,
    };

    if (options.tracer) {
      emitterOptions.tracer = options.tracer;
    }

    return new OpenTelemetryTraceEmitter(emitterOptions);
  }
}

function normalizeConfig(
  config?: OpenTelemetryTraceEmitterConfig | Record<string, unknown> | null
): NormalizedOpenTelemetryTraceEmitterConfig {
  if (!config) {
    return {
      serviceName: "naylence-service",
      endpoint: null,
      environment: null,
      sampler: null,
      headers: {},
      auth: null,
    };
  }

  const candidate = config as Record<string, unknown>;
  const headersFromConfig = extractHeaders(candidate.headers ?? candidate["headers"]);
  const authConfig = (candidate.auth ?? candidate["auth"]) as
    | AuthInjectionStrategyConfig
    | null
    | undefined;

  return {
    serviceName:
      extractString(candidate.serviceName ?? candidate["service_name"]) ?? "naylence-service",
    endpoint: extractString(candidate.endpoint ?? candidate["endpoint"]) ?? null,
    environment: extractString(candidate.environment ?? candidate["environment"]) ?? null,
    sampler: extractString(candidate.sampler ?? candidate["sampler"]) ?? null,
    headers: headersFromConfig ?? {},
    auth: authConfig ?? null,
  };
}

function extractString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return undefined;
}

function extractHeaders(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const headers: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string") {
      headers[key] = raw;
    }
  }
  return Object.keys(headers).length > 0 ? headers : null;
}

registerFactory(
  TRACE_EMITTER_FACTORY_BASE_TYPE,
  "OpenTelemetryTraceEmitter",
  OpenTelemetryTraceEmitterFactory
);
