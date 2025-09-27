import type { Sampler } from '@opentelemetry/api';
import type { SpanExporter, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { getLogger } from '../util/logging.js';

const logger = getLogger('telemetry.open-telemetry');

export interface SetupOtelOptions {
  serviceName: string;
  endpoint?: string | null;
  environment?: string | null;
  sampler?: string | null;
  headers?: Record<string, string> | undefined;
}

export async function setupOtel(options: SetupOtelOptions): Promise<void> {
  try {
    const [apiModule, resourcesModule, nodeModule, traceBaseModule] = await Promise.all([
      import('@opentelemetry/api'),
      import('@opentelemetry/resources'),
      import('@opentelemetry/sdk-trace-node'),
      import('@opentelemetry/sdk-trace-base'),
    ]);

    const { trace } = apiModule;
    const { defaultResource, resourceFromAttributes } = resourcesModule as typeof import('@opentelemetry/resources');
    const { NodeTracerProvider } = nodeModule as typeof import('@opentelemetry/sdk-trace-node');
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
      return;
    }
    if (currentProvider && currentProvider.constructor?.name === 'NodeTracerProvider') {
      return;
    }

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

    const provider = new NodeTracerProvider({
      resource,
      sampler,
    });

    const exporter = await resolveExporter(
      options.endpoint ?? undefined,
      options.headers,
      ConsoleSpanExporter
    );

    const spanProcessor = new BatchSpanProcessor(exporter);
    const providerWithProcessor = provider as unknown as {
      addSpanProcessor?: (processor: SpanProcessor) => void;
    };
    providerWithProcessor.addSpanProcessor?.(spanProcessor);
    provider.register();
  } catch (error) {
    logger.error('open_telemetry_not_available', { error });
  }
}

function generateInstanceId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
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
  } else if (normalized === 'always_on' || normalized === 'parentbased_always_on') {
    base = new samplers.AlwaysOnSampler();
  } else if (normalized.startsWith('ratio:')) {
    const ratioValue = Number.parseFloat(normalized.slice('ratio:'.length));
    const ratio = Number.isFinite(ratioValue) ? Math.min(Math.max(ratioValue, 0), 1) : 1;
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
      const exporterModule = await import('@opentelemetry/exporter-trace-otlp-http');
      if ('OTLPTraceExporter' in exporterModule) {
        const { OTLPTraceExporter } = exporterModule as {
          OTLPTraceExporter: new (config: { url: string; headers?: Record<string, string> }) => SpanExporter;
        };
        const exporterOptions: { url: string; headers?: Record<string, string> } = { url: endpoint };
        if (headers && Object.keys(headers).length > 0) {
          exporterOptions.headers = headers;
        }
        return new OTLPTraceExporter(exporterOptions);
      }
    } catch (error) {
      logger.error('open_telemetry_exporter_not_available', { error });
    }
  }

  return new ConsoleSpanExporter();
}
