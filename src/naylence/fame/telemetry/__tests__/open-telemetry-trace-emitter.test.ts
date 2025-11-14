import type { Tracer } from '@opentelemetry/api';
import type { AuthInjectionStrategy } from '../../security/auth/auth-injection-strategy.js';
import type { OtelLifecycleControl } from '../otel-setup.js';
import { OpenTelemetryTraceEmitter } from '../open-telemetry-trace-emitter.js';

type ConstructorOptions = ConstructorParameters<
  typeof OpenTelemetryTraceEmitter
>[0];

let mockForceFlush: jest.Mock;
let mockShutdown: jest.Mock;
let mockTracerProvider: { forceFlush: jest.Mock; shutdown: jest.Mock };
let mockStartSpan: jest.Mock;
let mockTracer: Tracer;
let mockGetTracer: jest.Mock;
let mockGetTracerProvider: jest.Mock;
let mockOtelApi: Pick<typeof import('@opentelemetry/api'), 'trace' | 'SpanStatusCode'>;

describe('OpenTelemetryTraceEmitter', () => {
  beforeEach(() => {
    mockForceFlush = jest.fn().mockResolvedValue(undefined);
    mockShutdown = jest.fn().mockResolvedValue(undefined);
    mockTracerProvider = {
      forceFlush: mockForceFlush,
      shutdown: mockShutdown,
    };
    mockStartSpan = jest.fn(() => createMockSpan());
    mockTracer = { startSpan: mockStartSpan } as unknown as Tracer;
    mockGetTracer = jest.fn(() => mockTracer);
    mockGetTracerProvider = jest.fn(() => mockTracerProvider);

    const traceApiMock = {
      getTracer: (...args: unknown[]) => mockGetTracer(...args),
      getTracerProvider: (...args: unknown[]) => mockGetTracerProvider(...args),
    } as unknown as typeof import('@opentelemetry/api').trace;

    mockOtelApi = {
      trace: traceApiMock,
      SpanStatusCode: { ERROR: 2 } as unknown as typeof import('@opentelemetry/api').SpanStatusCode,
    };
  });

  it('accepts snake_case constructor aliases without mutating telemetry attributes', async () => {
    const lifecycle: OtelLifecycleControl = {
      forceFlush: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
    };
    const authStrategy: AuthInjectionStrategy = {
      apply: jest.fn().mockResolvedValue(undefined),
      cleanup: jest.fn().mockResolvedValue(undefined),
    };

    const emitter = new OpenTelemetryTraceEmitter({
      otelApi: mockOtelApi,
      service_name: 'snake-service',
      auth_strategy: authStrategy,
      life_cycle: lifecycle,
    } as unknown as ConstructorOptions);

    const scope = emitter.startSpan('alias_span', {
      attributes: { custom_attr: 'value' },
    });
    scope.enter();
    scope.exit();

    expect(mockGetTracer).toHaveBeenCalledWith('snake-service');
    expect(mockStartSpan).toHaveBeenCalledWith(
      'alias_span',
      expect.objectContaining({ attributes: { custom_attr: 'value' } })
    );

    await emitter.flush();
    expect(lifecycle.forceFlush).toHaveBeenCalled();
    expect(mockGetTracerProvider).not.toHaveBeenCalled();

    await emitter.shutdown();
    expect(lifecycle.shutdown).toHaveBeenCalled();
    expect(authStrategy.cleanup).toHaveBeenCalled();
  });

  it('uses provided tracer without fetching a new tracer', () => {
    const customStartSpan = jest.fn(() => createMockSpan());
    const customTracer = { startSpan: customStartSpan } as unknown as Tracer;

    const emitter = new OpenTelemetryTraceEmitter({
      otelApi: mockOtelApi,
      serviceName: 'custom-service',
      tracer: customTracer,
    });

    const scope = emitter.startSpan('custom_span', {
      attributes: { another_attr: 'value' },
    });
    scope.enter();
    scope.exit();

    expect(mockGetTracer).not.toHaveBeenCalled();
    expect(customStartSpan).toHaveBeenCalledWith(
      'custom_span',
      expect.objectContaining({ attributes: { another_attr: 'value' } })
    );
  });
});

function createMockSpan() {
  return {
    spanContext: jest.fn(() => ({ traceId: 'trace', spanId: 'span' })),
    end: jest.fn(),
    setAttribute: jest.fn(),
    setStatus: jest.fn(),
    recordException: jest.fn(),
  };
}
