import type { OtelLifecycleControl } from '../otel-setup.js';

jest.mock('../../util/logging.js', () => ({
  getLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
  }),
}));

const mockGetTracerProvider = jest.fn(() => null);

jest.mock('@opentelemetry/api', () => ({
  trace: {
    getTracerProvider: () => mockGetTracerProvider(),
  },
  __reset: () => {
    mockGetTracerProvider.mockReset().mockReturnValue(null);
  },
}));

const defaultResourceMock = jest.fn(() => ({
  merge: jest.fn(() => ({ merged: true })),
}));
const resourceFromAttributesMock = jest.fn(
  (attrs: Record<string, unknown>) => ({
    ...attrs,
  })
);

jest.mock('@opentelemetry/resources', () => ({
  defaultResource: () => defaultResourceMock(),
  resourceFromAttributes: (attrs: Record<string, unknown>) =>
    resourceFromAttributesMock(attrs),
  __reset: () => {
    defaultResourceMock.mockClear();
    resourceFromAttributesMock.mockClear();
  },
}));

const nodeTracerProviderInstances: Array<{
  options: any;
  register: jest.Mock;
  forceFlush: jest.Mock;
  shutdown: jest.Mock;
}> = [];

class MockNodeTracerProvider {
  public options: any;
  public register: jest.Mock;
  public forceFlush: jest.Mock;
  public shutdown: jest.Mock;

  public constructor(options: any) {
    this.options = options;
    this.register = jest.fn();
    this.forceFlush = jest.fn().mockResolvedValue(undefined);
    this.shutdown = jest.fn().mockResolvedValue(undefined);
    nodeTracerProviderInstances.push(this);
  }
}

jest.mock('@opentelemetry/sdk-trace-node', () => ({
  NodeTracerProvider: MockNodeTracerProvider,
  __mockNodeTracerProviderInstances: nodeTracerProviderInstances,
  __reset: () => {
    nodeTracerProviderInstances.splice(0, nodeTracerProviderInstances.length);
  },
}));

const BatchSpanProcessorMock = jest.fn().mockImplementation(function (
  this: any,
  exporter: unknown
) {
  this.exporter = exporter;
});
const ConsoleSpanExporterMock = jest.fn().mockImplementation(function () {});
const ParentBasedSamplerMock = jest.fn().mockImplementation(function (
  this: any,
  config: unknown
) {
  this.config = config;
});
const AlwaysOnSamplerMock = jest.fn().mockImplementation(function () {});
const AlwaysOffSamplerMock = jest.fn().mockImplementation(function () {});
const TraceIdRatioBasedSamplerMock = jest
  .fn()
  .mockImplementation(function () {});

jest.mock('@opentelemetry/sdk-trace-base', () => ({
  BatchSpanProcessor: BatchSpanProcessorMock,
  ConsoleSpanExporter: ConsoleSpanExporterMock,
  ParentBasedSampler: ParentBasedSamplerMock,
  AlwaysOnSampler: AlwaysOnSamplerMock,
  AlwaysOffSampler: AlwaysOffSamplerMock,
  TraceIdRatioBasedSampler: TraceIdRatioBasedSamplerMock,
  __reset: () => {
    BatchSpanProcessorMock.mockClear();
    ConsoleSpanExporterMock.mockClear();
    ParentBasedSamplerMock.mockClear();
    AlwaysOnSamplerMock.mockClear();
    AlwaysOffSamplerMock.mockClear();
    TraceIdRatioBasedSamplerMock.mockClear();
  },
}));

const OTLPTraceExporterMock = jest.fn().mockImplementation(function (
  this: any,
  config: unknown
) {
  this.config = config;
});

jest.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: OTLPTraceExporterMock,
  __reset: () => {
    OTLPTraceExporterMock.mockClear();
  },
}));

describe('setupOtel', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    const traceNodeModule = jest.requireMock('@opentelemetry/sdk-trace-node');
    traceNodeModule.__reset();

    const traceBaseModule = jest.requireMock('@opentelemetry/sdk-trace-base');
    traceBaseModule.__reset();

    const exporterModule = jest.requireMock(
      '@opentelemetry/exporter-trace-otlp-http'
    );
    exporterModule.__reset();

    const resourcesModule = jest.requireMock('@opentelemetry/resources');
    resourcesModule.__reset();

    const apiModule = jest.requireMock('@opentelemetry/api');
    apiModule.__reset();
  });

  it('normalizes snake_case inputs before configuring OpenTelemetry', async () => {
    const { setupOtel } = await import('../otel-setup.js');
    const control = (await setupOtel({
      service_name: 'snake-service',
      deployment_environment: 'stage',
      sampler: 'always_off',
    })) as OtelLifecycleControl;

    expect(control).not.toBeNull();

    expect(resourceFromAttributesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        'service.name': 'snake-service',
        'deployment.environment': 'stage',
        'service.instance.id': expect.any(String),
      })
    );

    const traceBaseModule = jest.requireMock('@opentelemetry/sdk-trace-base');
    expect(traceBaseModule.AlwaysOffSampler).toHaveBeenCalledTimes(1);
    expect(traceBaseModule.ParentBasedSampler).toHaveBeenCalledWith({
      root: traceBaseModule.AlwaysOffSampler.mock.instances[0],
    });

    const traceNodeModule = jest.requireMock('@opentelemetry/sdk-trace-node');
    const providerInstance =
      traceNodeModule.__mockNodeTracerProviderInstances[0];
    expect(providerInstance).toBeDefined();
    expect(providerInstance.options.resource).toEqual({ merged: true });
  });

  it('merges endpoint aliases and propagates lifecycle controls', async () => {
    const { setupOtel } = await import('../otel-setup.js');
    const control = (await setupOtel({
      serviceName: 'alias-service',
      otlp_endpoint: 'https://telemetry.example/v1/traces',
      headers: {
        'x-telemetry-key': 'secret',
      },
    })) as OtelLifecycleControl;

    const exporterModule = jest.requireMock(
      '@opentelemetry/exporter-trace-otlp-http'
    );
    expect(exporterModule.OTLPTraceExporter).toHaveBeenCalledWith({
      url: 'https://telemetry.example/v1/traces',
      headers: {
        'x-telemetry-key': 'secret',
      },
    });

    const traceNodeModule = jest.requireMock('@opentelemetry/sdk-trace-node');
    const providerInstance =
      traceNodeModule.__mockNodeTracerProviderInstances[0];

    await control?.forceFlush?.();
    expect(providerInstance.forceFlush).toHaveBeenCalled();

    await control?.shutdown?.();
    expect(providerInstance.shutdown).toHaveBeenCalled();
  });
});
