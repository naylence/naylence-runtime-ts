import type { Tracer } from '@opentelemetry/api';

import {
  AuthInjectionStrategyFactory,
  type AuthInjectionStrategyConfig,
} from '../security/auth/auth-injection-strategy-factory.js';
import type { AuthInjectionStrategy } from '../security/auth/auth-injection-strategy.js';
import { setupOtel } from './otel-setup.js';
import type { OtelLifecycleControl } from './otel-setup.js';
import { safeImport } from '../util/lazy-import.js';
import type { TraceEmitter } from './trace-emitter.js';
import type { TraceEmitterConfig } from './trace-emitter-config.js';
import {
  TRACE_EMITTER_FACTORY_BASE_TYPE,
  TraceEmitterFactory,
} from './trace-emitter-factory.js';
import { getLogger } from '../util/logging.js';

export interface OpenTelemetryTraceEmitterConfig extends TraceEmitterConfig {
  type: 'OpenTelemetryTraceEmitter';
  serviceName?: string;
  service_name?: string;
  endpoint?: string | null;
  otlpEndpoint?: string | null;
  otlp_endpoint?: string | null;
  environment?: string | null;
  deploymentEnvironment?: string | null;
  deployment_environment?: string | null;
  sampler?: string | null;
  samplingStrategy?: string | null;
  sampling_strategy?: string | null;
  headers?: Record<string, string>;
  otlpHeaders?: Record<string, string>;
  otlp_headers?: Record<string, string>;
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

type OpenTelemetryTraceEmitterModule =
  typeof import('./open-telemetry-trace-emitter.js');

let openTelemetryTraceEmitterModulePromise: Promise<OpenTelemetryTraceEmitterModule> | null =
  null;

const logger = getLogger(
  'naylence.fame.telemetry.open_telemetry_trace_emitter_factory'
);

function getOpenTelemetryTraceEmitterModule(): Promise<OpenTelemetryTraceEmitterModule> {
  if (!openTelemetryTraceEmitterModulePromise) {
    openTelemetryTraceEmitterModulePromise = safeImport(
      () => import('./open-telemetry-trace-emitter.js'),
      '@opentelemetry/api',
      {
        helpMessage:
          'Missing optional OpenTelemetry dependency. Install @opentelemetry/api (and related packages) to enable trace emission.',
      }
    );
  }
  return openTelemetryTraceEmitterModulePromise;
}

export const FACTORY_META = {
  base: TRACE_EMITTER_FACTORY_BASE_TYPE,
  key: 'OpenTelemetryTraceEmitter',
} as const;

export class OpenTelemetryTraceEmitterFactory extends TraceEmitterFactory<OpenTelemetryTraceEmitterConfig> {
  public readonly type = 'OpenTelemetryTraceEmitter';

  public async create(
    config?: OpenTelemetryTraceEmitterConfig | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<TraceEmitter> {
    const options = (factoryArgs[0] ??
      {}) as OpenTelemetryTraceEmitterFactoryOptions;
    const normalized = normalizeConfig(config);

    const mergedHeaders: Record<string, string> = {
      ...normalized.headers,
      ...(options.headers ?? {}),
    };

    let authStrategy: AuthInjectionStrategy | null = null;

    if (normalized.auth) {
      authStrategy =
        await AuthInjectionStrategyFactory.createAuthInjectionStrategy(
          normalized.auth
        );
      try {
        await authStrategy.apply(mergedHeaders);
        logger.info('trace_emitter_auth_applied', {
          service_name: normalized.serviceName,
        });
      } catch (error) {
        try {
          await authStrategy.cleanup();
        } catch {
          // Ignore cleanup errors while propagating original failure
        }
        throw error;
      }
    }

    let lifecycle: OtelLifecycleControl | null = null;
    try {
      lifecycle = await setupOtel({
        serviceName: normalized.serviceName,
        endpoint: normalized.endpoint,
        environment: normalized.environment,
        sampler: normalized.sampler,
        headers:
          Object.keys(mergedHeaders).length > 0 ? mergedHeaders : undefined,
      });
      logger.debug('trace_emitter_lifecycle_acquired', {
        service_name: normalized.serviceName,
        lifecycle_available: Boolean(lifecycle),
      });
    } catch (error) {
      if (authStrategy) {
        try {
          await authStrategy.cleanup();
        } catch {
          // Ignore cleanup errors while propagating original failure
        }
      }
      throw error;
    }

    const { OpenTelemetryTraceEmitter } =
      await getOpenTelemetryTraceEmitterModule();

    const emitterOptions: {
      serviceName: string;
      tracer?: Tracer;
      lifecycle?: OtelLifecycleControl | null;
      authStrategy?: AuthInjectionStrategy | null;
    } = {
      serviceName: normalized.serviceName,
    };

    if (options.tracer) {
      emitterOptions.tracer = options.tracer;
    }

    if (lifecycle) {
      emitterOptions.lifecycle = lifecycle;
    }

    if (authStrategy) {
      emitterOptions.authStrategy = authStrategy;
    }

    try {
      const emitter = new OpenTelemetryTraceEmitter(emitterOptions);
      logger.debug('trace_emitter_created', {
        service_name: normalized.serviceName,
        has_lifecycle: Boolean(lifecycle),
        has_auth_strategy: Boolean(authStrategy),
      });
      return emitter;
    } catch (error) {
      if (authStrategy) {
        try {
          await authStrategy.cleanup();
        } catch {
          // Best effort cleanup
        }
      }
      throw error;
    }
  }
}

function normalizeConfig(
  config?: OpenTelemetryTraceEmitterConfig | Record<string, unknown> | null
): NormalizedOpenTelemetryTraceEmitterConfig {
  if (!config) {
    return {
      serviceName: 'naylence-service',
      endpoint: null,
      environment: null,
      sampler: null,
      headers: {},
      auth: null,
    };
  }

  const candidate = config as Record<string, unknown>;
  const serviceName =
    extractString(
      pickFirst(candidate, ['serviceName', 'service_name'])
    ) ?? 'naylence-service';
  const endpoint =
    extractString(
      pickFirst(candidate, ['endpoint', 'otlpEndpoint', 'otlp_endpoint'])
    ) ?? null;
  const environment =
    extractString(
      pickFirst(candidate, [
        'environment',
        'deploymentEnvironment',
        'deployment_environment',
      ])
    ) ?? null;
  const sampler =
    extractString(
      pickFirst(candidate, ['sampler', 'samplingStrategy', 'sampling_strategy'])
    ) ?? null;

  const headersFromConfig = extractHeaders(
    pickFirst(candidate, ['headers', 'otlpHeaders', 'otlp_headers'])
  );
  const authConfig = pickFirst<AuthInjectionStrategyConfig | null>(candidate, [
    'auth',
  ]);

  return {
    serviceName,
    endpoint,
    environment,
    sampler,
    headers: headersFromConfig ?? {},
    auth: (authConfig as AuthInjectionStrategyConfig | null | undefined) ?? null,
  };
}

function extractString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  return undefined;
}

function pickFirst<T>(
  source: Record<string, unknown>,
  keys: string[]
): T | undefined {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const value = source[key] as T | undefined;
      if (value !== undefined) {
        return value;
      }
    }
  }
  return undefined;
}

function extractHeaders(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const headers: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') {
      headers[key] = raw;
    }
  }
  return Object.keys(headers).length > 0 ? headers : null;
}

export default OpenTelemetryTraceEmitterFactory;
