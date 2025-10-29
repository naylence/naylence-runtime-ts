import type { Sampler } from '@opentelemetry/api';
import type { SpanExporter } from '@opentelemetry/sdk-trace-base';
import { getLogger } from '../util/logging.js';

const logger = getLogger('naylence.fame.telemetry.otel_setup');

type NodeTracerProvider =
  import('@opentelemetry/sdk-trace-node').NodeTracerProvider;

export interface SetupOtelOptions {
  serviceName: string;
  endpoint?: string | null;
  environment?: string | null;
  sampler?: string | null;
  headers?: Record<string, string> | undefined;
}

export interface OtelLifecycleControl {
  forceFlush?: () => Promise<void>;
  shutdown?: () => Promise<void>;
}

let registeredOtel: {
  provider: NodeTracerProvider;
  control: OtelLifecycleControl;
} | null = null;

export async function setupOtel(
  options: SetupOtelOptions
): Promise<OtelLifecycleControl | null> {
  try {
    if (registeredOtel) {
      logger.debug('open_telemetry_reusing_provider', {
        service_name: options.serviceName,
      });
      return registeredOtel.control;
    }

    const [apiModule, resourcesModule, nodeModule, traceBaseModule] =
      await Promise.all([
        import('@opentelemetry/api'),
        import('@opentelemetry/resources'),
        import('@opentelemetry/sdk-trace-node'),
        import('@opentelemetry/sdk-trace-base'),
      ]);

    const { trace } = apiModule;
    const { defaultResource, resourceFromAttributes } =
      resourcesModule as typeof import('@opentelemetry/resources');
    const { NodeTracerProvider } =
      nodeModule as typeof import('@opentelemetry/sdk-trace-node');
    const {
      BatchSpanProcessor,
      ConsoleSpanExporter,
      ParentBasedSampler,
      AlwaysOnSampler,
      AlwaysOffSampler,
      TraceIdRatioBasedSampler,
    } = traceBaseModule as typeof import('@opentelemetry/sdk-trace-base');

    const currentProvider = trace.getTracerProvider();
    if (currentProvider && currentProvider instanceof NodeTracerProvider) {
      return null;
    }
    if (
      currentProvider &&
      currentProvider.constructor?.name === 'NodeTracerProvider'
    ) {
      logger.debug('open_telemetry_existing_node_provider', {
        service_name: options.serviceName,
      });
      return null;
    }

    logger.debug('open_telemetry_initializing', {
      service_name: options.serviceName,
      endpoint: options.endpoint ?? null,
      environment: options.environment ?? null,
      sampler: options.sampler ?? null,
      headers_present: Boolean(
        options.headers && Object.keys(options.headers).length
      ),
    });

    const sampler = resolveSampler(options.sampler, {
      ParentBasedSampler,
      AlwaysOnSampler,
      AlwaysOffSampler,
      TraceIdRatioBasedSampler,
    });

    const baseResource = defaultResource();
    const mergedResource = resourceFromAttributes({
      'service.name': options.serviceName,
      'service.instance.id': generateInstanceId(),
      'deployment.environment': options.environment ?? 'dev',
    });
    const resource = baseResource.merge(mergedResource);

    const exporter = await resolveExporter(
      options.endpoint ?? undefined,
      options.headers,
      ConsoleSpanExporter
    );

    const spanProcessor = new BatchSpanProcessor(exporter);
    const provider = new NodeTracerProvider({
      resource,
      sampler,
      spanProcessors: [spanProcessor],
    });
    provider.register();

    logger.debug('open_telemetry_initialized', {
      service_name: options.serviceName,
      exporter: exporter.constructor?.name ?? 'unknown_exporter',
    });

    const control: OtelLifecycleControl = {
      forceFlush: async () => {
        try {
          await provider.forceFlush();
        } catch (flushError) {
          logger.warning('open_telemetry_force_flush_failed', {
            error:
              flushError instanceof Error
                ? flushError.message
                : String(flushError),
          });
        }
      },
      shutdown: async () => {
        try {
          await provider.shutdown();
        } catch (shutdownError) {
          logger.warning('open_telemetry_shutdown_failed', {
            error:
              shutdownError instanceof Error
                ? shutdownError.message
                : String(shutdownError),
          });
        } finally {
          registeredOtel = null;
        }
      },
    };

    registeredOtel = {
      provider,
      control,
    };

    return control;
  } catch (error) {
    logger.error('open_telemetry_not_available', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error && error.stack ? error.stack : undefined,
    });
    return null;
  }
}

function generateInstanceId(): string {
  try {
    if (
      typeof crypto !== 'undefined' &&
      typeof crypto.randomUUID === 'function'
    ) {
      return crypto.randomUUID().replace(/-/g, '');
    }
  } catch {
    // Ignore crypto availability errors
  }
  const random = Math.random().toString(16).slice(2);
  return random.padEnd(32, '0').slice(0, 32);
}

function resolveSampler(
  samplerSetting: string | null | undefined,
  samplers: {
    ParentBasedSampler: new (...args: any[]) => Sampler;
    AlwaysOnSampler: new () => Sampler;
    AlwaysOffSampler: new () => Sampler;
    TraceIdRatioBasedSampler: new (ratio: number) => Sampler;
  }
): Sampler {
  const normalized = (samplerSetting ?? 'parentbased_always_on').toLowerCase();
  let base: Sampler;

  if (normalized === 'always_off') {
    base = new samplers.AlwaysOffSampler();
  } else if (
    normalized === 'always_on' ||
    normalized === 'parentbased_always_on'
  ) {
    base = new samplers.AlwaysOnSampler();
  } else if (normalized.startsWith('ratio:')) {
    const ratioValue = Number.parseFloat(normalized.slice('ratio:'.length));
    const ratio = Number.isFinite(ratioValue)
      ? Math.min(Math.max(ratioValue, 0), 1)
      : 1;
    base = new samplers.TraceIdRatioBasedSampler(ratio);
  } else {
    base = new samplers.AlwaysOnSampler();
  }

  return new samplers.ParentBasedSampler({ root: base });
}

async function resolveExporter(
  endpoint: string | undefined,
  headers: Record<string, string> | undefined,
  ConsoleSpanExporter: new () => SpanExporter
): Promise<SpanExporter> {
  if (endpoint) {
    try {
      const exporterModule = await import(
        '@opentelemetry/exporter-trace-otlp-http'
      );
      if ('OTLPTraceExporter' in exporterModule) {
        const { OTLPTraceExporter } = exporterModule as {
          OTLPTraceExporter: new (config: {
            url: string;
            headers?: Record<string, string>;
          }) => SpanExporter;
        };
        const exporterOptions: {
          url: string;
          headers?: Record<string, string>;
        } = {
          url: endpoint,
        };
        if (headers && Object.keys(headers).length > 0) {
          exporterOptions.headers = headers;
        }
        logger.debug('open_telemetry_using_otlp_http_exporter', {
          endpoint,
          headers_present: Boolean(headers && Object.keys(headers).length),
        });
        return new OTLPTraceExporter(exporterOptions);
      }
    } catch (error) {
      logger.error('open_telemetry_exporter_not_available', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.warning('open_telemetry_falling_back_to_console_exporter');
  return new ConsoleSpanExporter();
}
