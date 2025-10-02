import { Expressions } from "naylence-factory";
import { getLogger } from "../util/logging.js";
import type { TraceEmitter } from "./trace-emitter.js";
import type { TraceEmitterConfig } from "./trace-emitter-config.js";
import { TRACE_EMITTER_FACTORY_BASE_TYPE, TraceEmitterFactory } from "./trace-emitter-factory.js";
import type { NoopTraceEmitterConfig } from "./noop-trace-emitter-factory.js";
import type { OpenTelemetryTraceEmitterConfig } from "./open-telemetry-trace-emitter-factory.js";

const logger = getLogger("trace-emitter-profile-factory");

export interface TraceEmitterProfileConfig extends TraceEmitterConfig {
  type: "TraceEmitterProfile";
  profile?: string | null;
}

export const PROFILE_NAME_NOOP = "noop";
export const PROFILE_NAME_OPEN_TELEMETRY = "open-telemetry";

const ENV_VAR_TELEMETRY_SERVICE_NAME = "FAME_TELEMETRY_SERVICE_NAME";

const NOOP_PROFILE: NoopTraceEmitterConfig = {
  type: "NoopTraceEmitter",
};

const OPEN_TELEMETRY_PROFILE: OpenTelemetryTraceEmitterConfig = {
  type: "OpenTelemetryTraceEmitter",
  serviceName: Expressions.env(ENV_VAR_TELEMETRY_SERVICE_NAME, "naylence-service"),
  headers: {},
};

const PROFILE_MAP: Record<string, TraceEmitterConfig> = {
  [PROFILE_NAME_NOOP]: NOOP_PROFILE,
  [PROFILE_NAME_OPEN_TELEMETRY]: OPEN_TELEMETRY_PROFILE,
};

export const FACTORY_META = {
  base: TRACE_EMITTER_FACTORY_BASE_TYPE,
  key: "TraceEmitterProfile",
} as const;

export class TraceEmitterProfileFactory extends TraceEmitterFactory<TraceEmitterProfileConfig> {
  public readonly type = "TraceEmitterProfile";

  public async create(
    config?: TraceEmitterProfileConfig | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<TraceEmitter> {
    const normalized = normalizeTraceEmitterProfileConfig(config);
    const profileConfig = resolveProfileConfig(normalized.profile);

    logger.debug("enabling_trace_emitter_profile", { profile: normalized.profile });

    const traceEmitter = await TraceEmitterFactory.createTraceEmitter(profileConfig, {
      factoryArgs,
    });

    if (!traceEmitter) {
      throw new Error(`Failed to instantiate trace emitter profile: ${normalized.profile}`);
    }

    return traceEmitter;
  }
}

interface NormalizedTraceEmitterProfileConfig {
  profile: string;
}

function normalizeTraceEmitterProfileConfig(
  config: TraceEmitterProfileConfig | Record<string, unknown> | null | undefined
): NormalizedTraceEmitterProfileConfig {
  if (!config) {
    return { profile: PROFILE_NAME_NOOP };
  }

  const candidate = config as TraceEmitterProfileConfig & Record<string, unknown>;
  const profileValue = candidate.profile ?? candidate["profile_name"] ?? candidate["profileName"];

  if (typeof profileValue === "string" && profileValue.trim().length > 0) {
    return { profile: profileValue.trim().toLowerCase() };
  }

  return { profile: PROFILE_NAME_NOOP };
}

function resolveProfileConfig(profileName: string): TraceEmitterConfig {
  const profile = PROFILE_MAP[profileName];
  if (!profile) {
    throw new Error(`Unknown trace emitter profile: ${profileName}`);
  }
  return deepClone(profile);
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export default TraceEmitterProfileFactory;
